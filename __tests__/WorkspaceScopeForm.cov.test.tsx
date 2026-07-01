import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { useStore, DEFAULT_SETTINGS } from "../src/state/store";
import { WorkspaceScopeForm, type ScopeInitial } from "../src/components/WorkspaceScopeForm";
import type { CreateSource } from "../src/lib/create";
import { DEFAULT_BRANCH_NAMING } from "../src/lib/branchNaming";
import { getRepoConfig } from "../src/lib/repoConfig";
import type { Preset } from "../src/lib/repoConfig";
import { emptyConnections } from "../src/lib/connections";

const ROOT = "/repo/aurora";
const REPO = { root: ROOT, name: "aurora", defaultBranch: "main" };

function makePreset(id: string, overrides: Partial<Preset> = {}): Preset {
  return {
    id,
    name: id,
    issueTypes: [],
    paneLayout: "1",
    runOnOpen: null,
    env: {},
    baseOverride: null,
    portOffset: "auto",
    jiraSync: false,
    ...overrides,
  };
}

const presetFeature = makePreset("pf", { name: "feature", runOnOpen: "build" });
const presetBug = makePreset("pb", { name: "bugfix", issueTypes: ["Bug"], runOnOpen: "dev", baseOverride: "hotfix-base", jiraSync: true });
const presetOther = makePreset("po", { name: "other" });

function seedRepo(opts: { presets?: Preset[]; baseBranch?: string; jiraSyncDefault?: boolean; jiraConnectionId?: string | null } = {}) {
  const cfg = getRepoConfig(ROOT);
  useStore.setState({
    repoConfigs: {
      [ROOT]: {
        ...cfg,
        presets: opts.presets ?? [],
        defaults: { ...cfg.defaults, baseBranch: opts.baseBranch ?? "cfg-main", branchNaming: DEFAULT_BRANCH_NAMING, jiraSyncDefault: opts.jiraSyncDefault ?? false },
        integrations: { ...cfg.integrations, jiraConnectionId: opts.jiraConnectionId ?? null },
      },
    },
  });
}

function connectJira(id = "j1") {
  useStore.setState({ connections: { jira: [{ id, site: "acme.atlassian.net", email: "me@acme.com" }], ai: [] } });
}

function renderForm(source: CreateSource, initial: ScopeInitial, onCancel: () => void = () => {}) {
  return render(<WorkspaceScopeForm repo={REPO} source={source} initial={initial} onCancel={onCancel} />);
}

function bases(container: HTMLElement) {
  return container.querySelectorAll("select");
}

beforeEach(() => {
  tauri.reset();
  tauri.invoke({
    validate_branch_name: () => ({ ok: true, enforced: true, message: null }),
    git_branches: () => ({ current: "cfg-main", branches: ["cfg-main", "develop"] }),
  });
  useStore.setState({
    repoConfigs: {},
    connections: emptyConnections(),
    userScripts: {},
    workspaces: [],
    repos: [],
    activeWs: null,
    notifs: [],
    notifLog: [],
    settings: { ...DEFAULT_SETTINGS },
    command: { query: "", sel: 0 },
  });
});
afterEach(cleanup);

