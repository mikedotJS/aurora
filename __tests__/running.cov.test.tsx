// Coverage suite for src/lib/running.ts — the generic per-pane running signal
// (sticky-running-server-tabs): the pure 3-tier paneRunning() predicate, the
// tab-level helpers TabStrip uses, and the generalised ensurePtyPoll/stopPtyPoll
// (which servers.ts re-exports as ensureServerPoll/stopPoll — see servers.cov.test.tsx
// for the poll's pre-existing Servers-tab-scoped coverage; this file adds the cases
// specific to the generalisation: polling ANY live pane, and writing foregroundState).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace, type Group, type PaneState, type Block } from "../src/state/store";
import { paneRunning, tabRunning, tabRunningLabel, ensurePtyPoll, stopPtyPoll } from "../src/lib/running";

// ── Fixtures (mirrors __tests__/servers.cov.test.tsx) ────────────────────────

let paneIdSeq = 700000;

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

function mkGroup(overrides: Partial<Group> = {}): Group {
  return { id: 600000 + Math.floor(Math.random() * 100000), panes: [mkPane()], active: 0, split: "h", ...overrides };
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

function resetStore(patch: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState(
    {
      workspaces: [],
      activeWs: null,
      serverStatus: {},
      foregroundState: {},
      ...patch,
    } as Partial<ReturnType<typeof useStore.getState>>,
    false,
  );
}

// ── paneRunning — pure 3-tier predicate (no store/Tauri reads) ───────────────

describe("paneRunning", () => {
  it("is false with no status/fg and no running block (not-running case)", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(pane)).toBe(false);
  });

  it("is false for a pane with no blocks at all", () => {
    const pane = mkPane({ blocks: [] });
    expect(paneRunning(pane)).toBe(false);
  });

  // tier 1: foreground child
  it("tier 1 — true when fg.running is true, regardless of status/blocks", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(pane, "dead", { running: true, pgid: 4242 })).toBe(true);
  });

  it("tier 1 — false when fg is present but fg.running is false (falls through to lower tiers)", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(pane, undefined, { running: false, pgid: null })).toBe(false);
  });

  // tier 2: captured detached group still alive
  it("tier 2 — true when status is 'alive', even with fg not running and no running block", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(pane, "alive", { running: false, pgid: null })).toBe(true);
  });

  it("tier 2 — 'capturing'/'dead'/'uncaptured' do NOT count on their own (fall through to tier 3)", () => {
    const runningBlockPane = mkPane({ blocks: [mkBlock({ running: true })] });
    const idleBlockPane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(runningBlockPane, "capturing")).toBe(true); // via tier 3, not tier 2
    expect(paneRunning(idleBlockPane, "capturing")).toBe(false);
    expect(paneRunning(idleBlockPane, "dead")).toBe(false);
    expect(paneRunning(idleBlockPane, "uncaptured")).toBe(false);
  });

  // tier 3: OSC-133 block fallback
  it("tier 3 — true when the last block's running flag is true and tiers 1/2 don't apply", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false }), mkBlock({ id: 2, running: true })] });
    expect(paneRunning(pane)).toBe(true);
  });

  it("tier 3 — only the LAST block's flag matters, not an earlier one", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: true }), mkBlock({ id: 2, running: false })] });
    expect(paneRunning(pane)).toBe(false);
  });

  it("priority order: tier 1 wins over a status/block that would say not-running", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(pane, "dead", { running: true, pgid: 1 })).toBe(true);
  });

  it("priority order: tier 2 wins when tier 1 doesn't apply", () => {
    const pane = mkPane({ blocks: [mkBlock({ running: false })] });
    expect(paneRunning(pane, "alive", { running: false, pgid: null })).toBe(true);
  });

  // rawMode gating is Pane.tsx's job (`!pane.rawMode && running`), NOT paneRunning's.
  // Lock the contract: the predicate must stay rawMode-agnostic so a `vim`/`top`
  // pane's raw-mode prompt handling is untouched by this feature (proposal risk:
  // "rawMode programs are unaffected"). If paneRunning ever started reading
  // pane.rawMode, Pane.tsx's independent `!pane.rawMode` guard would silently
  // double up / drift instead of being the single source of truth.
  it("ignores pane.rawMode entirely — a rawMode pane with a running block still reports running (component gates rawMode separately)", () => {
    const rawPane = mkPane({ rawMode: true, blocks: [mkBlock({ running: true })] });
    expect(paneRunning(rawPane)).toBe(true);
    const rawPaneFg = mkPane({ rawMode: true, blocks: [mkBlock({ running: false })] });
    expect(paneRunning(rawPaneFg, undefined, { running: true, pgid: 99 })).toBe(true);
  });

  it("ignores pane.rawMode for the not-running case too (rawMode alone never flips the signal)", () => {
    const rawIdle = mkPane({ rawMode: true, blocks: [mkBlock({ running: false })] });
    expect(paneRunning(rawIdle)).toBe(false);
  });
});

// ── tabRunning / tabRunningLabel ──────────────────────────────────────────────

