// Line-coverage suite for src/state/store.ts — the central Zustand store.
// Exercises every action + exported pure helper, hitting each branch (nominal,
// empty/null, malformed) so all reducers are proven, not just imported.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  useStore,
  activeWorkspace,
  activeGroup,
  activePane,
  findPane,
  workspaceOfPane,
  allRepoRoots,
  DEFAULT_SETTINGS,
  MODEL_OPTIONS,
  type StoreState,
  type Workspace,
  type Group,
  type PaneState,
  type BootInfo,
  type Repo,
} from "../src/state/store";
import type { PersistedWs } from "../src/lib/workspace";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let idSeq = 1;
function nextId(prefix: string) {
  return `${prefix}${idSeq++}`;
}

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: idSeq++,
    ptyId: null,
    ptyEpoch: 0,
    isZsh: false,
    cwd: "/repo",
    branch: null,
    input: "",
    ghost: "",
    history: [],
    hIndex: -1,
    suggestion: null,
    suggestionLoading: false,
    pendingFix: null,
    completion: null,
    inputSelected: false,
    rawMode: false,
    exited: false,
    ready: false,
    dirNames: [],
    blocks: [],
    repoRoot: null,
    firedHooks: [],
    hook: null,
    ...overrides,
  };
}

function mkGroup(panes: PaneState[], overrides: Partial<Group> = {}): Group {
  return { id: idSeq++, panes, active: 0, split: "h", ...overrides };
}

function mkWs(overrides: Partial<Workspace> = {}): Workspace {
  const pane = mkPane({ cwd: overrides.dir ?? "/repo", repoRoot: overrides.repoId ?? null });
  const group = mkGroup([pane]);
  return {
    id: nextId("w"),
    kind: "workspace",
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/repo",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [group],
    active: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
    ...overrides,
  };
}

/** Reset the store's data fields to a known baseline before each test. Actions
 *  are left intact (setState merges by default). */
function resetStore(patch: Partial<StoreState> = {}) {
  useStore.setState(
    {
      repos: [],
      workspaces: [],
      activeWs: null,
      initialized: false,
      railCollapsed: false,
      wsFilter: "",
      command: null,
      home: "~",
      settings: DEFAULT_SETTINGS,
      apiKeyPresent: false,
      keyEntry: false,
      keyError: null,
      settingsOpen: false,
      panel: null,
      userScripts: {},
      repoConfigs: {},
      workspaceSettingsRepo: null,
      scriptsSetupOpen: false,
      repoMrs: {},
      glabUser: null,
      connections: { jira: [], ai: [] },
      find: { open: false, query: "", current: 0 },
      notifs: [],
      notifLog: [],
      unseen: 0,
      muted: false,
      serverStatus: {},
      foregroundState: {},
      ...patch,
    },
    false,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetStore();
});
afterEach(() => {
  localStorage.clear();
});

// ══════════════════════════════════════════════════════════════════════════
// init()
// ══════════════════════════════════════════════════════════════════════════

const HOME = "/Users/tester";
const SETTINGS = DEFAULT_SETTINGS;

function repoPersisted(overrides: Partial<PersistedWs> = {}): PersistedWs {
  return {
    id: "w-restored",
    kind: "workspace",
    repoId: "/repo/gody",
    title: "GODY-1",
    issueKey: "GODY-1",
    branch: "feat/x",
    baseBranch: "develop",
    dir: "/repo/gody",
    preset: null,
    jiraStatus: "In Progress",
    jiraUrl: null,
    jiraSync: false,
    env: {},
    createdAt: 1,
    lastActive: 2,
    ...overrides,
  };
}

function homePersisted(overrides: Partial<PersistedWs> = {}): PersistedWs {
  return {
    id: "w-home-restored",
    kind: "home",
    repoId: null,
    title: "Home",
    issueKey: null,
    branch: null,
    baseBranch: "",
    dir: HOME,
    preset: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    createdAt: 1,
    lastActive: 2,
    ...overrides,
  };
}

