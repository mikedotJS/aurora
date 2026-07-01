// Coverage suite for src/lib/scripts.ts — per-repo script CRUD, execution
// (chained / split / server), the run-when-ready retry/respawn/give-up
// machinery, and the onEnter hook lifecycle.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  useStore,
  findPane as findPaneInStore,
  type PaneState,
  type Group,
  type Workspace,
  type RepoScripts,
} from "../src/state/store";
import { tauri } from "../test/mocks/tauri";
import {
  repoScripts,
  scriptsForRoot,
  onEnterFor,
  addScript,
  updateScript,
  deleteScript,
  addTask,
  updateTask,
  removeTask,
  setOnEnter,
  appendScripts,
  scriptKey,
  runScript,
  runCommand,
  runServerScript,
  runHook,
  maybeFireHook,
} from "../src/lib/scripts";

let seq = 8000;

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: seq++,
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
    view: "terminal",
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

/** Installs `panes` inside a fresh single-tab workspace as the active workspace.
 *  Does NOT touch userScripts — tests seed that separately via the CRUD helpers. */
function setup(panes: PaneState[], wsOverrides: Partial<Workspace> = {}) {
  const group: Group = { id: seq++, panes, active: 0, split: "h" };
  const ws: Workspace = {
    id: "w-" + group.id,
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: panes[0]?.cwd ?? "/repo",
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
    ...wsOverrides,
  };
  useStore.setState({ workspaces: [ws], activeWs: ws.id }, false);
  return { ws, group };
}

function pane(id: number): PaneState | undefined {
  return findPaneInStore(useStore.getState(), id);
}

beforeEach(() => {
  tauri.reset();
  useStore.setState({ workspaces: [], activeWs: null, userScripts: {}, initialized: true }, false);
});
afterEach(() => {
  // Guard against any accidental global.setTimeout override leaking across tests.
});

// ---------------------------------------------------------------------------
// Pure accessors
// ---------------------------------------------------------------------------

describe("repoScripts / scriptsForRoot / onEnterFor", () => {
  it("returns the empty default when root is null", () => {
    expect(repoScripts(null)).toEqual({ scripts: [], onEnter: null });
    expect(scriptsForRoot(null)).toEqual([]);
    expect(onEnterFor(null)).toBeNull();
  });

  it("returns the empty default when root isn't in the map", () => {
    expect(repoScripts("/nope")).toEqual({ scripts: [], onEnter: null });
  });

  it("returns the stored value for a known root", () => {
    const rs: RepoScripts = {
      scripts: [{ name: "a", desc: "", split: false, tasks: [{ dir: "", cmd: "x" }] }],
      onEnter: "a",
    };
    useStore.setState({ userScripts: { "/r": rs } }, false);
    expect(scriptsForRoot("/r")).toEqual(rs.scripts);
    expect(onEnterFor("/r")).toBe("a");
  });
});

describe("scriptKey", () => {
  it("prefers repoRoot over cwd", () => {
    expect(scriptKey(mkPane({ repoRoot: "/repo", cwd: "/repo/sub" }))).toBe("/repo");
  });
  it("falls back to cwd when repoRoot is null", () => {
    expect(scriptKey(mkPane({ repoRoot: null, cwd: "/wd" }))).toBe("/wd");
  });
});

// ---------------------------------------------------------------------------
// CRUD mutations
// ---------------------------------------------------------------------------

