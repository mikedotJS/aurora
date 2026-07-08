/**
 * Coverage suite for src/components/WorkspaceCommand.tsx — the ⌘K palette that
 * switches workspaces, searches Jira, and kicks off workspace creation.
 *
 * Exercises the component against the REAL store (useStore.setState) and the
 * global Tauri invoke() mock (test/mocks/tauri.ts), rendering it in many store
 * shapes to hit every conditional: repo resolution (targetRepoId / active /
 * fallback), noContext gating, preset-default display, Jira connect/disconnect,
 * debounced Jira search (incl. cancellation + unmount cleanup), quick-create
 * success/failure, and keyboard navigation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { WorkspaceCommand } from "../src/components/WorkspaceCommand";
import { useStore, type Repo, type Workspace } from "../src/state/store";
import { defaultRepoConfig, type RepoConfig, type Preset } from "../src/lib/repoConfig";
import { emptyConnections } from "../src/lib/connections";
import { tauri } from "../test/mocks/tauri";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── factories ────────────────────────────────────────────────────────────────

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, root: id, name: id, defaultBranch: "main", ...overrides };
}

function makeWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoId: null,
    title: id,
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: `/tmp/${id}`,
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [],
    active: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
    ...overrides,
  };
}

function makePreset(id: string, name: string, overrides: Partial<Preset> = {}): Preset {
  return {
    id,
    name,
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

function makeRepoConfig(root: string, overrides: Partial<RepoConfig> = {}): RepoConfig {
  const base = defaultRepoConfig(root);
  return {
    ...base,
    ...overrides,
    defaults: { ...base.defaults, ...(overrides.defaults ?? {}) },
    integrations: { ...base.integrations, ...(overrides.integrations ?? {}) },
  };
}

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  tauri.reset();
  // WorkspaceScopeForm (mounted whenever a source/jira row opens the create
  // form) fetches branches on mount; give it a well-shaped response so its own
  // effect doesn't throw on `bl.branches.length` against the mock default.
  tauri.invoke({ git_branches: () => ({ current: null, branches: [] }) });
  useStore.setState({
    repos: [],
    workspaces: [],
    activeWs: null,
    initialized: true,
    command: { query: "", sel: 0 },
    repoConfigs: {},
    connections: emptyConnections(),
    // Reset explicitly: Zustand's setState merges, so a prior test's
    // `apiKeyPresent: true` (needed for the ⌘Enter AI-create shortcut to not
    // surface the NoKeyError message) would otherwise leak forward into every
    // later test in this file.
    apiKeyPresent: false,
  });
});

afterEach(() => {
  cleanup();
});

// ── repo resolution + empty/disabled states ─────────────────────────────────

describe("repo resolution and disabled states", () => {
  it("with zero repos: shows the empty message, all 3 sources, and no-ops quick-create/openForm", () => {
    render(<WorkspaceCommand />);
    expect(screen.getByText("Open a git repository to create workspaces.")).toBeTruthy();
    expect(screen.queryByText("Choose repo")).toBeNull();
    expect(screen.getByText("a Jira issue")).toBeTruthy();
    expect(screen.getByText("a new branch off base")).toBeTruthy();
    expect(screen.queryByText("a plain-language description")).toBeNull();
    expect(screen.getByText("a clone of this workspace")).toBeTruthy();

    // click a non-disabled source row (branch) — quickCreate short-circuits on !repo
    fireEvent.click(screen.getByText("a new branch off base"));
    expect(useStore.getState().workspaces.length).toBe(0);
    expect(screen.queryByText("New workspace")).toBeNull();

    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");

    // Tab on the default-selected (sel=0 → jira source) item → openForm short-circuits on !repo
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByText("New workspace")).toBeNull();

    // ArrowDown/ArrowUp move the store's command.sel via moveCommand
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(useStore.getState().command?.sel).toBe(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(useStore.getState().command?.sel).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(useStore.getState().command?.sel).toBe(2); // wraps to last of 3 sources

    // Enter activates the clamped item; still a no-op since there's no repo
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useStore.getState().workspaces.length).toBe(0);

    // Escape closes the palette
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useStore.getState().command).toBeNull();
  });

  it("with a single repo: resolves it as target, shows branch/clone defaults, no-ops the disabled jira row", () => {
    const repoA = makeRepo("/repos/alpha", { name: "alpha", defaultBranch: "develop" });
    useStore.setState({ repos: [repoA], command: { query: "", sel: 0 } });
    render(<WorkspaceCommand />);

    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("▾")).toBeNull(); // no caret — only one repo
    // branch defaults: no preset saved → base falls back to repoConfig default "main"
    expect(screen.getByText(/main · on-open: none/)).toBeTruthy();
    // clone defaults: no active ws → base falls back to repo.defaultBranch "develop"
    expect(screen.getByText(/develop · on-open: none/)).toBeTruthy();

    fireEvent.click(screen.getByText("a Jira issue"));
    expect(screen.queryByText("New workspace")).toBeNull();
    expect(useStore.getState().workspaces.length).toBe(0);
  });

  it("with 2+ repos and no active/target: noContext blocks creation; the repo-menu resolves it", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const repoB = makeRepo("/repos/b", { name: "Beta" });
    useStore.setState({ repos: [repoA, repoB], command: { query: "", sel: 0 } });
    const { container } = render(<WorkspaceCommand />);

    expect(screen.getByText("Choose repo")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
    expect(screen.getByText("Pick a target repo (chip above) to enable workspace creation.")).toBeTruthy();

    // a source row is disabled (dim) under noContext — click is a no-op. Note:
    // `disabled` only gates the DOM onClick — it does NOT gate quickCreate/openForm
    // themselves, so this alone would NOT catch a regression that dropped the
    // `noContext` guard inside those functions (repo is truthy here: repos[0]).
    fireEvent.click(screen.getByText("a clone of this workspace"));
    expect(useStore.getState().workspaces.length).toBe(0);
    expect(screen.queryByText("New workspace")).toBeNull();

    // Keyboard activation bypasses the DOM `disabled` gate entirely (onKeyDown's
    // Enter/Tab call activateAt/openForm directly) — this is what actually proves
    // quickCreate/openForm's own `if (!repo || noContext) return;` guard fires
    // even though `repo` resolves truthy (repos[0] = Alpha) under noContext.
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter" }); // sel=0 → sources[0] = jira → quickCreate("jira") → openForm("jira")
    expect(useStore.getState().workspaces.length).toBe(0);
    expect(useStore.getState().command).not.toBeNull();
    fireEvent.keyDown(input, { key: "Tab" }); // → openForm("jira") directly
    expect(screen.queryByText("New workspace")).toBeNull();

    // "clone" and "branch"(+query) short-circuit INSIDE quickCreate without ever
    // delegating to openForm, so this is the path that actually proves
    // quickCreate's own top-of-function noContext guard (not just openForm's).
    // Assert on the synchronous first invoke() of runCreate's chain (pushed to
    // `calls` before quickCreate's first `await` yields) rather than the eventual
    // (async, and here validate_branch_name-default-shape-dependent) create
    // outcome — that keeps this a precise, timing-safe test of the guard itself.
    useStore.setState({ command: { ...useStore.getState().command!, sel: 2 } }); // sources[2] = clone
    fireEvent.keyDown(input, { key: "Enter" });
    expect(tauri.calls().some((c) => c.cmd === "validate_branch_name")).toBe(false);

    // open the repo menu from the chip
    fireEvent.click(screen.getByText("Choose repo"));
    expect(screen.getByText("Alpha")).toBeTruthy();
    const betaItem = screen.getByText("Beta");
    fireEvent.mouseEnter(betaItem); // RepoMenuItem hover state
    fireEvent.mouseLeave(betaItem);
    fireEvent.mouseEnter(betaItem);
    fireEvent.mouseDown(betaItem); // picks Beta, closes menu

    expect(useStore.getState().command?.repoId).toBe(repoB.id);
    expect(screen.queryByText("Pick a target repo (chip above) to enable workspace creation.")).toBeNull();
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0); // now the chip label

    // reopen and dismiss via the menu's own backdrop (not the outer overlay)
    fireEvent.click(screen.getAllByText("Beta")[0]);
    const backdrop = Array.from(container.querySelectorAll("div")).find((d) => d.style.zIndex === "89");
    expect(backdrop).toBeTruthy();
    fireEvent.mouseDown(backdrop!);
    const stillOpen = Array.from(container.querySelectorAll("div")).some((d) => d.style.zIndex === "89");
    expect(stillOpen).toBe(false);
  });

  it("falls through when the pinned targetRepoId no longer matches any repo", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "", sel: 0, repoId: "/repos/ghost" } });
    render(<WorkspaceCommand />);
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("resolves the repo via the active workspace and picks the 'feature' preset by name (not list[0])", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha", defaultBranch: "main" });
    const hotfix = makePreset("p2", "hotfix", { runOnOpen: null });
    const feature = makePreset("p1", "feature", { runOnOpen: "dev" });
    useStore.setState({
      repos: [repoA],
      repoConfigs: { [repoA.root]: makeRepoConfig(repoA.root, { presets: [hotfix, feature] }) },
    });
    const active = makeWorkspace("wsActive", { repoId: repoA.id, title: "Active one", branch: "main", preset: "hotfix" });
    useStore.setState({ workspaces: [active], activeWs: active.id, command: { query: "", sel: 0 } });
    render(<WorkspaceCommand />);

    // branch defaults always try "feature" first regardless of preset array order
    expect(screen.getByText(/main · feature · on-open: dev/)).toBeTruthy();
    // clone defaults use the ACTIVE workspace's preset ("hotfix"), found in the list
    expect(screen.getByText(/main · hotfix · on-open: none/)).toBeTruthy();
  });

  it("clone defaults show a null preset when the active workspace's preset name no longer exists", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha", defaultBranch: "trunk" });
    useStore.setState({ repos: [repoA], repoConfigs: {} }); // no presets saved at all
    const active = makeWorkspace("wsActive", { repoId: repoA.id, title: "Active one", branch: null, preset: "deleted-preset" });
    useStore.setState({ workspaces: [active], activeWs: active.id, command: { query: "", sel: 0 } });
    render(<WorkspaceCommand />);
    // presetName renders even though the preset object itself resolved to null
    expect(screen.getByText(/trunk · deleted-preset · on-open: none/)).toBeTruthy();
  });
});

// ── workspace matches + switching ───────────────────────────────────────────

describe("workspace matches", () => {
  it("filters workspaces by query across issueKey/title/branch, renders both variants, and switches on click", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const active = makeWorkspace("wsActive", { repoId: repoA.id, title: "unrelated" });
    const wsMatch1 = makeWorkspace("ws1", { repoId: repoA.id, title: "demo login fix", issueKey: "PROJ-1", branch: "proj-1/fix" });
    const wsMatch2 = makeWorkspace("ws2", { repoId: repoA.id, title: "demo other", issueKey: null, branch: null });
    useStore.setState({
      repos: [repoA],
      workspaces: [active, wsMatch1, wsMatch2],
      activeWs: active.id,
      command: { query: "demo", sel: 0 },
    });
    render(<WorkspaceCommand />);

    expect(screen.getByText("Switch to")).toBeTruthy();
    expect(screen.getByText("PROJ-1 · demo login fix")).toBeTruthy();
    expect(screen.getByText("⎇ proj-1/fix")).toBeTruthy();
    expect(screen.getByText("demo other")).toBeTruthy();
    expect(screen.queryByText("unrelated")).toBeNull(); // doesn't match "demo"

    fireEvent.click(screen.getByText("demo other"));
    expect(useStore.getState().activeWs).toBe("ws2");
    expect(useStore.getState().command).toBeNull(); // closeCommand
  });

  it("query empty ⇒ no matches shown even if workspaces would technically contain the empty string", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const ws1 = makeWorkspace("ws1", { repoId: repoA.id, title: "anything" });
    useStore.setState({ repos: [repoA], workspaces: [ws1], command: { query: "", sel: 0 } });
    render(<WorkspaceCommand />);
    expect(screen.queryByText("Switch to")).toBeNull();
  });
});

// ── Jira search (connected) ─────────────────────────────────────────────────

describe("Jira search", () => {
  function connectJira(repo: Repo) {
    useStore.setState({
      repoConfigs: {
        [repo.root]: makeRepoConfig(repo.root, {
          integrations: { jiraConnectionId: "conn1", jiraProjectKey: "PROJ", jiraInProgress: "In Progress", jiraDone: "Done" },
        }),
      },
      connections: { jira: [{ id: "conn1", site: "https://acme.atlassian.net", email: "me@acme.com" }], ai: [] },
    });
  }

  it("loads 'my sprint' on empty query (0ms debounce), hides the jira create-source, and opens the scope form on click", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA] });
    connectJira(repoA);
    tauri.invoke({
      jira_search: (args) =>
        args.query === ""
          ? [{ key: "PROJ-9", summary: "Sprint issue", issue_type: "Bug", status: "To Do", assignee: null, component: null, fix_version: null, sprint: null }]
          : [],
    });
    render(<WorkspaceCommand />);

    // jiraConnected removes the "create from Jira" quick-create source
    expect(screen.queryByText("a Jira issue")).toBeNull();
    // before the debounce fires, the empty-state message shows (query is falsy)
    expect(screen.getByText("Type an issue key or keywords to find your Jira issues.")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("Jira · my sprint")).toBeTruthy());
    expect(screen.getByText("PROJ-9")).toBeTruthy();
    expect(screen.getByText("Sprint issue")).toBeTruthy();
    expect(screen.getByText("To Do")).toBeTruthy();

    fireEvent.click(screen.getByText("Sprint issue"));
    expect(screen.getByText("New workspace")).toBeTruthy();
    expect(document.body.textContent).toContain("PROJ-9");

    fireEvent.click(screen.getByText("Back"));
    expect(screen.queryByText("New workspace")).toBeNull();
    expect(screen.getByText("Jira · my sprint")).toBeTruthy(); // list view restored
  });

  it("shows the 'no matching issues' empty state for a non-empty query with zero results", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "", sel: 0 } });
    connectJira(repoA);
    tauri.invoke({ jira_search: () => [] });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch, search Jira, or describe / name a workspace…");
    fireEvent.change(input, { target: { value: "ZZZ-404" } });
    await waitFor(() => expect(screen.getByText("No matching issues — try an issue key like PROJ-123.")).toBeTruthy());
  });

  it("debounces + cancels the stale request: only the final keystroke's query reaches the backend", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "", sel: 0 } });
    connectJira(repoA);
    tauri.invoke({
      jira_search: (args) =>
        args.query === "ab" ? [{ key: "PROJ-2", summary: "Final", issue_type: "Task", status: "Open", assignee: null, component: null, fix_version: null, sprint: null }] : [],
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch, search Jira, or describe / name a workspace…");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } }); // supersedes "a" before its 280ms fires

    await waitFor(() => expect(screen.getByText("PROJ-2")).toBeTruthy());
    const searches = tauri.calls().filter((c) => c.cmd === "jira_search");
    expect(searches.length).toBe(1);
    expect(searches[0].args.query).toBe("ab");
  });

  it("cancels the pending debounce on unmount (no stale backend call fires after teardown)", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "typed", sel: 0 } });
    connectJira(repoA);
    tauri.invoke({ jira_search: () => [{ key: "PROJ-3", summary: "x", issue_type: "Task", status: "Open", assignee: null, component: null, fix_version: null, sprint: null }] });
    const { unmount } = render(<WorkspaceCommand />);
    unmount();
    await sleep(320);
    expect(tauri.calls().filter((c) => c.cmd === "jira_search").length).toBe(0);
  });

  it("noContext (2+ repos, no active/target) dims jira rows and clicking them is a no-op", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const repoB = makeRepo("/repos/b", { name: "Beta" });
    useStore.setState({ repos: [repoA, repoB], command: { query: "", sel: 0 } });
    connectJira(repoA); // repo resolves to repos[0] = repoA even under noContext
    tauri.invoke({ jira_search: () => [{ key: "PROJ-5", summary: "Dim row", issue_type: "Task", status: "Open", assignee: null, component: null, fix_version: null, sprint: null }] });
    render(<WorkspaceCommand />);
    await waitFor(() => expect(screen.getByText("Dim row")).toBeTruthy());
    fireEvent.click(screen.getByText("Dim row"));
    expect(screen.queryByText("New workspace")).toBeNull();
  });
});

// ── openForm variants ────────────────────────────────────────────────────────

describe("openForm", () => {
  // Clicking a source row goes through quickCreate (which handles "clone" itself
  // without ever opening the form) — only Tab explicitly routes to openForm for
  // every source kind. Use Tab, with sel pinned at the clone item (index 2: no
  // matches, jira disconnected → items = [jira, branch, clone]).
  it("clone: seeds title/branch from the active workspace when present, and from the repo name when absent", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const active = makeWorkspace("wsActive", { repoId: repoA.id, title: "My WS", branch: "feat/foo" });
    useStore.setState({ repos: [repoA], workspaces: [active], activeWs: active.id, command: { query: "", sel: 2 } });
    render(<WorkspaceCommand />);
    fireEvent.keyDown(screen.getByPlaceholderText("Switch workspace, or describe / name one to create…"), { key: "Tab" });
    expect(screen.getByDisplayValue("feat-foo-copy")).toBeTruthy();
    cleanup();

    useStore.setState({ repos: [repoA], workspaces: [], activeWs: null, command: { query: "", sel: 2 } });
    render(<WorkspaceCommand />);
    fireEvent.keyDown(screen.getByPlaceholderText("Switch workspace, or describe / name one to create…"), { key: "Tab" });
    expect(screen.getByDisplayValue("work-copy")).toBeTruthy(); // no active ws → slugify("work")
  });

  it("branch source with an empty query falls through quickCreate into openForm's else-branch (blank initial)", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "   ", sel: 0 } });
    render(<WorkspaceCommand />);
    fireEvent.click(screen.getByText("a new branch off base"));
    expect(screen.getByDisplayValue("")).toBeTruthy(); // initial.branch === query.trim() === ""
    expect(useStore.getState().workspaces.length).toBe(0); // never hit runCreate
  });
});

// ── AI-generated title + branch, triggered by ⌘Enter / Ctrl+Enter on the input ──

describe("AI create shortcut (⌘Enter / Ctrl+Enter)", () => {
  it("the 'a plain-language description' row no longer exists in the palette", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "fix the login bug", sel: 0 } });
    render(<WorkspaceCommand />);
    expect(screen.queryByText("a plain-language description")).toBeNull();
    // the other 3 sources are unaffected
    expect(screen.getByText("a Jira issue")).toBeTruthy();
    expect(screen.getByText("a new branch off base")).toBeTruthy();
    expect(screen.getByText("a clone of this workspace")).toBeTruthy();
  });

  it("the footer advertises the shortcut", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "", sel: 0 } });
    render(<WorkspaceCommand />);
    expect(screen.getByText("create with AI")).toBeTruthy();
  });

  it("⌘Enter with text in the input fires both AI calls with the right params (title via claudeText, branch via resolveBranchName's AI+validator path), regardless of which item is selected", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const ws1 = makeWorkspace("ws1", { repoId: repoA.id, title: "unrelated match" });
    // sel defaults to 0, which resolves to a workspace match, not a source —
    // the shortcut must fire independently of what's selected in the list.
    useStore.setState({ repos: [repoA], workspaces: [ws1], apiKeyPresent: true, command: { query: "fix the login redirect bug", sel: 0 } });
    tauri.invoke({
      claude_text: (args) =>
        String(args.system).includes("workspace title")
          ? "Fix login redirect"
          : JSON.stringify({ name: "fix/login-redirect", reasoning: "matches the description" }),
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    await waitFor(() => expect(screen.getByText("New workspace")).toBeTruthy());

    const claudeCalls = tauri.calls().filter((c) => c.cmd === "claude_text");
    expect(claudeCalls.length).toBe(2); // one for the title, one for the branch
    expect(claudeCalls.some((c) => String(c.args.system).includes("workspace title") && c.args.prompt === "fix the login redirect bug")).toBe(true);
    expect(claudeCalls.some((c) => String(c.args.prompt).includes("Issue title: fix the login redirect bug"))).toBe(true);
    // criterion: the generated branch went through the repo's validator (not a
    // client-side slugify) — resolveBranchName's "ai" path calls validate_branch_name.
    expect(tauri.calls().some((c) => c.cmd === "validate_branch_name" && c.args.name === "fix/login-redirect")).toBe(true);
    // no workspace was switched/created — this opened the pre-filled form, nothing else.
    expect(useStore.getState().workspaces.length).toBe(1);
  });

  it("Ctrl+Enter triggers the same AI-create flow as ⌘Enter", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "add dark mode", sel: 0 } });
    tauri.invoke({
      claude_text: (args) =>
        String(args.system).includes("workspace title") ? "Add dark mode" : JSON.stringify({ name: "feat/dark-mode", reasoning: "r" }),
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("New workspace")).toBeTruthy());
    expect(tauri.calls().filter((c) => c.cmd === "claude_text").length).toBe(2);
  });

  // Criterion 1: the AI-generated title (from openDescribeForm's claudeText call)
  // must be shown AND editable in the scope form — a dedicated "Title" field for
  // source "describe" (WorkspaceScopeForm.tsx), distinct from the read-only Jira
  // summary block (which stays issueKey-gated for issue-backed sources).
  it("shows the AI-generated title in an editable field", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "fix the login redirect bug", sel: 0 } });
    tauri.invoke({
      claude_text: (args) =>
        String(args.system).includes("workspace title") ? "Fix login redirect" : JSON.stringify({ name: "fix/login-redirect", reasoning: "r" }),
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.getByText("New workspace")).toBeTruthy());

    const titleInput = screen.getByDisplayValue("Fix login redirect");
    expect(titleInput).toBeTruthy();
    fireEvent.change(titleInput, { target: { value: "Fix the login redirect, edited" } });
    expect(screen.getByDisplayValue("Fix the login redirect, edited")).toBeTruthy();
  });

  // Criterion 2: the branch shown must be the AI+validator result openDescribeForm
  // already computed — the form must NOT re-resolve it via the repo's *configured*
  // branchNaming (default: manual "{key}/{slug}"), which would collapse to a bare
  // slug since the describe NameIssue has no `key`.
  it("keeps the AI-generated, validator-checked branch untouched on mount (does not re-resolve via the repo's configured branchNaming)", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "fix the login redirect bug", sel: 0 } });
    tauri.invoke({
      claude_text: (args) =>
        String(args.system).includes("workspace title") ? "Fix login redirect" : JSON.stringify({ name: "fix/login-redirect", reasoning: "r" }),
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.getByText("New workspace")).toBeTruthy());

    expect(screen.getByDisplayValue("fix/login-redirect")).toBeTruthy();
    expect(screen.queryByDisplayValue("fix-login-redirect")).toBeNull();
  });

  it("shows a loading indicator while the AI calls are in flight, and it clears afterward", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "add dark mode", sel: 0 } });
    // Two concurrent claude_text calls are made (title + branch) — queue a
    // resolver per call so each can be released independently.
    const resolvers: Array<(v: string) => void> = [];
    tauri.invoke({
      claude_text: (args) =>
        new Promise<string>((res) => {
          resolvers.push((v) => res(v));
          void args; // both calls share this handler; distinguished by push order
        }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    // still on the palette (form not open yet) with the busy copy visible near
    // the error/status area at the bottom of the list.
    await waitFor(() => expect(screen.getByText("Asking Claude for a title and branch name…")).toBeTruthy());
    expect(screen.queryByText("New workspace")).toBeNull();

    await waitFor(() => expect(resolvers.length).toBe(2));
    resolvers[0](JSON.stringify({ name: "feat/dark-mode", reasoning: "ok" }));
    resolvers[1]("Add dark mode");
    tauri.invoke({ validate_branch_name: () => ({ ok: true, message: null, enforced: true }) });

    await waitFor(() => expect(screen.queryByText("Asking Claude for a title and branch name…")).toBeNull());
  });

  it("on error: shows an error message, does not open the form (no key-entry routing), and creates nothing", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "add dark mode", sel: 0 } });
    tauri.invoke({
      claude_text: () => {
        throw new Error("backend exploded");
      },
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    // claudeText's catch (src/ai/suggest.ts:52-54) wraps the original Error in a
    // new Error(String(e), { cause: e }) — one "Error: " prefix baked into the
    // message. openDescribeForm's catch (WorkspaceCommand.tsx) must read
    // e.message (not String(e) again), so the user sees a single prefix, not two.
    await waitFor(() => expect(screen.getByText("Error: backend exploded")).toBeTruthy());
    expect(screen.queryByText("New workspace")).toBeNull(); // stayed on the palette
    expect(useStore.getState().workspaces.length).toBe(0); // nothing created
    expect(tauri.calls().some((c) => c.cmd === "worktree_add")).toBe(false);
  });

  it("on NoKeyError specifically (no API key configured): surfaces the friendly add-a-key message rather than a silent no-op", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    // apiKeyPresent left false — the shortcut must still attempt the AI call
    // (no client-side gate) and let the real NoKeyError surface the message.
    useStore.setState({ repos: [repoA], command: { query: "add dark mode", sel: 0 } });
    tauri.invoke({
      claude_text: () => {
        throw new Error("no-key");
      },
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.getByText("Add an Anthropic API key to use AI workspace creation.")).toBeTruthy());
    expect(screen.queryByText("New workspace")).toBeNull();
  });

  it("when the branch validator can't be satisfied (empty branchResult.name): surfaces the explanation and never opens the form", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "add dark mode", sel: 0 } });
    tauri.invoke({
      // detect_branch_validator triggers the retry-chain in resolveBranchName's
      // "ai" source; validate_branch_name always fails, so after AI_RETRY_LIMIT
      // attempts branchResult.name is a non-empty but *invalid* name — to hit the
      // `!branchResult.name` branch we instead simulate the no-key path, which is
      // the actual real-world way resolveBranchName returns an empty name.
      claude_text: () => {
        throw new Error("no-key");
      },
      detect_branch_validator: () => ({ regex: "^feat/.+$", source: "package.json" }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.getByText("Add an Anthropic API key to use AI workspace creation.")).toBeTruthy());
    expect(screen.queryByText("New workspace")).toBeNull();
    expect(useStore.getState().workspaces.length).toBe(0);
  });

  it("does nothing when the query is blank (no AI calls, no form) — clean no-op", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], apiKeyPresent: true, command: { query: "   ", sel: 0 } });
    tauri.invoke({ claude_text: () => "should not be called" });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
    expect(screen.queryByText("New workspace")).toBeNull();
  });

  it("under noContext (2+ repos, no active/target): ⌘Enter is a no-op", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const repoB = makeRepo("/repos/b", { name: "Beta" });
    useStore.setState({ repos: [repoA, repoB], apiKeyPresent: true, command: { query: "add dark mode", sel: 0 } });
    tauri.invoke({ claude_text: () => "should not be called" });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
    expect(screen.queryByText("New workspace")).toBeNull();
  });
});

// ── quickCreate success/failure ──────────────────────────────────────────────

describe("quickCreate", () => {
  it("branch source: creates the workspace and closes the palette on backend success", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "new-feature", sel: 0 } });
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
      worktree_add: () => ({ path: "/x/new-feature", branch: "new-feature" }),
    });
    render(<WorkspaceCommand />);
    fireEvent.click(screen.getByText("a new branch off base"));
    // quickCreate is async (awaits runCreate) — the store update lands a few microtasks later.
    await waitFor(() => expect(useStore.getState().workspaces.length).toBe(1));
    const ws = useStore.getState().workspaces;
    expect(ws[0].branch).toBe("new-feature");
    expect(useStore.getState().command).toBeNull();
    expect(tauri.lastCall("worktree_add")?.args.branch).toBe("new-feature");
  });

  it("branch source: a locally-invalid name never reaches the backend and surfaces createError", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "bad name", sel: 0 } }); // contains a space
    render(<WorkspaceCommand />);
    fireEvent.click(screen.getByText("a new branch off base"));
    await waitFor(() => expect(screen.getByText("Branch name has invalid characters.")).toBeTruthy());
    expect(useStore.getState().workspaces.length).toBe(0);
    expect(useStore.getState().command).not.toBeNull(); // palette stays open
    expect(tauri.calls().some((c) => c.cmd === "worktree_add")).toBe(false);
  });

  it("clone source: activated via Enter with an out-of-range sel (clamped to the last item)", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha", defaultBranch: "main" });
    const active = makeWorkspace("wsActive", { repoId: repoA.id, title: "Active one", branch: "feat/foo" });
    // sel is intentionally way past the item count — activateAt must use the clamped index
    useStore.setState({ repos: [repoA], workspaces: [active], activeWs: active.id, command: { query: "", sel: 999 } });
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
      worktree_add: () => ({ path: "/x", branch: "feat-foo-copy" }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "Enter" }); // clamped(999) → last source item → "clone"
    await waitFor(() => expect(useStore.getState().workspaces.length).toBe(2));
    const ws = useStore.getState().workspaces;
    expect(ws[1].branch).toBe("feat-foo-copy");
    expect(ws[1].title).toBe("Active one (copy)");
    expect(useStore.getState().command).toBeNull();
  });

  it("clone source: humanizes a backend worktree failure into createError without creating a workspace", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const active = makeWorkspace("wsActive", { repoId: repoA.id, title: "Active one", branch: "feat/foo" });
    useStore.setState({ repos: [repoA], workspaces: [active], activeWs: active.id, command: { query: "", sel: 0 } });
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
      worktree_add: () => {
        throw new Error("already used by worktree /other");
      },
    });
    render(<WorkspaceCommand />);
    fireEvent.click(screen.getByText("a clone of this workspace"));
    await waitFor(() => expect(screen.getByText(/already exists — pick a different branch name\./)).toBeTruthy());
    expect(useStore.getState().workspaces.length).toBe(1); // unchanged
  });
});

// ── keyboard nav: Tab branches per item kind ────────────────────────────────

describe("keyboard Tab per item kind", () => {
  it("Tab on a workspace match is a no-op; Tab on a jira result opens the scope form", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const ws1 = makeWorkspace("ws1", { repoId: repoA.id, title: "match-me" });
    useStore.setState({ repos: [repoA], workspaces: [ws1], command: { query: "match", sel: 0 } });
    useStore.setState({
      repoConfigs: {
        [repoA.root]: makeRepoConfig(repoA.root, {
          integrations: { jiraConnectionId: "conn1", jiraProjectKey: "PROJ", jiraInProgress: "In Progress", jiraDone: "Done" },
        }),
      },
      connections: { jira: [{ id: "conn1", site: "https://acme.atlassian.net", email: "me@acme.com" }], ai: [] },
    });
    tauri.invoke({ jira_search: () => [{ key: "PROJ-7", summary: "Tabbed issue", issue_type: "Task", status: "Open", assignee: null, component: null, fix_version: null, sprint: null }] });
    const { rerender } = render(<WorkspaceCommand />);
    await waitFor(() => expect(screen.getByText("Tabbed issue")).toBeTruthy());

    const input = screen.getByPlaceholderText("Switch, search Jira, or describe / name a workspace…");
    // sel=0 → clamped item is the workspace match ("match-me") — Tab does nothing
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByText("New workspace")).toBeNull();

    // move sel to the jira result (index 1: matches[0] then jiraIssues[0])
    useStore.setState({ command: { ...useStore.getState().command!, sel: 1 } });
    rerender(<WorkspaceCommand />);
    fireEvent.keyDown(screen.getByPlaceholderText("Switch, search Jira, or describe / name a workspace…"), { key: "Tab" });
    expect(screen.getByText("New workspace")).toBeTruthy();
    expect(document.body.textContent).toContain("PROJ-7");
  });
});

// ── ⌘↑ / ⌘↓ target-repo cycling (keyboard-shortcuts-2) ──────────────────────

describe("⌘↑ / ⌘↓ target-repo cycling", () => {
  it("no-ops (no setCommandRepo call) when there's only one repo", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    useStore.setState({ repos: [repoA], command: { query: "", sel: 1 } });
    render(<WorkspaceCommand />);
    expect(screen.queryByText("⌘↑↓")).toBeNull(); // hint footer gated repos.length>1
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "ArrowDown", metaKey: true });
    expect(useStore.getState().command?.repoId).toBeUndefined();
  });

  it("⌘↓ cycles forward with wraparound; ⌘↑ cycles backward with wraparound", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const repoB = makeRepo("/repos/b", { name: "Beta" });
    const repoC = makeRepo("/repos/c", { name: "Gamma" });
    useStore.setState({ repos: [repoA, repoB, repoC], command: { query: "", sel: 0 } });
    render(<WorkspaceCommand />);
    expect(screen.getByText("⌘↑↓")).toBeTruthy();
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");

    // base is repos[0] (Alpha — no active ws, no explicit pin) → ⌘↓ → Beta
    fireEvent.keyDown(input, { key: "ArrowDown", metaKey: true });
    expect(useStore.getState().command?.repoId).toBe(repoB.id);

    fireEvent.keyDown(input, { key: "ArrowDown", metaKey: true });
    expect(useStore.getState().command?.repoId).toBe(repoC.id);

    // from the last repo, ⌘↓ wraps to the first
    fireEvent.keyDown(input, { key: "ArrowDown", metaKey: true });
    expect(useStore.getState().command?.repoId).toBe(repoA.id);

    // from the first repo, ⌘↑ wraps to the last
    fireEvent.keyDown(input, { key: "ArrowUp", metaKey: true });
    expect(useStore.getState().command?.repoId).toBe(repoC.id);
  });

  it("⌘↓ does not fall through to moveCommand — list selection (sel) stays put", () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const repoB = makeRepo("/repos/b", { name: "Beta" });
    useStore.setState({ repos: [repoA, repoB], command: { query: "", sel: 2 } });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");
    fireEvent.keyDown(input, { key: "ArrowDown", metaKey: true });
    expect(useStore.getState().command?.sel).toBe(2); // unchanged — moveCommand did NOT run
    expect(useStore.getState().command?.repoId).toBe(repoB.id); // setCommandRepo DID run
  });

  it("↵ after picking a repo via ⌘↓ creates the new workspace under that repo", async () => {
    const repoA = makeRepo("/repos/a", { name: "Alpha" });
    const repoB = makeRepo("/repos/b", { name: "Beta" });
    useStore.setState({ repos: [repoA, repoB], command: { query: "", sel: 0 } });
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: true }),
      worktree_add: () => ({ path: "/tmp/beta-ws", branch: "my-feature" }),
    });
    render(<WorkspaceCommand />);
    const input = screen.getByPlaceholderText("Switch workspace, or describe / name one to create…");

    fireEvent.keyDown(input, { key: "ArrowDown", metaKey: true }); // target -> Beta
    expect(useStore.getState().command?.repoId).toBe(repoB.id);

    // setCommandQuery resets sel to 0 (jira row, disabled — not connected) but
    // preserves the pinned repoId (setCommandQuery only touches query/sel).
    fireEvent.change(input, { target: { value: "my-feature" } });
    expect(useStore.getState().command?.repoId).toBe(repoB.id);

    fireEvent.keyDown(input, { key: "ArrowDown" }); // plain arrow: sel 0(jira) -> 1(branch)
    fireEvent.keyDown(input, { key: "Enter" }); // quickCreate("branch") under the targeted repo

    await waitFor(() => expect(useStore.getState().workspaces.length).toBe(1));
    expect(useStore.getState().workspaces[0].repoId).toBe(repoB.id);
  });
});