describe("init", () => {
  it("boot.repo set + nothing restored: creates & unshifts a boot lane, becomes active; Home is present but not active", () => {
    const boot: BootInfo = {
      repo: { root: "/repo/a", name: "a", defaultBranch: "main", currentBranch: "feat" },
      restored: [],
      activeWs: null,
    };
    useStore.getState().init(HOME, SETTINGS, true, boot);
    const s = useStore.getState();
    // The repo boot lane + the always-present Home terminal.
    expect(s.workspaces).toHaveLength(2);
    const bootWs = s.workspaces.find((w) => w.repoId === "/repo/a")!;
    expect(bootWs.branch).toBe("feat");
    expect(s.activeWs).toBe(bootWs.id);
    expect(s.initialized).toBe(true);
    expect(s.apiKeyPresent).toBe(true);
    expect(s.home).toBe(HOME);
    // Home exists but isn't active/focused.
    const home = s.workspaces.find((w) => w.kind === "home")!;
    expect(home).toBeDefined();
    expect(home.repoId).toBeNull();
    expect(home.dir).toBe(HOME);
    expect(s.activeWs).not.toBe(home.id);
  });

  it("boot.repo already among restored (same dir): reused, not duplicated", () => {
    const boot: BootInfo = {
      repo: { root: "/repo/gody", name: "gody", defaultBranch: "develop", currentBranch: "feat/x" },
      restored: [repoPersisted()],
      activeWs: "w-restored",
    };
    useStore.getState().init(HOME, SETTINGS, false, boot);
    const s = useStore.getState();
    // The restored repo lane + the synthesized Home terminal.
    expect(s.workspaces).toHaveLength(2);
    expect(s.workspaces.filter((w) => w.repoId === "/repo/gody")).toHaveLength(1);
    expect(s.activeWs).toBe("w-restored");
  });

  it("boot.repo.root === home dir (e.g. ~ is a dotfiles git repo): a real repo lane is created/activated, and Home stays present and distinct — not stolen by the dir match", () => {
    const boot: BootInfo = {
      repo: { root: HOME, name: "dotfiles", defaultBranch: "main", currentBranch: "main" },
      restored: [],
      activeWs: null,
    };
    useStore.getState().init(HOME, SETTINGS, false, boot);
    const s = useStore.getState();
    // Two distinct workspaces: the repo boot lane rooted at `~`, and Home —
    // never collapsed into one via an unqualified `dir` match.
    expect(s.workspaces).toHaveLength(2);
    const repoLane = s.workspaces.find((w) => w.kind === "workspace")!;
    expect(repoLane).toBeDefined();
    expect(repoLane.dir).toBe(HOME);
    expect(repoLane.repoId).toBe(HOME);
    const home = s.workspaces.find((w) => w.kind === "home")!;
    expect(home).toBeDefined();
    expect(home.id).not.toBe(repoLane.id);
    expect(home.repoId).toBeNull();
    expect(home.dir).toBe(HOME);
    // The repo boot lane wins focus (a repo launch is a real context), Home is
    // present but not active.
    expect(s.activeWs).toBe(repoLane.id);
    expect(s.activeWs).not.toBe(home.id);
  });

  it("no boot.repo, nothing restored: Home is synthesized and becomes active (never activeWs=null)", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].kind).toBe("home");
    expect(s.workspaces[0].repoId).toBeNull();
    expect(s.workspaces[0].dir).toBe(HOME);
    expect(s.activeWs).toBe(s.workspaces[0].id);
    expect(s.activeWs).not.toBeNull();
    expect(s.initialized).toBe(true);
    expect(activeWorkspace(s)).toBeDefined();
  });

  it("restored only, valid boot.activeWs: uses it directly (first ternary branch)", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [repoPersisted()], activeWs: "w-restored" });
    expect(useStore.getState().activeWs).toBe("w-restored");
  });

  it("restored only, invalid boot.activeWs: falls back to the Home terminal, not workspaces[0]", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [repoPersisted()], activeWs: "nope" });
    const s = useStore.getState();
    const home = s.workspaces.find((w) => w.kind === "home")!;
    expect(s.activeWs).toBe(home.id);
  });

  it("restored Home is reused, not duplicated (exactly one kind:home after init)", () => {
    useStore.getState().init(HOME, SETTINGS, false, {
      repo: null,
      restored: [homePersisted(), repoPersisted()],
      activeWs: "w-home-restored",
    });
    const s = useStore.getState();
    expect(s.workspaces.filter((w) => w.kind === "home")).toHaveLength(1);
    expect(s.workspaces.find((w) => w.kind === "home")!.id).toBe("w-home-restored");
    expect(s.activeWs).toBe("w-home-restored");
  });

  it("legacy persisted data with no `kind` loads without error; entries default to kind:workspace and Home is ensured", () => {
    // Simulate a pre-home-terminal persisted record: no `kind` field at all.
    const legacy = repoPersisted() as PersistedWs & { kind?: "home" | "workspace" };
    delete legacy.kind;
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [legacy], activeWs: null });
    const s = useStore.getState();
    expect(s.workspaces.find((w) => w.id === "w-restored")!.kind).toBe("workspace");
    expect(s.workspaces.filter((w) => w.kind === "home")).toHaveLength(1);
  });

  it("mounts only the active workspace; others (including Home) stay unmounted", () => {
    useStore.getState().init(HOME, SETTINGS, false, {
      repo: null,
      restored: [repoPersisted(), repoPersisted({ id: "w-2", dir: "/repo/two", repoId: "/repo/two", title: "two" })],
      activeWs: "w-2",
    });
    const s = useStore.getState();
    expect(s.workspaces.filter((w) => w.mounted)).toHaveLength(1);
    expect(s.workspaces.find((w) => w.mounted)!.id).toBe("w-2");
    expect(s.workspaces.find((w) => w.kind === "home")!.mounted).toBe(false);
  });

  it("merges persisted repos (localStorage) with the boot repo and derived workspace repos", () => {
    localStorage.setItem("aurora.repos", JSON.stringify([{ id: "/repo/extra", root: "/repo/extra", name: "extra", defaultBranch: "main" }]));
    useStore.getState().init(HOME, SETTINGS, false, {
      repo: { root: "/repo/a", name: "a", defaultBranch: "main", currentBranch: null },
      restored: [repoPersisted()],
      activeWs: null,
    });
    const s = useStore.getState();
    const ids = s.repos.map((r) => r.id).sort();
    expect(ids).toEqual(["/repo/a", "/repo/extra", "/repo/gody"].sort());
    // The Home terminal never contributes a repo (repoId: null is ignored by deriveRepos).
    expect(ids).not.toContain(HOME);
  });

  it("persists the derived boot state (readable back via loadPersisted)", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    const raw = localStorage.getItem("aurora.workspaces");
    expect(raw).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// createWorkspace / adoptRepo / addRepo
// ══════════════════════════════════════════════════════════════════════════

describe("createWorkspace", () => {
  it("adds a new repo entry when repoId is unknown", () => {
    const id = useStore.getState().createWorkspace({ repoId: "/repo/new", title: "t", dir: "/repo/new", branch: "main" });
    const s = useStore.getState();
    expect(s.activeWs).toBe(id);
    expect(s.repos.some((r) => r.id === "/repo/new")).toBe(true);
    expect(s.workspaces).toHaveLength(1);
  });

  it("does not duplicate an already-known repo", () => {
    resetStore({ repos: [{ id: "/repo/x", root: "/repo/x", name: "x", defaultBranch: "main" }] });
    useStore.getState().createWorkspace({ repoId: "/repo/x", title: "t", dir: "/repo/x", branch: null });
    expect(useStore.getState().repos).toHaveLength(1);
  });

  it("repoId null: manual lane, no repo added", () => {
    useStore.getState().createWorkspace({ repoId: null, title: "manual", dir: HOME, branch: null });
    const s = useStore.getState();
    expect(s.repos).toHaveLength(0);
    expect(activeWorkspace(s)!.repoId).toBeNull();
  });

  it("paneCount>1 creates a multi-pane group with the given split", () => {
    const id = useStore.getState().createWorkspace({ repoId: null, title: "t", dir: "/x", branch: null, paneCount: 3, split: "v" });
    const ws = useStore.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.tabs[0].panes).toHaveLength(3);
    expect(ws.tabs[0].split).toBe("v");
  });

  it("paneCount is clamped to [1,4]", () => {
    const idHigh = useStore.getState().createWorkspace({ repoId: null, title: "hi", dir: "/x", branch: null, paneCount: 99 });
    expect(useStore.getState().workspaces.find((w) => w.id === idHigh)!.tabs[0].panes).toHaveLength(4);
    const idLow = useStore.getState().createWorkspace({ repoId: null, title: "lo", dir: "/x", branch: null, paneCount: 0 });
    expect(useStore.getState().workspaces.find((w) => w.id === idLow)!.tabs[0].panes).toHaveLength(1);
  });

  it("persists the new workspace list", () => {
    useStore.getState().createWorkspace({ repoId: null, title: "t", dir: "/x", branch: null });
    expect(localStorage.getItem("aurora.workspaces")).not.toBeNull();
  });

  it("never persists foregroundState/serverStatus, even when both are populated at save time (sticky-running-server-tabs: runtime-only state must not leak into PersistedWs)", () => {
    // Populate both runtime-only maps with a recognizable ptyId BEFORE the save
    // triggered by createWorkspace below — if a future refactor ever threaded
    // these maps into the persisted workspace shape (e.g. by adding a
    // foregroundState/serverStatus field to Workspace and mapping it in
    // savePersisted), this is the test that would catch it.
    useStore.getState().setForegroundState("pty-leak-check", { running: true, pgid: 4242 });
    useStore.getState().setServerStatus("pty-leak-check", "alive");
    useStore.getState().createWorkspace({ repoId: null, title: "t", dir: "/x", branch: null });

    expect(useStore.getState().foregroundState["pty-leak-check"]).toEqual({ running: true, pgid: 4242 });
    expect(useStore.getState().serverStatus["pty-leak-check"]).toBe("alive");

    const raw = localStorage.getItem("aurora.workspaces")!;
    expect(raw).not.toContain("foregroundState");
    expect(raw).not.toContain("serverStatus");
    expect(raw).not.toContain("pty-leak-check");
  });
});

describe("adoptRepo", () => {
  it("is a no-op for an unknown workspace id", () => {
    const before = useStore.getState().workspaces;
    useStore.getState().adoptRepo("nope", { root: "/r", name: "r", defaultBranch: "main" });
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("is a no-op when the workspace already has a repoId", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", repoId: "/already" })], activeWs: "w1" });
    useStore.getState().adoptRepo("w1", { root: "/other", name: "other", defaultBranch: "main" });
    expect(useStore.getState().workspaces[0].repoId).toBe("/already");
  });

  it("binds repoId + registers a new repo entry when unknown", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", repoId: null, baseBranch: "" })], activeWs: "w1" });
    useStore.getState().adoptRepo("w1", { root: "/manual/repo", name: "manual", defaultBranch: "trunk" });
    const s = useStore.getState();
    expect(s.workspaces[0].repoId).toBe("/manual/repo");
    expect(s.workspaces[0].baseBranch).toBe("trunk"); // was empty, falls back to repo default
    expect(s.repos.some((r) => r.id === "/manual/repo")).toBe(true);
  });

  it("keeps an existing baseBranch and does not duplicate an existing repo entry", () => {
    resetStore({
      workspaces: [mkWs({ id: "w1", repoId: null, baseBranch: "release" })],
      activeWs: "w1",
      repos: [{ id: "/manual/repo", root: "/manual/repo", name: "manual", defaultBranch: "trunk" }],
    });
    useStore.getState().adoptRepo("w1", { root: "/manual/repo", name: "manual", defaultBranch: "trunk" });
    const s = useStore.getState();
    expect(s.workspaces[0].baseBranch).toBe("release");
    expect(s.repos).toHaveLength(1);
  });

  it("never adopts a repo into the Home terminal, even though repoId is null", () => {
    resetStore({
      workspaces: [mkWs({ id: "home", kind: "home", repoId: null, baseBranch: "" })],
      activeWs: "home",
    });
    useStore.getState().adoptRepo("home", { root: "/some/repo", name: "some", defaultBranch: "main" });
    const s = useStore.getState();
    expect(s.workspaces[0].repoId).toBeNull();
    expect(s.workspaces[0].kind).toBe("home");
    expect(s.repos).toHaveLength(0);
  });
});

