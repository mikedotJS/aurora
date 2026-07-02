/// <reference types="bun-types" />
/**
 * Tests — workspace-run-servers (phase 6)
 *
 * 6.1 portScripts        — pure function, static import, zero mocks.
 * 6.2 serversUp          — pure selector, plain object fixtures, no store.
 * 6.3 runServers map/cap — inline store + pty mock.
 * 6.4 stopServers        — inline store + pty mock.
 * 6.5 idempotence        — inline store + pty mock.
 *
 * Mock strategy (guards against bun process-global mock leaks):
 *
 *  - 6.1 / 6.2: pure functions — no mocks at all.
 *
 *  - 6.3 – 6.5: bun's mock.module() is process-global WHILE a file's tests are
 *    running, but bun test automatically un-registers a file's own mock.module()
 *    calls once that file finishes (verified empirically) — so teardown.test.ts's
 *    "../src/state/store" stripped shim (no setState, no createWorkspace, etc.)
 *    does not leak in here. This file still re-registers that path with a richer
 *    inline store so servers.ts/scripts.ts see the right API while ITS OWN tests
 *    run, regardless of file execution order.
 *
 *    Rule: only mock LEAVES (pty). Tauri/xterm/theme are already fully stubbed
 *    by the preload (test/setup.ts) — no per-file mock needed for those.
 *    "../src/lib/*" is NOT mocked — the real runServerScript/scriptsForRoot are
 *    used; only the Tauri-calling pty leaf is intercepted.
 */

// ── 6.1 / 6.7 static imports — must precede all mock.module() calls ──────────
import { portScripts, serverUnits } from "../src/lib/ports.ts";
import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// ═══════════════════════════════════════════════════════════════════════════════
// Inline store — overrides teardown.test.ts's stripped mock so both single-file
// and full-suite runs see the same richer implementation.
// Only implements what servers.ts / scripts.ts actually call.
// ═══════════════════════════════════════════════════════════════════════════════

let _paneSeq = 5000;
let _groupSeq = 5000;
let _blockSeq = 5000;
let _notifSeq = 0;
let _wsSeq = 1;

interface MockPane {
  id: number;
  ptyId: string | null;
  ptyEpoch: number;
  cwd: string;
  repoRoot: string | null;
  ready: boolean;
  exited: boolean;
  blocks: { id: number; command: string; cwd: string; running: boolean; exitCode: number | null; output: string }[];
}
interface MockGroup { id: number; panes: MockPane[]; active: number; split: "h" | "v" }
interface MockWs { id: string; repoId: string | null; dir: string; tabs: MockGroup[]; active: number; serverTabId: number | null }

let _workspaces: MockWs[] = [];
let _userScripts: Record<string, { scripts: any[]; onEnter: string | null }> = {};
let _notifLog: any[] = [];
let _activeWs = "";
let _selectTabCalls: number[] = [];
let _serverStatus: Record<string, string> = {};
// Runtime-only per-pane foreground signal (sticky-running-server-tabs / running.ts poll).
let _foregroundState: Record<string, { running: boolean; pgid: number | null }> = {};
// When true, _newPane creates panes that are already ready (ptyId set).
// Lets runWhenReady fire send() synchronously — needed for command-content assertions.
let _panesReadyOnCreate = false;

function _newPane(cwd: string, repoRoot: string | null = null): MockPane {
  const id = _paneSeq++;
  return {
    id,
    ptyId: _panesReadyOnCreate ? `pty-auto-${id}` : null,
    ptyEpoch: 0, cwd, repoRoot,
    ready: _panesReadyOnCreate,
    exited: false, blocks: [],
  };
}
function _newGroup(cwd: string, repoRoot: string | null = null): MockGroup {
  return { id: _groupSeq++, panes: [_newPane(cwd, repoRoot)], active: 0, split: "h" };
}

function _findPane(s: { workspaces: MockWs[] }, id: number): MockPane | undefined {
  for (const w of s.workspaces) for (const g of w.tabs) for (const p of g.panes) if (p.id === id) return p;
  return undefined;
}

function _patchPane(paneId: number, patch: any) {
  const s = { workspaces: _workspaces };
  const pane = _findPane(s, paneId);
  if (!pane) return;
  const update = typeof patch === "function" ? patch(pane) : patch;
  // Spread-style update (replace entire `blocks` array when provided)
  for (const k of Object.keys(update)) (pane as any)[k] = update[k];
}

const _createWorkspace = (opts: { repoId: string | null; title: string; dir: string; branch: string | null }): string => {
  const id = `w${_wsSeq++}-test`;
  _workspaces.push({ id, repoId: opts.repoId, dir: opts.dir, tabs: [_newGroup(opts.dir, opts.repoId)], active: 0, serverTabId: null });
  _activeWs = id;
  return id;
};

const _prepareServerTab = (wsId: string, n: number) => {
  const ws = _workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const count = Math.min(4, Math.max(1, n));
  // (a) Remove stale server tab if any — no length guard; fresh tab is appended next,
  // so a momentary empty array is safe and prevents zombie stale tabs.
  if (ws.serverTabId != null) {
    const idx = ws.tabs.findIndex((g) => g.id === ws.serverTabId);
    if (idx !== -1) ws.tabs.splice(idx, 1);
  }
  // (b) Fresh group with count panes
  const group = _newGroup(ws.dir, ws.repoId);
  for (let i = 1; i < count; i++) group.panes.push(_newPane(ws.dir, ws.repoId));
  // (c) Append, switch active, record id
  ws.tabs.push(group);
  ws.active = ws.tabs.length - 1;
  ws.serverTabId = group.id;
};