describe("preset auto-selection", () => {
  it("falls back to the preset named 'feature' when nothing else matches", async () => {
    seedRepo({ presets: [presetFeature, presetBug, presetOther] });
    const { container } = renderForm("branch", { title: "", branch: "my-branch" });
    await waitFor(() => expect((bases(container)[0] as HTMLSelectElement).value).toBe("cfg-main"));
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    const ws = useStore.getState().workspaces[0];
    expect(ws.preset).toBe("feature");
    expect(ws.baseBranch).toBe("cfg-main");
  });

  it("falls back to the first preset when there's no 'feature' preset and no issue-type match", async () => {
    seedRepo({ presets: [presetOther, presetBug] });
    renderForm("branch", { title: "", branch: "my-branch" });
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    expect(useStore.getState().workspaces[0].preset).toBe("other");
  });

  it("auto-selects a preset by Jira issue type over the 'feature' fallback", async () => {
    seedRepo({ presets: [presetFeature, presetBug, presetOther], jiraConnectionId: "j1" });
    connectJira("j1");
    tauri.invoke({
      jira_issue: () => ({
        key: "AUR-7",
        summary: "Fix the thing",
        issue_type: "Bug",
        status: "In Review",
        assignee: null,
        component: null,
        fix_version: null,
        sprint: null,
        description: "",
        url: "https://acme.atlassian.net/browse/AUR-7",
        comments: [],
      }),
    });
    const { container } = renderForm("jira", { issueKey: "AUR-7", issueType: "Bug", title: "Fix the thing", branch: "aur-7/placeholder" });
    expect(screen.getByText("AUR-7")).toBeTruthy();
    expect(screen.getByText("Fix the thing")).toBeTruthy();
    // base pre-selects the bugfix preset's override
    await waitFor(() => expect((bases(container)[0] as HTMLSelectElement).value).toBe("hotfix-base"));
    // the branch-name suggestion effect overwrites the initial placeholder branch
    await waitFor(() => expect(screen.getByDisplayValue("aur-7/fix-the-thing")).toBeTruthy());

    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    const ws = useStore.getState().workspaces[0];
    expect(ws.preset).toBe("bugfix");
    expect(ws.jiraUrl).toBe("https://acme.atlassian.net/browse/AUR-7");
    // jiraSync (from the bugfix preset) then transitions it again on top of the fetched status
    await waitFor(() => expect(useStore.getState().workspaces[0].jiraStatus).toBe("In Progress"));
  });

  it("prefers an explicitly seeded preset over the issue-type match", async () => {
    seedRepo({ presets: [presetFeature, presetBug, presetOther] });
    renderForm("branch", { title: "", branch: "my-branch", issueType: "Bug", preset: "other" });
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    expect(useStore.getState().workspaces[0].preset).toBe("other");
  });

  it("shows the empty-presets hint and still creates a presetless workspace", async () => {
    seedRepo({ presets: [] });
    renderForm("branch", { title: "", branch: "my-branch" });
    expect(screen.getByText("none — add presets in Workspace settings")).toBeTruthy();
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    const ws = useStore.getState().workspaces[0];
    expect(ws.preset).toBeNull();
  });
});

describe("describe source", () => {
  it("triggers the branch-name suggestion even without an issue key when source is 'describe'", async () => {
    seedRepo({ presets: [presetFeature] });
    renderForm("describe", { title: "Improve onboarding flow", branch: "placeholder" });
    await waitFor(() => expect(screen.getByDisplayValue("improve-onboarding-flow")).toBeTruthy());
  });
});

describe("base branch resolution from gitBranches()", () => {
  it("resets the base branch when neither the current selection nor the default is in the fetched list", async () => {
    tauri.invoke({ git_branches: () => ({ current: null, branches: ["release", "hotfix"] }) });
    seedRepo({ presets: [presetFeature], baseBranch: "cfg-main" });
    const { container } = renderForm("branch", { title: "", branch: "my-branch" });
    await waitFor(() => expect((bases(container)[0] as HTMLSelectElement).value).toBe("release"));
  });

  it("falls back to the repo's current branch when the branch list is empty", async () => {
    tauri.invoke({ git_branches: () => ({ current: "trunk", branches: [] }) });
    seedRepo({ presets: [presetFeature], baseBranch: "cfg-main" });
    const { container } = renderForm("branch", { title: "", branch: "my-branch" });
    await waitFor(() => expect((bases(container)[0] as HTMLSelectElement).value).toBe("trunk"));
  });

  it("falls back to the default base when the branch list and current are both empty", async () => {
    tauri.invoke({ git_branches: () => ({ current: null, branches: [] }) });
    seedRepo({ presets: [presetFeature], baseBranch: "cfg-main" });
    const { container } = renderForm("branch", { title: "", branch: "my-branch" });
    await waitFor(() => expect((bases(container)[0] as HTMLSelectElement).value).toBe("cfg-main"));
  });
});