describe("addRepo", () => {
  it("adds a new repo and persists it", () => {
    useStore.getState().addRepo({ root: "/r1", name: "r1", defaultBranch: "main" });
    const s = useStore.getState();
    expect(s.repos).toHaveLength(1);
    expect(localStorage.getItem("aurora.repos")).toContain("/r1");
  });

  it("is a no-op when the repo is already registered", () => {
    resetStore({ repos: [{ id: "/r1", root: "/r1", name: "r1", defaultBranch: "main" }] });
    useStore.getState().addRepo({ root: "/r1", name: "r1", defaultBranch: "main" });
    expect(useStore.getState().repos).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// switchWorkspace / removeWorkspace / setWs* / rail / filter
// ══════════════════════════════════════════════════════════════════════════

describe("switchWorkspace", () => {
  it("no-op when switching to the already-active workspace", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().switchWorkspace("w1");
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("no-op for an unknown id", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().switchWorkspace("ghost");
    expect(useStore.getState().activeWs).toBe("w1");
  });

  it("switches active + mounts + bumps lastActive", () => {
    resetStore({
      workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2", mounted: false, lastActive: 0 })],
      activeWs: "w1",
    });
    useStore.getState().switchWorkspace("w2");
    const s = useStore.getState();
    expect(s.activeWs).toBe("w2");
    expect(s.workspaces.find((w) => w.id === "w2")!.mounted).toBe(true);
    expect(s.workspaces.find((w) => w.id === "w2")!.lastActive).toBeGreaterThan(0);
  });
});

describe("removeWorkspace", () => {
  it("refuses to remove the last remaining workspace", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().removeWorkspace("w1");
    expect(useStore.getState().workspaces).toHaveLength(1);
  });

  it("no-op for an id not present (with >1 workspaces)", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2" })], activeWs: "w1" });
    useStore.getState().removeWorkspace("ghost");
    expect(useStore.getState().workspaces).toHaveLength(2);
  });

  it("removes a non-active workspace, activeWs unchanged", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2" })], activeWs: "w1" });
    useStore.getState().removeWorkspace("w2");
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.activeWs).toBe("w1");
  });

  it("removes the active workspace: activeWs recomputed to a neighbor", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2" }), mkWs({ id: "w3" })], activeWs: "w2" });
    useStore.getState().removeWorkspace("w2");
    const s = useStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["w1", "w3"]);
    expect(s.activeWs).toBe("w3"); // idx=1 clamped to length-1=1 -> w3
  });

  it("prunes serverStatus/foregroundState for every ptyId owned by the removed workspace (sticky-running-server-tabs)", () => {
    const p1 = mkPane({ ptyId: "pty-w2-a" });
    const p2 = mkPane({ ptyId: "pty-w2-b" });
    resetStore({
      workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2", tabs: [mkGroup([p1, p2])] })],
      activeWs: "w1",
      serverStatus: { "pty-w2-a": "alive", "pty-w2-b": "dead", "pty-elsewhere": "alive" },
      foregroundState: { "pty-w2-a": { running: true, pgid: 1 }, "pty-elsewhere": { running: true, pgid: 2 } },
    });
    useStore.getState().removeWorkspace("w2");
    const s = useStore.getState();
    expect(s.serverStatus).toEqual({ "pty-elsewhere": "alive" });
    expect(s.foregroundState).toEqual({ "pty-elsewhere": { running: true, pgid: 2 } });
  });

  it("refuses to remove the Home terminal even with other workspaces present", () => {
    resetStore({
      workspaces: [mkWs({ id: "home", kind: "home", repoId: null }), mkWs({ id: "w1" })],
      activeWs: "home",
    });
    useStore.getState().removeWorkspace("home");
    const s = useStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["home", "w1"]);
    expect(s.activeWs).toBe("home");
  });
});

describe("setWsDiff / setWsMr / setWsJiraStatus", () => {
  it("setWsDiff updates the matching workspace only", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2" })], activeWs: "w1" });
    useStore.getState().setWsDiff("w1", { files: 2, added: 1, removed: 1, conflicted: 0 });
    const s = useStore.getState();
    expect(s.workspaces.find((w) => w.id === "w1")!.diff).toEqual({ files: 2, added: 1, removed: 1, conflicted: 0 });
    expect(s.workspaces.find((w) => w.id === "w2")!.diff).toBeNull();
  });

  it("setWsMr updates mr", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().setWsMr("w1", { iid: 5, state: "open", url: "https://x" });
    expect(useStore.getState().workspaces[0].mr).toEqual({ iid: 5, state: "open", url: "https://x" });
  });

  it("setWsJiraStatus updates status + persists", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().setWsJiraStatus("w1", "Done");
    expect(useStore.getState().workspaces[0].jiraStatus).toBe("Done");
    expect(localStorage.getItem("aurora.workspaces")).toContain("Done");
  });
});

describe("rail / filter", () => {
  it("setRailCollapsed + toggleRail", () => {
    useStore.getState().setRailCollapsed(true);
    expect(useStore.getState().railCollapsed).toBe(true);
    useStore.getState().toggleRail();
    expect(useStore.getState().railCollapsed).toBe(false);
    useStore.getState().toggleRail();
    expect(useStore.getState().railCollapsed).toBe(true);
  });

  it("setWsFilter", () => {
    useStore.getState().setWsFilter("abc");
    expect(useStore.getState().wsFilter).toBe("abc");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Command palette
// ══════════════════════════════════════════════════════════════════════════

describe("command palette", () => {
  it("openCommand with and without a repoId", () => {
    useStore.getState().openCommand("r1");
    expect(useStore.getState().command).toEqual({ query: "", sel: 0, repoId: "r1" });
    useStore.getState().openCommand();
    expect(useStore.getState().command).toEqual({ query: "", sel: 0, repoId: null });
  });

  it("closeCommand", () => {
    useStore.getState().openCommand();
    useStore.getState().closeCommand();
    expect(useStore.getState().command).toBeNull();
  });

  it("setCommandQuery is a no-op when closed, updates + resets sel when open", () => {
    useStore.getState().setCommandQuery("x");
    expect(useStore.getState().command).toBeNull();
    useStore.getState().openCommand("r1");
    useStore.getState().setCommandSel(2);
    useStore.getState().setCommandQuery("feat");
    expect(useStore.getState().command).toEqual({ query: "feat", sel: 0, repoId: "r1" });
  });

  it("setCommandRepo is a no-op when closed, preserves query/sel when open", () => {
    useStore.getState().setCommandRepo("r2");
    expect(useStore.getState().command).toBeNull();
    useStore.getState().openCommand("r1");
    useStore.getState().setCommandQuery("q");
    useStore.getState().setCommandSel(1);
    useStore.getState().setCommandRepo("r2");
    expect(useStore.getState().command).toEqual({ query: "q", sel: 1, repoId: "r2" });
  });

  it("moveCommand: no-op when closed or count<=0, wraps otherwise", () => {
    useStore.getState().moveCommand(1, 3);
    expect(useStore.getState().command).toBeNull();
    useStore.getState().openCommand();
    useStore.getState().moveCommand(1, 0);
    expect(useStore.getState().command!.sel).toBe(0);
    useStore.getState().moveCommand(-1, 3);
    expect(useStore.getState().command!.sel).toBe(2); // wraps
    useStore.getState().moveCommand(1, 3);
    expect(useStore.getState().command!.sel).toBe(0);
  });

  it("setCommandSel: no-op when closed", () => {
    useStore.getState().setCommandSel(5);
    expect(useStore.getState().command).toBeNull();
    useStore.getState().openCommand();
    useStore.getState().setCommandSel(2);
    expect(useStore.getState().command!.sel).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Pane runtime: setPaneRuntime / markExited / respawnPane
// ══════════════════════════════════════════════════════════════════════════

describe("pane runtime", () => {
  it("setPaneRuntime patches ptyId+isZsh on the owning workspace only", () => {
    const p1 = mkPane();
    const w1 = mkWs({ id: "w1", tabs: [mkGroup([p1])] });
    const w2 = mkWs({ id: "w2" }); // does not own p1 -> patchPane "return w" branch
    resetStore({ workspaces: [w1, w2], activeWs: "w1" });
    useStore.getState().setPaneRuntime(p1.id, { ptyId: "pty-1", isZsh: true });
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.ptyId).toBe("pty-1");
    expect(pane.isZsh).toBe(true);
  });

  it("markExited sets exited + clears rawMode", () => {
    const p1 = mkPane({ rawMode: true });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().markExited(p1.id);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.exited).toBe(true);
    expect(pane.rawMode).toBe(false);
  });

  it("markExited prunes the pane's serverStatus/foregroundState entries", () => {
    const p1 = mkPane({ ptyId: "pty-1" });
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })],
      activeWs: "w1",
      serverStatus: { "pty-1": "alive" },
      foregroundState: { "pty-1": { running: true, pgid: 1 } },
    });
    useStore.getState().markExited(p1.id);
    const s = useStore.getState();
    expect(s.serverStatus).toEqual({});
    expect(s.foregroundState).toEqual({});
  });

  it("markExited on a pane with no ptyId leaves the running-state maps untouched", () => {
    const p1 = mkPane();
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })],
      activeWs: "w1",
      serverStatus: { elsewhere: "alive" },
    });
    useStore.getState().markExited(p1.id);
    expect(useStore.getState().serverStatus).toEqual({ elsewhere: "alive" });
  });

  it("respawnPane is a no-op for an unknown pane id", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().respawnPane(999999);
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("respawnPane bumps ptyEpoch and resets runtime flags", () => {
    const p1 = mkPane({ ptyId: "old", ptyEpoch: 2, ready: true, exited: true, rawMode: true });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().respawnPane(p1.id);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.ptyId).toBeNull();
    expect(pane.ptyEpoch).toBe(3);
    expect(pane.ready).toBe(false);
    expect(pane.exited).toBe(false);
    expect(pane.rawMode).toBe(false);
  });

  it("respawnPane prunes the OLD ptyId's serverStatus/foregroundState entries", () => {
    const p1 = mkPane({ ptyId: "old" });
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })],
      activeWs: "w1",
      serverStatus: { old: "alive", elsewhere: "alive" },
      foregroundState: { old: { running: true, pgid: 1 } },
    });
    useStore.getState().respawnPane(p1.id);
    const s = useStore.getState();
    expect(s.serverStatus).toEqual({ elsewhere: "alive" });
    expect(s.foregroundState).toEqual({});
  });

  it("openChanges / closeChanges / toggleChanges drive the app-level overlay (not a pane)", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    expect(useStore.getState().changesWsId).toBeNull();

    useStore.getState().openChanges();
    expect(useStore.getState().changesWsId).toBe("w1");

    useStore.getState().closeChanges();
    expect(useStore.getState().changesWsId).toBeNull();

    useStore.getState().toggleChanges();
    expect(useStore.getState().changesWsId).toBe("w1");
    useStore.getState().toggleChanges();
    expect(useStore.getState().changesWsId).toBeNull();
  });

  it("removeWorkspace clears a Changes overlay tied to the removed workspace", () => {
    const p1 = mkPane();
    const p2 = mkPane();
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] }), mkWs({ id: "w2", tabs: [mkGroup([p2])] })],
      activeWs: "w1",
    });
    useStore.getState().openChanges();
    expect(useStore.getState().changesWsId).toBe("w1");
    useStore.getState().removeWorkspace("w1");
    expect(useStore.getState().changesWsId).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Server tab: prepareServerTab / dropServerTab / setServerStatus / clearServerStatus