const _dropServerTab = (wsId: string) => {
  const ws = _workspaces.find((w) => w.id === wsId);
  if (!ws || ws.serverTabId == null) return;

  // Clear serverStatus for dropped panes (mirrors the real store's dropServerTab).
  const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
  if (tab) {
    for (const p of tab.panes) {
      if (p.ptyId) delete (_serverStatus as any)[p.ptyId];
    }
  }

  const idx = ws.tabs.findIndex((g) => g.id === ws.serverTabId);
  if (idx === -1) { ws.serverTabId = null; return; }
  // Last tab: replace with a fresh work group so the workspace always has a usable tab
  // and serversUp() returns false (serverTabId → null).
  if (ws.tabs.length <= 1) {
    ws.tabs = [_newGroup(ws.dir, ws.repoId)];
    ws.active = 0;
    ws.serverTabId = null;
    return;
  }
  ws.tabs.splice(idx, 1);
  if (idx < ws.active) ws.active -= 1;
  else if (idx === ws.active) ws.active = Math.min(ws.active, ws.tabs.length - 1);
  ws.serverTabId = null;
};

const _getState = () => ({
  workspaces: _workspaces,
  userScripts: _userScripts,
  notifLog: _notifLog,
  activeWs: _activeWs,
  createWorkspace: _createWorkspace,
  prepareServerTab: _prepareServerTab,
  dropServerTab: _dropServerTab,
  setUserScripts: (m: any) => { _userScripts = m; },
  setPaneRuntime: (paneId: number, rt: { ptyId: string; isZsh: boolean }) => {
    _patchPane(paneId, { ptyId: rt.ptyId });
  },
  startBlock: (paneId: number, command: string, cwd: string) => {
    _patchPane(paneId, (p: MockPane) => {
      const blocks = p.blocks.map((b) => (b.running ? { ...b, running: false } : b));
      blocks.push({ id: _blockSeq++, command, cwd, output: "", exitCode: null, running: true });
      return { blocks };
    });
  },
  endBlock: (paneId: number, exitCode: number | null) => {
    _patchPane(paneId, (p: MockPane) => {
      if (!p.blocks.length) return {};
      const blocks = p.blocks.slice();
      const last = blocks[blocks.length - 1];
      if (!last.running) return {};
      blocks[blocks.length - 1] = { ...last, running: false, exitCode };
      return { blocks };
    });
  },
  newTab: () => {
    const ws = _workspaces.find((w) => w.id === _activeWs);
    if (!ws) return;
    ws.tabs.push(_newGroup(ws.dir, ws.repoId));
    ws.active = ws.tabs.length - 1;
  },
  selectTab: (i: number) => { _selectTabCalls.push(i); },
  notify: (n: any) => { _notifLog.unshift({ ...n, id: ++_notifSeq, ts: Date.now() }); },
  respawnPane: (_paneId: number) => {},
  // Runtime-only server liveness map (D3 revised / D8 poll)
  serverStatus: _serverStatus,
  setServerStatus: (ptyId: string, s: string) => { _serverStatus = { ..._serverStatus, [ptyId]: s }; },
  clearServerStatus: (ptyIds: string[]) => {
    _serverStatus = { ..._serverStatus };
    for (const id of ptyIds) delete (_serverStatus as any)[id];
  },
  // Runtime-only per-pane foreground signal (sticky-running-server-tabs, tier 1 —
  // src/lib/running.ts's generalised poll writes/reads this alongside serverStatus).
  foregroundState: _foregroundState,
  setForegroundState: (ptyId: string, s: { running: boolean; pgid: number | null }) => {
    _foregroundState = { ..._foregroundState, [ptyId]: s };
  },
  clearForegroundState: (ptyIds: string[]) => {
    _foregroundState = { ..._foregroundState };
    for (const id of ptyIds) delete (_foregroundState as any)[id];
  },
  // Extra no-ops for completeness (scripts.ts may call these via other paths)
  appendOutput: () => {},
  markCapture: () => {},
});

// ── Controllable mocks for pty leaf (kill, captureServerPgid, serverStatus) ──
const ptyKillMock = mock((): Promise<void> => Promise.resolve());
const ptyCaptureServerPgidMock = mock((_id: string): Promise<void> => Promise.resolve());
const ptyServerStatusMock = mock((_id: string): Promise<string> => Promise.resolve("alive"));
// running.ts's generalised poll (D8, re-exported here as ensureServerPoll/stopPoll)
// probes BOTH serverStatus and foregroundState per pane each tick — mock both leaves.
const ptyForegroundStateMock = mock(
  (_id: string): Promise<{ running: boolean; pgid: number | null }> =>
    Promise.resolve({ running: false, pgid: null }),
);

// ── All mock.module() calls must come before any dynamic import ───────────────

// Override the store mock that teardown.test.ts registered (process-global leak fix).
mock.module("../src/state/store", () => ({
  useStore: {
    getState: _getState,
    setState: (patch: any) => {
      const data = typeof patch === "function" ? patch(_getState()) : patch;
      if ("workspaces" in data) _workspaces = data.workspaces;
      if ("userScripts" in data) _userScripts = data.userScripts;
      if ("notifLog" in data) _notifLog = data.notifLog;
      if ("activeWs" in data) _activeWs = data.activeWs;
    },
    subscribe: () => () => {},
  },
  findPane: _findPane,
  activeGroup: (s: any) => { const w = s.workspaces.find((w: any) => w.id === s.activeWs); return w ? w.tabs[w.active] : undefined; },
  workspaceOfPane: (s: any, id: number) => {
    for (const w of s.workspaces) for (const g of w.tabs) for (const p of g.panes) if (p.id === id) return w;
    return undefined;
  },
}));

// The preload (test/setup.ts) already stubs every Tauri/xterm module and the
// real theme.ts applyTheme() works fine under happy-dom, so no per-file mocks
// are needed for those.
// pty is a Tauri-calling leaf; mock it so pty.kill/captureServerPgid/serverStatus are interceptable.
mock.module("../src/term/pty", () => ({
  pty: {
    kill: ptyKillMock,
    write: () => {},
    spawn: () => Promise.resolve(),
    captureServerPgid: ptyCaptureServerPgidMock,
    serverStatus: ptyServerStatusMock,
    foregroundState: ptyForegroundStateMock,
  },
}));

