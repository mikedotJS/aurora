/**
 * Line-coverage suite for src/lib/keymap.ts — the global keydown handler that
 * drives the Aurora prompt (submit, Tab completion, history, key entry, ⌘/⌃
 * shortcuts) plus its private helpers (submit, runInShell, handleAurora,
 * askClaude, saveKey, pasteClipboard, triggerFolderCompletion, completionBase).
 * `handleKeyDown` is the only export, so every helper is exercised indirectly
 * by dispatching synthetic KeyboardEvent-shaped objects at it, against the
 * REAL Zustand store (a fresh workspace/pane per test via createWorkspace) so
 * assertions reflect real reducer behavior, not a re-implementation of it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, activeGroup, activeWorkspace, findPane, DEFAULT_SETTINGS, type PaneState } from "../src/state/store";
import { handleKeyDown } from "../src/lib/keymap";
import { stopPtyPoll } from "../src/lib/running";
import type { Suggestion } from "../src/ai/suggest";

// ── Clipboard control (readText/writeText aren't routed through invoke(), so we
// drive them via tauri.setReadText()/setWriteText() with mutable closures) ────
let clipboardText = "";
let clipboardShouldThrow = false;
let writeTextCalls: string[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkPane(dir = "/Users/test/proj"): number {
  const wsId = useStore.getState().createWorkspace({ repoId: null, title: "t" + Math.random(), dir, branch: null });
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
  return ws.tabs[0].panes[0].id;
}
function pane(id: number): PaneState {
  return findPane(useStore.getState(), id)!;
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
  clipboardText = "";
  clipboardShouldThrow = false;
  writeTextCalls = [];
  tauri.setReadText(() =>
    clipboardShouldThrow ? Promise.reject(new Error("clipboard denied")) : Promise.resolve(clipboardText),
  );
  tauri.setWriteText((t: string) => {
    writeTextCalls.push(t);
    return Promise.resolve();
  });
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
    // Runtime-only maps feeding Ctrl+C routing (sticky-running-server-tabs) —
    // reset so one test's foregroundState/serverStatus can't leak into the next
    // (ptyId "pty-1" is reused across many tests via withPty()'s default).
    foregroundState: {},
    serverStatus: {},
    notifs: [],
    notifLog: [],
    // The one-time intro dialog guard (top of handleKeyDown) swallows every key
    // while unseen; these suites cover pre-existing keymap behavior, not the
    // intro itself, so seed it dismissed. (Intro-specific keymap coverage is a
    // separate, dedicated describe block.)
    settings: { ...DEFAULT_SETTINGS, introSeen: true },
  });
});

// tauri.reset() (called in every beforeEach above) already clears the
// setReadText()/setWriteText() overrides, but guard the tail end too so a file
// that never calls tauri.reset() after this one can't inherit our last closures.
afterAll(() => {
  tauri.reset();
  // runInShell (Enter, via submit()) fires ensurePtyPoll() on every real
  // command submit (sticky-running-server-tabs) — a real setInterval(…,1500).
  // Without this the process never goes idle and `bun test` hangs (the exact
  // failure mode fixed in e2464eb for unrelated per-file mock.module leaks).
  stopPtyPoll();
});

// ── Form-field guard ─────────────────────────────────────────────────────────

describe("handleKeyDown — form field guard", () => {
  it("ignores keydowns targeting INPUT/SELECT/TEXTAREA (xterm's textarea / form fields own them)", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "abc");
    for (const tag of ["INPUT", "SELECT", "TEXTAREA"]) {
      const evt = keyEvt("x", { target: { tagName: tag } });
      handleKeyDown(evt);
      expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    }
    expect(pane(id).input).toBe("abc");
  });

  it("does nothing when there is no active pane", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("a");
    expect(() => handleKeyDown(evt)).not.toThrow();
  });

  it("still respects the form-field guard for the pane-independent ⌘K/⌘,/⌘B shortcuts", () => {
    useStore.setState({ activeWs: null });
    for (const key of [",", "k", "b"]) {
      const evt = keyEvt(key, { metaKey: true, target: { tagName: "INPUT" } });
      handleKeyDown(evt);
      expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    }
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(useStore.getState().command).toBeNull();
    expect(useStore.getState().railCollapsed).toBe(false);
  });
});

// ── Empty-startup state (no active workspace/pane) ──────────────────────────

describe("handleKeyDown — pane-independent ⌘ shortcuts in the empty-startup state", () => {
  it("⌘K opens the command palette with no active pane (EmptyState's ⌘K affordance)", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("k", { metaKey: true });
    handleKeyDown(evt);
    expect(useStore.getState().command).not.toBeNull();
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("⌘, opens settings with no active pane", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt(",", { metaKey: true });
    handleKeyDown(evt);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("⌘B toggles the workspace rail with no active pane", () => {
    useStore.setState({ activeWs: null, railCollapsed: false });
    const evt = keyEvt("b", { metaKey: true });
    handleKeyDown(evt);
    expect(useStore.getState().railCollapsed).toBe(true);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("Escape closes settings that were opened with no active pane", () => {
    useStore.setState({ activeWs: null });
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("Escape closes the command palette that was opened with no active pane", () => {
    useStore.setState({ activeWs: null });
    useStore.getState().openCommand();
    expect(useStore.getState().command).not.toBeNull();
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().command).toBeNull();
  });

  it("other ⌘ shortcuts that need a pane remain no-ops with no active pane", () => {
    useStore.setState({ activeWs: null });
    expect(() => handleKeyDown(keyEvt("v", { metaKey: true }))).not.toThrow();
    expect(() => handleKeyDown(keyEvt("t", { metaKey: true }))).not.toThrow();
    expect(useStore.getState().command).toBeNull();
    expect(useStore.getState().settingsOpen).toBe(false);
  });
});

// ── Modal-priority branches ──────────────────────────────────────────────────

describe("handleKeyDown — modal priority (scripts setup / settings / command / panel / find)", () => {
  it("scriptsSetupOpen: Escape closes it, other keys are swallowed", () => {
    mkPane();
    useStore.getState().openScriptsSetup();
    handleKeyDown(keyEvt("a", { target: null }));
    expect(useStore.getState().scriptsSetupOpen).toBe(true); // untouched
    const esc = keyEvt("Escape");
    handleKeyDown(esc);
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
    expect((esc.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("settingsOpen: Escape closes it, other keys are swallowed", () => {
    mkPane();
    useStore.getState().openSettings();
    handleKeyDown(keyEvt("a"));
    expect(useStore.getState().settingsOpen).toBe(true);
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("command palette open: Escape closes it, other keys are swallowed", () => {
    mkPane();
    useStore.getState().openCommand();
    handleKeyDown(keyEvt("a"));
    expect(useStore.getState().command).not.toBeNull();
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().command).toBeNull();
  });

  it("panel open: Escape closes it, other keys are swallowed", () => {
    mkPane();
    useStore.getState().openPanel("mr");
    handleKeyDown(keyEvt("a"));
    expect(useStore.getState().panel).toBe("mr");
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().panel).toBeNull();
  });

  it("find open: Escape closes it even with focus elsewhere", () => {
    mkPane();
    useStore.getState().openFind();
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().find.open).toBe(false);
  });

  it("find open: non-Escape keys are NOT swallowed (fall through to normal handling)", () => {
    const id = mkPane();
    useStore.getState().openFind();
    handleKeyDown(keyEvt("a"));
    expect(pane(id).input).toBe("a"); // reached the bottom char-append branch
  });
});

// ── Alt+Arrow pane cycling / Ctrl+Tab tab cycling ────────────────────────────

describe("handleKeyDown — alt+arrow cyclePane, ctrl+Tab cycleTab", () => {
  it("alt+ArrowRight/ArrowUp cycles the active pane within a split group", () => {
    mkPane();
    handleKeyDown(keyEvt("d", { metaKey: true })); // splitPane("h") → 2 panes
    expect(activeGroup(useStore.getState())!.panes.length).toBe(2);
    expect(activeGroup(useStore.getState())!.active).toBe(1);
    handleKeyDown(keyEvt("ArrowRight", { altKey: true }));
    expect(activeGroup(useStore.getState())!.active).toBe(0);
    handleKeyDown(keyEvt("ArrowUp", { altKey: true }));
    expect(activeGroup(useStore.getState())!.active).toBe(1);
  });

  it("ctrl+Tab cycles tabs forward, ctrl+shift+Tab cycles backward", () => {
    mkPane();
    handleKeyDown(keyEvt("t", { metaKey: true })); // newTab → 2 tabs, active=1
    expect(activeWorkspace(useStore.getState())!.active).toBe(1);
    handleKeyDown(keyEvt("Tab", { ctrlKey: true }));
    expect(activeWorkspace(useStore.getState())!.active).toBe(0);
    handleKeyDown(keyEvt("Tab", { ctrlKey: true, shiftKey: true }));
    expect(activeWorkspace(useStore.getState())!.active).toBe(1);
  });
});

// ── ⌘ shortcuts ──────────────────────────────────────────────────────────────

describe("handleKeyDown — ⌘ shortcuts", () => {
  it("⌘F opens find", () => {
    mkPane();
    handleKeyDown(keyEvt("f", { metaKey: true }));
    expect(useStore.getState().find.open).toBe(true);
  });

  it("⌘A selects the whole input, but is a no-op while entering a key (still consumes the event)", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "hello");
    handleKeyDown(keyEvt("A", { metaKey: true }));
    expect(pane(id).inputSelected).toBe(true);

    useStore.getState().setInput(id, "hello");
    useStore.setState({ keyEntry: true });
    const evt = keyEvt("a", { metaKey: true });
    handleKeyDown(evt);
    expect(pane(id).inputSelected).toBe(false);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("⌘C copies the selected input to the clipboard only when selected + non-empty", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "copy me");
    useStore.getState().selectAllInput(id);
    handleKeyDown(keyEvt("c", { metaKey: true }));
    expect(writeTextCalls).toEqual(["copy me"]);
  });

  it("⌘Enter asks Claude with the trimmed, ?-stripped input (empty input is a no-op)", async () => {
    const id = mkPane();
    tauri.invoke({ claude_suggest: () => ({ command: "git log", note: "ok" }) });

    // empty input: preventDefault fires but nothing is asked
    const evtEmpty = keyEvt("Enter", { metaKey: true });
    handleKeyDown(evtEmpty);
    await flush();
    expect(pane(id).suggestion).toBeNull();

    useStore.getState().setInput(id, "? what changed");
    handleKeyDown(keyEvt("Enter", { metaKey: true }));
    expect(pane(id).input).toBe(""); // cleared synchronously
    await flush();
    expect(pane(id).suggestion?.command).toBe("git log");
  });

  it("⌘, opens settings; ⌘K opens the command palette; ⌘G opens the changes overlay", () => {
    mkPane();
    handleKeyDown(keyEvt(",", { metaKey: true }));
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.setState({ settingsOpen: false }); // modal priority would otherwise swallow the next shortcuts
    handleKeyDown(keyEvt("k", { metaKey: true }));
    expect(useStore.getState().command).not.toBeNull();
    useStore.setState({ command: null });
    handleKeyDown(keyEvt("g", { metaKey: true }));
    // The overlay opens for the active workspace — never on a pane.
    expect(useStore.getState().changesWsId).toBe(useStore.getState().activeWs);
    expect(useStore.getState().changesWsId).not.toBeNull();
  });

  it("⌘⌥D toggles the changes overlay open <-> closed", () => {
    mkPane();
    useStore.getState().openChanges();
    handleKeyDown(keyEvt("d", { metaKey: true, altKey: true }));
    expect(useStore.getState().changesWsId).toBeNull();
    handleKeyDown(keyEvt("D", { metaKey: true, altKey: true }));
    expect(useStore.getState().changesWsId).toBe(useStore.getState().activeWs);
  });

  it("⌘D splits horizontally, ⌘⇧D splits vertically", () => {
    mkPane();
    handleKeyDown(keyEvt("d", { metaKey: true }));
    expect(activeGroup(useStore.getState())!.panes.length).toBe(2);
    expect(activeGroup(useStore.getState())!.split).toBe("h");
    handleKeyDown(keyEvt("D", { metaKey: true, shiftKey: true }));
    expect(activeGroup(useStore.getState())!.panes.length).toBe(3);
    expect(activeGroup(useStore.getState())!.split).toBe("v");
  });

  it("⌘T opens a new tab", () => {
    mkPane();
    handleKeyDown(keyEvt("t", { metaKey: true }));
    expect(activeWorkspace(useStore.getState())!.tabs.length).toBe(2);
    expect(activeWorkspace(useStore.getState())!.active).toBe(1);
  });

  it("⌘W closes the pane when the group has multiple panes", () => {
    mkPane();
    handleKeyDown(keyEvt("d", { metaKey: true })); // split → 2 panes
    expect(activeGroup(useStore.getState())!.panes.length).toBe(2);
    handleKeyDown(keyEvt("w", { metaKey: true }));
    expect(activeGroup(useStore.getState())!.panes.length).toBe(1);
  });

  it("⌘W closes the tab when its group has a single pane and multiple tabs exist", () => {
    mkPane();
    handleKeyDown(keyEvt("t", { metaKey: true })); // 2 tabs, active=1, single pane each
    expect(activeWorkspace(useStore.getState())!.tabs.length).toBe(2);
    handleKeyDown(keyEvt("W", { metaKey: true }));
    expect(activeWorkspace(useStore.getState())!.tabs.length).toBe(1);
  });

  it("⌘W is a no-op (no crash) on the very last tab/pane", () => {
    mkPane();
    expect(() => handleKeyDown(keyEvt("w", { metaKey: true }))).not.toThrow();
    expect(activeWorkspace(useStore.getState())!.tabs.length).toBe(1);
  });

  it("⌘B toggles the workspace rail", () => {
    mkPane();
    expect(useStore.getState().railCollapsed).toBe(false);
    handleKeyDown(keyEvt("b", { metaKey: true }));
    expect(useStore.getState().railCollapsed).toBe(true);
  });

  it("⌘<digit> selects that tab (1-indexed), out-of-range digits are a no-op", () => {
    mkPane();
    handleKeyDown(keyEvt("t", { metaKey: true })); // 2 tabs, active=1
    handleKeyDown(keyEvt("1", { metaKey: true }));
    expect(activeWorkspace(useStore.getState())!.active).toBe(0);
    handleKeyDown(keyEvt("9", { metaKey: true })); // only 2 tabs exist
    expect(activeWorkspace(useStore.getState())!.active).toBe(0);
  });

  it("⌘] cycles tabs forward, ⌘[ cycles tabs backward", () => {
    mkPane();
    handleKeyDown(keyEvt("t", { metaKey: true })); // 2 tabs, active=1
    handleKeyDown(keyEvt("]", { metaKey: true }));
    expect(activeWorkspace(useStore.getState())!.active).toBe(0);
    handleKeyDown(keyEvt("[", { metaKey: true }));
    expect(activeWorkspace(useStore.getState())!.active).toBe(1);
  });

  it("an unrecognized ⌘ shortcut is swallowed without side effects", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "abc");
    handleKeyDown(keyEvt("z", { metaKey: true }));
    expect(pane(id).input).toBe("abc");
    // also exercises the same catch-all when the more specific ⌘C guard fails
    handleKeyDown(keyEvt("c", { metaKey: true }));
    expect(writeTextCalls).toEqual([]);
  });
});

// ── ⌃ control-code forwarding ────────────────────────────────────────────────

describe("handleKeyDown — ⌃ control codes", () => {
  it("⌃L clears blocks and writes a form-feed to a live pty", () => {
    const id = mkPane();
    withPty(id);
    useStore.getState().startBlock(id, "ls", "/x");
    handleKeyDown(keyEvt("l", { ctrlKey: true }));
    expect(pane(id).blocks).toEqual([]);
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "\x0c" });
  });

  it("⌃L without a live pty still clears blocks but writes nothing", () => {
    const id = mkPane();
    useStore.getState().startBlock(id, "ls", "/x");
    handleKeyDown(keyEvt("L", { ctrlKey: true }));
    expect(pane(id).blocks).toEqual([]);
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("⌃<letter> forwards the control code to a live pty", () => {
    const id = mkPane();
    withPty(id);
    handleKeyDown(keyEvt("a", { ctrlKey: true }));
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: String.fromCharCode(1) });
  });

  it("⌃C also clears the input (in addition to forwarding ETX)", () => {
    const id = mkPane();
    withPty(id);
    useStore.getState().setInput(id, "half-typed");
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: String.fromCharCode(3) });
    expect(pane(id).input).toBe("");
  });

  it("⌃<letter> without a live pty writes nothing (no crash)", () => {
    mkPane();
    expect(() => handleKeyDown(keyEvt("a", { ctrlKey: true }))).not.toThrow();
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("⌃<non-letter> is swallowed without touching pty or blocks", () => {
    const id = mkPane();
    withPty(id);
    handleKeyDown(keyEvt("1", { ctrlKey: true }));
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("⌃C without a live pty is a no-op (early return, no crash)", () => {
    mkPane();
    expect(() => handleKeyDown(keyEvt("c", { ctrlKey: true }))).not.toThrow();
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });
});

// ── ⌃C routing (sticky-running-server-tabs) ──────────────────────────────────

describe("handleKeyDown — ⌃C routing by what's actually running", () => {
  it("foreground child running (fg.running) -> plain \\x03, even though status says 'dead'", () => {
    const id = mkPane();
    withPty(id);
    useStore.setState({
      foregroundState: { "pty-1": { running: true, pgid: 4242 } },
      serverStatus: { "pty-1": "dead" },
    });
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "\x03" });
    expect(tauri.calls().some((c) => c.cmd === "pty_signal_server")).toBe(false);
  });

  it("not running at all -> plain \\x03 (unchanged idle-shell behavior)", () => {
    const id = mkPane();
    withPty(id);
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "\x03" });
    expect(tauri.calls().some((c) => c.cmd === "pty_signal_server")).toBe(false);
  });

  it("detached-but-captured (alive, fg not running) -> signalServer(SIGINT), no \\x03", () => {
    const id = mkPane();
    withPty(id);
    tauri.invoke({ pty_signal_server: () => true });
    useStore.setState({
      foregroundState: { "pty-1": { running: false, pgid: 1 } },
      serverStatus: { "pty-1": "alive" },
    });
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
    expect(tauri.lastCall("pty_signal_server")?.args).toEqual({ id: "pty-1", signal: 2 });
  });

  it("detached-but-captured via the OSC-133 block flag (tier 3) also routes to signalServer", () => {
    const id = mkPane();
    withPty(id);
    tauri.invoke({ pty_signal_server: () => true });
    useStore.getState().startBlock(id, "nx serve", "/x"); // last block running: true
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    expect(tauri.lastCall("pty_signal_server")?.args).toEqual({ id: "pty-1", signal: 2 });
  });

  it("signalServer resolves false (uncaptured/dead) -> honest notice, never a false 'stopped'", async () => {
    const id = mkPane();
    withPty(id);
    tauri.invoke({ pty_signal_server: () => false });
    useStore.setState({ serverStatus: { "pty-1": "alive" } });
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif?.headline).toBe("Couldn't reach the process");
  });

  it("signalServer resolving true does not surface any notice", async () => {
    const id = mkPane();
    withPty(id);
    tauri.invoke({ pty_signal_server: () => true });
    useStore.setState({ serverStatus: { "pty-1": "alive" } });
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    await flush();
    expect(useStore.getState().notifLog).toEqual([]);
  });
});

// ── Changes-view swallow ─────────────────────────────────────────────────────

describe("handleKeyDown — changes view", () => {
  it("Escape closes the changes overlay", () => {
    mkPane();
    useStore.getState().openChanges();
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().changesWsId).toBeNull();
  });

  it("other keys are swallowed (prompt underneath is not touched), no preventDefault", () => {
    const id = mkPane();
    useStore.getState().openChanges();
    const evt = keyEvt("x");
    handleKeyDown(evt);
    expect(pane(id).input).toBe("");
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it("the Changes overlay owns its keys even in rawMode: Escape exits, other keys are swallowed", () => {
    // The Changes overlay paints over the pane grid, so it must intercept keys
    // even when a full-screen program (rawMode) runs underneath — otherwise you
    // can't leave the view and keystrokes leak to the hidden program.
    const id = mkPane();
    useStore.getState().openChanges();
    useStore.getState().setRawMode(id, true);

    // a control key that would otherwise be forwarded to the PTY is swallowed
    withPty(id);
    handleKeyDown(keyEvt("c", { ctrlKey: true }));
    expect(pane(id).input).toBe("");
    expect(tauri.lastCall("pty_write")).toBeUndefined();

    // a plain key does nothing to the hidden prompt
    handleKeyDown(keyEvt("x"));
    expect(pane(id).input).toBe("");

    // Escape closes the overlay
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().changesWsId).toBeNull();
  });
});

// ── Key-entry mode ───────────────────────────────────────────────────────────

describe("handleKeyDown — key entry mode", () => {
  it("types characters and clears a prior error", () => {
    const id = mkPane();
    useStore.setState({ keyEntry: true, keyError: "bad" });
    handleKeyDown(keyEvt("s"));
    expect(pane(id).input).toBe("s");
    expect(useStore.getState().keyError).toBeNull();
  });

  it("Backspace deletes the last character and clears the error", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "sk-x");
    useStore.setState({ keyEntry: true, keyError: "bad" });
    handleKeyDown(keyEvt("Backspace"));
    expect(pane(id).input).toBe("sk-");
    expect(useStore.getState().keyError).toBeNull();
  });

  it("Escape cancels key entry and clears the input", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "sk-x");
    useStore.setState({ keyEntry: true });
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().keyEntry).toBe(false);
    expect(pane(id).input).toBe("");
  });

  it("alt+letter and non-character keys (e.g. ArrowUp) are swallowed without effect", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "sk-x");
    useStore.setState({ keyEntry: true });
    handleKeyDown(keyEvt("e", { altKey: true }));
    expect(pane(id).input).toBe("sk-x");
    handleKeyDown(keyEvt("ArrowUp"));
    expect(pane(id).input).toBe("sk-x");
  });

  it("Enter saves a valid key", async () => {
    const id = mkPane();
    tauri.invoke({ key_set: () => undefined });
    useStore.getState().setInput(id, "sk-ant-1234567890");
    useStore.setState({ keyEntry: true });
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(useStore.getState().apiKeyPresent).toBe(true);
    expect(useStore.getState().keyEntry).toBe(false);
    expect(pane(id).input).toBe("");
  });
});

// ── saveKey (via key-entry Enter) ────────────────────────────────────────────

describe("saveKey", () => {
  it("cancels key entry when the trimmed input is empty", async () => {
    const id = mkPane();
    useStore.getState().setInput(id, "   ");
    useStore.setState({ keyEntry: true });
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(useStore.getState().keyEntry).toBe(false);
    expect(pane(id).input).toBe("");
  });

  it("rejects a value that doesn't look like an Anthropic key", async () => {
    const id = mkPane();
    useStore.getState().setInput(id, "not-a-key");
    useStore.setState({ keyEntry: true });
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(useStore.getState().keyError).toMatch(/doesn't look like/);
    expect(useStore.getState().keyEntry).toBe(true); // stays open

    useStore.getState().setInput(id, "sk-short");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(useStore.getState().keyError).toMatch(/doesn't look like/);
  });

  it("surfaces a backend error from key_set", async () => {
    const id = mkPane();
    tauri.invoke({
      key_set: () => {
        throw new Error("keychain denied");
      },
    });
    useStore.getState().setInput(id, "sk-ant-1234567890");
    useStore.setState({ keyEntry: true });
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(useStore.getState().keyError).toContain("keychain denied");
    expect(useStore.getState().apiKeyPresent).toBe(false);
  });
});

// ── pane.suggestion ──────────────────────────────────────────────────────────

describe("handleKeyDown — pane.suggestion", () => {
  function withSuggestion(id: number, sug: Suggestion) {
    useStore.getState().setSuggestion(id, sug);
  }

  it("command suggestion: Enter runs it, clearing the suggestion", () => {
    const id = mkPane();
    withPty(id);
    withSuggestion(id, { command: "git status", note: "typo?" });
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).suggestion).toBeNull();
    expect(pane(id).blocks.at(-1)?.command).toBe("git status");
  });

  it("command suggestion: Tab accepts it into the input without running", () => {
    const id = mkPane();
    withSuggestion(id, { command: "git status", note: "typo?" });
    handleKeyDown(keyEvt("Tab"));
    expect(pane(id).input).toBe("git status");
    expect(pane(id).suggestion).toBeNull();
  });

  it("command suggestion: Escape dismisses it", () => {
    const id = mkPane();
    withSuggestion(id, { command: "git status", note: "typo?" });
    handleKeyDown(keyEvt("Escape"));
    expect(pane(id).suggestion).toBeNull();
  });

  it("command suggestion: an unrelated key falls through to normal typing", () => {
    const id = mkPane();
    withSuggestion(id, { command: "git status", note: "typo?" });
    handleKeyDown(keyEvt("x"));
    expect(pane(id).input).toBe("x");
    expect(pane(id).suggestion).toBeNull(); // setInput always clears it
  });

  it("needsKey suggestion: Enter/Tab route to key entry", () => {
    const id = mkPane();
    withSuggestion(id, { command: "", note: "bring your own key", needsKey: true });
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).suggestion).toBeNull();
    expect(useStore.getState().keyEntry).toBe(true);
  });

  it("needsKey suggestion: Escape dismisses it", () => {
    const id = mkPane();
    withSuggestion(id, { command: "", note: "bring your own key", needsKey: true });
    handleKeyDown(keyEvt("Escape"));
    expect(pane(id).suggestion).toBeNull();
    expect(useStore.getState().keyEntry).toBe(false);
  });

  it("needsKey suggestion: an unrelated key falls through", () => {
    const id = mkPane();
    withSuggestion(id, { command: "", note: "bring your own key", needsKey: true });
    handleKeyDown(keyEvt("x"));
    expect(pane(id).input).toBe("x");
  });

  it("plain note suggestion (no command, no needsKey): Escape/Enter dismiss", () => {
    const id = mkPane();
    withSuggestion(id, { command: "", note: "claude: boom" });
    handleKeyDown(keyEvt("Escape"));
    expect(pane(id).suggestion).toBeNull();

    withSuggestion(id, { command: "", note: "claude: boom" });
    handleKeyDown(keyEvt("Enter"));
    // Enter with empty input just runs submit() after dismissing — no crash either way.
    expect(pane(id).suggestion).toBeNull();
  });

  it("plain note suggestion: an unrelated key falls through", () => {
    const id = mkPane();
    withSuggestion(id, { command: "", note: "claude: boom" });
    handleKeyDown(keyEvt("x"));
    expect(pane(id).input).toBe("x");
  });
});

// ── pane.completion ──────────────────────────────────────────────────────────

describe("handleKeyDown — pane.completion", () => {
  function withCompletion(id: number) {
    useStore.getState().openCompletion(id, {
      items: [
        { name: "alpha", is_dir: true },
        { name: "beta", is_dir: true },
      ],
      tokenStart: 3,
      dir: "",
    });
  }

  it("ArrowDown/ArrowUp move the selection", () => {
    const id = mkPane();
    withCompletion(id);
    handleKeyDown(keyEvt("ArrowDown"));
    expect(pane(id).completion!.index).toBe(1);
    handleKeyDown(keyEvt("ArrowUp"));
    expect(pane(id).completion!.index).toBe(0);
  });

  it("Tab accepts the selected candidate", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "cd al");
    withCompletion(id);
    handleKeyDown(keyEvt("Tab"));
    expect(pane(id).input).toBe("cd alpha/");
    expect(pane(id).completion).toBeNull();
  });

  it("Enter also accepts the selected candidate", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "cd al");
    withCompletion(id);
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).input).toBe("cd alpha/");
  });

  it("Escape closes the list without touching the input", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "cd al");
    withCompletion(id);
    handleKeyDown(keyEvt("Escape"));
    expect(pane(id).completion).toBeNull();
    expect(pane(id).input).toBe("cd al");
  });

  it("an unrelated key falls through to typing, which clears the list", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "cd al");
    withCompletion(id);
    handleKeyDown(keyEvt("x"));
    expect(pane(id).input).toBe("cd alx");
    expect(pane(id).completion).toBeNull();
  });
});

// ── pane.inputSelected ───────────────────────────────────────────────────────

describe("handleKeyDown — pane.inputSelected (⌘A selection)", () => {
  function selectAll(id: number, value: string) {
    useStore.getState().setInput(id, value);
    useStore.getState().selectAllInput(id);
  }

  it("arrow keys collapse the selection", () => {
    const id = mkPane();
    selectAll(id, "abc");
    handleKeyDown(keyEvt("ArrowLeft"));
    expect(pane(id).inputSelected).toBe(false);
  });

  it("Backspace/Delete clear the whole input", () => {
    const id = mkPane();
    selectAll(id, "abc");
    handleKeyDown(keyEvt("Delete"));
    expect(pane(id).input).toBe("");

    selectAll(id, "abc");
    handleKeyDown(keyEvt("Backspace"));
    expect(pane(id).input).toBe("");
  });

  it("typing a character replaces the whole selection", () => {
    const id = mkPane();
    selectAll(id, "abc");
    handleKeyDown(keyEvt("z"));
    expect(pane(id).input).toBe("z");
  });

  it("Enter falls through to submit (setInput clears the selection flag)", () => {
    const id = mkPane();
    selectAll(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).blocks.at(-1)?.command).toBe("ls");
  });
});

// ── Bottom-level: Enter / Tab / ArrowRight / history / Backspace / Escape / typing ──

describe("handleKeyDown — bottom-level prompt editing", () => {
  it("Enter submits and clears the input first", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).blocks.at(-1)?.command).toBe("ls");
  });

  it("Tab prefers a pendingFix over ghost/path completion", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "l");
    useStore.getState().setPendingFix(id, "ls -la");
    handleKeyDown(keyEvt("Tab"));
    expect(pane(id).input).toBe("ls -la");
    expect(pane(id).pendingFix).toBeNull();
  });

  it("Tab accepts an inline ghost when the token isn't a path arg", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "l"); // ghost "s" from "ls"
    expect(pane(id).ghost).toBe("s");
    handleKeyDown(keyEvt("Tab"));
    expect(pane(id).input).toBe("ls");
  });

  it("Tab is a no-op when there's no ghost and no path arg", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "zz");
    expect(pane(id).ghost).toBe("");
    handleKeyDown(keyEvt("Tab"));
    expect(pane(id).input).toBe("zz");
  });

  it("ArrowRight accepts an inline ghost", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "l");
    const evt = keyEvt("ArrowRight");
    handleKeyDown(evt);
    expect(pane(id).input).toBe("ls");
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("ArrowRight without a ghost does nothing (still consumes the key)", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "zz");
    const evt = keyEvt("ArrowRight");
    handleKeyDown(evt);
    expect(pane(id).input).toBe("zz");
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it("ArrowUp/ArrowDown navigate command history", () => {
    const id = mkPane();
    useStore.getState().pushHistory(id, "git status");
    useStore.getState().pushHistory(id, "ls -la");
    handleKeyDown(keyEvt("ArrowUp"));
    expect(pane(id).input).toBe("ls -la");
    handleKeyDown(keyEvt("ArrowUp"));
    expect(pane(id).input).toBe("git status");
    handleKeyDown(keyEvt("ArrowDown"));
    expect(pane(id).input).toBe("ls -la");
  });

  it("Backspace deletes the last character", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "abc");
    handleKeyDown(keyEvt("Backspace"));
    expect(pane(id).input).toBe("ab");
  });

  it("Escape clears the input", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "abc");
    handleKeyDown(keyEvt("Escape"));
    expect(pane(id).input).toBe("");
  });

  it("a printable character is appended", () => {
    const id = mkPane();
    handleKeyDown(keyEvt("a"));
    expect(pane(id).input).toBe("a");
  });

  it("alt+character does not append (e.g. macOS accented-key composition)", () => {
    const id = mkPane();
    handleKeyDown(keyEvt("e", { altKey: true }));
    expect(pane(id).input).toBe("");
  });

  it("non-character keys with no dedicated handler are silently ignored", () => {
    const id = mkPane();
    expect(() => handleKeyDown(keyEvt("F1"))).not.toThrow();
    expect(() => handleKeyDown(keyEvt("CapsLock"))).not.toThrow();
    expect(pane(id).input).toBe("");
  });
});

// ── submit() via Enter ───────────────────────────────────────────────────────

describe("submit — via Enter", () => {
  function submitLine(id: number, line: string) {
    useStore.getState().setInput(id, line);
    handleKeyDown(keyEvt("Enter"));
  }

  it("empty input sends a bare newline to a live pty, and does nothing without one", () => {
    const id = mkPane();
    withPty(id);
    submitLine(id, "   ");
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "\n" });

    const id2 = mkPane();
    submitLine(id2, "");
    expect(pane(id2).blocks).toEqual([]);
  });

  it("a leading ? asks Claude", async () => {
    const id = mkPane();
    tauri.invoke({ claude_suggest: () => ({ command: "git log --oneline", note: "" }) });
    submitLine(id, "? recent commits");
    await flush();
    expect(pane(id).suggestion?.command).toBe("git log --oneline");
  });

  it("a bare ? with only whitespace does not ask Claude", async () => {
    const id = mkPane();
    tauri.invoke({ claude_suggest: () => ({ command: "should not be used", note: "" }) });
    submitLine(id, "?   ");
    await flush();
    expect(pane(id).suggestion).toBeNull();
    expect(tauri.calls().some((c) => c.cmd === "claude_suggest")).toBe(false);
  });

  it("`aurora auth|key|login` starts key entry", () => {
    for (const sub of ["auth", "key", "login", "AUTH"]) {
      const id = mkPane();
      submitLine(id, `aurora ${sub}`);
      expect(useStore.getState().keyEntry).toBe(true);
      useStore.setState({ keyEntry: false });
    }
  });

  it("`aurora logout` clears the stored key and notifies the pty", async () => {
    const id = mkPane();
    withPty(id);
    useStore.setState({ apiKeyPresent: true });
    tauri.invoke({ key_delete: () => undefined });
    submitLine(id, "aurora logout");
    expect(tauri.lastCall("pty_write")?.args.data).toContain("aurora: key removed");
    await flush();
    expect(useStore.getState().apiKeyPresent).toBe(false);
  });

  it("`aurora logout` without a live pty still clears the key (no write)", async () => {
    const id = mkPane();
    useStore.setState({ apiKeyPresent: true });
    submitLine(id, "aurora logout");
    expect(tauri.lastCall("pty_write")).toBeUndefined();
    await flush();
    expect(useStore.getState().apiKeyPresent).toBe(false);
  });

  it("`aurora` with no/unknown subcommand opens settings", () => {
    const id = mkPane();
    submitLine(id, "aurora");
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.setState({ settingsOpen: false });

    const id2 = mkPane();
    submitLine(id2, "aurora frobnicate");
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("settings/config/prefs open settings", () => {
    for (const w of ["settings", "config", "prefs"]) {
      const id = mkPane();
      submitLine(id, w);
      expect(useStore.getState().settingsOpen).toBe(true);
      useStore.setState({ settingsOpen: false });
    }
  });

  it("`run <name>` with no matching script prints feedback in the pane", () => {
    const id = mkPane();
    submitLine(id, "run build");
    const b = pane(id).blocks.at(-1)!;
    expect(b.command).toBe("run build");
    expect(b.exitCode).toBe(1);
    expect(b.output).toContain("no script 'build'");
  });

  it("bare `run` opens the scripts panel", () => {
    const id = mkPane();
    submitLine(id, "run");
    expect(useStore.getState().panel).toBe("scripts");
  });

  it("`scripts` opens the scripts setup modal", () => {
    const id = mkPane();
    submitLine(id, "scripts");
    expect(useStore.getState().scriptsSetupOpen).toBe(true);
  });

  it("a single-word typo is offered as a suggestion, not executed", () => {
    const id = mkPane();
    submitLine(id, "gs");
    expect(pane(id).suggestion).toEqual({ command: "git status", note: "Looks like a typo — run the corrected command?" });
    expect(pane(id).blocks).toEqual([]);
  });

  it("a multi-word line with a typo'd first word is corrected and offered", () => {
    const id = mkPane();
    submitLine(id, "gti status");
    expect(pane(id).suggestion?.command).toBe("git status");
  });

  it("cd.. is corrected to `cd ..`", () => {
    const id = mkPane();
    submitLine(id, "cd..");
    expect(pane(id).suggestion?.command).toBe("cd ..");
  });

  it("a normal, non-typo command runs directly in the shell", () => {
    const id = mkPane();
    submitLine(id, "ls -la");
    expect(pane(id).blocks.at(-1)?.command).toBe("ls -la");
    expect(pane(id).suggestion).toBeNull();
  });
});

// ── runInShell (via submit) ──────────────────────────────────────────────────

describe("runInShell", () => {
  it("clear/cls wipe blocks (no new block) and forward to a live pty", () => {
    const id = mkPane();
    withPty(id);
    useStore.getState().setInput(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).blocks.length).toBe(1);
    useStore.getState().setInput(id, "clear");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).blocks).toEqual([]);
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "clear\n" });
  });

  it("cls without a live pty still clears blocks, writes nothing", () => {
    const id = mkPane();
    useStore.getState().startBlock(id, "x", "/y");
    useStore.getState().setInput(id, "cls");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).blocks).toEqual([]);
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("cd <dir> resolves against cwd and updates it", () => {
    const id = mkPane("/Users/test/proj");
    withPty(id);
    useStore.getState().setInput(id, "cd sub");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).cwd).toBe("/Users/test/proj/sub");
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "cd sub\n" });
  });

  it("an interactive program hands the pane over to raw mode", () => {
    const id = mkPane();
    withPty(id);
    useStore.getState().setInput(id, "vim file.txt");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).rawMode).toBe(true);
  });

  it("a non-interactive command leaves raw mode untouched", () => {
    const id = mkPane();
    withPty(id);
    useStore.getState().setInput(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).rawMode).toBe(false);
  });

  it("without a live pty: warns, ends the block with exit 1, and respawns the pane", () => {
    const id = mkPane();
    const epochBefore = pane(id).ptyEpoch;
    useStore.getState().setInput(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    const b = pane(id).blocks.at(-1)!;
    expect(b.running).toBe(false);
    expect(b.exitCode).toBe(1);
    expect(b.output).toContain("lost its shell");
    expect(pane(id).ptyEpoch).toBe(epochBefore + 1);
  });
});

// ── runInShell: capture-on-every-command + poll-ensure (sticky-running-server-tabs) ──
// Generalisation this feature adds to the Enter path: EVERY typed command (not
// just the dedicated "Run servers" flow, already covered in servers.cov.test.tsx)
// fires a fire-and-forget captureServerPgid and ensures the generic liveness poll
// is running — otherwise a typed `nx serve --no-tui` would never get its detached
// pgid captured and would never badge/route Ctrl+C correctly.

describe("runInShell — capture-on-every-command + poll-ensure", () => {
  let capturedTick: (() => Promise<void>) | null;
  let origSetInterval: typeof globalThis.setInterval;
  let origClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    // Reset any real poll left running by earlier tests in this file (Enter
    // fires ensurePtyPoll() unconditionally, and the interval is a module-level
    // singleton shared across every test in this process).
    stopPtyPoll();
    capturedTick = null;
    origSetInterval = globalThis.setInterval;
    origClearInterval = globalThis.clearInterval;
    (globalThis as unknown as { setInterval: unknown }).setInterval = ((cb: () => Promise<void>) => {
      capturedTick = cb;
      return 424242 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = (() => {}) as typeof clearInterval;
  });

  afterEach(() => {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    stopPtyPoll();
  });

  it("fires pty.captureServerPgid(ptyId) for an ORDINARY typed command, not just the Run-button flow", () => {
    const id = mkPane();
    withPty(id, "pty-cap-1");
    useStore.getState().setInput(id, "nx serve my-app --no-tui");
    handleKeyDown(keyEvt("Enter"));
    expect(tauri.calls().some((c) => c.cmd === "pty_capture_server_pgid" && c.args.id === "pty-cap-1")).toBe(true);
  });

  // Code-review regression (#1, MAJEUR): resubmitting a command in a pane whose
  // server capture is already confirmed alive must NOT re-trigger the capture
  // round-trip — the Rust side no-ops this too (should_rearm), but this test
  // would fail if the front-end guard regressed and unconditionally re-fired
  // pty_capture_server_pgid, which is exactly the bug: on the real backend that
  // call resets the session to Pending, clobbering a still-alive Found(pgid)
  // and losing Ctrl+C's only kill target.
  it("does NOT re-fire captureServerPgid when serverStatus is already 'alive' for this ptyId", () => {
    const id = mkPane();
    withPty(id, "pty-cap-alive");
    useStore.setState({ serverStatus: { "pty-cap-alive": "alive" } });
    useStore.getState().setInput(id, "echo again");
    handleKeyDown(keyEvt("Enter"));
    expect(tauri.calls().some((c) => c.cmd === "pty_capture_server_pgid")).toBe(false);
  });

  it("DOES re-fire captureServerPgid when serverStatus is anything other than 'alive' (dead/uncaptured/capturing/unset)", () => {
    for (const status of ["dead", "uncaptured", "capturing", undefined] as const) {
      tauri.reset();
      const id = mkPane();
      withPty(id, "pty-cap-notalive");
      if (status) useStore.setState({ serverStatus: { "pty-cap-notalive": status } });
      useStore.getState().setInput(id, "echo again");
      handleKeyDown(keyEvt("Enter"));
      expect(tauri.calls().some((c) => c.cmd === "pty_capture_server_pgid" && c.args.id === "pty-cap-notalive")).toBe(true);
    }
  });

  it("ensures the generic liveness poll is running (setInterval fires) after a single ordinary command, so a later detach is still observed", () => {
    const id = mkPane();
    withPty(id, "pty-cap-2");
    useStore.getState().setInput(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    expect(capturedTick).not.toBeNull();
  });

  it("a captureServerPgid rejection from the typed-command path is swallowed (fire-and-forget) — the block still completes", async () => {
    const id = mkPane();
    withPty(id, "pty-cap-3");
    tauri.invoke({
      pty_capture_server_pgid: () => {
        throw new Error("sampler boom");
      },
    });
    useStore.getState().setInput(id, "ls");
    expect(() => handleKeyDown(keyEvt("Enter"))).not.toThrow();
    await flush();
    expect(pane(id).blocks.at(-1)?.command).toBe("ls");
  });

  it("without a live pty, neither captureServerPgid nor the poll fire (nothing to capture)", () => {
    const id = mkPane();
    useStore.getState().setInput(id, "ls");
    handleKeyDown(keyEvt("Enter"));
    expect(tauri.calls().some((c) => c.cmd === "pty_capture_server_pgid")).toBe(false);
    expect(capturedTick).toBeNull();
  });
});

// ── askClaude ─────────────────────────────────────────────────────────────

describe("askClaude (via `? <question>`)", () => {
  it("sets suggestionLoading then the resolved suggestion on success", async () => {
    const id = mkPane();
    tauri.invoke({ claude_suggest: () => ({ command: "git stash", note: "ok" }) });
    useStore.getState().setInput(id, "? stash my changes");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(pane(id).suggestion).toEqual({ command: "git stash", note: "ok" });
    expect(pane(id).suggestionLoading).toBe(false);
  });

  it("gathers project context for the pane's cwd and forwards the formatted block to claude_suggest", async () => {
    const id = mkPane("/repo");
    tauri.invoke({
      claude_suggest: () => ({ command: "pnpm build", note: "ok" }),
      git_repo_info: () => ({ root: "/repo", main_root: "/repo", name: "repo", default_branch: "main", current_branch: "main" }),
      list_dir: (a: Record<string, unknown>) =>
        a.path === "/repo" ? [{ name: "package.json", is_dir: false }, { name: "pnpm-lock.yaml", is_dir: false }] : [],
      read_text_file: (a: Record<string, unknown>) =>
        a.path === "/repo/package.json" ? JSON.stringify({ scripts: { build: "vite build" } }) : null,
    });
    useStore.getState().setInput(id, "? build the project");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    const call = tauri.lastCall("claude_suggest");
    expect(call?.args.context).toContain("package manager: pnpm");
    expect(call?.args.context).toContain("Scripts: build");
  });

  it("passes context: undefined when detection finds nothing useful (context-free call, today's behavior)", async () => {
    const id = mkPane("/Users/test/proj");
    tauri.invoke({ claude_suggest: () => ({ command: "ls", note: "ok" }) });
    useStore.getState().setInput(id, "? list files");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(tauri.lastCall("claude_suggest")?.args.context).toBeUndefined();
  });

  it("a project-context detection failure is non-fatal — falls back to the context-free call", async () => {
    const id = mkPane("/repo");
    tauri.invoke({
      claude_suggest: () => ({ command: "ls", note: "ok" }),
      git_repo_info: () => {
        throw new Error("detection boom");
      },
      list_dir: () => {
        throw new Error("detection boom");
      },
    });
    useStore.getState().setInput(id, "? list files");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(pane(id).suggestion).toEqual({ command: "ls", note: "ok" });
    expect(tauri.lastCall("claude_suggest")?.args.context).toBeUndefined();
  });

  it("maps a no-key backend error to a needsKey suggestion", async () => {
    const id = mkPane();
    tauri.invoke({
      claude_suggest: () => {
        throw new Error("no-key");
      },
    });
    useStore.getState().setInput(id, "? anything");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(pane(id).suggestion?.needsKey).toBe(true);
    expect(pane(id).suggestion?.command).toBe("");
  });

  it("surfaces a generic backend error as a note", async () => {
    const id = mkPane();
    tauri.invoke({
      claude_suggest: () => {
        throw new Error("rate limited");
      },
    });
    useStore.getState().setInput(id, "? anything");
    handleKeyDown(keyEvt("Enter"));
    await flush();
    expect(pane(id).suggestion?.note).toContain("rate limited");
    expect(pane(id).suggestion?.command).toBe("");
  });
});

// ── pasteClipboard (⌘V) ──────────────────────────────────────────────────────

describe("pasteClipboard", () => {
  it("appends clipboard text to the input", async () => {
    const id = mkPane();
    clipboardText = " pasted text ";
    useStore.getState().setInput(id, "echo ");
    handleKeyDown(keyEvt("v", { metaKey: true }));
    await flush();
    expect(pane(id).input).toBe("echo  pasted text ");
  });

  it("during key entry, whitespace is stripped and the error cleared", async () => {
    const id = mkPane();
    clipboardText = "sk- ant 123\t456";
    useStore.setState({ keyEntry: true, keyError: "bad" });
    handleKeyDown(keyEvt("V", { metaKey: true }));
    await flush();
    expect(pane(id).input).toBe("sk-ant123456");
    expect(useStore.getState().keyError).toBeNull();
  });

  it("an empty clipboard is a harmless no-op append", async () => {
    const id = mkPane();
    clipboardText = "";
    useStore.getState().setInput(id, "abc");
    handleKeyDown(keyEvt("v", { metaKey: true }));
    await flush();
    expect(pane(id).input).toBe("abc");
  });

  it("a clipboard read failure is swallowed (no state change)", async () => {
    const id = mkPane();
    clipboardShouldThrow = true;
    useStore.getState().setInput(id, "abc");
    handleKeyDown(keyEvt("v", { metaKey: true }));
    await flush();
    expect(pane(id).input).toBe("abc");
  });

  it("bails out if the active pane disappears while the read is in flight", async () => {
    const id = mkPane();
    clipboardText = "late text";
    useStore.getState().setInput(id, "abc");
    handleKeyDown(keyEvt("v", { metaKey: true }));
    // Race: the workspace goes away before readText() resolves.
    useStore.setState({ activeWs: null });
    await flush();
    expect(findPane(useStore.getState(), id)?.input).toBe("abc");
  });
});

// ── triggerFolderCompletion / completionBase (via Tab on a path arg) ────────

describe("triggerFolderCompletion", () => {
  it("honors an existing ghost when there are no folder matches", () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setDirNames(id, ["src"]);
    useStore.getState().setInput(id, "cd sr"); // ghost "c" from dirNames
    tauri.invoke({ list_dir: () => [] });
    handleKeyDown(keyEvt("Tab"));
    return flush().then(() => {
      expect(pane(id).input).toBe("cd src");
    });
  });

  it("does nothing when there are no matches and no ghost", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd zz");
    tauri.invoke({ list_dir: () => [] });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(pane(id).input).toBe("cd zz");
    expect(pane(id).completion).toBeNull();
  });

  it("completes inline on exactly one match", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd sc");
    tauri.invoke({ list_dir: () => [{ name: "scripts", is_dir: true }] });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(pane(id).input).toBe("cd scripts/");
    expect(pane(id).completion).toBeNull();
  });

  it("extends to the common prefix and opens a list on many matches (prefix beyond the leaf)", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd sc");
    tauri.invoke({
      list_dir: () => [
        { name: "scripts", is_dir: true },
        { name: "scriptable", is_dir: true },
      ],
    });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(pane(id).input).toBe("cd script");
    expect(pane(id).completion?.items.length).toBe(2);
  });

  it("opens a list without extending input when the common prefix doesn't grow (immediate divergence)", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd s");
    tauri.invoke({
      list_dir: () => [
        { name: "src", is_dir: true },
        { name: "scripts", is_dir: true },
      ],
    });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(pane(id).input).toBe("cd s");
    expect(pane(id).completion?.items.length).toBe(2);
  });

  it("drops a stale result when the input changed while the read was in flight", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd sc");
    tauri.invoke({ list_dir: () => [{ name: "scripts", is_dir: true }] });
    handleKeyDown(keyEvt("Tab"));
    useStore.getState().setInput(id, "cd scX"); // user kept typing before the read resolved
    await flush();
    expect(pane(id).input).toBe("cd scX"); // untouched by the abandoned completion
    expect(pane(id).completion).toBeNull();
  });

  it("resolves a ~-rooted path as-is (no cwd join)", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd ~/sub");
    tauri.invoke({ list_dir: () => [] });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(tauri.lastCall("list_dir")?.args.path).toBe("~/");
  });

  it("resolves an absolute path as-is (no cwd join)", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd /etc/pa");
    tauri.invoke({ list_dir: () => [] });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(tauri.lastCall("list_dir")?.args.path).toBe("/etc/");
  });

  it("joins a relative dir prefix onto cwd", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd sub/de");
    tauri.invoke({ list_dir: () => [] });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(tauri.lastCall("list_dir")?.args.path).toBe("/Users/test/proj/sub/");
  });

  it("reads the cwd itself when the token has no dir prefix", async () => {
    const id = mkPane("/Users/test/proj");
    useStore.getState().setInput(id, "cd sc"); // preceded by "cd " → path arg, no "/" in token
    tauri.invoke({ list_dir: () => [] });
    handleKeyDown(keyEvt("Tab"));
    await flush();
    expect(tauri.lastCall("list_dir")?.args.path).toBe("/Users/test/proj");
  });
});

// ── The one-time "Introducing Workspaces" intro — keyboard-modal guard ─────
// (workspaces-intro-dialog). The file-level beforeEach seeds introSeen:true
// so the suites above (pre-existing keymap behavior) aren't gated by it; this
// describe block overrides introSeen:false per test to cover the guard itself.

describe("handleKeyDown — 'Introducing Workspaces' intro guard (settings.introSeen === false)", () => {
  beforeEach(() => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, introSeen: false } });
  });

  it("Escape dismisses the intro (dismissIntro runs) and calls preventDefault, even with no active pane/workspace", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("Escape");
    handleKeyDown(evt);
    expect(useStore.getState().settings.introSeen).toBe(true);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("Escape dismisses the intro even when e.target is a TEXTAREA (focus landed in the xterm textarea mounted behind the modal on first launch inside a repo) — the intro guard now runs above the form-field early-return", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("Escape", { target: { tagName: "TEXTAREA" } });
    handleKeyDown(evt);
    expect(useStore.getState().settings.introSeen).toBe(true);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("Escape dismisses the intro even when e.target is an INPUT", () => {
    useStore.setState({ activeWs: null });
    const evt = keyEvt("Escape", { target: { tagName: "INPUT" } });
    handleKeyDown(evt);
    expect(useStore.getState().settings.introSeen).toBe(true);
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("swallows ⌘K: the command palette does not open while the intro is unseen", () => {
    useStore.setState({ activeWs: null, command: null });
    handleKeyDown(keyEvt("k", { metaKey: true }));
    expect(useStore.getState().command).toBeNull();
    expect(useStore.getState().settings.introSeen).toBe(false); // only Escape dismisses, not other keys
  });

  it("swallows ⌘,: settings does not open while the intro is unseen", () => {
    useStore.setState({ activeWs: null, settingsOpen: false });
    handleKeyDown(keyEvt(",", { metaKey: true }));
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("swallows ⌘B: the workspace rail does not toggle while the intro is unseen", () => {
    useStore.setState({ activeWs: null, railCollapsed: false });
    handleKeyDown(keyEvt("b", { metaKey: true }));
    expect(useStore.getState().railCollapsed).toBe(false);
  });

  it("once introSeen is true, the guard is inert: Escape falls through to normal handling (closes the open command palette) instead of re-dismissing", () => {
    useStore.getState().openCommand();
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, introSeen: true } });
    expect(useStore.getState().command).not.toBeNull();
    handleKeyDown(keyEvt("Escape"));
    expect(useStore.getState().command).toBeNull();
  });
});
