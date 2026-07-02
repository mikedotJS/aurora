// Coverage suite for src/lib/servers.ts — the Run/Stop server orchestrator.
//
// Unlike the hand-rolled-store style of __tests__/runServers.test.ts, this file
// drives the REAL Zustand store (src/state/store.ts) via useStore.setState(),
// with only the Tauri leaf mocked (the shared test/mocks/tauri.ts control object,
// wired in by the preload). pty.ts, scripts.ts and store.ts all run for real.
//
// The one wrinkle: runWhenReady() (in scripts.ts) retries via a real
// setTimeout(…, 60) loop until a pane's `ready`/`ptyId` flip true (normally done
// by the mounted <Terminal/> after a real PTY spawns). Headless tests never mount
// a Terminal, so we intercept global setTimeout to CAPTURE (not fire) the retry
// callback, flip the newly-created pane to ready+ptyId ourselves via the real
// store actions, then invoke the captured callback manually to resume the send.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace, type Group, type PaneState, type Block } from "../src/state/store";
import { serversUp, runServers, stopServers, ensureServerPoll, stopPoll } from "../src/lib/servers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let paneIdSeq = 900000; // far above the store's internal paneSeq to avoid collisions

function mkBlock(overrides: Partial<Block> = {}): Block {
  return { id: 1, command: "cmd", cwd: "/", output: "", exitCode: null, running: false, ...overrides };
}

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: paneIdSeq++,
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

function mkGroup(overrides: Partial<Group> = {}): Group {
  return { id: 800000 + Math.floor(Math.random() * 100000), panes: [mkPane()], active: 0, split: "h", ...overrides };
}

function mkWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws1",
    repoId: "/repo",
    title: "feat/x",
    issueKey: null,
    branch: "feat/x",
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
    tabs: [mkGroup()],
    active: 0,
    createdAt: 1,
    lastActive: 1,
    serverTabId: null,
    ...overrides,
  };
}

const PORT_SCRIPT = (name: string, port: number) => ({
  name,
  desc: "",
  split: false,
  tasks: [{ dir: "", cmd: `serve --port $((${port} + AURORA_PORT_OFFSET))` }],
});
const NON_PORT_SCRIPT = { name: "lint", desc: "", split: false, tasks: [{ dir: "", cmd: "eslint ." }] };

/** Reset the store to a blank-but-valid slate before every test. */
function resetStore(patch: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState(
    {
      repos: [],
      workspaces: [],
      activeWs: null,
      userScripts: {},
      notifLog: [],
      notifs: [],
      unseen: 0,
      muted: false,
      serverStatus: {},
      ...patch,
    } as Partial<ReturnType<typeof useStore.getState>>,
    false,
  );
}

beforeEach(() => {
  tauri.reset();
  tauri.invoke({
    pty_write: () => undefined,
    pty_kill: () => undefined,
    pty_capture_server_pgid: () => undefined,
    pty_server_status: () => "alive",
  });
  resetStore();
  stopPoll();
});

afterEach(() => {
  stopPoll();
});

// ── serversUp (pure selector over a Workspace) ────────────────────────────────

