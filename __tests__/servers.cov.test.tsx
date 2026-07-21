// Coverage suite for src/lib/servers.ts — the managed-server-lifecycle Run/Stop
// orchestrator. Drives the REAL Zustand store (src/state/store.ts) with only
// the Tauri leaf mocked (server_spawn/status/stop/probe, read_text_file for
// aurora.json) via the shared test/mocks/tauri.ts control object.
//
// Reshaped for the corrected model ("1 command → 1 pane, 1 run script →
// multiple commands"): `scripts.run` is an ORDERED ARRAY of `RunCommand`, each
// entry keyed by its INDEX (`run:<i>`, via `runCommandId`) — not a Record
// keyed by script id. `run_mode`/`default`/`hide` no longer exist: a flat
// list is always launched concurrently, and `runOneRunCommand` replaces the
// old per-id `runServer`.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace, type Group, type PaneState, type Block } from "../src/state/store";
import {
  repoLabel,
  managedServerId,
  runCommandId,
  runCommandLabel,
  runCommands,
  serversUp,
  runningScriptIds,
  runOneRunCommand,
  runCustom,
  stopServer,
  runServers,
  stopServers,
  ensureServerPoll,
  stopServerPoll,
} from "../src/lib/servers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let paneIdSeq = 900000;

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
    serverId: null,
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

type RawRunCommand = { command: string; cwd?: string; name?: string };
type RawCustomScript = { command: string; cwd?: string };

/** A committed aurora.json's raw text, for tauri.invoke({read_text_file: ...}). */
function auroraJson(run: RawRunCommand[], opts: { setup?: string | null; custom?: Record<string, RawCustomScript> } = {}): string {
  return JSON.stringify({
    version: 1,
    scripts: {
      setup: opts.setup ?? null,
      run,
      custom: opts.custom ?? {},
      archive: null,
    },
  });
}

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
      managedServers: {},
      auroraConfigs: {},
      portCollisions: [],
      runMenuWsId: null,
      ...patch,
    } as Partial<ReturnType<typeof useStore.getState>>,
    false,
  );
}

beforeEach(() => {
  tauri.reset();
  // Default: no committed aurora.json (readTextFile resolves null on a Rust
  // error) — tests that need one override read_text_file explicitly.
  tauri.invoke({
    read_text_file: () => {
      throw new Error("ENOENT");
    },
    server_spawn: () => ({ pid: 1, pgid: 1, ptyId: "srv" }),
    server_stop: () => undefined,
    server_status: () => ({ state: "running" }),
    server_probe: () => [],
  });
  resetStore();
  stopServerPoll();
});