describe("tabRunning", () => {
  it("is false when no pane in the tab is running", () => {
    const tab = mkGroup({ panes: [mkPane({ ptyId: "p1" }), mkPane({ ptyId: "p2" })] });
    expect(tabRunning(tab, {}, {})).toBe(false);
  });

  it("is true when ANY pane in the tab is running (some())", () => {
    const tab = mkGroup({ panes: [mkPane({ ptyId: "p1" }), mkPane({ ptyId: "p2" })] });
    expect(tabRunning(tab, { p1: "dead", p2: "alive" }, {})).toBe(true);
  });

  it("handles a pane with no ptyId (never looked up in the maps)", () => {
    const tab = mkGroup({ panes: [mkPane({ ptyId: null, blocks: [mkBlock({ running: true })] })] });
    // no ptyId -> status/fg lookups skipped -> falls through to tier 3 (block flag)
    expect(tabRunning(tab, {}, {})).toBe(true);
  });
});

describe("tabRunningLabel", () => {
  it("prefers the auto-set Group.name when present", () => {
    const tab = mkGroup({ name: "dev + tests", panes: [mkPane({ ptyId: "p1" })] });
    expect(tabRunningLabel(tab, { p1: "alive" }, {})).toBe("dev + tests");
  });

  it("falls back to the running pane's command text when unnamed", () => {
    const runner = mkPane({ ptyId: "p1", blocks: [mkBlock({ command: "vite dev", running: false })] });
    const idle = mkPane({ ptyId: "p2", blocks: [mkBlock({ command: "ls", running: false })] });
    const tab = mkGroup({ panes: [idle, runner] });
    expect(tabRunningLabel(tab, { p1: "alive" }, {})).toBe("vite dev");
  });

  it("truncates a long command to 24 chars with an ellipsis", () => {
    const long = "nx serve my-really-long-app-name --no-tui --verbose";
    const runner = mkPane({ ptyId: "p1", blocks: [mkBlock({ command: long })] });
    const tab = mkGroup({ panes: [runner] });
    const label = tabRunningLabel(tab, { p1: "alive" }, {});
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBe(25); // 24 chars + ellipsis
  });

  it("falls back to a generic label when no running pane has a command", () => {
    const runner = mkPane({ ptyId: "p1" }); // no blocks at all
    const tab = mkGroup({ panes: [runner] });
    expect(tabRunningLabel(tab, {}, { p1: { running: true, pgid: 1 } })).toBe("process");
  });
});

// ── ensurePtyPoll / stopPtyPoll — generalisation-specific cases ──────────────
// (Servers-tab-scoped coverage of the SAME functions, re-exported by servers.ts
// as ensureServerPoll/stopPoll, already lives in servers.cov.test.tsx.)

describe("ensurePtyPoll / stopPtyPoll — generalised to every live pane", () => {
  let capturedTick: (() => Promise<void>) | null;
  let clearCalls: unknown[];
  let origSetInterval: typeof globalThis.setInterval;
  let origClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    tauri.reset();
    capturedTick = null;
    clearCalls = [];
    origSetInterval = globalThis.setInterval;
    origClearInterval = globalThis.clearInterval;
    (globalThis as unknown as { setInterval: unknown }).setInterval = ((cb: () => Promise<void>) => {
      capturedTick = cb;
      return 9999 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = ((id: unknown) => {
      clearCalls.push(id);
    }) as typeof clearInterval;
    resetStore();
  });

  afterEach(() => {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    stopPtyPoll();
  });

  it("probes a pane in an ORDINARY tab (not a Servers tab) and writes both maps", async () => {
    const pane = mkPane({ ptyId: "pty-plain" });
    resetStore({ workspaces: [mkWs({ id: "ws1", tabs: [mkGroup({ panes: [pane] })] })], activeWs: "ws1" });
    tauri.invoke({
      pty_foreground_state: () => ({ running: true, pgid: 555 }),
      pty_server_status: () => "uncaptured",
    });

    ensurePtyPoll();
    expect(capturedTick).not.toBeNull();
    await capturedTick!();

    expect(useStore.getState().foregroundState["pty-plain"]).toEqual({ running: true, pgid: 555 });
    expect(useStore.getState().serverStatus["pty-plain"]).toBe("uncaptured");
  });

  it("skips an exited pane even though it still has a ptyId", async () => {
    const pane = mkPane({ ptyId: "pty-dead", exited: true });
    resetStore({ workspaces: [mkWs({ id: "ws1", tabs: [mkGroup({ panes: [pane] })] })], activeWs: "ws1" });
    ensurePtyPoll();
    await capturedTick!();
    expect(clearCalls).toEqual([9999]); // nothing live to poll -> auto-stops
  });

  it("discards a stale write for a pane closed mid-probe (generalised across all workspaces)", async () => {
    const pane = mkPane({ ptyId: "pty-race" });
    resetStore({ workspaces: [mkWs({ id: "ws1", tabs: [mkGroup({ panes: [pane] })] })], activeWs: "ws1" });

    let resolveFg!: (v: { running: boolean; pgid: number | null }) => void;
    tauri.invoke({ pty_foreground_state: () => new Promise((res) => (resolveFg = res)) });

    ensurePtyPoll();
    const tick = capturedTick!();
    // Pane closes while the probe is still in-flight.
    resetStore({ workspaces: [], activeWs: null });
    resolveFg({ running: true, pgid: 1 });
    await tick;

    expect(useStore.getState().foregroundState["pty-race"]).toBeUndefined();
  });
});
