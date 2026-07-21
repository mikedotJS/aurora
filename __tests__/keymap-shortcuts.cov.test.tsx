/**
 * Coverage suite for the ⌘O (add repository) and ⌘R (run/stop servers)
 * pane-independent shortcuts added to src/lib/keymap.ts (~402-456), plus a
 * regression check that they don't disturb the pre-existing ⌘ shortcuts or
 * leak into the ⌃ PTY control-code forwarding block.
 *
 * Why a separate file from keymap.cov.test.tsx: these two shortcuts pull in
 * lib/repo's addRepoFromFolder (wraps a native Tauri folder dialog — not
 * drivable for real) and lib/servers' runServers/stopServers/serversUp (a
 * whole PTY orchestrator out of scope here). Both need mock.module()
 * control, exactly like WorkspaceRail.cov.test.tsx already does for the
 * same two collaborators (see its Run/Stop button + add-repo button tests).
 * mock.module() must run BEFORE the target module is first imported — but
 * keymap.cov.test.tsx already statically `import`s keymap.ts at its own top
 * (static imports are hoisted above all other module code, including any
 * mock.module() call placed later in that file), so by the time any of its
 * code runs, keymap.ts has already bound the REAL "./repo"/"./servers"
 * exports and a later mock.module() can't retroactively rebind them. This
 * file sidesteps that by registering the mocks first, then reaching
 * keymap.ts via a dynamic `await import()` (a runtime expression, not
 * hoisted) — same pattern WorkspaceRail.cov.test.tsx uses.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, DEFAULT_SETTINGS } from "../src/state/store";
import { stopPtyPoll } from "../src/lib/running";

// ---- Controllable mocks (must precede the dynamic import below) -----------

let addRepoCalls = 0;
let addRepoImpl: () => Promise<unknown> = () => Promise.resolve({ cancelled: true });
mock.module("../src/lib/repo", () => ({
  addRepoFromFolder: () => {
    addRepoCalls++;
    return addRepoImpl();
  },
}));

const serversCalls: Array<{ fn: "run" | "stop"; wsId: string }> = [];
let serversUpValue = false;
let runServersImpl: (id: string) => Promise<void> = () => Promise.resolve();
let stopServersImpl: (id: string) => Promise<void> = () => Promise.resolve();
/** ⌘R (down) now resolves the Run Script's command list via `runCommands`
 *  (backed by aurora.json) instead of the old userScripts port-script regex —
 *  mocked here like runServers/stopServers since the real aurora.json load is
 *  out of scope for this file. */
let runScriptEntriesValue: Array<{ command: string }> = [];
mock.module("../src/lib/servers", () => ({
  serversUp: () => serversUpValue,
  runCommands: () => runScriptEntriesValue,
  runServers: (id: string) => {
    serversCalls.push({ fn: "run", wsId: id });
    return runServersImpl(id);
  },
  stopServers: (id: string) => {
    serversCalls.push({ fn: "stop", wsId: id });
    return stopServersImpl(id);
  },
  repoLabel: (repoId: string | null) => repoId?.split("/").filter(Boolean).pop() ?? "",
}));

const { handleKeyDown } = await import("../src/lib/keymap");

// ── Helpers (mirrors keymap.cov.test.tsx's own harness) ────────────────────

function mkPane(repoId: string | null = null, dir = "/Users/test/proj"): number {
  const wsId = useStore.getState().createWorkspace({ repoId, title: "t" + Math.random(), dir, branch: null });
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
  return ws.tabs[0].panes[0].id;
}
function wsIdOfPane(paneId: number): string {
  return useStore.getState().workspaces.find((w) => w.tabs.some((g) => g.panes.some((p) => p.id === paneId)))!.id;
}
function withPty(id: number, ptyId = "pty-1") {
  useStore.getState().setPaneRuntime(id, { ptyId, isZsh: false });
}
function keyEvt(key: string, opts: Record<string, unknown> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault: mock(() => {}),
    ...opts,
  } as unknown as KeyboardEvent;
}
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  tauri.reset();
  addRepoCalls = 0;
  addRepoImpl = () => Promise.resolve({ cancelled: true });
  serversCalls.length = 0;
  serversUpValue = false;
  runServersImpl = () => Promise.resolve();
  stopServersImpl = () => Promise.resolve();
  runScriptEntriesValue = [];
  useStore.setState({
    command: null,
    panel: null,
    changesWsId: null,
    settingsOpen: false,
    scriptsSetupOpen: false,
    find: { open: false, query: "", current: 0 },
    keyEntry: false,
    keyError: null,
    apiKeyPresent: false,
    railCollapsed: false,
    foregroundState: {},
    serverStatus: {},
    managedServers: {},
    auroraConfigs: {},
    portCollisions: [],
    runMenuWsId: null,
    notifs: [],
    notifLog: [],
    userScripts: {},
    settings: { ...DEFAULT_SETTINGS, introSeen: true, tutorialSeen: true },
  });
});