// bun test automatically un-registers a file's own mock.module() calls once
// that file's tests finish (verified empirically — no manual mock.restore()
// needed, and calling it here would double-pop bun's internal mock stack and
// corrupt state for later real-store files).

// ── Dynamic imports after all mocks are registered ───────────────────────────
const { serversUp, runServers, stopServers, ensureServerPoll, stopPoll } = await import("../src/lib/servers.ts");
const { runServerScript } = await import("../src/lib/scripts.ts");

// ── Shared test constants ─────────────────────────────────────────────────────
const REPO_ID = "/repo/test-project";
const WS_DIR = "/repo/test-project/.aurora-worktrees/feat";

const SCRIPT_DEV = { name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "next dev --port $((3000 + AURORA_PORT_OFFSET))" }] };
const SCRIPT_API = { name: "api", desc: "", split: false, tasks: [{ dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" }] };
const SCRIPT_TEST = { name: "test", desc: "", split: false, tasks: [{ dir: "", cmd: "bun test" }] };
const SCRIPT_DUAL_PORT = { name: "full-stack", desc: "", split: false, tasks: [
  { dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" },
  { dir: "", cmd: "nx serve web --port $((4200 + AURORA_PORT_OFFSET))" },
]};
const FIVE_SERVERS = Array.from({ length: 5 }, (_, i) => ({
  name: `srv${i}`, desc: "", split: false,
  tasks: [{ dir: "", cmd: `node server.js --port $((${4000 + i} + AURORA_PORT_OFFSET))` }],
}));

// Split-aware fixtures
const API_CMD = "nx serve api --port $((3333 + AURORA_PORT_OFFSET))";
const WELCOMER_CMD = "welcomer dev --port $((4210 + AURORA_PORT_OFFSET))";
const SCRIPT_SPLIT_TWO_SERVERS = {
  name: "api-welcomer", desc: "", split: true,
  tasks: [{ dir: "", cmd: API_CMD }, { dir: "", cmd: WELCOMER_CMD }],
};
const SCRIPT_SPLIT_ONE_TASK = {
  name: "single-split", desc: "", split: true,
  tasks: [{ dir: "", cmd: "next dev --port $((3000 + AURORA_PORT_OFFSET))" }],
};
// Non-split, 2 tasks (second task binds port) — tasks should chain with &&.
const SCRIPT_NO_SPLIT_TWO_TASKS = {
  name: "build-serve", desc: "", split: false,
  tasks: [
    { dir: "", cmd: "bun build --outdir dist" },
    { dir: "", cmd: "serve dist --port $((3000 + AURORA_PORT_OFFSET))" },
  ],
};

// ── Minimal fixtures for 6.2 / 10.1 pure tests (no store involved) ────────────
function makeBlock(running: boolean) { return { id: 1, command: "cmd", cwd: "/", output: "", exitCode: null, running }; }
function makePane(id: number, blocks: ReturnType<typeof makeBlock>[] = [], ptyId: string | null = null) {
  return { id, ptyId, blocks };
}
function makeGroup(id: number, panes: ReturnType<typeof makePane>[]) { return { id, panes, active: 0, split: "h" as const }; }
function makeWs(overrides: Record<string, unknown> = {}) {
  return { serverTabId: null as number | null, tabs: [] as ReturnType<typeof makeGroup>[], ...overrides };
}

// ── Reset inline store + pty mock between tests ───────────────────────────────
beforeEach(() => {
  // Stop any poll left running from a previous test BEFORE clearing workspaces,
  // so the interval callback doesn't fire on stale state.
  stopPoll();
  _workspaces = [];
  _userScripts = {};
  _notifLog = [];
  _activeWs = "";
  _wsSeq = 1;
  _paneSeq = 5000;
  _groupSeq = 5000;
  _blockSeq = 5000;
  _notifSeq = 0;
  _selectTabCalls = [];
  _serverStatus = {};
  _foregroundState = {};
  _panesReadyOnCreate = false;
  ptyKillMock.mockReset();
  ptyKillMock.mockImplementation(() => Promise.resolve());
  ptyCaptureServerPgidMock.mockReset();
  ptyCaptureServerPgidMock.mockImplementation(() => Promise.resolve());
  ptyServerStatusMock.mockReset();
  ptyServerStatusMock.mockImplementation(() => Promise.resolve("alive"));
  ptyForegroundStateMock.mockReset();
  ptyForegroundStateMock.mockImplementation(() => Promise.resolve({ running: false, pgid: null }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.1  portScripts — pure function, static import, no mock needed
// ═══════════════════════════════════════════════════════════════════════════════

describe("portScripts — server identification", () => {
  it("includes a script with $((3000 + AURORA_PORT_OFFSET))", () => {
    const result = portScripts([SCRIPT_DEV]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("dev");
  });

  it("a script binding two ports appears exactly once (one server = one pane)", () => {
    const result = portScripts([SCRIPT_DUAL_PORT]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("full-stack");
  });

  it("excludes a script with no $((N + AURORA_PORT_OFFSET)) pattern", () => {
    expect(portScripts([SCRIPT_TEST])).toHaveLength(0);
  });

  it("a fixed port number (not the offset pattern) does not match", () => {
    const scripts = [{ name: "serve", tasks: [{ dir: "", cmd: "next dev --port 3000" }] }];
    expect(portScripts(scripts)).toHaveLength(0);
  });

  it("empty input → empty output", () => {
    expect(portScripts([])).toEqual([]);
  });

  it("returns only the port-scripts from a mixed array", () => {
    const result = portScripts([SCRIPT_TEST, SCRIPT_DEV, SCRIPT_API]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(["dev", "api"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.2  serversUp — pure selector, plain object fixtures, no store
// ═══════════════════════════════════════════════════════════════════════════════

describe("serversUp — pure selector", () => {
  it("returns false when serverTabId is null", () => {
    expect(serversUp(makeWs() as any)).toBe(false);
  });

  it("returns false when the tab matching serverTabId no longer exists", () => {
    const ws = makeWs({
      serverTabId: 99,
      tabs: [makeGroup(1, [makePane(10, [makeBlock(true)])])], // tab id 1, not 99
    });
    expect(serversUp(ws as any)).toBe(false);
  });

  it("returns false when all server panes' last blocks have running=false", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(false)]), makePane(12, [makeBlock(false)])])],
    });
    expect(serversUp(ws as any)).toBe(false);
  });

  it("returns true when at least one pane's last block has running=true", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(false)]), makePane(12, [makeBlock(true)])])],
    });
    expect(serversUp(ws as any)).toBe(true);
  });

  it("returns true for a single-server tab with one running block", () => {
    const ws = makeWs({
      serverTabId: 7,
      tabs: [makeGroup(7, [makePane(20, [makeBlock(true)])])],
    });
    expect(serversUp(ws as any)).toBe(true);
  });

  it("returns false when the server tab exists but panes have no blocks", () => {
    const ws = makeWs({
      serverTabId: 7,
      tabs: [makeGroup(7, [makePane(20, [])])],
    });
    expect(serversUp(ws as any)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.3  runServers — pane count = min(4, serverCount)
// ═══════════════════════════════════════════════════════════════════════════════

describe("runServers — mapping and pane cap", () => {
  it("k=1 → 1 server pane, serverTabId set", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    expect(ws.serverTabId).not.toBeNull();
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId);
    expect(serverTab?.panes).toHaveLength(1);
  });

  it("k=2 → 2 server panes", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV, SCRIPT_API], onEnter: null } };

    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId);
    expect(serverTab?.panes).toHaveLength(2);
  });

  it("k=5 (>4) → exactly 4 server panes (cap enforced)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: FIVE_SERVERS, onEnter: null } };

    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId);
    expect(serverTab?.panes).toHaveLength(4);
  });

  it("k=5 does not throw and notifies about the excess", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: FIVE_SERVERS, onEnter: null } };

    expect(() => runServers(wsId)).not.toThrow();

    expect(_notifLog.length).toBeGreaterThan(0);
    expect(_notifLog[0].headline).toMatch(/not started/i);
  });

  it("no-op when no port-scripts exist (serverTabId stays null)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_TEST], onEnter: null } };

    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    expect(ws.serverTabId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.4  stopServers — kills PTYs, drops server tab, leaves workspace intact
// ═══════════════════════════════════════════════════════════════════════════════

describe("stopServers — kills PTYs and drops the server tab", () => {
  it("calls pty.kill for each server pane that has a ptyId", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 2);

    const ws1 = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws1.tabs.find((g) => g.id === ws1.serverTabId)!;
    const [pane0, pane1] = serverTab.panes;
    pane0.ptyId = "pty-srv-0";
    pane1.ptyId = "pty-srv-1";

    await stopServers(wsId);

    const killed = (ptyKillMock.mock.calls as string[][]).map((c) => c[0]).sort();
    expect(killed).toEqual(["pty-srv-0", "pty-srv-1"]);
  });

  it("clears serverTabId after stopping", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);

    await stopServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    expect(ws.serverTabId).toBeNull();
  });

  it("leaves the workspace and its non-server tabs intact", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    // Add two user working tabs
    const ws = _workspaces.find((w) => w.id === wsId)!;
    ws.tabs.push(_newGroup(WS_DIR, REPO_ID));
    ws.tabs.push(_newGroup(WS_DIR, REPO_ID));
    const userTabIds = ws.tabs.map((g) => g.id);

    _prepareServerTab(wsId, 1);
    await stopServers(wsId);

    const wsAfter = _workspaces.find((w) => w.id === wsId);
    expect(wsAfter).toBeDefined();
    const remainingIds = wsAfter!.tabs.map((g) => g.id);
    for (const id of userTabIds) expect(remainingIds).toContain(id);
  });

  it("does NOT remove the workspace from the store", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);
    const wsIdsBefore = _workspaces.map((w) => w.id);

    await stopServers(wsId);

    expect(_workspaces.map((w) => w.id)).toEqual(wsIdsBefore);
  });

  it("is a no-op when serverTabId is already null (servers already down)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });

    await stopServers(wsId);

    expect(ptyKillMock.mock.calls.length).toBe(0);
  });

  it("skips panes whose ptyId is null (shells never spawned)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 2);
    // Both panes have ptyId = null by default

    await stopServers(wsId);

    expect(ptyKillMock.mock.calls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.5  Idempotence and self-heal
// ═══════════════════════════════════════════════════════════════════════════════

describe("runServers — idempotence and self-heal", () => {
  it("does NOT open a second tab when servers are already up", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    // First call — creates the server tab
    await runServers(wsId);

    const ws1 = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws1.tabs.find((g) => g.id === ws1.serverTabId)!;
    const tabCountAfterFirst = ws1.tabs.length;
    const serverTabIdFirst = ws1.serverTabId;

    // Simulate a running server: add a running block to the server pane
    _getState().startBlock(serverTab.panes[0].id, "next dev", WS_DIR);
    const ws2 = _workspaces.find((w) => w.id === wsId)!;
    expect(serversUp(ws2 as any)).toBe(true); // guard: servers are up

    // Second call — must be a no-op
    await runServers(wsId);

    const ws3 = _workspaces.find((w) => w.id === wsId)!;
    expect(ws3.tabs).toHaveLength(tabCountAfterFirst);
    expect(ws3.serverTabId).toBe(serverTabIdFirst);
  });

  it("drops the stale tab and opens a fresh one after a server crash (self-heal)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    // First run
    await runServers(wsId);
    const ws1 = _workspaces.find((w) => w.id === wsId)!;
    const staleServerTabId = ws1.serverTabId!;
    const stalePane = ws1.tabs.find((g) => g.id === staleServerTabId)!.panes[0];

    // Server started then crashed (block done, running=false)
    _getState().startBlock(stalePane.id, "next dev", WS_DIR);
    _getState().endBlock(stalePane.id, 1); // non-zero exit

    const ws2 = _workspaces.find((w) => w.id === wsId)!;
    expect(serversUp(ws2 as any)).toBe(false); // stale
    expect(ws2.serverTabId).not.toBeNull(); // tab id still recorded

    // Self-heal run
    await runServers(wsId);

    const ws3 = _workspaces.find((w) => w.id === wsId)!;
    expect(ws3.serverTabId).not.toBeNull(); // a server tab is tracked again
    expect(ws3.serverTabId).not.toBe(staleServerTabId); // it is a NEW group
  });

  it("calls pty.kill for straggler PTYs in the stale tab during self-heal", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    // First run
    await runServers(wsId);
    const ws1 = _workspaces.find((w) => w.id === wsId)!;
    const stalePane = ws1.tabs.find((g) => g.id === ws1.serverTabId)!.panes[0];

    // Give the pane a ptyId (straggler shell) then mark server done
    stalePane.ptyId = "pty-stale";
    _getState().startBlock(stalePane.id, "next dev", WS_DIR);
    _getState().endBlock(stalePane.id, 0);

    ptyKillMock.mockReset();
    ptyKillMock.mockImplementation(() => Promise.resolve());

    // Self-heal
    await runServers(wsId);

    const killedIds = (ptyKillMock.mock.calls as string[][]).map((c) => c[0]);
    expect(killedIds).toContain("pty-stale");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.6  Regression — last-tab edge cases (the "toggle frozen on Stop" bug cluster)
// ═══════════════════════════════════════════════════════════════════════════════

describe("stopServers — server tab is the last tab", () => {
  it("serversUp→false, serverTabId→null, one fresh work tab remains, pty.kill called", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    // Run — creates [workTab, serverTab]
    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTabId = ws.serverTabId!;
    const serverTab = ws.tabs.find((g) => g.id === serverTabId)!;
    serverTab.panes[0].ptyId = "pty-last-tab";
    _getState().startBlock(serverTab.panes[0].id, "next dev", WS_DIR); // mark running

    // Remove all non-server tabs → server tab is now the LAST tab (reproduction of the bug)
    ws.tabs = ws.tabs.filter((g) => g.id === serverTabId);
    ws.active = 0;
    expect(ws.tabs).toHaveLength(1); // guard: really the last tab

    await stopServers(wsId);

    const ws2 = _workspaces.find((w) => w.id === wsId)!;
    expect(serversUp(ws2 as any)).toBe(false);          // toggle unblocked
    expect(ws2.serverTabId).toBeNull();                  // id cleared
    expect(ws2.tabs).toHaveLength(1);                    // still one usable tab
    expect(ws2.tabs[0].id).not.toBe(serverTabId);        // fresh tab, not the dead server tab
    expect(ptyKillMock.mock.calls.length).toBeGreaterThanOrEqual(1); // kill was called
  });
});

describe("runServers — selectTab scoped to active workspace", () => {
  it("does not call selectTab when wsId is not the active workspace (already up)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    // First call — brings servers up
    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    _getState().startBlock(serverTab.panes[0].id, "next dev", WS_DIR);
    expect(serversUp(ws as any)).toBe(true); // guard: servers must be up

    // Switch active workspace away from wsId
    const otherId = _createWorkspace({ repoId: REPO_ID, title: "Other", dir: WS_DIR, branch: null });
    _activeWs = otherId;
    _selectTabCalls = []; // reset after setup calls

    // runServers on a background (non-active) workspace — already up, should NOT selectTab
    await runServers(wsId);

    expect(_selectTabCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.7  serverUnits — pure function, static import, no mock needed
// ═══════════════════════════════════════════════════════════════════════════════

describe("serverUnits — split-aware pane expansion", () => {
  it("split script with 2 tasks → 2 units (taskIndex 0 and 1)", () => {
    const units = serverUnits([SCRIPT_SPLIT_TWO_SERVERS]);
    expect(units).toHaveLength(2);
    expect(units[0]).toEqual({ name: "api-welcomer", taskIndex: 0 });
    expect(units[1]).toEqual({ name: "api-welcomer", taskIndex: 1 });
  });

  it("non-split script with 2 tasks → 1 unit (taskIndex null)", () => {
    const units = serverUnits([SCRIPT_NO_SPLIT_TWO_TASKS]);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({ name: "build-serve", taskIndex: null });
  });

  it("split script with exactly 1 task → 1 unit (taskIndex null — no split)", () => {
    const units = serverUnits([SCRIPT_SPLIT_ONE_TASK]);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({ name: "single-split", taskIndex: null });
  });

  it("mix: split-2 + non-split → 3 units total", () => {
    const units = serverUnits([SCRIPT_SPLIT_TWO_SERVERS, SCRIPT_DEV]);
    expect(units).toHaveLength(3);
    expect(units[0]).toEqual({ name: "api-welcomer", taskIndex: 0 });
    expect(units[1]).toEqual({ name: "api-welcomer", taskIndex: 1 });
    expect(units[2]).toEqual({ name: "dev", taskIndex: null });
  });

  it("script with no port pattern → no units (portScripts gate)", () => {
    const script = { name: "test", split: true, tasks: [{ dir: "", cmd: "bun test" }, { dir: "", cmd: "lint" }] };
    expect(serverUnits([script])).toHaveLength(0);
  });

  it("empty input → empty units", () => {
    expect(serverUnits([])).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.8  runServers — split-aware: one pane per task for split scripts
// ═══════════════════════════════════════════════════════════════════════════════

describe("runServers — split-aware server pane allocation", () => {
  it("split script with 2 tasks → 2 panes opened", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_SPLIT_TWO_SERVERS], onEnter: null } };

    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    expect(ws.serverTabId).not.toBeNull();
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(serverTab.panes).toHaveLength(2);
  });

  it("split script with 2 tasks: each pane runs its own task only, no && joining both", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_SPLIT_TWO_SERVERS], onEnter: null } };

    // Ready panes → runWhenReady fires send() synchronously → startBlock records the command.
    _panesReadyOnCreate = true;
    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    const [pane0, pane1] = serverTab.panes;

    const cmd0 = pane0.blocks[pane0.blocks.length - 1]?.command ?? "";
    const cmd1 = pane1.blocks[pane1.blocks.length - 1]?.command ?? "";

    // Neither pane should chain both tasks with &&.
    expect(cmd0).not.toContain(API_CMD + " && " + WELCOMER_CMD);
    expect(cmd1).not.toContain(API_CMD + " && " + WELCOMER_CMD);

    // Each pane should contain exactly one of the two tasks.
    expect(cmd0).toContain("nx serve api");
    expect(cmd0).not.toContain("welcomer dev");

    expect(cmd1).toContain("welcomer dev");
    expect(cmd1).not.toContain("nx serve api");
  });

  it("non-split script with 2 tasks → 1 pane, tasks chained with &&", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_NO_SPLIT_TWO_TASKS], onEnter: null } };

    _panesReadyOnCreate = true;
    await runServers(wsId);

    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(serverTab.panes).toHaveLength(1);

    const cmd = serverTab.panes[0].blocks[serverTab.panes[0].blocks.length - 1]?.command ?? "";
    expect(cmd).toContain("&&");
    expect(cmd).toContain("bun build");
    expect(cmd).toContain("serve dist");
  });

  it("split script run twice is idempotent (second call is no-op when up)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_SPLIT_TWO_SERVERS], onEnter: null } };

    await runServers(wsId);
    const ws1 = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws1.tabs.find((g) => g.id === ws1.serverTabId)!;
    const tabCountAfterFirst = ws1.tabs.length;
    const serverTabIdFirst = ws1.serverTabId;

    // Mark both panes as running so serversUp → true.
    _getState().startBlock(serverTab.panes[0].id, "nx serve api", WS_DIR);
    _getState().startBlock(serverTab.panes[1].id, "welcomer dev", WS_DIR);
    expect(serversUp(ws1 as any)).toBe(true);

    await runServers(wsId);

    const ws2 = _workspaces.find((w) => w.id === wsId)!;
    expect(ws2.tabs).toHaveLength(tabCountAfterFirst);
    expect(ws2.serverTabId).toBe(serverTabIdFirst);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6.9  runServerScript — taskIndex dispatch (direct unit tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe("runServerScript — taskIndex single-task dispatch", () => {
  /** Create a workspace with a ready pane and return the pane. */
  function setupReadyPane(): MockPane {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    const ws = _workspaces.find((w) => w.id === wsId)!;
    const pane = ws.tabs[0].panes[0];
    pane.ready = true;
    pane.ptyId = "pty-direct-test";
    return pane;
  }

  it("taskIndex=0 runs only task 0, no && in command", () => {
    const pane = setupReadyPane();
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_SPLIT_TWO_SERVERS], onEnter: null } };

    runServerScript(pane.id, "api-welcomer", { lookupRoot: REPO_ID, execBase: WS_DIR, taskIndex: 0 });

    const cmd = pane.blocks[pane.blocks.length - 1]?.command ?? "";
    expect(cmd).toContain("nx serve api");
    expect(cmd).not.toContain("welcomer dev");
    expect(cmd).not.toContain("&&");
  });

  it("taskIndex=1 runs only task 1, no && in command", () => {
    const pane = setupReadyPane();
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_SPLIT_TWO_SERVERS], onEnter: null } };

    runServerScript(pane.id, "api-welcomer", { lookupRoot: REPO_ID, execBase: WS_DIR, taskIndex: 1 });

    const cmd = pane.blocks[pane.blocks.length - 1]?.command ?? "";
    expect(cmd).toContain("welcomer dev");
    expect(cmd).not.toContain("nx serve api");
    expect(cmd).not.toContain("&&");
  });

  it("no taskIndex chains all tasks with &&", () => {
    const pane = setupReadyPane();
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_NO_SPLIT_TWO_TASKS], onEnter: null } };

    runServerScript(pane.id, "build-serve", { lookupRoot: REPO_ID, execBase: WS_DIR });

    const cmd = pane.blocks[pane.blocks.length - 1]?.command ?? "";
    expect(cmd).toContain("&&");
    expect(cmd).toContain("bun build");
    expect(cmd).toContain("serve dist");
  });

  it("taskIndex out of range records a feedback error block", () => {
    const pane = setupReadyPane();
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_SPLIT_TWO_SERVERS], onEnter: null } };

    runServerScript(pane.id, "api-welcomer", { lookupRoot: REPO_ID, execBase: WS_DIR, taskIndex: 99 });

    // feedback() calls startBlock + endBlock with a non-zero exit code.
    const last = pane.blocks[pane.blocks.length - 1];
    expect(last?.exitCode).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10.1  serversUp(ws, status) — reliability matrix (D3 revised)