describe("serversUp", () => {
  it("is false when serverTabId is null", () => {
    expect(serversUp(mkWs({ serverTabId: null }))).toBe(false);
  });

  it("is false when the referenced tab doesn't exist in ws.tabs", () => {
    expect(serversUp(mkWs({ serverTabId: 999, tabs: [mkGroup({ id: 1 })] }))).toBe(false);
  });

  it("is true when status is 'alive' for a pane", () => {
    const tab = mkGroup({ id: 5, panes: [mkPane({ ptyId: "p1" })] });
    const ws = mkWs({ serverTabId: 5, tabs: [tab] });
    expect(serversUp(ws, { p1: "alive" })).toBe(true);
  });

  it("is true when status is 'capturing' for a pane", () => {
    const tab = mkGroup({ id: 5, panes: [mkPane({ ptyId: "p1" })] });
    const ws = mkWs({ serverTabId: 5, tabs: [tab] });
    expect(serversUp(ws, { p1: "capturing" })).toBe(true);
  });

  it("is false when status is 'dead' even if the block says running (status wins)", () => {
    const pane = mkPane({ ptyId: "p1", blocks: [mkBlock({ running: true })] });
    const tab = mkGroup({ id: 5, panes: [pane] });
    const ws = mkWs({ serverTabId: 5, tabs: [tab] });
    expect(serversUp(ws, { p1: "dead" })).toBe(false);
  });

  it("falls back to the last block's running flag when status is 'uncaptured'", () => {
    const paneRunning = mkPane({ ptyId: "p1", blocks: [mkBlock({ running: true })] });
    const tab = mkGroup({ id: 5, panes: [paneRunning] });
    expect(serversUp(mkWs({ serverTabId: 5, tabs: [tab] }), { p1: "uncaptured" })).toBe(true);
  });

  it("falls back to the last block's running flag when status is absent for that pane", () => {
    const paneRunning = mkPane({ ptyId: "p1", blocks: [mkBlock({ running: true })] });
    const tab = mkGroup({ id: 5, panes: [paneRunning] });
    expect(serversUp(mkWs({ serverTabId: 5, tabs: [tab] }), {})).toBe(true);
  });

  it("falls back to the block flag for every pane when status is omitted entirely", () => {
    const paneRunning = mkPane({ ptyId: "p1", blocks: [mkBlock({ running: true })] });
    const tab = mkGroup({ id: 5, panes: [paneRunning] });
    expect(serversUp(mkWs({ serverTabId: 5, tabs: [tab] }))).toBe(true);
  });

  it("is false when the pane has no blocks at all (fallback default)", () => {
    const tab = mkGroup({ id: 5, panes: [mkPane({ ptyId: "p1", blocks: [] })] });
    expect(serversUp(mkWs({ serverTabId: 5, tabs: [tab] }))).toBe(false);
  });

  it("is true if ANY pane in the tab is up (some())", () => {
    const tab = mkGroup({
      id: 5,
      panes: [mkPane({ ptyId: "p1" }), mkPane({ ptyId: "p2" })],
    });
    expect(serversUp(mkWs({ serverTabId: 5, tabs: [tab] }), { p1: "dead", p2: "alive" })).toBe(true);
  });
});

// ── setTimeout capture helper (see file header) ───────────────────────────────

/** Flip every pane in the workspace's tabs to ready+ptyId, then run one queued retry per pane. */
function resolveAllPending(wsId: string, queue: Array<() => void>) {
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
  for (const tab of ws.tabs) {
    for (const pane of tab.panes) {
      useStore.getState().setPaneRuntime(pane.id, { ptyId: `pty-${pane.id}`, isZsh: false });
      useStore.getState().setReady(pane.id);
    }
  }
  // Drain the queue (each captured callback resumes exactly one pane's runWhenReady).
  while (queue.length) queue.shift()!();
}

// ── runServers ────────────────────────────────────────────────────────────────