afterEach(() => {
  stopServerPoll();
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("repoLabel", () => {
  it("is the trailing path segment", () => {
    expect(repoLabel("/Users/me/dev/aurora")).toBe("aurora");
  });
  it("is empty for null", () => {
    expect(repoLabel(null)).toBe("");
  });
});

describe("managedServerId / runCommandId", () => {
  it("namespaces scriptId by wsId", () => {
    expect(managedServerId("ws1", "web")).toBe("ws1:web");
  });
  it("runCommandId is index-based", () => {
    expect(runCommandId(0)).toBe("run:0");
    expect(runCommandId(3)).toBe("run:3");
  });
});

describe("runCommandLabel", () => {
  it("prefers an explicit name", () => {
    expect(runCommandLabel({ command: "bun run dev" }, 0)).toBe("bun-run-dev");
    expect(runCommandLabel({ command: "bun run dev", name: "web" }, 0)).toBe("web");
  });
  it("falls back to a positional label when the command slugifies to empty", () => {
    expect(runCommandLabel({ command: "!!!" }, 2)).toBe("cmd-3");
  });
});

describe("runCommands", () => {
  it("returns the cached Run Script's ordered command list", () => {
    resetStore({
      auroraConfigs: {
        "/repo": { version: 1, scripts: { setup: null, archive: null, run: [{ command: "a" }, { command: "b" }], custom: {} } },
      },
    });
    expect(runCommands("/repo").map((r) => r.command)).toEqual(["a", "b"]);
  });

  it("is empty for a repo with no cached config", () => {
    expect(runCommands("/unknown")).toEqual([]);
  });
});

describe("serversUp / runningScriptIds", () => {
  it("serversUp is true when any entry for wsId is running or starting", () => {
    const managedServers = {
      "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: 1, status: "running" as const, exitCode: null, ports: [] },
      "ws2:run:0": { wsId: "ws2", scriptId: "run:0", paneId: 2, status: "running" as const, exitCode: null, ports: [] },
    };
    expect(serversUp("ws1", managedServers)).toBe(true);
    expect(serversUp("ws3", managedServers)).toBe(false);
  });

  it("exited entries don't count as up", () => {
    const managedServers = {
      "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: 1, status: "exited" as const, exitCode: 0, ports: [] },
    };
    expect(serversUp("ws1", managedServers)).toBe(false);
    expect(runningScriptIds("ws1", managedServers)).toEqual([]);
  });

  it("runningScriptIds lists only this workspace's live scriptIds", () => {
    const managedServers = {
      "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: 1, status: "starting" as const, exitCode: null, ports: [] },
      "ws1:run:1": { wsId: "ws1", scriptId: "run:1", paneId: 2, status: "exited" as const, exitCode: 0, ports: [] },
    };
    expect(runningScriptIds("ws1", managedServers)).toEqual(["run:0"]);
  });
});

// ── runOneRunCommand ─────────────────────────────────────────────────────────

describe("runOneRunCommand", () => {
  it("no-op for an unknown workspace", async () => {
    resetStore();
    await runOneRunCommand("nope", 0);
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("no-op for a manual lane (repoId == null)", async () => {
    resetStore({ workspaces: [mkWs({ repoId: null })] });
    await runOneRunCommand("ws1", 0);
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("no-op when the index isn't in the resolved run list", async () => {
    tauri.invoke({ read_text_file: () => auroraJson([{ command: "bun run dev" }]) });
    resetStore({ workspaces: [mkWs()] });
    await runOneRunCommand("ws1", 3);
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("spawns via server_spawn with command/cwd/env, creates a Servers-tab pane, starts a block", async () => {
    tauri.invoke({ read_text_file: () => auroraJson([{ command: "bun run dev", name: "web" }]) });
    resetStore({ workspaces: [mkWs({ env: { FOO: "bar" } })] });

    await runOneRunCommand("ws1", 0);

    const spawnCall = tauri.lastCall("server_spawn")!;
    expect(spawnCall.args).toMatchObject({ id: "ws1:run:0", command: "bun run dev", args: [], cwd: "/repo" });
    expect(spawnCall.args.env).toEqual([["FOO", "bar"]]);

    const ws = useStore.getState().workspaces[0];
    expect(ws.serverTabId).not.toBeNull();
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(tab.panes).toHaveLength(1);
    expect(tab.panes[0].serverId).toBe("ws1:run:0");
    expect(tab.panes[0].blocks[0]).toMatchObject({ command: "bun run dev", running: true });

    const entry = useStore.getState().managedServers["ws1:run:0"];
    expect(entry).toMatchObject({ wsId: "ws1", scriptId: "run:0", label: "web", status: "running" });
  });

  it("resolves a relative cwd against the workspace dir", async () => {
    tauri.invoke({ read_text_file: () => auroraJson([{ command: "bun", cwd: "apps/web" }]) });
    resetStore({ workspaces: [mkWs({ dir: "/repo/ws" })] });
    await runOneRunCommand("ws1", 0);
    expect(tauri.lastCall("server_spawn")!.args.cwd).toBe("/repo/ws/apps/web");
  });

  it("already running -> no second spawn; focuses the Servers tab if this workspace is active", async () => {
    const serverTab = mkGroup({ panes: [mkPane({ serverId: "ws1:run:0" })] });
    const workTab = mkGroup();
    tauri.invoke({ read_text_file: () => auroraJson([{ command: "bun" }]) });
    resetStore({
      workspaces: [mkWs({ tabs: [workTab, serverTab], active: 0, serverTabId: serverTab.id })],
      activeWs: "ws1",
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: serverTab.panes[0].id, status: "running", exitCode: null, ports: [] } },
    });

    await runOneRunCommand("ws1", 0);

    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
    expect(useStore.getState().workspaces[0].active).toBe(1); // switched to the server tab
  });

  it("a spawn failure ends the block with a non-zero exit, removes the entry/pane, and notifies with the command's label", async () => {
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun", name: "web" }]),
      server_spawn: () => {
        throw new Error("boom");
      },
    });
    resetStore({ workspaces: [mkWs()] });

    await runOneRunCommand("ws1", 0);

    expect(useStore.getState().managedServers["ws1:run:0"]).toBeUndefined();
    const ws = useStore.getState().workspaces[0];
    expect(ws.serverTabId).toBeNull(); // pane removed -> tab dropped (it was the only pane)
    expect(useStore.getState().notifLog[0]?.headline).toContain("Couldn't start web");
  });

  it("hits the 4-pane cap: notifies, does not call server_spawn", async () => {
    const fullPanes = ["a", "b", "c", "d"].map((s) => mkPane({ serverId: `ws1:${s}` }));
    const serverTab = mkGroup({ panes: fullPanes });
    tauri.invoke({ read_text_file: () => auroraJson([{ command: "bun" }]) });
    resetStore({
      workspaces: [mkWs({ tabs: [serverTab], serverTabId: serverTab.id })],
      managedServers: Object.fromEntries(
        fullPanes.map((p, i) => ["ws1:" + "abcd"[i], { wsId: "ws1", scriptId: "abcd"[i], paneId: p.id, status: "running", exitCode: null, ports: [] }]),
      ),
    });

    await runOneRunCommand("ws1", 0);

    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
    expect(useStore.getState().notifLog[0]?.headline).toContain("pane limit reached");
  });

  it("each Run Script entry is independent — starting one never stops another", async () => {
    const webPane = mkPane({ serverId: "ws1:run:0" });
    const serverTab = mkGroup({ panes: [webPane] });
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun" }, { command: "bun api" }]),
    });
    resetStore({
      workspaces: [mkWs({ tabs: [serverTab], serverTabId: serverTab.id })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: webPane.id, status: "running", exitCode: null, ports: [] } },
    });

    await runOneRunCommand("ws1", 1);

    expect(tauri.calls().some((c) => c.cmd === "server_stop")).toBe(false);
    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running" });
    expect(useStore.getState().managedServers["ws1:run:1"]).toMatchObject({ status: "running" });
  });
});

// ── runCustom ────────────────────────────────────────────────────────────────

describe("runCustom", () => {
  it("no-op for an unknown workspace", async () => {
    resetStore();
    await runCustom("nope", "lint");
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("no-op when scriptId isn't in scripts.custom", async () => {
    tauri.invoke({ read_text_file: () => auroraJson([], { custom: {} }) });
    resetStore({ workspaces: [mkWs()] });
    await runCustom("ws1", "lint");
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("spawns a scripts.custom entry via server_spawn, creates a Servers-tab pane, starts a block", async () => {
    tauri.invoke({
      read_text_file: () => auroraJson([], { custom: { lint: { command: "bun run lint" } } }),
    });
    resetStore({ workspaces: [mkWs({ env: { FOO: "bar" } })] });

    await runCustom("ws1", "lint");

    const spawnCall = tauri.lastCall("server_spawn")!;
    expect(spawnCall.args).toMatchObject({ id: "ws1:lint", command: "bun run lint", args: [], cwd: "/repo" });
    expect(spawnCall.args.env).toEqual([["FOO", "bar"]]);

    const ws = useStore.getState().workspaces[0];
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(tab.panes[0].serverId).toBe("ws1:lint");
    expect(useStore.getState().managedServers["ws1:lint"]).toMatchObject({ wsId: "ws1", scriptId: "lint", label: "lint", status: "running" });
  });

  it("already running -> no second spawn; focuses the Servers tab if this workspace is active", async () => {
    const serverTab = mkGroup({ panes: [mkPane({ serverId: "ws1:lint" })] });
    const workTab = mkGroup();
    tauri.invoke({ read_text_file: () => auroraJson([], { custom: { lint: { command: "bun" } } }) });
    resetStore({
      workspaces: [mkWs({ tabs: [workTab, serverTab], active: 0, serverTabId: serverTab.id })],
      activeWs: "ws1",
      managedServers: { "ws1:lint": { wsId: "ws1", scriptId: "lint", paneId: serverTab.panes[0].id, status: "running", exitCode: null, ports: [] } },
    });

    await runCustom("ws1", "lint");

    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
    expect(useStore.getState().workspaces[0].active).toBe(1); // switched to the server tab
  });

  it("never stops other running servers — custom scripts are independent", async () => {
    const webPane = mkPane({ serverId: "ws1:run:0" });
    const serverTab = mkGroup({ panes: [webPane] });
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun" }], { custom: { lint: { command: "eslint" } } }),
    });
    resetStore({
      workspaces: [mkWs({ tabs: [serverTab], serverTabId: serverTab.id })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: webPane.id, status: "running", exitCode: null, ports: [] } },
    });

    await runCustom("ws1", "lint");

    expect(tauri.calls().some((c) => c.cmd === "server_stop")).toBe(false);
    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running" });
    expect(useStore.getState().managedServers["ws1:lint"]).toMatchObject({ status: "running" });
  });

  it("a spawn failure ends the block with a non-zero exit, removes the entry/pane, and notifies", async () => {
    tauri.invoke({
      read_text_file: () => auroraJson([], { custom: { lint: { command: "eslint" } } }),
      server_spawn: () => {
        throw new Error("boom");
      },
    });
    resetStore({ workspaces: [mkWs()] });

    await runCustom("ws1", "lint");

    expect(useStore.getState().managedServers["ws1:lint"]).toBeUndefined();
    expect(useStore.getState().notifLog[0]?.headline).toContain("Couldn't start lint");
  });
});

// ── stopServer / stopServers ─────────────────────────────────────────────────

describe("stopServer", () => {
  it("no-op when untracked", async () => {
    resetStore({ workspaces: [mkWs()] });
    await stopServer("ws1", "run:0");
    expect(tauri.calls().some((c) => c.cmd === "server_stop")).toBe(false);
  });

  it("stops the tracked process, ends the block, removes the entry and the pane", async () => {
    const pane = mkPane({ serverId: "ws1:run:0", blocks: [mkBlock({ running: true })] });
    const serverTab = mkGroup({ panes: [pane] });
    resetStore({
      workspaces: [mkWs({ tabs: [serverTab], serverTabId: serverTab.id })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });

    await stopServer("ws1", "run:0");

    expect(tauri.lastCall("server_stop")!.args).toEqual({ id: "ws1:run:0" });
    expect(useStore.getState().managedServers["ws1:run:0"]).toBeUndefined();
    expect(useStore.getState().workspaces[0].serverTabId).toBeNull();
  });
});

describe("runServers / stopServers (workspace-level toggle)", () => {
  it("runServers starts EVERY run-list command concurrently, each getting its own spawn call", async () => {
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun" }, { command: "bun api" }]),
    });
    resetStore({ workspaces: [mkWs()] });
    await runServers("ws1");
    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running" });
    expect(useStore.getState().managedServers["ws1:run:1"]).toMatchObject({ status: "running" });
    expect(tauri.calls().filter((c) => c.cmd === "server_spawn")).toHaveLength(2);
  });

  it("runServers lands every entry as its own pane inside the SAME split Servers tab (side-by-side, not separate tabs)", async () => {
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun" }, { command: "bun api" }]),
    });
    resetStore({ workspaces: [mkWs()] });
    await runServers("ws1");
    const ws = useStore.getState().workspaces[0];
    // mkWs() starts with one pre-existing work tab; runServers must add exactly
    // ONE Servers tab for both entries — not a second tab per server.
    expect(ws.tabs).toHaveLength(2);
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId)!;
    expect(tab.split).toBe("h");
    expect(tab.panes.map((p) => p.serverId).sort()).toEqual(["ws1:run:0", "ws1:run:1"]);
  });

  it("runServers beyond the 4-pane cap: launches what fits, notifies for the rest, doesn't crash", async () => {
    tauri.invoke({
      read_text_file: () =>
        auroraJson([{ command: "bun" }, { command: "bun" }, { command: "bun" }, { command: "bun" }, { command: "bun" }]),
    });
    resetStore({ workspaces: [mkWs()] });
    await runServers("ws1");
    expect(tauri.calls().filter((c) => c.cmd === "server_spawn")).toHaveLength(4);
    expect(useStore.getState().notifLog.some((n) => n.headline.includes("pane limit reached"))).toBe(true);
  });

  it("runServers no-ops when the repo's Run Script is empty (visibility guard)", async () => {
    tauri.invoke({ read_text_file: () => auroraJson([]) });
    resetStore({ workspaces: [mkWs()] });
    await runServers("ws1");
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("stopServers stops every managed server tracked for the workspace", async () => {
    const p1 = mkPane({ serverId: "ws1:run:0" });
    const p2 = mkPane({ serverId: "ws1:run:1" });
    const serverTab = mkGroup({ panes: [p1, p2] });
    resetStore({
      workspaces: [mkWs({ tabs: [serverTab], serverTabId: serverTab.id })],
      managedServers: {
        "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: p1.id, status: "running", exitCode: null, ports: [] },
        "ws1:run:1": { wsId: "ws1", scriptId: "run:1", paneId: p2.id, status: "running", exitCode: null, ports: [] },
      },
    });

    await stopServers("ws1");

    expect(tauri.calls().filter((c) => c.cmd === "server_stop")).toHaveLength(2);
    expect(Object.keys(useStore.getState().managedServers)).toHaveLength(0);
    expect(useStore.getState().workspaces[0].serverTabId).toBeNull();
  });
});