// Pure selector, plain object fixtures, no store interaction.
// ═══════════════════════════════════════════════════════════════════════════════

describe("serversUp(ws, status) — D3 reliability matrix", () => {
  it("alive → up (overrides block.running=false)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(false)], "pty-1")])],
    });
    expect(serversUp(ws as any, { "pty-1": "alive" })).toBe(true);
  });

  it("capturing → up (no flash during boot — block may be empty)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [], "pty-1")])],
    });
    expect(serversUp(ws as any, { "pty-1": "capturing" })).toBe(true);
  });

  it("dead → down (overrides block.running=true)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(true)], "pty-1")])],
    });
    expect(serversUp(ws as any, { "pty-1": "dead" })).toBe(false);
  });

  it("uncaptured + block running=true → up (fallback to block flag)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(true)], "pty-1")])],
    });
    expect(serversUp(ws as any, { "pty-1": "uncaptured" })).toBe(true);
  });

  it("uncaptured + block running=false → down (fallback to block flag)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(false)], "pty-1")])],
    });
    expect(serversUp(ws as any, { "pty-1": "uncaptured" })).toBe(false);
  });

  it("status key absent → falls back to block.running (back-compat)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(true)], "pty-1")])],
    });
    // Empty status map → key absent → fallback to block running=true
    expect(serversUp(ws as any, {})).toBe(true);
  });

  it("status undefined → falls back to block.running for all panes (back-compat with 6.2)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [makePane(11, [makeBlock(true)], "pty-1")])],
    });
    expect(serversUp(ws as any, undefined)).toBe(true);
  });

  it("one pane alive, one pane dead → overall up (any wins)", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [
        makePane(11, [makeBlock(false)], "pty-a"),
        makePane(12, [makeBlock(false)], "pty-b"),
      ])],
    });
    // pty-a dead, pty-b alive → servers are still up
    expect(serversUp(ws as any, { "pty-a": "dead", "pty-b": "alive" })).toBe(true);
  });

  it("all panes dead → down", () => {
    const ws = makeWs({
      serverTabId: 5,
      tabs: [makeGroup(5, [
        makePane(11, [makeBlock(true)], "pty-a"),
        makePane(12, [makeBlock(true)], "pty-b"),
      ])],
    });
    expect(serversUp(ws as any, { "pty-a": "dead", "pty-b": "dead" })).toBe(false);
  });

  it("pane with null ptyId + no status entry → falls back to block.running", () => {
    // ptyId null → key "" → absent in status → fallback
    const ws = makeWs({
      serverTabId: 7,
      tabs: [makeGroup(7, [makePane(20, [makeBlock(true)])])], // ptyId = null
    });
    expect(serversUp(ws as any, {})).toBe(true); // fallback: block running=true
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10.2  Capture trigger — runServers calls captureServerPgid once per pane (D7)
// ═══════════════════════════════════════════════════════════════════════════════

describe("runServers — D7 capture trigger", () => {
  it("calls captureServerPgid once per launched server pane with its ptyId", async () => {
    // Panes ready on create → runWhenReady fires send() synchronously → onLaunched fires.
    _panesReadyOnCreate = true;
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV, SCRIPT_API], onEnter: null } };

    await runServers(wsId);

    // Should have called captureServerPgid once per pane (2 servers → 2 panes).
    expect(ptyCaptureServerPgidMock.mock.calls.length).toBe(2);

    // Verify the captured ptyIds match the actual server panes' ptyIds.
    const ws = _workspaces.find((w) => w.id === wsId)!;
    const serverTab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    const paneptyIds = serverTab.panes
      .map((p) => p.ptyId)
      .filter((id): id is string => id !== null)
      .sort();
    const capturedIds = (ptyCaptureServerPgidMock.mock.calls as [string][]).map(([id]) => id).sort();
    expect(capturedIds).toEqual(paneptyIds);
  });

  it("does NOT call captureServerPgid when panes are not ready (deferred launch)", async () => {
    // _panesReadyOnCreate = false → runWhenReady schedules a retry (async, not fired in test).
    _panesReadyOnCreate = false;
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _userScripts = { [REPO_ID]: { scripts: [SCRIPT_DEV], onEnter: null } };

    await runServers(wsId);

    // No capture yet: pane not ready → send() not called → onLaunched not invoked.
    expect(ptyCaptureServerPgidMock.mock.calls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10.3  Poll loop (ensureServerPoll) — lifecycle without real timers
// Strategy: intercept globalThis.setInterval / clearInterval to capture the tick
// callback; invoke it manually; verify writes to setServerStatus + interval cleanup.
// ═══════════════════════════════════════════════════════════════════════════════

describe("ensureServerPoll — D8 poll lifecycle", () => {
  let origSetInterval: typeof globalThis.setInterval;
  let origClearInterval: typeof globalThis.clearInterval;
  let capturedTick: (() => Promise<void>) | null;
  let clearIntervalCalls: unknown[];

  beforeEach(() => {
    origSetInterval = globalThis.setInterval;
    origClearInterval = globalThis.clearInterval;
    capturedTick = null;
    clearIntervalCalls = [];

    (globalThis as any).setInterval = (cb: () => Promise<void>, _ms: number) => {
      capturedTick = cb;
      return 9999; // fake handle
    };
    (globalThis as any).clearInterval = (id: unknown) => {
      clearIntervalCalls.push(id);
    };
  });

  afterEach(() => {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    // Defensive: ensure stopPoll resets module-level var in case a test left it set.
    stopPoll();
  });

  it("starts exactly one interval even if called multiple times", () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    const [pane] = ws.tabs.find((g) => g.id === ws.serverTabId)!.panes;
    pane.ptyId = "pty-poll-1";

    ensureServerPoll();
    ensureServerPoll(); // second call must be a no-op
    ensureServerPoll(); // third call must be a no-op

    // setInterval should have been called exactly once.
    expect(capturedTick).not.toBeNull();
    // Only one call — subsequent ensureServerPoll() calls are no-ops.
    // We verify by checking only one tick callback was captured (one setInterval call).
    let setIntervalCallCount = 0;
    const origMock = (globalThis as any).setInterval;
    (globalThis as any).setInterval = () => { setIntervalCallCount++; return 0; };
    ensureServerPoll(); // should be no-op since _pollInterval is already set
    (globalThis as any).setInterval = origMock;
    expect(setIntervalCallCount).toBe(0);
  });

  it("tick calls serverStatus for each server pane and writes setServerStatus", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 2);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    const [pane0, pane1] = ws.tabs.find((g) => g.id === ws.serverTabId)!.panes;
    pane0.ptyId = "pty-poll-a";
    pane1.ptyId = "pty-poll-b";

    ptyServerStatusMock.mockImplementation((id: string) =>
      Promise.resolve(id === "pty-poll-a" ? "alive" : "dead"),
    );

    ensureServerPoll();
    expect(capturedTick).not.toBeNull();

    // Manually fire the tick.
    await capturedTick!();

    // Both panes should have been probed.
    const probed = (ptyServerStatusMock.mock.calls as [string][]).map(([id]) => id).sort();
    expect(probed).toEqual(["pty-poll-a", "pty-poll-b"].sort());

    // setServerStatus should have been called with the results.
    expect(_serverStatus["pty-poll-a"]).toBe("alive");
    expect(_serverStatus["pty-poll-b"]).toBe("dead");
  });

  it("tick stops the interval when no server tabs remain", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    ws.tabs.find((g) => g.id === ws.serverTabId)!.panes[0].ptyId = "pty-poll-c";

    ensureServerPoll();

    // Drop the server tab (simulates stopServers completing).
    _dropServerTab(wsId);

    // Fire the tick — should detect no server tabs and call clearInterval.
    await capturedTick!();

    expect(clearIntervalCalls.length).toBe(1);
    expect(clearIntervalCalls[0]).toBe(9999);
  });

  // ── Race: probe in-flight while tab is dropped ──────────────────────────────
  //
  // Regression for the "slow serverStatus leak" finding:
  // The async probe (pty.serverStatus) may complete AFTER stopServers/dropServerTab
  // has already cleared the pane's entry. Without the liveness guard, the tick
  // would re-write "dead" into serverStatus[ptyId], creating a stale entry that
  // never gets cleaned up (map grows on every Run/Stop cycle).
  it("tick does not write serverStatus for a pane dropped while the probe was in-flight", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    ws.tabs.find((g) => g.id === ws.serverTabId)!.panes[0].ptyId = "pty-race";

    // Make the probe hang until we manually resolve it — simulates async latency.
    let resolveProbe!: (s: string) => void;
    ptyServerStatusMock.mockImplementation(
      () => new Promise<string>((res) => { resolveProbe = res; }),
    );

    ensureServerPoll();

    // Start the tick — it collects the pane and hangs waiting for the probe.
    const tickPromise = capturedTick!();

    // While the probe is still in-flight, drop the server tab (stopServers scenario).
    _dropServerTab(wsId);

    // Now resolve the probe with "dead" — the liveness guard must discard the write.
    resolveProbe("dead");
    await tickPromise;

    // The entry must NOT have been written: no stale "dead" in the map.
    expect(_serverStatus["pty-race"]).toBeUndefined();
  });

  it("tick DOES write serverStatus for a pane that is still live when probe resolves", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    ws.tabs.find((g) => g.id === ws.serverTabId)!.panes[0].ptyId = "pty-live";

    ptyServerStatusMock.mockImplementation(() => Promise.resolve("alive"));

    ensureServerPoll();
    await capturedTick!();

    // The tab is still live — write must have happened.
    expect(_serverStatus["pty-live"]).toBe("alive");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10.4  stopServers clears serverStatus for dropped panes (D9.7)
// ═══════════════════════════════════════════════════════════════════════════════

describe("stopServers — D9.7 clears serverStatus", () => {
  it("clears serverStatus entries for all stopped panes", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 2);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    const [pane0, pane1] = ws.tabs.find((g) => g.id === ws.serverTabId)!.panes;
    pane0.ptyId = "pty-stop-a";
    pane1.ptyId = "pty-stop-b";

    // Seed some status entries.
    _serverStatus["pty-stop-a"] = "alive";
    _serverStatus["pty-stop-b"] = "alive";

    await stopServers(wsId);

    expect(_serverStatus["pty-stop-a"]).toBeUndefined();
    expect(_serverStatus["pty-stop-b"]).toBeUndefined();
  });

  it("still calls pty.kill for each server pane (kill path unchanged)", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 2);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    const [pane0, pane1] = ws.tabs.find((g) => g.id === ws.serverTabId)!.panes;
    pane0.ptyId = "pty-kill-a";
    pane1.ptyId = "pty-kill-b";

    await stopServers(wsId);

    const killed = (ptyKillMock.mock.calls as unknown as [string][]).map(([id]) => id).sort();
    expect(killed).toEqual(["pty-kill-a", "pty-kill-b"].sort());
  });

  it("does not clear serverStatus for unrelated panes in other workspaces", async () => {
    const wsId = _createWorkspace({ repoId: REPO_ID, title: "T", dir: WS_DIR, branch: null });
    const ws2Id = _createWorkspace({ repoId: REPO_ID, title: "Other", dir: WS_DIR, branch: null });
    _prepareServerTab(wsId, 1);
    const ws = _workspaces.find((w) => w.id === wsId)!;
    ws.tabs.find((g) => g.id === ws.serverTabId)!.panes[0].ptyId = "pty-ws1";

    // Seed status for both workspaces.
    _serverStatus["pty-ws1"] = "alive";
    _serverStatus["pty-ws2"] = "capturing";

    await stopServers(wsId);

    // ws1's status cleared; ws2's status untouched.
    expect(_serverStatus["pty-ws1"]).toBeUndefined();
    expect(_serverStatus["pty-ws2"]).toBe("capturing");

    // cleanup
    void ws2Id;
  });
});