describe("branch input + live validity badge", () => {
  it("shows a valid badge, an invalid badge with a note, and no badge when unenforced", async () => {
    tauri.invoke({
      validate_branch_name: (a) => {
        const name = a.name as string;
        if (name === "good-branch") return { ok: true, enforced: true, message: null };
        if (name === "bad branch") return { ok: false, enforced: true, message: "Branch names can't contain spaces." };
        return { ok: true, enforced: false, message: null };
      },
    });
    seedRepo({ presets: [presetFeature] });
    renderForm("branch", { title: "", branch: "good-branch" });
    await waitFor(() => expect(screen.getByText("✓")).toBeTruthy());

    const input = screen.getByDisplayValue("good-branch") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad branch" } });
    await waitFor(() => expect(screen.getByText("✕")).toBeTruthy());
    expect(screen.getByText("Branch names can't contain spaces.")).toBeTruthy();

    fireEvent.change(input, { target: { value: "unenforced-branch" } });
    await waitFor(() => expect(screen.queryByText("✓")).toBeNull());
    expect(screen.queryByText("✕")).toBeNull();
  });

  it("clears the badge when the branch is emptied", async () => {
    seedRepo({ presets: [presetFeature] });
    renderForm("branch", { title: "", branch: "my-branch" });
    await waitFor(() => expect(screen.getByText("✓")).toBeTruthy());
    const input = screen.getByDisplayValue("my-branch") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    await waitFor(() => expect(screen.queryByText("✓")).toBeNull());
    expect(screen.queryByText("✕")).toBeNull();
  });
});

describe("preset picker + jira sync toggle", () => {
  it("switches script + jira sync when a different preset is clicked, and updates the overrides count", async () => {
    seedRepo({ presets: [presetFeature, presetBug, presetOther], jiraConnectionId: "j1" });
    connectJira("j1");
    useStore.setState({ userScripts: { [ROOT]: { scripts: [{ name: "build", desc: "", split: false, tasks: [] }, { name: "dev", desc: "", split: false, tasks: [] }], onEnter: null } } });
    const { container } = renderForm("branch", { title: "", branch: "my-branch" });
    expect(screen.getByText("Inherits aurora · overrides 0 fields")).toBeTruthy();

    fireEvent.click(screen.getByText("bugfix"));
    // switching preset also shifts defaultBase to the new preset's baseOverride,
    // so the base (still "cfg-main") now counts as an override too: 2 fields.
    expect(screen.getByText("Inherits aurora · overrides 2 fields")).toBeTruthy();
    const scriptSelect = container.querySelectorAll("select")[1] as HTMLSelectElement;
    expect(scriptSelect.value).toBe("dev");

    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    expect(useStore.getState().workspaces[0].jiraSync).toBe(true);
  });

  it("does not toggle jira sync when Jira isn't connected", async () => {
    seedRepo({ presets: [presetFeature] }); // no jiraConnectionId
    renderForm("branch", { title: "", branch: "my-branch" });
    const label = screen.getByText("Two-way Jira sync");
    const toggle = label.parentElement!.nextElementSibling as HTMLElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    expect(useStore.getState().workspaces[0].jiraSync).toBe(false);
  });

  it("toggles jira sync on when Jira is connected", async () => {
    seedRepo({ presets: [presetFeature], jiraConnectionId: "j1", jiraSyncDefault: false });
    connectJira("j1");
    renderForm("branch", { title: "", branch: "my-branch" });
    const label = screen.getByText("Two-way Jira sync");
    const toggle = label.parentElement!.nextElementSibling as HTMLElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    expect(useStore.getState().workspaces[0].jiraSync).toBe(true);
  });
});

