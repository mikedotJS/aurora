import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings";
import { getRepoConfig, saveRepoConfig, hasSavedConfig, defaultRepoConfig } from "../src/lib/repoConfig";

const ROOT = "/repo/aurora";

function resetStore() {
  useStore.setState({
    workspaceSettingsRepo: null,
    repoConfigs: {},
    repos: [],
    connections: { jira: [], ai: [] },
    settingsOpen: false,
  });
}

beforeEach(() => {
  tauri.reset();
  tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "develop", "feature/x"] }) });
  resetStore();
});
afterEach(cleanup);

describe("closed state", () => {
  it("renders nothing when no repo is targeted", () => {
    const { container } = render(<WorkspaceSettings />);
    expect(container.firstChild).toBeNull();
  });
});

describe("opening + seeding", () => {
  it("seeds a default config on first open of a repo with no saved config", async () => {
    expect(hasSavedConfig(ROOT)).toBe(false);
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    await waitFor(() => expect(hasSavedConfig(ROOT)).toBe(true));
    expect(getRepoConfig(ROOT).defaults.baseBranch).toBe("main");
  });

  it("does not reseed a repo that already has saved config", () => {
    saveRepoConfig({ ...defaultRepoConfig(ROOT), defaults: { ...defaultRepoConfig(ROOT).defaults, baseBranch: "custom-base" } });
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    expect(getRepoConfig(ROOT).defaults.baseBranch).toBe("custom-base");
  });
});

describe("header", () => {
  it("uses the matching repo's name when present in `repos`", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT, repos: [{ id: ROOT, root: ROOT, name: "Aurora Repo", defaultBranch: "main" }] });
    render(<WorkspaceSettings />);
    expect(screen.getByText("· Aurora Repo")).toBeTruthy();
  });

  it("falls back to the last path segment when the repo isn't registered", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT, repos: [] });
    render(<WorkspaceSettings />);
    expect(screen.getByText("· aurora")).toBeTruthy();
  });

  it("closes via the backdrop click", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    const { container } = render(<WorkspaceSettings />);
    const backdrop = container.firstElementChild!.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useStore.getState().workspaceSettingsRepo).toBeNull();
  });

  it("closes via the × button", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    fireEvent.click(screen.getByText("×"));
    expect(useStore.getState().workspaceSettingsRepo).toBeNull();
  });
});

describe("jira connection binding", () => {
  it("shows a 'Connect a site…' pill when no Jira connections exist, and jumps to app settings", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT, connections: { jira: [], ai: [] } });
    render(<WorkspaceSettings />);
    fireEvent.click(screen.getByText("Connect a site…"));
    expect(useStore.getState().workspaceSettingsRepo).toBeNull();
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("offers a select of connections (falling back to siteHost when unlabeled) and binds on change", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({
      workspaceSettingsRepo: ROOT,
      connections: {
        jira: [
          { id: "j1", site: "https://team.atlassian.net", email: "a@b.com", label: "Team Jira" },
          { id: "j2", site: "https://other.atlassian.net", email: "c@d.com" },
        ],
        ai: [],
      },
    });
    render(<WorkspaceSettings />);
    expect(screen.getByText("Team Jira")).toBeTruthy();
    expect(screen.getByText("other.atlassian.net")).toBeTruthy();
    const select = screen.getByText("Team Jira").closest("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "j2" } });
    expect(getRepoConfig(ROOT).integrations.jiraConnectionId).toBe("j2");
    fireEvent.change(select, { target: { value: "" } });
    expect(getRepoConfig(ROOT).integrations.jiraConnectionId).toBeNull();
  });

  it("edits the Jira project key", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    const input = screen.getByPlaceholderText("PROJ") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "AUR" } });
    expect(getRepoConfig(ROOT).integrations.jiraProjectKey).toBe("AUR");
  });
});

describe("sync status names (unbound)", () => {
  it("shows free-text fallback inputs when there is no bound Jira project, and edits them", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    const startInput = screen.getByPlaceholderText("In Progress") as HTMLInputElement;
    const mergeInput = screen.getByPlaceholderText("Done") as HTMLInputElement;
    expect(startInput.value).toBe("In Progress");
    expect(mergeInput.value).toBe("Done");
    fireEvent.change(startInput, { target: { value: "Doing" } });
    expect(getRepoConfig(ROOT).integrations.jiraInProgress).toBe("Doing");
    fireEvent.change(mergeInput, { target: { value: "Shipped" } });
    expect(getRepoConfig(ROOT).integrations.jiraDone).toBe("Shipped");
  });
});