afterAll(() => {
  tauri.reset();
  stopPtyPoll();
});

// ── ⌘O — add repository ──────────────────────────────────────────────────

describe("handleKeyDown — ⌘O add repository", () => {
  it("calls addRepoFromFolder exactly once and preventDefaults, with no active pane required", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("o", { metaKey: true });
    handleKeyDown(evt);
    expect(addRepoCalls).toBe(1);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("uppercase O also triggers it (Shift+⌘O)", () => {
    useStore.setState({ activeWs: null });
    handleKeyDown(keyEvt("O", { metaKey: true, shiftKey: true }));
    expect(addRepoCalls).toBe(1);
  });

  it("on { ok: false, error } notifies with the backend error message", async () => {
    addRepoImpl = () => Promise.resolve({ ok: false, error: "That folder isn't inside a git repository." });
    handleKeyDown(keyEvt("o", { metaKey: true }));
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif?.headline).toBe("Couldn't add repository");
    expect(notif?.sub).toBe("That folder isn't inside a git repository.");
  });

  it("does not notify when the dialog is cancelled", async () => {
    addRepoImpl = () => Promise.resolve({ cancelled: true });
    handleKeyDown(keyEvt("o", { metaKey: true }));
    await flush();
    expect(useStore.getState().notifLog.length).toBe(0);
  });

  it("does not notify on success ({ ok: true })", async () => {
    addRepoImpl = () => Promise.resolve({ ok: true, root: "/r", name: "r" });
    handleKeyDown(keyEvt("o", { metaKey: true }));
    await flush();
    expect(useStore.getState().notifLog.length).toBe(0);
  });
});

// ── ⌘R — run/stop servers ────────────────────────────────────────────────

describe("handleKeyDown — ⌘R run/stop servers", () => {
  it("preventDefaults but no-ops when there is no active workspace", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("r", { metaKey: true });
    handleKeyDown(evt);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect(serversCalls.length).toBe(0);
  });

  it("preventDefaults but no-ops when the workspace has zero run scripts configured", async () => {
    mkPane("/repo/a");
    runScriptEntriesValue = [];
    const evt = keyEvt("r", { metaKey: true });
    handleKeyDown(evt);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    await flush();
    expect(serversCalls.length).toBe(0);
  });

  it("also no-ops when the workspace has no repoId at all (no run scripts can resolve)", async () => {
    mkPane(null);
    handleKeyDown(keyEvt("r", { metaKey: true }));
    await flush();
    expect(serversCalls.length).toBe(0);
  });

  it("servers DOWN, single run script → calls runServers(ws.id) exactly once, no menu", async () => {
    const id = mkPane("/repo/a");
    const wsId = wsIdOfPane(id);
    runScriptEntriesValue = [{ command: "web" }];
    serversUpValue = false;
    handleKeyDown(keyEvt("r", { metaKey: true }));
    await flush();
    expect(serversCalls).toEqual([{ fn: "run", wsId }]);
    expect(useStore.getState().runMenuWsId).toBeNull();
  });

  it("servers DOWN, >1 run scripts → ALSO calls runServers(ws.id) directly (run-all-in-split, no pick-one menu)", async () => {
    const id = mkPane("/repo/a");
    const wsId = wsIdOfPane(id);
    runScriptEntriesValue = [{ command: "web" }, { command: "api" }];
    serversUpValue = false;
    handleKeyDown(keyEvt("r", { metaKey: true }));
    await flush();
    expect(serversCalls).toEqual([{ fn: "run", wsId }]);
    expect(useStore.getState().runMenuWsId).toBeNull(); // no more pick-one menu on the primary ⌘R path
  });

  it("servers UP → calls stopServers(ws.id) exactly once, synchronously (no menu involved)", () => {
    const id = mkPane("/repo/a");
    const wsId = wsIdOfPane(id);
    serversUpValue = true;
    handleKeyDown(keyEvt("r", { metaKey: true }));
    expect(serversCalls).toEqual([{ fn: "stop", wsId }]);
  });

  it("always preventDefaults on ⌘R with an active workspace, regardless of up/down", () => {
    mkPane("/repo/a");
    const evt = keyEvt("r", { metaKey: true });
    handleKeyDown(evt);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("a rejected runServers() surfaces a notify with the workspace title and error message", async () => {
    const id = mkPane("/repo/a");
    const title = useStore.getState().workspaces.find((w) => w.id === wsIdOfPane(id))!.title;
    runScriptEntriesValue = [{ command: "web" }];
    serversUpValue = false;
    runServersImpl = () => Promise.reject(new Error("spawn failed"));
    handleKeyDown(keyEvt("r", { metaKey: true }));
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif?.headline).toBe(`Couldn't start servers — ${title}`);
    expect(notif?.sub).toBe("spawn failed");
  });

  it("a rejected stopServers() surfaces a notify too (stop, not start)", async () => {
    mkPane("/repo/a");
    serversUpValue = true;
    stopServersImpl = () => Promise.reject(new Error("kill failed"));
    handleKeyDown(keyEvt("r", { metaKey: true }));
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif?.headline).toContain("Couldn't stop servers");
    expect(notif?.sub).toBe("kill failed");
  });
});