describe("script CRUD mutations", () => {
  const root = "/repo1";

  it("addScript appends default scripts with sequential names", () => {
    addScript(root);
    addScript(root);
    const scripts = scriptsForRoot(root);
    expect(scripts.map((s) => s.name)).toEqual(["script1", "script2"]);
    expect(scripts[0]).toEqual({ name: "script1", desc: "", split: false, tasks: [{ dir: "", cmd: "" }] });
  });

  it("updateScript merges a patch", () => {
    addScript(root);
    updateScript(root, 0, { name: "build", desc: "builds it", split: true });
    const s = scriptsForRoot(root)[0];
    expect(s).toMatchObject({ name: "build", desc: "builds it", split: true });
  });

  it("deleteScript removes the script at index", () => {
    addScript(root);
    addScript(root);
    deleteScript(root, 0);
    expect(scriptsForRoot(root).map((s) => s.name)).toEqual(["script2"]);
  });

  it("addTask / updateTask / removeTask manage a script's task list", () => {
    addScript(root);
    addTask(root, 0);
    expect(scriptsForRoot(root)[0].tasks).toHaveLength(2);
    updateTask(root, 0, 1, { dir: "sub", cmd: "npm test" });
    expect(scriptsForRoot(root)[0].tasks[1]).toEqual({ dir: "sub", cmd: "npm test" });
    removeTask(root, 0, 0);
    expect(scriptsForRoot(root)[0].tasks).toEqual([{ dir: "sub", cmd: "npm test" }]);
  });

  it("setOnEnter sets and clears the hook name", () => {
    addScript(root);
    setOnEnter(root, "script1");
    expect(onEnterFor(root)).toBe("script1");
    setOnEnter(root, "");
    expect(onEnterFor(root)).toBeNull();
  });
});

describe("appendScripts — name collision handling", () => {
  const root = "/repo2";
  const task = { dir: "", cmd: "echo hi" };

  it("appends with original names when there's no collision", () => {
    appendScripts(root, [{ name: "dev", desc: "", split: false, tasks: [task] }]);
    expect(scriptsForRoot(root).map((s) => s.name)).toEqual(["dev"]);
  });

  it("suffixes a name colliding with an existing script", () => {
    appendScripts(root, [{ name: "build", desc: "", split: false, tasks: [task] }]);
    appendScripts(root, [{ name: "build", desc: "", split: false, tasks: [task] }]);
    expect(scriptsForRoot(root).map((s) => s.name)).toEqual(["build", "build-2"]);
  });

  it("suffixes collisions within the same batch, incrementing past taken suffixes", () => {
    appendScripts(root, [{ name: "y", desc: "", split: false, tasks: [task] }]);
    appendScripts(root, [
      { name: "y", desc: "", split: false, tasks: [task] },
      { name: "y", desc: "", split: false, tasks: [task] },
    ]);
    expect(scriptsForRoot(root).map((s) => s.name)).toEqual(["y", "y-2", "y-3"]);
  });
});

// ---------------------------------------------------------------------------
// runScript
// ---------------------------------------------------------------------------