describe("sync status names (bound project with real statuses)", () => {
  it("switches to select pickers once statuses load, preserving a configured value absent from the workflow", async () => {
    tauri.invoke({ jira_project_statuses: () => ["Open", "In Review", "Closed"] });
    const cfg = defaultRepoConfig(ROOT);
    cfg.integrations = { jiraConnectionId: "j1", jiraProjectKey: "AUR", jiraInProgress: "In Progress", jiraDone: "Done" };
    saveRepoConfig(cfg);
    useStore.setState({
      workspaceSettingsRepo: ROOT,
      connections: { jira: [{ id: "j1", site: "https://team.atlassian.net", email: "a@b.com" }], ai: [] },
    });
    render(<WorkspaceSettings />);
    await waitFor(() => expect(screen.getByText("Pulled from the project workflow; applied on start / merge.")).toBeTruthy());
    // "In Progress" isn't among the loaded statuses -> prepended so it isn't dropped.
    const selects = screen.getAllByDisplayValue("In Progress");
    expect(selects.length).toBeGreaterThan(0);
    const startSelect = selects.find((el) => el.tagName === "SELECT") as HTMLSelectElement;
    fireEvent.change(startSelect, { target: { value: "Open" } });
    expect(getRepoConfig(ROOT).integrations.jiraInProgress).toBe("Open");
  });
});

describe("gitlab row", () => {
  it("always shows the auto-detected note", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    expect(screen.getByText("auto · via glab")).toBeTruthy();
  });
});

describe("two-way sync default toggle", () => {
  it("flips jiraSyncDefault", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    const label = screen.getByText("Two-way sync by default");
    const toggle = label.parentElement!.parentElement!.querySelector('div[onclick], div[style*="border-radius: 999px"]') as HTMLElement;
    fireEvent.click(toggle);
    expect(getRepoConfig(ROOT).defaults.jiraSyncDefault).toBe(true);
  });
});

describe("default AI account", () => {
  it("defaults to the terminal key and binds a pooled AI account on change", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({
      workspaceSettingsRepo: ROOT,
      connections: { jira: [], ai: [{ id: "ai1", provider: "claude", label: "Work Claude" }] },
    });
    render(<WorkspaceSettings />);
    const select = screen.getByText("Work Claude").closest("select") as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "ai1" } });
    expect(getRepoConfig(ROOT).defaults.aiDefaultId).toBe("ai1");
    fireEvent.change(select, { target: { value: "" } });
    expect(getRepoConfig(ROOT).defaults.aiDefaultId).toBeNull();
  });
});

describe("presets", () => {
  it("renders each preset's layout + issue types (or 'no auto-types'), opens the editor, and returns via 'all settings'", () => {
    const cfg = defaultRepoConfig(ROOT);
    cfg.presets = [
      { id: "p1", name: "feature-work", issueTypes: ["Bug", "Story"], paneLayout: "2-split", runOnOpen: null, env: {}, baseOverride: null, portOffset: "auto", jiraSync: false },
      { id: "p2", name: "bare", issueTypes: [], paneLayout: "1", runOnOpen: null, env: {}, baseOverride: null, portOffset: "auto", jiraSync: false },
    ];
    saveRepoConfig(cfg);
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    expect(screen.getByText("feature-work")).toBeTruthy();
    expect(screen.getByText(/2-split · Bug\/Story/)).toBeTruthy();
    expect(screen.getByText(/1 · no auto-types/)).toBeTruthy();

    fireEvent.click(screen.getByText("feature-work"));
    expect(screen.getByText("‹ all settings")).toBeTruthy();
    expect(screen.getByText("Edit preset")).toBeTruthy();

    fireEvent.click(screen.getByText("‹ all settings"));
    expect(screen.queryByText("‹ all settings")).toBeNull();
    expect(screen.getByText("feature-work")).toBeTruthy();
  });

  it("creates a new preset via '+ New preset' and opens its editor", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    fireEvent.click(screen.getByText("+ New preset"));
    expect(screen.getByText("Edit preset")).toBeTruthy();
    expect(getRepoConfig(ROOT).presets.some((p) => p.name === "new-preset")).toBe(true);
  });
});

describe("new-workspace defaults", () => {
  it("shows the branch-naming source label and opens/closes the branch editor", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    expect(screen.getByText("Token template")).toBeTruthy();
    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByText("‹ all settings")).toBeTruthy();
    fireEvent.click(screen.getByText("‹ all settings"));
    expect(screen.getByText("Token template")).toBeTruthy();
  });

  it("populates the base-branch select from git and switches it", async () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    const select = screen.getByDisplayValue("main") as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: "develop" } });
    expect(getRepoConfig(ROOT).defaults.baseBranch).toBe("develop");
  });

  it("flips 'show rail on launch'", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    useStore.setState({ workspaceSettingsRepo: ROOT });
    render(<WorkspaceSettings />);
    const label = screen.getByText("Show rail on launch");
    const toggle = label.parentElement!.parentElement!.lastElementChild!.firstElementChild as HTMLElement;
    fireEvent.click(toggle);
    expect(getRepoConfig(ROOT).defaults.showRailOnLaunch).toBe(false);
  });
});