describe("runServers", () => {
  it("no-op when the workspace id is unknown", async () => {
    resetStore({ workspaces: [mkWs({ id: "ws1" })], activeWs: "ws1" });
    await runServers("does-not-exist");
    expect(useStore.getState().workspaces[0].serverTabId).toBeNull();
  });

  it("no-op for a manual lane (repoId == null)", async () => {
    resetStore({ workspaces: [mkWs({ id: "ws1", repoId: null })], activeWs: "ws1" });
    await runServers("ws1");
    expect(useStore.getState().workspaces[0].serverTabId).toBeNull();
  });

  it("no-op when the repo has no port-scripts (visibility guard)", async () => {
    resetStore({
      workspaces: [mkWs({ id: "ws1" })],
      activeWs: "ws1",
      userScripts: { "/repo": { scripts: [NON_PORT_SCRIPT], onEnter: null } },
    });
    await runServers("ws1");
    expect(useStore.getState().workspaces[0].serverTabId).toBeNull();
  });

  it("creates a fresh server tab, launches each unit, captures pgid, and starts the poll", async () => {
    resetStore({
      workspaces: [mkWs({ id: "ws1" })],
      activeWs: "ws1",
      userScripts: {
        "/repo": { scripts: [PORT_SCRIPT("web", 3000), PORT_SCRIPT("api", 4000)], onEnter: null },
      },
    });

    // Capture across the full call: prepareServerTab runs synchronously inside runServers,
    // then runServerScript(pane) schedules one setTimeout per pane before returning.
    const queue: Array<() => void> = [];
    const orig = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((cb: () => void) => {
      queue.push(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      await runServers("ws1");
    } finally {
      globalThis.setTimeout = orig;
    }

    const ws = useStore.getState().workspaces[0];
    expect(ws.serverTabId).not.toBeNull();
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(tab.panes.length).toBe(2); // 2 port-scripts -> 2 panes
    expect(ws.active).toBe(ws.tabs.length - 1); // switched to the new tab

    // Nothing sent yet (panes weren't ready) — resolve the pending retries now.
    expect(queue.length).toBe(2);
    resolveAllPending("ws1", queue);

    // Each pane got a startBlock with the right server command.
    const cmds = useStore
      .getState()
      .workspaces[0].tabs.find((g) => g.id === ws.serverTabId)!
      .panes.map((p) => p.blocks[p.blocks.length - 1]?.command)
      .sort();
    expect(cmds).toEqual([
      "serve --port $((3000 + AURORA_PORT_OFFSET))",
      "serve --port $((4000 + AURORA_PORT_OFFSET))",
    ].sort());

    // captureServerPgid fired for each launched pane's ptyId (D7).
    const captured = tauri.calls().filter((c) => c.cmd === "pty_capture_server_pgid").map((c) => c.args.id);
    expect(captured.sort()).toEqual(tab.panes.map((p) => `pty-${p.id}`).sort());

    // The liveness poll is running — stop it (also covers stopPoll's non-null branch).
    stopPoll();
  });

  it("a captureServerPgid rejection is swallowed (fire-and-forget) without failing the launch", async () => {
    tauri.invoke({
      pty_capture_server_pgid: () => {
        throw new Error("no distinct process group");
      },
    });
    resetStore({
      workspaces: [mkWs({ id: "ws1" })],
      activeWs: "ws1",
      userScripts: { "/repo": { scripts: [PORT_SCRIPT("web", 3000)], onEnter: null } },
    });
    await expect(withCapturedTimeoutsAsync(() => runServers("ws1"))).resolves.toBeUndefined();
    const ws = useStore.getState().workspaces[0];
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    // The pane still launched (block started) despite the capture failure.
    expect(tab.panes[0].blocks.length).toBe(1);
  });

  it("caps at 4 panes and notifies about the remainder", async () => {
    const scripts = [0, 1, 2, 3, 4].map((i) => PORT_SCRIPT(`srv${i}`, 5000 + i));
    resetStore({
      workspaces: [mkWs({ id: "ws1" })],
      activeWs: "ws1",
      userScripts: { "/repo": { scripts, onEnter: null } },
    });
    await withCapturedTimeoutsAsync(() => runServers("ws1"));

    const ws = useStore.getState().workspaces[0];
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(tab.panes.length).toBe(4);
    const notif = useStore.getState().notifLog[0];
    expect(notif.headline).toContain("1 server not started");
    expect(notif.sub).toContain("caps server panes at 4");
  });

  it("already up + wsId is the active workspace -> focuses the server tab (selectTab)", async () => {
    const serverPane = mkPane({ ptyId: "p1" });
    const workTab = mkGroup({ id: 1 });
    const serverTab = mkGroup({ id: 2, panes: [serverPane] });
    resetStore({
      workspaces: [mkWs({ id: "ws1", tabs: [workTab, serverTab], active: 0, serverTabId: 2 })],
      activeWs: "ws1",
      serverStatus: { p1: "alive" },
      userScripts: { "/repo": { scripts: [PORT_SCRIPT("web", 3000)], onEnter: null } },
    });
    await runServers("ws1");
    expect(useStore.getState().workspaces[0].active).toBe(1); // focused the server tab
    expect(useStore.getState().workspaces[0].tabs.length).toBe(2); // no new tab created
  });

  it("already up but wsId is NOT the active workspace -> does not change the active tab", async () => {
    const serverPane = mkPane({ ptyId: "p1" });
    const workTab = mkGroup({ id: 1 });
    const serverTab = mkGroup({ id: 2, panes: [serverPane] });
    resetStore({
      workspaces: [
        mkWs({ id: "ws1", tabs: [workTab, serverTab], active: 0, serverTabId: 2 }),
        mkWs({ id: "ws2", dir: "/other", repoId: "/other" }),
      ],
      activeWs: "ws2", // ws1 is not the focused workspace
      serverStatus: { p1: "alive" },
      userScripts: { "/repo": { scripts: [PORT_SCRIPT("web", 3000)], onEnter: null } },
    });
    await runServers("ws1");
    expect(useStore.getState().workspaces[0].active).toBe(0); // untouched
  });

  it("stale server tab (down) -> kills lingering PTYs, drops the tab, then starts a fresh one", async () => {
    const deadPane = mkPane({ ptyId: "pty-stale" });
    const staleTab = mkGroup({ id: 2, panes: [deadPane] });
    const workTab = mkGroup({ id: 1 });
    resetStore({
      workspaces: [mkWs({ id: "ws1", tabs: [workTab, staleTab], active: 1, serverTabId: 2 })],
      activeWs: "ws1",
      serverStatus: { "pty-stale": "dead" }, // down -> not "up"
      userScripts: { "/repo": { scripts: [PORT_SCRIPT("web", 3000)], onEnter: null } },
    });
    await withCapturedTimeoutsAsync(() => runServers("ws1"));

    // The stale pane's PTY was killed before the fresh tab was created.
    expect(tauri.calls().some((c) => c.cmd === "pty_kill" && c.args.id === "pty-stale")).toBe(true);

    const ws = useStore.getState().workspaces[0];
    // A brand-new server tab exists (different id from the stale one).
    expect(ws.serverTabId).not.toBe(2);
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(tab.panes.length).toBe(1);
    // The stale tab itself is gone.
    expect(ws.tabs.some((g) => g.id === 2)).toBe(false);
  });
});

/** Run `fn` with setTimeout captured, then immediately resolve every captured retry. */
async function withCapturedTimeoutsAsync(fn: () => Promise<void>) {
  const queue: Array<() => void> = [];
  const orig = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((cb: () => void) => {
    queue.push(cb);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await fn();
  } finally {
    globalThis.setTimeout = orig;
  }
  // Figure out which workspace(s) got a fresh tab and flip their panes ready, then drain.
  for (const ws of useStore.getState().workspaces) {
    if (ws.serverTabId == null) continue;
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
    if (!tab) continue;
    for (const pane of tab.panes) {
      if (!pane.ready) {
        useStore.getState().setPaneRuntime(pane.id, { ptyId: `pty-${pane.id}`, isZsh: false });
        useStore.getState().setReady(pane.id);
      }
    }
  }
  while (queue.length) queue.shift()!();
}

// ── stopServers ───────────────────────────────────────────────────────────────

describe("stopServers", () => {
  it("no-op when the workspace id is unknown", async () => {
    resetStore({ workspaces: [mkWs({ id: "ws1" })], activeWs: "ws1" });
    await stopServers("does-not-exist");
    expect(tauri.calls().some((c) => c.cmd === "pty_kill")).toBe(false);
  });

  it("no-op when serverTabId is already null", async () => {
    resetStore({ workspaces: [mkWs({ id: "ws1", serverTabId: null })], activeWs: "ws1" });
    await stopServers("ws1");
    expect(tauri.calls().some((c) => c.cmd === "pty_kill")).toBe(false);
  });

  it("kills server PTYs, clears their status, drops the tab, and stops the poll", async () => {
    const p1 = mkPane({ ptyId: "pty-a" });
    const p2 = mkPane({ ptyId: "pty-b" });
    const serverTab = mkGroup({ id: 2, panes: [p1, p2] });
    const workTab = mkGroup({ id: 1 });
    resetStore({
      workspaces: [mkWs({ id: "ws1", tabs: [workTab, serverTab], active: 1, serverTabId: 2 })],
      activeWs: "ws1",
      serverStatus: { "pty-a": "alive", "pty-b": "alive" },
    });

    await stopServers("ws1");

    const killed = tauri.calls().filter((c) => c.cmd === "pty_kill").map((c) => c.args.id).sort();
    expect(killed).toEqual(["pty-a", "pty-b"]);
    expect(useStore.getState().serverStatus).toEqual({});
    const ws = useStore.getState().workspaces[0];
    expect(ws.serverTabId).toBeNull();
    expect(ws.tabs.some((g) => g.id === 2)).toBe(false);
  });

  it("does not stop the poll while another workspace still has a server tab up", async () => {
    const p1 = mkPane({ ptyId: "pty-a" });
    const serverTab1 = mkGroup({ id: 2, panes: [p1] });
    const p2 = mkPane({ ptyId: "pty-c" });
    const serverTab2 = mkGroup({ id: 4, panes: [p2] });
    resetStore({
      workspaces: [
        mkWs({ id: "ws1", tabs: [mkGroup({ id: 1 }), serverTab1], active: 1, serverTabId: 2 }),
        mkWs({ id: "ws2", dir: "/other", repoId: "/other", tabs: [mkGroup({ id: 3 }), serverTab2], active: 1, serverTabId: 4 }),
      ],
      activeWs: "ws1",
    });

    // Start the poll for real, intercepting setInterval so we can observe clearInterval.
    let cleared = 0;
    const origClear = globalThis.clearInterval;
    const origSet = globalThis.setInterval;
    (globalThis as unknown as { setInterval: unknown }).setInterval = ((cb: () => void) => {
      void cb;
      return 12345 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = (() => {
      cleared++;
    }) as typeof clearInterval;
    try {
      ensureServerPoll();
      await stopServers("ws1"); // ws2 still has a server tab -> poll must keep running
      expect(cleared).toBe(0);
    } finally {
      globalThis.setInterval = origSet;
      globalThis.clearInterval = origClear;
      stopPoll();
    }
  });
});

// ── ensureServerPoll / stopPoll (D8 liveness poll) ────────────────────────────

describe("ensureServerPoll / stopPoll", () => {
  let capturedTick: (() => Promise<void>) | null;
  let clearCalls: unknown[];
  let origSetInterval: typeof globalThis.setInterval;
  let origClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    capturedTick = null;
    clearCalls = [];
    origSetInterval = globalThis.setInterval;
    origClearInterval = globalThis.clearInterval;
    (globalThis as unknown as { setInterval: unknown }).setInterval = ((cb: () => Promise<void>) => {
      capturedTick = cb;
      return 4242 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = ((id: unknown) => {
      clearCalls.push(id);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    stopPoll();
  });

  it("is idempotent — a second call does not start a second interval", () => {
    ensureServerPoll();
    expect(capturedTick).not.toBeNull();
    let calls = 0;
    const orig = globalThis.setInterval;
    globalThis.setInterval = (() => {
      calls++;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    ensureServerPoll();
    globalThis.setInterval = orig;
    expect(calls).toBe(0);
  });

  it("a tick probes every server pane's ptyId and writes the result into store.serverStatus", async () => {
    const p1 = mkPane({ ptyId: "pty-1" });
    const p2 = mkPane({ ptyId: "pty-2" });
    const serverTab = mkGroup({ id: 2, panes: [p1, p2] });
    resetStore({
      workspaces: [mkWs({ id: "ws1", tabs: [mkGroup({ id: 1 }), serverTab], active: 1, serverTabId: 2 })],
      activeWs: "ws1",
    });
    tauri.invoke({ pty_server_status: (a) => (a.id === "pty-1" ? "alive" : "dead") });

    ensureServerPoll();
    expect(capturedTick).not.toBeNull();
    await capturedTick!();

    expect(useStore.getState().serverStatus).toEqual({ "pty-1": "alive", "pty-2": "dead" });
  });

  it("a tick stops the poll (clearInterval) when no workspace has a server tab", async () => {
    resetStore({ workspaces: [mkWs({ id: "ws1", serverTabId: null })], activeWs: "ws1" });
    ensureServerPoll();
    await capturedTick!();
    expect(clearCalls).toEqual([4242]);
  });

  it("a tick skips panes without a ptyId and ignores a failed probe", async () => {
    const noPty = mkPane({ ptyId: null });
    const failing = mkPane({ ptyId: "pty-fail" });
    const serverTab = mkGroup({ id: 2, panes: [noPty, failing] });
    resetStore({
      workspaces: [mkWs({ id: "ws1", tabs: [mkGroup({ id: 1 }), serverTab], active: 1, serverTabId: 2 })],
      activeWs: "ws1",
    });
    tauri.invoke({
      pty_server_status: () => {
        throw new Error("session gone");
      },
    });
    ensureServerPoll();
    await expect(capturedTick!()).resolves.toBeUndefined();
    // Failure is swallowed — nothing written for the failing pane.
    expect(useStore.getState().serverStatus["pty-fail"]).toBeUndefined();
  });

  it("discards a write when the pane's tab was dropped while the probe was still in-flight", async () => {
    const p1 = mkPane({ ptyId: "pty-race" });
    const serverTab = mkGroup({ id: 2, panes: [p1] });
    resetStore({
      workspaces: [mkWs({ id: "ws1", tabs: [mkGroup({ id: 1 }), serverTab], active: 1, serverTabId: 2 })],
      activeWs: "ws1",
    });

    let resolveProbe!: (s: string) => void;
    tauri.invoke({ pty_server_status: () => new Promise((res) => (resolveProbe = res as (s: string) => void)) });

    ensureServerPoll();
    const tickPromise = capturedTick!();

    // Drop the server tab while the probe is still pending (race regression guard).
    useStore.getState().dropServerTab("ws1");

    resolveProbe("dead");
    await tickPromise;

    expect(useStore.getState().serverStatus["pty-race"]).toBeUndefined();
  });
});