describe("runScript", () => {
  it("does nothing when the pane doesn't exist", () => {
    expect(() => runScript(999999, "dev")).not.toThrow();
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("shows feedback when the script doesn't exist", () => {
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: "/repo", repoRoot: "/repo" });
    setup([p]);
    runScript(p.id, "missing");
    const updated = pane(p.id)!;
    expect(updated.blocks).toHaveLength(1);
    expect(updated.blocks[0].command).toBe("run missing");
    expect(updated.blocks[0].output).toContain("no script 'missing' here");
    expect(updated.blocks[0].exitCode).toBe(1);
    expect(updated.blocks[0].running).toBe(false);
  });

  it("shows feedback when the script has no non-empty commands", () => {
    const root = "/repo";
    addScript(root); // default task has an empty cmd
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p]);
    runScript(p.id, "script1");
    const updated = pane(p.id)!;
    expect(updated.blocks[0].output).toContain("has no commands");
    expect(updated.blocks[0].exitCode).toBe(1);
  });

  it("sends a single-task command to a ready pane", () => {
    const root = "/repo";
    addScript(root);
    updateTask(root, 0, 0, { cmd: "npm run build" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p]);
    runScript(p.id, "script1");
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "npm run build\n" });
    expect(pane(p.id)!.blocks[0]).toMatchObject({ command: "npm run build", running: true });
  });

  it("prefixes a task with cd when a dir is set", () => {
    const root = "/repo";
    addScript(root);
    updateTask(root, 0, 0, { dir: "packages/app", cmd: "npm test" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p]);
    runScript(p.id, "script1");
    expect(tauri.lastCall("pty_write")?.args.data).toBe("cd /repo/packages/app && npm test\n");
  });

  it("joins multiple tasks with && and prepends a prelude when given", () => {
    const root = "/repo";
    addScript(root);
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "npm ci" });
    updateTask(root, 0, 1, { cmd: "npm run build" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p]);
    runScript(p.id, "script1", { prelude: "echo start" });
    expect(tauri.lastCall("pty_write")?.args.data).toBe("echo start && npm ci && npm run build\n");
  });

  it("skips empty tasks when chaining (filters before joining)", () => {
    const root = "/repo";
    addScript(root);
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "npm ci" });
    updateTask(root, 0, 1, { cmd: "   " }); // blank — filtered out
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p]);
    runScript(p.id, "script1");
    expect(tauri.lastCall("pty_write")?.args.data).toBe("npm ci\n");
  });

  it("resolves the script from lookupRoot and cd's into execBase", () => {
    const mainRoot = "/main";
    addScript(mainRoot);
    updateTask(mainRoot, 0, 0, { dir: "app", cmd: "npm start" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: "/worktree", repoRoot: null });
    setup([p]);
    runScript(p.id, "script1", { lookupRoot: mainRoot, execBase: "/worktree" });
    expect(tauri.lastCall("pty_write")?.args.data).toBe("cd /worktree/app && npm start\n");
  });

  it("falls back to the non-split chain when split=true but there's only one task", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { split: true });
    updateTask(root, 0, 0, { cmd: "solo" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p]);
    runScript(p.id, "script1");
    expect(tauri.lastCall("pty_write")?.args.data).toBe("solo\n");
  });

  it("schedules a retry instead of sending immediately when the pane isn't ready yet", () => {
    const root = "/repo";
    addScript(root);
    updateTask(root, 0, 0, { cmd: "npm start" });
    const p = mkPane({ ready: false, ptyId: null, exited: false, cwd: root, repoRoot: root });
    setup([p]);
    const scheduled: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    // Capture-only fake: never auto-invokes, so no dangling real timer survives the test.
    globalThis.setTimeout = ((fn: () => void) => {
      scheduled.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      runScript(p.id, "script1");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(scheduled).toHaveLength(1);
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("stops immediately without scheduling a retry when the pane has exited", () => {
    const root = "/repo";
    addScript(root);
    updateTask(root, 0, 0, { cmd: "npm start" });
    const p = mkPane({ ready: false, ptyId: null, exited: true, cwd: root, repoRoot: root });
    setup([p]);
    let calledTimeout = false;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      calledTimeout = true;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      runScript(p.id, "script1");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(calledTimeout).toBe(false);
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("respawns the pane once after ~50 stalled attempts, then keeps retrying until it gives up at 165", () => {
    const root = "/repo";
    addScript(root);
    updateTask(root, 0, 0, { cmd: "npm start" });
    const p = mkPane({ ready: false, ptyId: null, exited: false, cwd: root, repoRoot: root });
    setup([p]);
    const realSetTimeout = globalThis.setTimeout;
    // Fast-forward synchronously: the pane never becomes ready or exits, so this
    // deterministically walks every attempt from 0 to the give-up point at 165.
    globalThis.setTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      runScript(p.id, "script1");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    // respawnPane fires exactly once (bumps ptyEpoch by 1) despite ~165 attempts.
    expect(pane(p.id)!.ptyEpoch).toBe(1);
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });
});

describe("runScript — split", () => {
  it("runs each task in its own already-present pane and focuses the first", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { split: true });
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "api" });
    updateTask(root, 0, 1, { cmd: "web" });
    const p0 = mkPane({ ready: true, ptyId: "pty-0", cwd: root, repoRoot: root });
    const p1 = mkPane({ ready: true, ptyId: "pty-1", cwd: root, repoRoot: root });
    setup([p0, p1]);
    useStore.getState().focusPane(1); // move focus away first, to prove focusPane(0) runs after
    runScript(p0.id, "script1", { prelude: "echo boot" });
    const calls = tauri.calls().filter((c) => c.cmd === "pty_write");
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual({ id: "pty-0", data: "echo boot && api\n" });
    expect(calls[1].args).toEqual({ id: "pty-1", data: "web\n" });
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(0);
  });

  it("grows the pane group with splitPane when there aren't enough panes yet, and waits on the fresh ones", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { split: true });
    addTask(root, 0);
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "a" });
    updateTask(root, 0, 1, { cmd: "b" });
    updateTask(root, 0, 2, { cmd: "c" });
    const p0 = mkPane({ ready: true, ptyId: "pty-0", cwd: root, repoRoot: root });
    setup([p0]);
    const scheduled: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      scheduled.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      runScript(p0.id, "script1");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(useStore.getState().workspaces[0].tabs[0].panes).toHaveLength(3);
    expect(tauri.calls().filter((c) => c.cmd === "pty_write")).toHaveLength(1); // only p0 was ready
    expect(scheduled).toHaveLength(2); // the two freshly split panes await readiness
  });

  it("no-ops the split dispatch when the pane's workspace isn't the active one", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { split: true });
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "a" });
    updateTask(root, 0, 1, { cmd: "b" });
    const p0 = mkPane({ ready: true, ptyId: "pty-0", cwd: root, repoRoot: root });
    setup([p0]);
    useStore.setState({ activeWs: "does-not-exist" }, false); // activeGroup() -> undefined
    expect(() => runScript(p0.id, "script1")).not.toThrow();
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  it("does nothing for a blank command", () => {
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: "/repo" });
    setup([p]);
    runCommand(p.id, "   ");
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("does nothing when the pane doesn't exist", () => {
    expect(() => runCommand(424242, "echo hi")).not.toThrow();
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("sends the command immediately to a ready pane", () => {
    const p = mkPane({ ready: true, ptyId: "pty-9", cwd: "/repo" });
    setup([p]);
    runCommand(p.id, "npm install");
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-9", data: "npm install\n" });
  });
});