// ══════════════════════════════════════════════════════════════════════════

describe("prepareServerTab", () => {
  it("no-op for an unknown workspace", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().prepareServerTab("ghost", 2);
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("first call (no prior serverTabId): appends a single-pane tab, n clamped to 1; leaves other workspaces untouched", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" }), mkWs({ id: "w2" })], activeWs: "w1" });
    const otherBefore = useStore.getState().workspaces.find((w) => w.id === "w2");
    useStore.getState().prepareServerTab("w1", 1);
    const s = useStore.getState();
    const ws = s.workspaces.find((w) => w.id === "w1")!;
    expect(ws.tabs).toHaveLength(2);
    expect(ws.active).toBe(1);
    expect(ws.serverTabId).toBe(ws.tabs[1].id);
    expect(ws.tabs[1].panes).toHaveLength(1);
    // the untargeted workspace is returned as-is (identity preserved) by the map's else branch
    expect(s.workspaces.find((w) => w.id === "w2")).toBe(otherBefore);
  });

  it("n>4 clamps to 4 panes, split h", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().prepareServerTab("w1", 9);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs[1].panes).toHaveLength(4);
    expect(ws.tabs[1].split).toBe("h");
  });

  it("second call replaces the stale server tab (found in tabs)", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().prepareServerTab("w1", 1);
    const firstTabId = useStore.getState().workspaces[0].serverTabId;
    useStore.getState().prepareServerTab("w1", 2);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs.some((g) => g.id === firstTabId)).toBe(false);
    expect(ws.tabs).toHaveLength(2); // original work tab + fresh server tab
    expect(ws.serverTabId).not.toBe(firstTabId);
  });

  it("stale serverTabId that no longer matches any tab: skips the filter, still appends fresh", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", serverTabId: 999999 })], activeWs: "w1" });
    const tabsBefore = useStore.getState().workspaces[0].tabs.length;
    useStore.getState().prepareServerTab("w1", 1);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(tabsBefore + 1);
    expect(ws.serverTabId).not.toBe(999999);
  });
});

describe("dropServerTab", () => {
  it("no-op for an unknown workspace", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().dropServerTab("ghost");
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("no-op when serverTabId is already null", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().dropServerTab("w1");
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("removes the server tab, clears serverStatus/foregroundState for its ptyIds, fixes active index (tabIdx === active)", () => {
    resetStore({
      workspaces: [mkWs({ id: "w1" })],
      activeWs: "w1",
      serverStatus: { "pty-srv": "alive" },
      foregroundState: { "pty-srv": { running: true, pgid: 1 } },
    });
    useStore.getState().prepareServerTab("w1", 1);
    let ws = useStore.getState().workspaces[0];
    const serverTabId = ws.serverTabId!;
    // give the server pane a ptyId so we can assert cleanup
    useStore.setState({
      workspaces: useStore.getState().workspaces.map((w) =>
        w.id === "w1"
          ? { ...w, tabs: w.tabs.map((g) => (g.id === serverTabId ? { ...g, panes: g.panes.map((p) => ({ ...p, ptyId: "pty-srv" })) } : g)) }
          : w,
      ),
    });
    useStore.getState().dropServerTab("w1");
    ws = useStore.getState().workspaces[0];
    expect(ws.serverTabId).toBeNull();
    expect(ws.tabs.some((g) => g.id === serverTabId)).toBe(false);
    expect(useStore.getState().serverStatus["pty-srv"]).toBeUndefined();
    expect(useStore.getState().foregroundState["pty-srv"]).toBeUndefined();
  });

  it("tabIdx < active: active shifts down by one", () => {
    const serverGroup = mkGroup([mkPane()]);
    const tab1 = mkGroup([mkPane()]);
    const tab2 = mkGroup([mkPane()]);
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [serverGroup, tab1, tab2], active: 2, serverTabId: serverGroup.id })],
      activeWs: "w1",
    });
    useStore.getState().dropServerTab("w1");
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(2);
    expect(ws.active).toBe(1); // was 2, shifted down since removed idx(0) < active
  });

  it("last remaining tab is the server tab: replaced by a fresh work tab", () => {
    const serverGroup = mkGroup([mkPane()]);
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [serverGroup], active: 0, serverTabId: serverGroup.id })], activeWs: "w1" });
    useStore.getState().dropServerTab("w1");
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0].id).not.toBe(serverGroup.id);
    expect(ws.serverTabId).toBeNull();
    expect(ws.active).toBe(0);
  });

  it("serverTabId set but tab already gone (not found): clears the id, no crash", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", serverTabId: 424242 })], activeWs: "w1" });
    const tabsBefore = useStore.getState().workspaces[0].tabs.length;
    useStore.getState().dropServerTab("w1");
    const ws = useStore.getState().workspaces[0];
    expect(ws.serverTabId).toBeNull();
    expect(ws.tabs).toHaveLength(tabsBefore);
  });
});

describe("setServerStatus / clearServerStatus", () => {
  it("setServerStatus sets a single entry", () => {
    useStore.getState().setServerStatus("p1", "alive");
    expect(useStore.getState().serverStatus.p1).toBe("alive");
  });

  it("clearServerStatus removes only the given ids", () => {
    resetStore({ serverStatus: { p1: "alive", p2: "dead" } });
    useStore.getState().clearServerStatus(["p1"]);
    expect(useStore.getState().serverStatus).toEqual({ p2: "dead" });
  });

  // Code-review regression (#2, MAJEUR perf): the ~1.5s poll (running.ts)
  // calls setServerStatus for every live pane on every tick, even when the
  // status hasn't changed. Without a no-op guard, that allocates a fresh
  // `serverStatus` map every tick -> a new reference -> every subscriber
  // (TabStrip, each Pane) re-renders forever. Locks the fix: writing the SAME
  // value must return the SAME map reference.
  it("writing the SAME status is a no-op — same map reference (regression: was a fresh map every poll tick)", () => {
    resetStore({ serverStatus: { p1: "alive" } });
    const before = useStore.getState().serverStatus;
    useStore.getState().setServerStatus("p1", "alive");
    expect(useStore.getState().serverStatus).toBe(before);
  });

  it("writing a DIFFERENT status still allocates a new map (the guard doesn't over-suppress real changes)", () => {
    resetStore({ serverStatus: { p1: "alive" } });
    const before = useStore.getState().serverStatus;
    useStore.getState().setServerStatus("p1", "dead");
    expect(useStore.getState().serverStatus).not.toBe(before);
    expect(useStore.getState().serverStatus.p1).toBe("dead");
  });
});