// ── Regression: pre-existing ⌘ shortcuts still work with the new imports ───

describe("handleKeyDown — regression: ⌘0/⌘K/⌘1-9/⌘B unaffected by the ⌘O/⌘R additions", () => {
  it("⌘0 still jumps to the Home terminal", () => {
    const homeId = useStore.getState().createWorkspace({
      repoId: null,
      title: "~",
      dir: "/Users/test",
      branch: null,
      kind: "home",
    });
    mkPane(); // a second, non-home workspace becomes active
    expect(useStore.getState().activeWs).not.toBe(homeId);
    handleKeyDown(keyEvt("0", { metaKey: true, code: "Digit0" }));
    expect(useStore.getState().activeWs).toBe(homeId);
  });

  it("⌘K still opens the command palette", () => {
    mkPane();
    handleKeyDown(keyEvt("k", { metaKey: true }));
    expect(useStore.getState().command).not.toBeNull();
  });

  it("⌘B still toggles the workspace rail", () => {
    mkPane();
    useStore.setState({ railCollapsed: false });
    handleKeyDown(keyEvt("b", { metaKey: true }));
    expect(useStore.getState().railCollapsed).toBe(true);
  });

  it("⌘1 still selects the first tab (physical Digit1)", () => {
    const id = mkPane();
    const wsId = wsIdOfPane(id);
    useStore.getState().newTab(); // 2 tabs now, active moves to the new tab (index 1)
    expect(useStore.getState().workspaces.find((w) => w.id === wsId)!.active).toBe(1);
    handleKeyDown(keyEvt("1", { metaKey: true, code: "Digit1" }));
    expect(useStore.getState().workspaces.find((w) => w.id === wsId)!.active).toBe(0);
  });
});

// ── ⌘O / ⌘R must never leak into ⌃ PTY control-code forwarding ─────────────

describe("handleKeyDown — ⌘O/⌘R never forward as PTY control codes", () => {
  it("⌘R with a live pty attached writes nothing to the pty", () => {
    const id = mkPane("/repo/a");
    withPty(id);
    runScriptEntriesValue = [{ command: "web" }];
    handleKeyDown(keyEvt("r", { metaKey: true }));
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("⌘O with a live pty attached writes nothing to the pty", () => {
    const id = mkPane();
    withPty(id);
    handleKeyDown(keyEvt("o", { metaKey: true }));
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });

  it("contrast: plain ⌃R (no meta) DOES forward as a control code — proves the ⌘R guard is meta-specific, not a global 'r' carve-out", () => {
    const id = mkPane();
    withPty(id);
    handleKeyDown(keyEvt("r", { ctrlKey: true }));
    const code = "r".toLowerCase().charCodeAt(0) - 96; // ^A=1 … ^Z=26
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: String.fromCharCode(code) });
  });

  it("contrast: plain ⌃O (no meta) also forwards as a control code", () => {
    const id = mkPane();
    withPty(id);
    handleKeyDown(keyEvt("o", { ctrlKey: true }));
    const code = "o".toLowerCase().charCodeAt(0) - 96;
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: String.fromCharCode(code) });
  });
});