// ---------------------------------------------------------------------------
// runServerScript
// ---------------------------------------------------------------------------

describe("runServerScript", () => {
  it("does nothing when the pane doesn't exist", () => {
    expect(() => runServerScript(999, "dev", { lookupRoot: "/repo", execBase: "/repo" })).not.toThrow();
  });

  it("shows feedback when the script doesn't exist under lookupRoot", () => {
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: "/repo" });
    setup([p]);
    runServerScript(p.id, "missing", { lookupRoot: "/repo", execBase: "/repo" });
    expect(pane(p.id)!.blocks[0].output).toContain("no script 'missing' here");
  });

  it("shows feedback when the script has no non-empty commands", () => {
    const root = "/repo";
    addScript(root);
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root });
    setup([p]);
    runServerScript(p.id, "script1", { lookupRoot: root, execBase: root });
    expect(pane(p.id)!.blocks[0].output).toContain("has no commands");
  });

  it("shows feedback when taskIndex is out of range", () => {
    const root = "/repo";
    addScript(root);
    updateTask(root, 0, 0, { cmd: "npm start" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root });
    setup([p]);
    runServerScript(p.id, "script1", { lookupRoot: root, execBase: root, taskIndex: 5 });
    expect(pane(p.id)!.blocks[0].output).toContain("no task at index 5");
  });

  it("runs only the given task at taskIndex and fires onLaunched", () => {
    const root = "/repo";
    addScript(root);
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "api" });
    updateTask(root, 0, 1, { dir: "web", cmd: "web-serve" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root });
    setup([p]);
    let launched: string | undefined;
    runServerScript(p.id, "script1", {
      lookupRoot: root,
      execBase: root,
      taskIndex: 1,
      onLaunched: (id) => {
        launched = id;
      },
    });
    expect(tauri.lastCall("pty_write")?.args.data).toBe("cd /repo/web && web-serve\n");
    expect(launched).toBe("pty-1");
  });

  it("chains all tasks with && when taskIndex is omitted", () => {
    const root = "/repo";
    addScript(root);
    addTask(root, 0);
    updateTask(root, 0, 0, { cmd: "a" });
    updateTask(root, 0, 1, { cmd: "b" });
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: root });
    setup([p]);
    runServerScript(p.id, "script1", { lookupRoot: root, execBase: root });
    expect(tauri.lastCall("pty_write")?.args.data).toBe("a && b\n");
  });
});

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