// ── ensureServerPoll / stopServerPoll ────────────────────────────────────────

describe("ensureServerPoll / stopServerPoll", () => {
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
      return 8888 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = ((id: unknown) => {
      clearCalls.push(id);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  });

  it("is idempotent — a second call does not start a second interval", () => {
    let calls = 0;
    globalThis.setInterval = (() => {
      calls++;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    ensureServerPoll();
    ensureServerPoll();
    expect(calls).toBe(1);
  });

  it("auto-stops when nothing is tracked", async () => {
    resetStore();
    ensureServerPoll();
    await capturedTick!();
    expect(clearCalls).toEqual([8888]);
  });

  it("a running entry gets its ports refreshed from server_probe", async () => {
    const pane = mkPane({ serverId: "ws1:run:0" });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });
    tauri.invoke({ server_status: () => ({ state: "running" }), server_probe: () => [3000, 3001] });

    ensureServerPoll();
    await capturedTick!();

    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running", ports: [3000, 3001] });
  });

  it("an exited entry ends its block with the reported code and stops being polled", async () => {
    const pane = mkPane({ serverId: "ws1:run:0", blocks: [mkBlock({ running: true })] });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });
    tauri.invoke({ server_status: () => ({ state: "exited", code: 7 }) });

    ensureServerPoll();
    await capturedTick!();

    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "exited", exitCode: 7 });
    const block = useStore.getState().workspaces[0].tabs[0].panes[0].blocks[0];
    expect(block).toMatchObject({ running: false, exitCode: 7 });
  });

  it("a rejected server_status (untracked Rust-side) is treated as exited, not a crash", async () => {
    const pane = mkPane({ serverId: "ws1:run:0" });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });
    tauri.invoke({
      server_status: () => {
        throw new Error("no such server");
      },
    });

    ensureServerPoll();
    await capturedTick!();

    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "exited" });
  });

  it("discards a write for an entry removed while the probe was in-flight", async () => {
    const pane = mkPane({ serverId: "ws1:run:0" });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });
    let resolveProbe!: (v: number[]) => void;
    tauri.invoke({ server_probe: () => new Promise((res) => (resolveProbe = res)) });

    ensureServerPoll();
    const tick = capturedTick!();
    resetStore({ managedServers: {} }); // entry removed (e.g. Stop clicked) mid-probe
    resolveProbe([4000]);
    await tick;

    expect(useStore.getState().managedServers["ws1:run:0"]).toBeUndefined();
  });

  it("recomputes collisions across workspaces and notifies once per newly-appeared collision", async () => {
    const paneA = mkPane({ serverId: "wsA:run:0" });
    const paneB = mkPane({ serverId: "wsB:run:0" });
    resetStore({
      workspaces: [
        mkWs({ id: "wsA", env: { AURORA_PORT_OFFSET: "0" }, tabs: [mkGroup({ panes: [paneA] })], serverTabId: 1 }),
        mkWs({ id: "wsB", env: { AURORA_PORT_OFFSET: "10" }, tabs: [mkGroup({ panes: [paneB] })], serverTabId: 2 }),
      ],
      managedServers: {
        "wsA:run:0": { wsId: "wsA", scriptId: "run:0", paneId: paneA.id, status: "running", exitCode: null, ports: [] },
        "wsB:run:0": { wsId: "wsB", scriptId: "run:0", paneId: paneB.id, status: "running", exitCode: null, ports: [] },
      },
    });
    // Both bind the SAME port (3000) — a cross-workspace collision, and it's
    // outside wsB's own [3010,3019] range too.
    tauri.invoke({ server_probe: () => [3000] });

    ensureServerPoll();
    await capturedTick!();

    const collisions = useStore.getState().portCollisions;
    expect(collisions.length).toBeGreaterThan(0);
    const notifCount = useStore.getState().notifLog.length;
    expect(notifCount).toBeGreaterThan(0);

    // Second tick, same collisions -> no NEW notifications.
    await capturedTick!();
    expect(useStore.getState().notifLog.length).toBe(notifCount);
  });

  // Regression (review finding #1): a naturally-exited single managed server
  // used to sit forever in Rust's registry (only `stopServers`'s explicit
  // Stop path reaped it) — so a later Run hit Rust's `contains_key` guard and
  // errored "already tracked", meaning a crashed single-server workspace
  // could never self-heal by hitting Run again. The poll must now reap the
  // Rust-side entry (server_stop) the moment it observes the exit.
  it("reaps the Rust registry entry (server_stop) the moment it observes a natural exit", async () => {
    const pane = mkPane({ serverId: "ws1:run:0", blocks: [mkBlock({ running: true })] });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });
    tauri.invoke({ server_status: () => ({ state: "exited", code: 0 }) });

    ensureServerPoll();
    await capturedTick!();

    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "exited", exitCode: 0 });
    expect(tauri.lastCall("server_stop")?.args).toEqual({ id: "ws1:run:0" });
  });

  it("does not reap (no server_stop) while an entry is merely running (no exit observed)", async () => {
    const pane = mkPane({ serverId: "ws1:run:0" });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "running", exitCode: null, ports: [] } },
    });
    tauri.invoke({ server_status: () => ({ state: "running" }) });

    ensureServerPoll();
    await capturedTick!();

    expect(tauri.calls().some((c) => c.cmd === "server_stop")).toBe(false);
  });

  // Regression (review finding #3): while `runOneRunCommand` is still awaiting
  // spawnServer() for a NEW concurrent server, an already-running poll tick
  // (triggered by an existing server) can land in the window before Rust has
  // inserted the new id into its registry — `server_status` rejects, and the
  // poll used to treat that reject as "exited", spuriously ending the block
  // of a server that hadn't even finished starting. A reject must be ignored
  // for an entry still `status:"starting"`.
  it("a rejected server_status for a still-starting entry is ignored, not marked exited", async () => {
    const pane = mkPane({ serverId: "ws1:run:0", blocks: [mkBlock({ running: true })] });
    resetStore({
      workspaces: [mkWs({ tabs: [mkGroup({ panes: [pane] })], serverTabId: 1 })],
      managedServers: { "ws1:run:0": { wsId: "ws1", scriptId: "run:0", paneId: pane.id, status: "starting", exitCode: null, ports: [] } },
    });
    tauri.invoke({
      server_status: () => {
        throw new Error("no such server 'ws1:run:0'"); // Rust hasn't tracked it yet
      },
    });

    ensureServerPoll();
    await capturedTick!();

    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "starting" }); // NOT exited
    const block = useStore.getState().workspaces[0].tabs[0].panes[0].blocks[0];
    expect(block).toMatchObject({ running: true, exitCode: null }); // endBlock was NOT called
  });
});