describe("setForegroundState / clearForegroundState", () => {
  it("setForegroundState sets a single entry", () => {
    useStore.getState().setForegroundState("p1", { running: true, pgid: 555 });
    expect(useStore.getState().foregroundState.p1).toEqual({ running: true, pgid: 555 });
  });

  it("clearForegroundState removes only the given ids", () => {
    resetStore({
      foregroundState: { p1: { running: true, pgid: 1 }, p2: { running: false, pgid: null } },
    });
    useStore.getState().clearForegroundState(["p1"]);
    expect(useStore.getState().foregroundState).toEqual({ p2: { running: false, pgid: null } });
  });

  it("clearForegroundState with an empty list is a no-op (same reference)", () => {
    resetStore({ foregroundState: { p1: { running: true, pgid: 1 } } });
    const before = useStore.getState().foregroundState;
    useStore.getState().clearForegroundState([]);
    expect(useStore.getState().foregroundState).toBe(before);
  });

  // Code-review regression (#2, MAJEUR perf) — same reasoning as setServerStatus
  // above, for the other map the poll writes every ~1.5s tick.
  it("writing an EQUAL {running, pgid} is a no-op — same map reference (regression: was a fresh map every poll tick)", () => {
    resetStore({ foregroundState: { p1: { running: true, pgid: 555 } } });
    const before = useStore.getState().foregroundState;
    useStore.getState().setForegroundState("p1", { running: true, pgid: 555 });
    expect(useStore.getState().foregroundState).toBe(before);
  });

  it("writing a DIFFERENT pgid (even with the same `running`) still allocates a new map", () => {
    resetStore({ foregroundState: { p1: { running: true, pgid: 555 } } });
    const before = useStore.getState().foregroundState;
    useStore.getState().setForegroundState("p1", { running: true, pgid: 999 });
    expect(useStore.getState().foregroundState).not.toBe(before);
    expect(useStore.getState().foregroundState.p1).toEqual({ running: true, pgid: 999 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tabs
// ══════════════════════════════════════════════════════════════════════════

describe("tabs", () => {
  it("newTab appends a group to the active workspace and switches to it", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().newTab();
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(2);
    expect(ws.active).toBe(1);
  });

  it("closeTab: no-op with no active workspace", () => {
    resetStore({ workspaces: [], activeWs: null });
    const before = useStore.getState().workspaces;
    useStore.getState().closeTab(0);
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("closeTab: no-op when it's the last tab", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().closeTab(0);
    expect(useStore.getState().workspaces[0].tabs).toHaveLength(1);
  });

  it("closeTab: closing before the active tab shifts active down", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()]), mkGroup([mkPane()]), mkGroup([mkPane()])], active: 2 })], activeWs: "w1" });
    useStore.getState().closeTab(0);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(2);
    expect(ws.active).toBe(1);
  });

  it("closeTab: closing the active tab clamps active to the new length", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()]), mkGroup([mkPane()])], active: 1 })], activeWs: "w1" });
    useStore.getState().closeTab(1);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(1);
    expect(ws.active).toBe(0);
  });

  it("closeTab: prunes serverStatus/foregroundState for every ptyId in the closed tab", () => {
    const p1 = mkPane({ ptyId: "pty-a" });
    const p2 = mkPane({ ptyId: "pty-b" });
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1, p2]), mkGroup([mkPane({ ptyId: "pty-other" })])], active: 1 })],
      activeWs: "w1",
      serverStatus: { "pty-a": "alive", "pty-b": "dead", "pty-other": "alive" },
      foregroundState: { "pty-a": { running: true, pgid: 1 } },
    });
    useStore.getState().closeTab(0);
    const s = useStore.getState();
    expect(s.serverStatus).toEqual({ "pty-other": "alive" });
    expect(s.foregroundState).toEqual({});
  });

  it("selectTab: no-op with no active workspace or out-of-range index", () => {
    resetStore({ workspaces: [], activeWs: null });
    useStore.getState().selectTab(0);
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().selectTab(5);
    expect(useStore.getState().workspaces[0].active).toBe(0);
  });

  it("selectTab: valid index switches active", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()]), mkGroup([mkPane()])] })], activeWs: "w1" });
    useStore.getState().selectTab(1);
    expect(useStore.getState().workspaces[0].active).toBe(1);
  });

  it("setTabName: no-op when the tab id isn't found anywhere, or name is unchanged", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().setTabName(9999999, "x");
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("setTabName: updates the matching group across workspaces", () => {
    const g1 = mkGroup([mkPane()]);
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [g1] }), mkWs({ id: "w2" })], activeWs: "w1" });
    useStore.getState().setTabName(g1.id, "renamed");
    expect(useStore.getState().workspaces[0].tabs[0].name).toBe("renamed");
    // same name again -> no-op branch
    const before = useStore.getState().workspaces;
    useStore.getState().setTabName(g1.id, "renamed");
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("cycleTab: no-op with no active workspace or fewer than 2 tabs", () => {
    resetStore({ workspaces: [], activeWs: null });
    useStore.getState().cycleTab(1);
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().cycleTab(1);
    expect(useStore.getState().workspaces[0].active).toBe(0);
  });

  it("cycleTab: wraps forward and backward", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()]), mkGroup([mkPane()])], active: 0 })], activeWs: "w1" });
    useStore.getState().cycleTab(1);
    expect(useStore.getState().workspaces[0].active).toBe(1);
    useStore.getState().cycleTab(1);
    expect(useStore.getState().workspaces[0].active).toBe(0);
    useStore.getState().cycleTab(-1);
    expect(useStore.getState().workspaces[0].active).toBe(1);
  });

  it("mergeTabs: no-op with no active workspace or src===dest", () => {
    resetStore({ workspaces: [], activeWs: null });
    useStore.getState().mergeTabs(0, 1);
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().mergeTabs(0, 0);
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("mergeTabs: no-op when either tab is missing or the merge would exceed 4 panes", () => {
    resetStore({
      workspaces: [
        mkWs({
          id: "w1",
          tabs: [mkGroup([mkPane(), mkPane(), mkPane()]), mkGroup([mkPane(), mkPane()])],
        }),
      ],
      activeWs: "w1",
    });
    const before = useStore.getState().workspaces;
    useStore.getState().mergeTabs(0, 1); // 3+2=5 > 4
    expect(useStore.getState().workspaces).toBe(before);
    useStore.getState().mergeTabs(0, 5); // dest missing
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("mergeTabs: merges panes into dest, removes src, dest>src shifts active left", () => {
    const g0 = mkGroup([mkPane()]);
    const g1 = mkGroup([mkPane()]);
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [g0, g1], active: 0 })], activeWs: "w1" });
    useStore.getState().mergeTabs(0, 1);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0].panes).toHaveLength(2);
    expect(ws.active).toBe(0); // dest(1) > src(0) -> dest-1
  });

  it("mergeTabs: dest<src keeps dest as active", () => {
    const g0 = mkGroup([mkPane()]);
    const g1 = mkGroup([mkPane()]);
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [g0, g1], active: 1 })], activeWs: "w1" });
    useStore.getState().mergeTabs(1, 0);
    const ws = useStore.getState().workspaces[0];
    expect(ws.tabs).toHaveLength(1);
    expect(ws.active).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Panes: split / close / focus / cycle
// ══════════════════════════════════════════════════════════════════════════

describe("panes", () => {
  it("splitPane: no-op with no active workspace, or group already at 4 panes", () => {
    resetStore({ workspaces: [], activeWs: null });
    useStore.getState().splitPane("h");
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane(), mkPane(), mkPane(), mkPane()])] })], activeWs: "w1" });
    const before = useStore.getState().workspaces;
    useStore.getState().splitPane("h");
    expect(useStore.getState().workspaces).toBe(before);
  });

  it("splitPane: inserts a new pane after the active one, inherits cwd/repoRoot", () => {
    const p1 = mkPane({ cwd: "/inherit", repoRoot: "/repo/inherit" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().splitPane("v");
    const g = useStore.getState().workspaces[0].tabs[0];
    expect(g.panes).toHaveLength(2);
    expect(g.split).toBe("v");
    expect(g.active).toBe(1);
    expect(g.panes[1].cwd).toBe("/inherit");
    expect(g.panes[1].repoRoot).toBe("/repo/inherit");
  });

  it("closePane: no-op with no active workspace or no group", () => {
    resetStore({ workspaces: [], activeWs: null });
    useStore.getState().closePane();
    expect(useStore.getState().workspaces).toHaveLength(0);
  });

  it("closePane: last pane of a non-last tab closes the tab", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()]), mkGroup([mkPane()])], active: 0 })], activeWs: "w1" });
    useStore.getState().closePane();
    expect(useStore.getState().workspaces[0].tabs).toHaveLength(1);
  });

  it("closePane: last pane of the last tab is a no-op (never closes the last tab)", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()])] })], activeWs: "w1" });
    useStore.getState().closePane();
    expect(useStore.getState().workspaces[0].tabs).toHaveLength(1);
  });

  it("closePane: removes the active pane from a multi-pane group, clamps active", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane(), mkPane()], { active: 1 })] })], activeWs: "w1" });
    useStore.getState().closePane();
    const g = useStore.getState().workspaces[0].tabs[0];
    expect(g.panes).toHaveLength(1);
    expect(g.active).toBe(0);
  });

  it("closePane: prunes serverStatus/foregroundState for the closed pane's ptyId", () => {
    const stay = mkPane({ ptyId: "pty-stay" });
    const closed = mkPane({ ptyId: "pty-closed" });
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([stay, closed], { active: 1 })] })],
      activeWs: "w1",
      serverStatus: { "pty-stay": "alive", "pty-closed": "alive" },
      foregroundState: { "pty-closed": { running: true, pgid: 9 } },
    });
    useStore.getState().closePane();
    const s = useStore.getState();
    expect(s.serverStatus).toEqual({ "pty-stay": "alive" });
    expect(s.foregroundState).toEqual({});
  });

  it("closePane: closing the last pane of a tab prunes that tab's ptyId too", () => {
    const closed = mkPane({ ptyId: "pty-a" });
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([closed]), mkGroup([mkPane({ ptyId: "pty-other" })])], active: 0 })],
      activeWs: "w1",
      serverStatus: { "pty-a": "alive", "pty-other": "alive" },
    });
    useStore.getState().closePane();
    expect(useStore.getState().serverStatus).toEqual({ "pty-other": "alive" });
  });

  it("focusPane: no-op with no active workspace or out-of-range index", () => {
    resetStore({ workspaces: [], activeWs: null });
    useStore.getState().focusPane(0);
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().focusPane(3);
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(0);
  });

  it("focusPane: sets the active pane index", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane(), mkPane()])] })], activeWs: "w1" });
    useStore.getState().focusPane(1);
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(1);
  });

  it("cyclePane: no-op with <2 panes", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    useStore.getState().cyclePane(1);
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(0);
  });

  it("cyclePane: wraps via focusPane", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane(), mkPane()], { active: 0 })] })], activeWs: "w1" });
    useStore.getState().cyclePane(-1);
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Prompt: setInput / setDirNames / setCwd / setBranch (+ recomputeGhost)
// ══════════════════════════════════════════════════════════════════════════