describe("runHook", () => {
  it("does nothing when the pane doesn't exist", () => {
    expect(() => runHook(999)).not.toThrow();
  });

  it("does nothing when the pane has no pending hook", () => {
    const p = mkPane({ ready: true, ptyId: "pty-1", cwd: "/repo", hook: null });
    setup([p]);
    runHook(p.id);
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("clears the hook and runs the named script", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { name: "boot" });
    updateTask(root, 0, 0, { cmd: "npm run boot" });
    const p = mkPane({
      ready: true,
      ptyId: "pty-1",
      cwd: root,
      repoRoot: root,
      hook: { name: "boot", label: "boot", desc: "" },
    });
    setup([p]);
    runHook(p.id);
    expect(pane(p.id)!.hook).toBeNull();
    expect(tauri.lastCall("pty_write")?.args.data).toBe("npm run boot\n");
  });
});

// ---------------------------------------------------------------------------
// maybeFireHook
// ---------------------------------------------------------------------------

describe("maybeFireHook", () => {
  it("does nothing when the pane doesn't exist", () => {
    expect(() => maybeFireHook(999)).not.toThrow();
  });

  it("does nothing while inside a repo but not at its root", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { name: "boot" });
    setOnEnter(root, "boot");
    const p = mkPane({ cwd: root + "/sub", repoRoot: root });
    setup([p]);
    maybeFireHook(p.id);
    expect(pane(p.id)!.hook).toBeNull();
  });

  it("does nothing when the hook already fired for this key", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { name: "boot" });
    setOnEnter(root, "boot");
    const p = mkPane({ cwd: root, repoRoot: root, firedHooks: [root] });
    setup([p]);
    maybeFireHook(p.id);
    expect(pane(p.id)!.hook).toBeNull();
  });

  it("does nothing when there's no onEnter configured", () => {
    const root = "/repo";
    addScript(root); // onEnter stays null
    const p = mkPane({ cwd: root, repoRoot: root });
    setup([p]);
    maybeFireHook(p.id);
    expect(pane(p.id)!.hook).toBeNull();
  });

  it("does nothing when the onEnter script no longer exists", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { name: "boot" });
    setOnEnter(root, "boot");
    deleteScript(root, 0); // onEnter now points at a script that's gone
    const p = mkPane({ cwd: root, repoRoot: root });
    setup([p]);
    maybeFireHook(p.id);
    expect(pane(p.id)!.hook).toBeNull();
  });

  it("marks the hook fired and sets the pane's hook card at the repo root", () => {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { name: "boot", desc: "boots things" });
    setOnEnter(root, "boot");
    const p = mkPane({ cwd: root, repoRoot: root });
    setup([p]);
    maybeFireHook(p.id);
    const updated = pane(p.id)!;
    expect(updated.firedHooks).toContain(root);
    expect(updated.hook).toEqual({ name: "boot", label: "boot", desc: "boots things" });
  });

  it("also fires when repoRoot is null and cwd itself has scripts configured", () => {
    const cwd = "/scratch/dir";
    addScript(cwd);
    updateScript(cwd, 0, { name: "setup" });
    setOnEnter(cwd, "setup");
    const p = mkPane({ cwd, repoRoot: null });
    setup([p]);
    maybeFireHook(p.id);
    expect(pane(p.id)!.hook?.name).toBe("setup");
  });
});