// ── end-to-end: reap-then-restart + concurrent-start race (finding #1 & #3) ─

describe("runOneRunCommand end-to-end: exit -> reap -> restart, and concurrent-start race", () => {
  let capturedTick: (() => Promise<void>) | null;
  let origSetInterval: typeof globalThis.setInterval;

  beforeEach(() => {
    capturedTick = null;
    origSetInterval = globalThis.setInterval;
  });

  afterEach(() => {
    globalThis.setInterval = origSetInterval;
  });

  /** Yield the microtask queue up to `tries` times until `fn()` is true. */
  async function waitUntil(fn: () => boolean, tries = 20): Promise<void> {
    for (let i = 0; i < tries && !fn(); i++) await Promise.resolve();
  }

  it("a naturally-exited server can be Run again without 'already tracked' (mirrors Rust's contains_key guard)", async () => {
    // Mimic Rust's real ServerManager registry: server_spawn errors when the
    // id is still tracked; server_stop removes it.
    const tracked = new Set<string>();
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun" }]),
      server_spawn: (a) => {
        const id = a.id as string;
        if (tracked.has(id)) throw new Error(`server '${id}' is already tracked — stop it before respawning`);
        tracked.add(id);
        return { pid: 1, pgid: 1, ptyId: "srv" };
      },
      server_stop: (a) => {
        tracked.delete(a.id as string);
        return undefined;
      },
      server_status: () => ({ state: "exited", code: 0 }),
      server_probe: () => [],
    });
    resetStore({ workspaces: [mkWs()] });

    await runOneRunCommand("ws1", 0);
    expect(tracked.has("ws1:run:0")).toBe(true);
    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running" });

    // Capture the poll tick started by runOneRunCommand's ensureServerPoll() call.
    let tick: (() => Promise<void>) | null = null;
    globalThis.setInterval = ((cb: () => Promise<void>) => {
      tick = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    // ensureServerPoll is idempotent and already running from runOneRunCommand
    // above; stop it and re-arm under our capturing setInterval so we can drive it.
    stopServerPoll();
    ensureServerPoll();

    await tick!(); // "the server exits on its own"

    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "exited" });
    expect(tracked.has("ws1:run:0")).toBe(false); // reaped

    // "user hits Run again" — must succeed cleanly, no couldn't-start notify.
    await runOneRunCommand("ws1", 0);
    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running" });
    expect(useStore.getState().notifLog.some((n) => n.headline.includes("Couldn't start"))).toBe(false);
  });

  it("starting a 2nd server while the 1st is already live+polled does not transiently flip the 2nd to exited", async () => {
    tauri.invoke({
      read_text_file: () => auroraJson([{ command: "bun" }, { command: "bun api" }]),
    });
    resetStore({ workspaces: [mkWs()] });

    // First server: already running, poll active.
    let tick: (() => Promise<void>) | null = null;
    globalThis.setInterval = ((cb: () => Promise<void>) => {
      tick = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    await runOneRunCommand("ws1", 0);
    expect(useStore.getState().managedServers["ws1:run:0"]).toMatchObject({ status: "running" });
    expect(tick).not.toBeNull();

    // Now start the 2nd server, holding its spawnServer() in flight so the
    // entry sits at status:"starting" while a poll tick fires concurrently.
    let resolveSpawn!: (v: { pid: number; pgid: number; ptyId: string }) => void;
    tauri.invoke({
      server_spawn: (a) =>
        a.id === "ws1:run:1"
          ? new Promise((res) => (resolveSpawn = res))
          : { pid: 1, pgid: 1, ptyId: "srv" },
      server_status: (a) =>
        a.id === "ws1:run:1" ? Promise.reject(new Error("no such server 'ws1:run:1'")) : { state: "running" },
    });

    const runP = runOneRunCommand("ws1", 1);
    await waitUntil(() => useStore.getState().managedServers["ws1:run:1"]?.status === "starting");
    expect(useStore.getState().managedServers["ws1:run:1"]).toMatchObject({ status: "starting" });

    await tick!(); // the in-flight poll tick — server_status("ws1:run:1") rejects mid-spawn

    // Must still be "starting", not spuriously "exited".
    expect(useStore.getState().managedServers["ws1:run:1"]).toMatchObject({ status: "starting" });

    resolveSpawn({ pid: 2, pgid: 2, ptyId: "srv2" });
    await runP;
    expect(useStore.getState().managedServers["ws1:run:1"]).toMatchObject({ status: "running" });
  });
});