describe("on-open script select", () => {
  it("lists the repo's scripts and lets the user change the selection", () => {
    seedRepo({ presets: [presetFeature] });
    useStore.setState({ userScripts: { [ROOT]: { scripts: [{ name: "build", desc: "", split: false, tasks: [] }, { name: "test", desc: "", split: false, tasks: [] }], onEnter: null } } });
    const { container } = renderForm("branch", { title: "", branch: "my-branch" });
    const select = container.querySelectorAll("select")[1] as HTMLSelectElement;
    expect(select.value).toBe("build");
    fireEvent.change(select, { target: { value: "test" } });
    expect(select.value).toBe("test");
  });
});

describe("create() failure + double-submit guard", () => {
  it("surfaces the backend error and re-enables the button on failure", async () => {
    tauri.invoke({
      validate_branch_name: () => ({ ok: false, enforced: true, message: "That branch already exists." }),
    });
    seedRepo({ presets: [presetFeature] });
    renderForm("branch", { title: "", branch: "taken-branch" });
    fireEvent.click(screen.getByText("Create workspace"));
    // shown both as the live branch-note and as the create() error
    await waitFor(() => expect(screen.getAllByText("That branch already exists.").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("Create workspace")).toBeTruthy(); // no longer stuck on "Creating…"
    expect(useStore.getState().workspaces).toHaveLength(0);
  });

  it("ignores a second click while a create is already in flight", async () => {
    let resolveWorktree: (v: unknown) => void = () => {};
    tauri.invoke({
      worktree_add: () => new Promise((resolve) => (resolveWorktree = resolve)),
    });
    seedRepo({ presets: [presetFeature] });
    renderForm("branch", { title: "", branch: "slow-branch" });
    const btn = screen.getByText("Create workspace");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Creating…")).toBeTruthy());
    fireEvent.click(screen.getByText("Creating…"));
    fireEvent.click(screen.getByText("Creating…"));
    resolveWorktree({ path: "/x", branch: "slow-branch", head: "abc" });
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    expect(tauri.calls().filter((c) => c.cmd === "worktree_add")).toHaveLength(1);
  });
});

describe("jira sync transition on create", () => {
  it("records the new jira status on a successful transition", async () => {
    seedRepo({ presets: [presetBug], jiraConnectionId: "j1" });
    connectJira("j1");
    tauri.invoke({
      jira_issue: () => ({
        key: "AUR-9",
        summary: "Sync test",
        issue_type: "Bug",
        status: "To Do",
        assignee: null,
        component: null,
        fix_version: null,
        sprint: null,
        description: "",
        url: "https://acme.atlassian.net/browse/AUR-9",
        comments: [],
      }),
      jira_transition: () => undefined,
    });
    renderForm("jira", { issueKey: "AUR-9", issueType: "Bug", title: "Sync test", branch: "aur-9/sync-test" });
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().workspaces[0].jiraStatus).toBe("In Progress"));
  });

  it("shows a warning notification when the transition fails", async () => {
    seedRepo({ presets: [presetBug], jiraConnectionId: "j1" });
    connectJira("j1");
    tauri.invoke({
      jira_issue: () => ({
        key: "AUR-9",
        summary: "Sync test",
        issue_type: "Bug",
        status: "To Do",
        assignee: null,
        component: null,
        fix_version: null,
        sprint: null,
        description: "",
        url: "https://acme.atlassian.net/browse/AUR-9",
        comments: [],
      }),
      jira_transition: () => {
        throw new Error("boom");
      },
    });
    renderForm("jira", { issueKey: "AUR-9", issueType: "Bug", title: "Sync test", branch: "aur-9/sync-test" });
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(useStore.getState().workspaces).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().notifs.some((n) => n.headline === "Jira not updated")).toBe(true));
  });
});

describe("cancel", () => {
  it("calls onCancel when Back is clicked", () => {
    seedRepo({ presets: [presetFeature] });
    let cancelled = false;
    renderForm("branch", { title: "", branch: "my-branch" }, () => (cancelled = true));
    fireEvent.click(screen.getByText("Back"));
    expect(cancelled).toBe(true);
  });
});