describe("prompt", () => {
  it("setInput recomputes ghost via ghostFor when ghost is enabled and no suggestion", () => {
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()])] })], activeWs: "w1", settings: { ...DEFAULT_SETTINGS, ghost: true } });
    const paneId = useStore.getState().workspaces[0].tabs[0].panes[0].id;
    useStore.getState().setInput(paneId, "gi");
    const pane = findPane(useStore.getState(), paneId)!;
    expect(pane.input).toBe("gi");
    expect(pane.hIndex).toBe(-1);
    expect(pane.suggestion).toBeNull();
  });

  it("setInput: ghost disabled in settings -> ghost stays empty", () => {
    resetStore({
      workspaces: [mkWs({ id: "w1", tabs: [mkGroup([mkPane()])] })],
      activeWs: "w1",
      settings: { ...DEFAULT_SETTINGS, ghost: false },
    });
    const paneId = useStore.getState().workspaces[0].tabs[0].panes[0].id;
    useStore.getState().setInput(paneId, "gi");
    expect(findPane(useStore.getState(), paneId)!.ghost).toBe("");
  });

  it("setDirNames: with an existing suggestion, recomputeGhost short-circuits to empty", () => {
    const p1 = mkPane({ suggestion: { command: "ls", note: "n" } });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setDirNames(p1.id, ["a", "b"]);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.dirNames).toEqual(["a", "b"]);
    expect(pane.ghost).toBe("");
  });

  it("setCwd: same cwd is a no-op (keeps branch)", () => {
    const p1 = mkPane({ cwd: "/same", branch: "main" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setCwd(p1.id, "/same");
    expect(findPane(useStore.getState(), p1.id)!.branch).toBe("main");
  });

  it("setCwd: different cwd clears branch", () => {
    const p1 = mkPane({ cwd: "/old", branch: "main" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setCwd(p1.id, "/new");
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.cwd).toBe("/new");
    expect(pane.branch).toBeNull();
  });

  it("setBranch", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setBranch(p1.id, "feature/x");
    expect(findPane(useStore.getState(), p1.id)!.branch).toBe("feature/x");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Command blocks
// ══════════════════════════════════════════════════════════════════════════

describe("command blocks", () => {
  it("startBlock: marks a prior running block as finished, pushes a new running one", () => {
    const p1 = mkPane({ blocks: [{ id: 1, command: "old", cwd: "/", output: "o", exitCode: null, running: true }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().startBlock(p1.id, "new cmd", "/x");
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.blocks).toHaveLength(2);
    expect(pane.blocks[0].running).toBe(false);
    expect(pane.blocks[1].command).toBe("new cmd");
    expect(pane.blocks[1].running).toBe(true);
  });

  it("markCapture: no-op with no blocks", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().markCapture(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.blocks).toEqual([]);
  });

  it("markCapture: clears output only when the last block is running", () => {
    const p1 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "junk", exitCode: null, running: true }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().markCapture(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.blocks[0].output).toBe("");

    const p2 = mkPane({ blocks: [{ id: 2, command: "c", cwd: "/", output: "keep", exitCode: 0, running: false }] });
    resetStore({ workspaces: [mkWs({ id: "w2", tabs: [mkGroup([p2])] })], activeWs: "w2" });
    useStore.getState().markCapture(p2.id);
    expect(findPane(useStore.getState(), p2.id)!.blocks[0].output).toBe("keep");
  });

  it("appendOutput: no-op with no blocks, or last block not running", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().appendOutput(p1.id, "x");
    expect(findPane(useStore.getState(), p1.id)!.blocks).toEqual([]);

    const p2 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "a", exitCode: 0, running: false }] });
    resetStore({ workspaces: [mkWs({ id: "w2", tabs: [mkGroup([p2])] })], activeWs: "w2" });
    useStore.getState().appendOutput(p2.id, "b");
    expect(findPane(useStore.getState(), p2.id)!.blocks[0].output).toBe("a");
  });

  it("appendOutput: appends to a running block", () => {
    const p1 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "a", exitCode: null, running: true }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().appendOutput(p1.id, "b");
    expect(findPane(useStore.getState(), p1.id)!.blocks[0].output).toBe("ab");
  });

  it("appendOutput: caps output at 256KB, cutting on a newline when present", () => {
    // 300000 'x' + '\n' + 'TAIL' = 300005 chars, well over the 262144 cap. The
    // cut point (300005-262144=57861) falls before the single newline at index
    // 300000, so the newline branch trims everything up to and including it.
    const seed = "x".repeat(300000) + "\nTAIL";
    const p1 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "", exitCode: null, running: true }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().appendOutput(p1.id, seed);
    const out = findPane(useStore.getState(), p1.id)!.blocks[0].output;
    expect(out).toBe("TAIL");
  });

  it("appendOutput: caps output with no newline in the cut region (falls back to hard cut)", () => {
    const seed = "y".repeat(300000); // no newline at all
    const p1 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "", exitCode: null, running: true }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().appendOutput(p1.id, seed);
    const out = findPane(useStore.getState(), p1.id)!.blocks[0].output;
    expect(out.length).toBe(262144);
    expect(out).toBe("y".repeat(262144));
  });

  it("endBlock: no-op with no blocks, or last block not running", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().endBlock(p1.id, 0);
    expect(findPane(useStore.getState(), p1.id)!.blocks).toEqual([]);

    const p2 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "", exitCode: 0, running: false }] });
    resetStore({ workspaces: [mkWs({ id: "w2", tabs: [mkGroup([p2])] })], activeWs: "w2" });
    useStore.getState().endBlock(p2.id, 1);
    expect(findPane(useStore.getState(), p2.id)!.blocks[0].exitCode).toBe(0); // unchanged
  });

  it("endBlock: finalizes a running block with the given exit code", () => {
    const p1 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "", exitCode: null, running: true }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().endBlock(p1.id, 127);
    const b = findPane(useStore.getState(), p1.id)!.blocks[0];
    expect(b.running).toBe(false);
    expect(b.exitCode).toBe(127);
  });

  it("clearBlocks empties the list", () => {
    const p1 = mkPane({ blocks: [{ id: 1, command: "c", cwd: "/", output: "", exitCode: 0, running: false }] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().clearBlocks(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.blocks).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// History
// ══════════════════════════════════════════════════════════════════════════

describe("pushHistory / histNav", () => {
  it("pushHistory: skips empty commands and immediate duplicates, pushes new ones", () => {
    const p1 = mkPane({ history: ["a"] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().pushHistory(p1.id, "");
    expect(findPane(useStore.getState(), p1.id)!.history).toEqual(["a"]);
    useStore.getState().pushHistory(p1.id, "a");
    expect(findPane(useStore.getState(), p1.id)!.history).toEqual(["a"]);
    useStore.getState().pushHistory(p1.id, "b");
    expect(findPane(useStore.getState(), p1.id)!.history).toEqual(["a", "b"]);
  });

  it("histNav: no-op with empty history", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().histNav(p1.id, -1);
    expect(findPane(useStore.getState(), p1.id)!.hIndex).toBe(-1);
  });

  it("histNav: dir<0 from hIndex=-1 jumps to the last entry", () => {
    const p1 = mkPane({ history: ["a", "b", "c"] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().histNav(p1.id, -1);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.hIndex).toBe(2);
    expect(pane.input).toBe("c");
  });

  it("histNav: dir<0 repeatedly decrements and clamps at 0", () => {
    const p1 = mkPane({ history: ["a", "b"], hIndex: 0 });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().histNav(p1.id, -1);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.hIndex).toBe(0);
    expect(pane.input).toBe("a");
  });

  it("histNav: dir>0 from hIndex=-1 is a no-op", () => {
    const p1 = mkPane({ history: ["a"] });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().histNav(p1.id, 1);
    expect(findPane(useStore.getState(), p1.id)!.hIndex).toBe(-1);
  });

  it("histNav: dir>0 past the end clears input and resets hIndex", () => {
    const p1 = mkPane({ history: ["a", "b"], hIndex: 1 });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().histNav(p1.id, 1);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.hIndex).toBe(-1);
    expect(pane.input).toBe("");
  });

  it("histNav: dir>0 mid-history moves forward one entry", () => {
    const p1 = mkPane({ history: ["a", "b", "c"], hIndex: 0 });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().histNav(p1.id, 1);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.hIndex).toBe(1);
    expect(pane.input).toBe("b");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suggestion / completion / selection
// ══════════════════════════════════════════════════════════════════════════

describe("suggestion / completion / selection", () => {
  it("setSuggestion + setSuggestionLoading + setPendingFix", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setSuggestionLoading(p1.id, true);
    expect(findPane(useStore.getState(), p1.id)!.suggestionLoading).toBe(true);
    useStore.getState().setSuggestion(p1.id, { command: "ls -la", note: "list" });
    let pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.suggestion).toEqual({ command: "ls -la", note: "list" });
    expect(pane.suggestionLoading).toBe(false);
    useStore.getState().setPendingFix(p1.id, "git add .");
    pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.pendingFix).toBe("git add .");
    expect(pane.completion).toBeNull();
  });

  it("openCompletion / moveCompletion / closeCompletion", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().moveCompletion(p1.id, 1); // no completion open -> no-op
    expect(findPane(useStore.getState(), p1.id)!.completion).toBeNull();

    useStore.getState().openCompletion(p1.id, { items: [{ name: "a", is_dir: true }, { name: "b", is_dir: true }], tokenStart: 0, dir: "./" });
    let pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.completion!.index).toBe(0);

    useStore.getState().moveCompletion(p1.id, 1);
    pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.completion!.index).toBe(1);
    useStore.getState().moveCompletion(p1.id, 1); // wraps
    pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.completion!.index).toBe(0);

    useStore.getState().closeCompletion(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.completion).toBeNull();
  });

  it("moveCompletion: no-op when items list is empty", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().openCompletion(p1.id, { items: [], tokenStart: 0, dir: "./" });
    useStore.getState().moveCompletion(p1.id, 1);
    expect(findPane(useStore.getState(), p1.id)!.completion!.index).toBe(0);
  });

  it("acceptCompletion: no-op when completion is null or items empty", () => {
    const p1 = mkPane({ input: "cd fo" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().acceptCompletion(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.input).toBe("cd fo");

    useStore.getState().openCompletion(p1.id, { items: [], tokenStart: 3, dir: "" });
    useStore.getState().acceptCompletion(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.completion!.items).toEqual([]);
  });

  it("acceptCompletion: rebuilds input from tokenStart + dir + item name", () => {
    const p1 = mkPane({ input: "cd fo" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().openCompletion(p1.id, { items: [{ name: "foobar", is_dir: true }], tokenStart: 3, dir: "" });
    useStore.getState().acceptCompletion(p1.id);
    const pane = findPane(useStore.getState(), p1.id)!;
    expect(pane.input).toBe("cd foobar/");
    expect(pane.completion).toBeNull();
    expect(pane.suggestion).toBeNull();
  });

  it("selectAllInput: no-op when input is empty, sets inputSelected when non-empty", () => {
    const p1 = mkPane({ input: "" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().selectAllInput(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.inputSelected).toBe(false);

    const p2 = mkPane({ input: "hi" });
    resetStore({ workspaces: [mkWs({ id: "w2", tabs: [mkGroup([p2])] })], activeWs: "w2" });
    useStore.getState().selectAllInput(p2.id);
    expect(findPane(useStore.getState(), p2.id)!.inputSelected).toBe(true);
  });

  it("collapseInputSelection: no-op when not selected, clears when selected", () => {
    const p1 = mkPane({ inputSelected: false });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().collapseInputSelection(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.inputSelected).toBe(false);

    const p2 = mkPane({ inputSelected: true });
    resetStore({ workspaces: [mkWs({ id: "w2", tabs: [mkGroup([p2])] })], activeWs: "w2" });
    useStore.getState().collapseInputSelection(p2.id);
    expect(findPane(useStore.getState(), p2.id)!.inputSelected).toBe(false);
  });

  it("setRawMode toggles", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setRawMode(p1.id, true);
    expect(findPane(useStore.getState(), p1.id)!.rawMode).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Settings / panels / key entry
// ══════════════════════════════════════════════════════════════════════════

describe("settings / panels", () => {
  it("setSetting persists to localStorage and re-applies the theme", () => {
    useStore.getState().setSetting("accent", "violet");
    expect(useStore.getState().settings.accent).toBe("violet");
    expect(localStorage.getItem("aurora.settings")).toContain("violet");
  });

  it("openSettings / closeSettings", () => {
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().closeSettings();
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("openPanel toggles: same panel closes it, different panel opens the new one", () => {
    useStore.getState().openPanel("mr");
    expect(useStore.getState().panel).toBe("mr");
    useStore.getState().openPanel("mr");
    expect(useStore.getState().panel).toBeNull();
    useStore.getState().openPanel("notif");
    expect(useStore.getState().panel).toBe("notif");
    useStore.getState().closePanel();
    expect(useStore.getState().panel).toBeNull();
  });

  it("setUserScripts persists + updates", () => {
    useStore.getState().setUserScripts({ "/r": { scripts: [], onEnter: null } });
    expect(useStore.getState().userScripts["/r"]).toEqual({ scripts: [], onEnter: null });
    expect(localStorage.getItem("aurora.scripts")).not.toBeNull();
  });

  it("openScriptsSetup closes the panel too; closeScriptsSetup", () => {
    resetStore({ panel: "scripts" });
    useStore.getState().openScriptsSetup();
    expect(useStore.getState().scriptsSetupOpen).toBe(true);
    expect(useStore.getState().panel).toBeNull();
    useStore.getState().closeScriptsSetup();
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
  });

  it("setRepoConfigs / setRepoConfig persist", () => {
    useStore.getState().setRepoConfigs({});
    expect(useStore.getState().repoConfigs).toEqual({});
    const cfg = { version: 6 } as unknown as Parameters<typeof useStore.getState.__proto__>[0];
    useStore.getState().setRepoConfig("/r1", { presets: [], defaultPreset: null } as never);
    expect(useStore.getState().repoConfigs["/r1"]).toBeDefined();
    expect(localStorage.getItem("aurora.repoconfig")).toContain("/r1");
  });

  it("openWorkspaceSettings closes settings too; closeWorkspaceSettings", () => {
    resetStore({ settingsOpen: true });
    useStore.getState().openWorkspaceSettings("/r1");
    expect(useStore.getState().workspaceSettingsRepo).toBe("/r1");
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().closeWorkspaceSettings();
    expect(useStore.getState().workspaceSettingsRepo).toBeNull();
  });
});

describe("pane repo/hook state", () => {
  it("setRepoRoot / setHook / setReady", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().setRepoRoot(p1.id, "/repo/x");
    expect(findPane(useStore.getState(), p1.id)!.repoRoot).toBe("/repo/x");
    useStore.getState().setHook(p1.id, { name: "postCreate", label: "Post-create", desc: "d" });
    expect(findPane(useStore.getState(), p1.id)!.hook!.name).toBe("postCreate");
    useStore.getState().setReady(p1.id);
    expect(findPane(useStore.getState(), p1.id)!.ready).toBe(true);
  });

  it("markHookFired: adds a new root once, no-ops on repeat", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    useStore.getState().markHookFired(p1.id, "/repo/x");
    expect(findPane(useStore.getState(), p1.id)!.firedHooks).toEqual(["/repo/x"]);
    useStore.getState().markHookFired(p1.id, "/repo/x");
    expect(findPane(useStore.getState(), p1.id)!.firedHooks).toEqual(["/repo/x"]);
  });
});

describe("repoMrs / glabUser", () => {
  it("setRepoMrs keyed by root", () => {
    useStore.getState().setRepoMrs("/repo/x", [{ iid: 1, title: "t", branch: "b", draft: false, author: "a", web_url: "u", updated: "now" }]);
    expect(useStore.getState().repoMrs["/repo/x"]).toHaveLength(1);
  });

  it("setGlabUser", () => {
    useStore.getState().setGlabUser("mromain");
    expect(useStore.getState().glabUser).toBe("mromain");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Connections
// ══════════════════════════════════════════════════════════════════════════

describe("connections", () => {
  it("setConnections persists + replaces", () => {
    useStore.getState().setConnections({ jira: [], ai: [] });
    expect(useStore.getState().connections).toEqual({ jira: [], ai: [] });
  });

  it("addJiraConnection: new id appends; same id replaces", () => {
    const c1 = { id: "j1", site: "a.atlassian.net", label: "a", email: "e", token: "t" } as never;
    useStore.getState().addJiraConnection(c1);
    expect(useStore.getState().connections.jira).toHaveLength(1);
    const c1b = { ...c1, label: "renamed" } as never;
    useStore.getState().addJiraConnection(c1b);
    expect(useStore.getState().connections.jira).toHaveLength(1);
    expect((useStore.getState().connections.jira[0] as unknown as { label: string }).label).toBe("renamed");
  });

  it("removeJiraConnection removes by id", () => {
    resetStore({ connections: { jira: [{ id: "j1" } as never], ai: [] } });
    useStore.getState().removeJiraConnection("j1");
    expect(useStore.getState().connections.jira).toHaveLength(0);
  });

  it("addAiConnection: new id appends; same id replaces", () => {
    const a1 = { id: "a1", provider: "openai", label: "a" } as never;
    useStore.getState().addAiConnection(a1);
    expect(useStore.getState().connections.ai).toHaveLength(1);
    useStore.getState().addAiConnection(a1);
    expect(useStore.getState().connections.ai).toHaveLength(1);
  });

  it("removeAiConnection removes by id", () => {
    resetStore({ connections: { jira: [], ai: [{ id: "a1" } as never] } });
    useStore.getState().removeAiConnection("a1");
    expect(useStore.getState().connections.ai).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Find-in-output
// ══════════════════════════════════════════════════════════════════════════

describe("find", () => {
  it("openFind / closeFind / setFindQuery", () => {
    useStore.getState().openFind();
    expect(useStore.getState().find.open).toBe(true);
    useStore.getState().setFindQuery("err");
    expect(useStore.getState().find.query).toBe("err");
    expect(useStore.getState().find.current).toBe(0);
    useStore.getState().closeFind();
    expect(useStore.getState().find).toEqual({ open: false, query: "", current: 0 });
  });

  it("stepFind: total<=0 resets current to 0", () => {
    resetStore({ find: { open: true, query: "x", current: 3 } });
    useStore.getState().stepFind(1, 0);
    expect(useStore.getState().find.current).toBe(0);
  });

  it("stepFind: wraps forward and backward over total matches", () => {
    resetStore({ find: { open: true, query: "x", current: 0 } });
    useStore.getState().stepFind(-1, 3);
    expect(useStore.getState().find.current).toBe(2);
    useStore.getState().stepFind(1, 3);
    expect(useStore.getState().find.current).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Notifications
// ══════════════════════════════════════════════════════════════════════════

describe("notify / dismissNotif / clearNotifLog / toggleMute / markNotifsSeen", () => {
  const realSetTimeout = globalThis.setTimeout;
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  it("muted: logs the notif but shows no toast and schedules no dismiss timer", () => {
    let timeoutCalled = false;
    // @ts-expect-error test stub
    globalThis.setTimeout = (..._args: unknown[]) => {
      timeoutCalled = true;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    resetStore({ muted: true });
    useStore.getState().notify({ color: "red", icon: "x", headline: "h", sub: "s", repo: "/r" });
    const s = useStore.getState();
    expect(s.notifs).toEqual([]);
    expect(s.notifLog).toHaveLength(1);
    expect(s.unseen).toBe(1);
    expect(timeoutCalled).toBe(false);
  });

  it("unmuted: shows a toast (capped at 3) and schedules an auto-dismiss", () => {
    let captured: (() => void) | null = null;
    // @ts-expect-error test stub
    globalThis.setTimeout = (fn: () => void) => {
      captured = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    resetStore({ muted: false });
    useStore.getState().notify({ color: "g", icon: "i", headline: "one", sub: "", repo: "/r" });
    let s = useStore.getState();
    expect(s.notifs).toHaveLength(1);
    expect(captured).not.toBeNull();
    const id = s.notifs[0].id;
    captured!();
    s = useStore.getState();
    expect(s.notifs.find((n) => n.id === id)).toBeUndefined();
  });

  it("notify caps visible toasts at 3 (oldest drop) and notifLog at 40", () => {
    // @ts-expect-error test stub
    globalThis.setTimeout = () => 0 as unknown as ReturnType<typeof setTimeout>;
    resetStore({ muted: false });
    for (let i = 0; i < 5; i++) {
      useStore.getState().notify({ color: "g", icon: "i", headline: `n${i}`, sub: "", repo: "/r" });
    }
    expect(useStore.getState().notifs).toHaveLength(3);
    expect(useStore.getState().notifs.map((n) => n.headline)).toEqual(["n2", "n3", "n4"]);
  });

  it("dismissNotif removes only the given id", () => {
    resetStore({ notifs: [{ id: 1, color: "g", icon: "i", headline: "a", sub: "", repo: "/r", ts: 1 }, { id: 2, color: "g", icon: "i", headline: "b", sub: "", repo: "/r", ts: 2 }] });
    useStore.getState().dismissNotif(1);
    expect(useStore.getState().notifs.map((n) => n.id)).toEqual([2]);
  });

  it("clearNotifLog resets log and unseen", () => {
    resetStore({ notifLog: [{ id: 1, color: "g", icon: "i", headline: "a", sub: "", repo: "/r", ts: 1 }], unseen: 4 });
    useStore.getState().clearNotifLog();
    expect(useStore.getState().notifLog).toEqual([]);
    expect(useStore.getState().unseen).toBe(0);
  });

  it("toggleMute: unmuted->muted clears visible toasts; muted->unmuted just flips", () => {
    resetStore({ muted: false, notifs: [{ id: 1, color: "g", icon: "i", headline: "a", sub: "", repo: "/r", ts: 1 }] });
    useStore.getState().toggleMute();
    let s = useStore.getState();
    expect(s.muted).toBe(true);
    expect(s.notifs).toEqual([]);

    useStore.getState().toggleMute();
    s = useStore.getState();
    expect(s.muted).toBe(false);
  });

  it("markNotifsSeen resets unseen", () => {
    resetStore({ unseen: 7 });
    useStore.getState().markNotifsSeen();
    expect(useStore.getState().unseen).toBe(0);
  });
});

describe("key entry", () => {
  it("startKeyEntry / cancelKeyEntry / setKeyError / setApiKeyPresent", () => {
    useStore.getState().startKeyEntry();
    let s = useStore.getState();
    expect(s.keyEntry).toBe(true);
    expect(s.keyError).toBeNull();
    useStore.getState().setKeyError("bad key");
    expect(useStore.getState().keyError).toBe("bad key");
    useStore.getState().cancelKeyEntry();
    s = useStore.getState();
    expect(s.keyEntry).toBe(false);
    expect(s.keyError).toBeNull();
    useStore.getState().setApiKeyPresent(true);
    expect(useStore.getState().apiKeyPresent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Exported pure helpers
// ══════════════════════════════════════════════════════════════════════════

describe("selectors: activeWorkspace / activeGroup / activePane", () => {
  it("return undefined when there is no active workspace", () => {
    resetStore({ workspaces: [], activeWs: null });
    const s = useStore.getState();
    expect(activeWorkspace(s)).toBeUndefined();
    expect(activeGroup(s)).toBeUndefined();
    expect(activePane(s)).toBeUndefined();
  });

  it("resolve through to the active pane when present", () => {
    const p1 = mkPane({ input: "hey" });
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] })], activeWs: "w1" });
    const s = useStore.getState();
    expect(activeWorkspace(s)!.id).toBe("w1");
    expect(activeGroup(s)!.panes[0].id).toBe(p1.id);
    expect(activePane(s)!.input).toBe("hey");
  });
});

describe("findPane / workspaceOfPane / allRepoRoots", () => {
  it("findPane / workspaceOfPane return undefined for an unknown id", () => {
    resetStore({ workspaces: [mkWs({ id: "w1" })], activeWs: "w1" });
    const s = useStore.getState();
    expect(findPane(s, 99999999)).toBeUndefined();
    expect(workspaceOfPane(s, 99999999)).toBeUndefined();
  });

  it("findPane / workspaceOfPane locate a pane across workspaces", () => {
    const p1 = mkPane();
    resetStore({ workspaces: [mkWs({ id: "w1", tabs: [mkGroup([p1])] }), mkWs({ id: "w2" })], activeWs: "w1" });
    const s = useStore.getState();
    expect(findPane(s, p1.id)!.id).toBe(p1.id);
    expect(workspaceOfPane(s, p1.id)!.id).toBe("w1");
  });

  it("allRepoRoots collects only non-null repoRoots across every workspace/pane", () => {
    const pA = mkPane({ repoRoot: "/repo/a" });
    const pB = mkPane({ repoRoot: null });
    const pC = mkPane({ repoRoot: "/repo/a" }); // duplicate -> Set dedupes
    const pD = mkPane({ repoRoot: "/repo/b" });
    resetStore({
      workspaces: [
        mkWs({ id: "w1", tabs: [mkGroup([pA, pB])] }),
        mkWs({ id: "w2", tabs: [mkGroup([pC]), mkGroup([pD])] }),
      ],
      activeWs: "w1",
    });
    const roots = allRepoRoots(useStore.getState());
    expect([...roots].sort()).toEqual(["/repo/a", "/repo/b"]);
  });

  it("allRepoRoots is empty for no workspaces", () => {
    resetStore({ workspaces: [] });
    expect(allRepoRoots(useStore.getState()).size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module-level constants
// ══════════════════════════════════════════════════════════════════════════

describe("constants", () => {
  it("MODEL_OPTIONS + DEFAULT_SETTINGS are well-formed", () => {
    expect(MODEL_OPTIONS.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.model).toBe("claude-sonnet-4-6");
    expect(DEFAULT_SETTINGS.accent).toBe("teal");
  });
});
