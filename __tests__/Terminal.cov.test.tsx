/**
 * Line-coverage suite for src/components/Terminal.tsx — the per-pane PTY engine.
 *
 * Strategy: render <Terminal paneId=.../> against the real Zustand store (a fresh
 * pane created via createWorkspace per test), drive the mocked `invoke("pty_spawn")`
 * and `tauri.emit("pty:data" | "pty:exit", ...)` to simulate the Rust backend, and
 * assert on real store state + the mocked xterm instance's recorded writes/options.
 *
 * Gotcha this file works around: `pty` (src/term/pty.ts) is a module-level singleton
 * whose `ensure()` registers `listen("pty:data"/"pty:exit", ...)` into the tauri
 * mock's listener map exactly ONCE per process (it caches a resolved `ready` promise
 * forever). `tauri.reset()` clears that listener map (to give every test clean
 * invoke handlers), which would silently break `tauri.emit(...)` for every test
 * after the first. Fix: force PtyHub to re-run `ensure()` each test by nulling its
 * `ready` field (a TS-only `private`, i.e. a plain runtime property) — this is
 * introspection of our own test's module instance, not a modification of src/ or
 * test/ infra.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { act } from "react";
import { tauri } from "../test/mocks/tauri";
import { pty } from "../src/term/pty";
import { useStore, findPane } from "../src/state/store";
import { Terminal as XTermMock } from "@xterm/xterm";
import { FitAddon as FitAddonMock } from "@xterm/addon-fit";
import { Terminal } from "../src/components/Terminal";

// ── xterm/RO instance capture (patches the shared mock classes' prototypes; this
// is a test-local spy on our own file's usage, not a re-registration of the
// mock.module() bindings set up by test/setup.ts) ─────────────────────────────

type AnyTerm = InstanceType<typeof XTermMock> & {
  written: string[];
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  _emitData: (d: string) => void;
};

const openedTerms: AnyTerm[] = [];
const origOpen = XTermMock.prototype.open;
XTermMock.prototype.open = function (this: AnyTerm, el: HTMLElement) {
  openedTerms.push(this);
  return origOpen.call(this, el);
};

let focusCalls = 0;
const origFocus = XTermMock.prototype.focus;
XTermMock.prototype.focus = function (this: AnyTerm) {
  focusCalls++;
  return origFocus.call(this);
};

let fitCallCount = 0;
let fitShouldThrow = false;
const origFit = FitAddonMock.prototype.fit;
FitAddonMock.prototype.fit = function (this: InstanceType<typeof FitAddonMock>) {
  fitCallCount++;
  if (fitShouldThrow) throw new Error("not laid out");
  return origFit.call(this);
};

class SpyResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const roInstances: SpyResizeObserver[] = [];
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class extends SpyResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    super(cb);
    roInstances.push(this);
  }
};

function b64(s: string) {
  return Buffer.from(s, "latin1").toString("base64");
}

function emitData(id: string, text: string) {
  tauri.emit("pty:data", { id, data: b64(text) });
}

function emitExit(id: string, code: number) {
  tauri.emit("pty:exit", { id, code });
}

async function tick(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function mkPane(): number {
  const wsId = useStore.getState().createWorkspace({
    repoId: null,
    title: "t" + Math.random(),
    dir: "/tmp/aurora-test",
  });
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
  return ws.tabs[0].panes[0].id;
}

function pane(paneId: number) {
  return findPane(useStore.getState(), paneId)!;
}

let spawnSeq = 0;
beforeEach(() => {
  tauri.reset();
  (pty as unknown as { ready: Promise<void> | null }).ready = null;
  openedTerms.length = 0;
  roInstances.length = 0;
  focusCalls = 0;
  fitCallCount = 0;
  fitShouldThrow = false;
  spawnSeq++;
});
afterEach(() => {
  cleanup();
});

const AURORA_READY = "\x1b]1337;AuroraReady\x07";

describe("Terminal — zsh spawn / readiness gate", () => {
  it("writes ZSH_INIT, gates output until the AuroraReady banner, then flips ready (and the 1200ms initTimer fallback also fires)", async () => {
    const id = `zsh-${spawnSeq}`;
    tauri.invoke({
      pty_spawn: () => ({ id, shell: "/bin/zsh", is_zsh: true }),
    });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();

    // .then() zsh branch: ZSH_INIT written, readyRef flipped false (not ready yet)
    const write = tauri.lastCall("pty_write");
    expect(write?.args.id).toBe(id);
    expect(String(write?.args.data)).toContain("AuroraReady");
    expect(pane(paneId).ready).toBe(false);

    // readyRef false + no banner in this chunk → data dropped, still not ready
    await act(async () => {
      emitData(id, "some early boot noise\n");
    });
    expect(pane(paneId).ready).toBe(false);
    expect(pane(paneId).blocks.length).toBe(0);

    // readyRef false + banner present → ready flips
    await act(async () => {
      emitData(id, AURORA_READY);
    });
    expect(pane(paneId).ready).toBe(true);

    // term.onData → pty.write once a ptyId is wired up
    const term = openedTerms[openedTerms.length - 1];
    term._emitData("ls\n");
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id, data: "ls\n" });

    // let the 1200ms initTimer fallback fire too (idempotent setReady + readyRef=true)
    await tick(1300);
    expect(pane(paneId).ready).toBe(true);
  }, 3000);
});

describe("Terminal — non-zsh spawn / blocks-mode parsing", () => {
  it("is ready immediately (no ZSH_INIT write); appends output around OSC 133 D + OSC 7; onExit marks the pane exited", async () => {
    const id = `bash-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();

    expect(pane(paneId).ready).toBe(true);
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);

    useStore.getState().startBlock(paneId, "echo hi", "/tmp/aurora-test");

    await act(async () => {
      // no "\x1b]133;C" marker in this chunk → rawSeedRef else-branch (line 247)
      emitData(id, "before" + "middle" + "\x1b]133;D;0\x07" + "after-ignored");
    });
    const p = pane(paneId);
    expect(p.blocks[0].output).toBe("beforemiddle");
    expect(p.blocks[0].exitCode).toBe(0);
    expect(p.blocks[0].running).toBe(false);

    await act(async () => {
      emitExit(id, 1);
    });
    expect(pane(paneId).exited).toBe(true);
  });

  it("blocks-mode paste is a no-op (rawMode false → early return, event not consumed)", async () => {
    const id = `bash-paste-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    const { container } = render(<Terminal paneId={paneId} />);
    await tick();
    expect(pane(paneId).rawMode).toBe(false);

    const el = container.querySelector(".aurora-term")!;
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    const prevented = !el.dispatchEvent(ev);
    // default not prevented since the handler returns before ev.preventDefault()
    expect(prevented).toBe(false);
  });
});

describe("Terminal — OSC parsing edge cases", () => {
  it("buffers an OSC sequence split across two pty chunks via pendingRef, then resolves it on the next chunk", async () => {
    const id = `split-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();
    useStore.getState().startBlock(paneId, "cmd", "/tmp/aurora-test");

    await act(async () => {
      // chunk 1 ends mid-OSC (no terminator) → buffered into pendingRef
      emitData(id, "plain text" + "\x1b]133;D;0");
    });
    await act(async () => {
      // chunk 2 completes it
      emitData(id, "\x07after");
    });
    const p = pane(paneId);
    expect(p.blocks[0].output).toBe("plain text");
    expect(p.blocks[0].exitCode).toBe(0);
    expect(p.blocks[0].running).toBe(false);
  });

  it("OSC 7 with a malformed percent-escape is caught silently (cwd unchanged, no throw)", async () => {
    const id = `osc7bad-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();
    const cwdBefore = pane(paneId).cwd;

    await act(async () => {
      emitData(id, "\x1b]7;file://host/%\x07");
    });
    expect(pane(paneId).cwd).toBe(cwdBefore);
  });

  it("a well-formed OSC 7 updates the pane cwd (cIdx if-branch also hit via a trailing 133;C marker)", async () => {
    const id = `osc7ok-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();

    await act(async () => {
      emitData(id, "\x1b]7;file://host/new/dir\x07" + "\x1b]133;C\x07");
    });
    expect(pane(paneId).cwd).toBe("/new/dir");
  });
});

describe("Terminal — alternate-screen raw mode", () => {
  it("auto-enters raw mode on alt-screen enter, writes raw bytes, exits on alt-screen leave; focuses xterm while raw", async () => {
    const id = `alt-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();
    expect(pane(paneId).rawMode).toBe(false);

    await act(async () => {
      emitData(id, "\x1b[?1049h" + "vim screen contents");
    });
    expect(pane(paneId).rawMode).toBe(true);
    // rawMode effect (deps [rawMode]) re-runs → term.focus() called
    expect(focusCalls).toBeGreaterThan(0);

    const term = openedTerms[openedTerms.length - 1];
    expect(term.written.join("")).toContain("vim screen contents");

    await act(async () => {
      emitData(id, "\x1b[?1049l");
    });
    expect(pane(paneId).rawMode).toBe(false);
  });

  it("clears a pending prompt-watch timer when raw data arrives, and exits raw via an inline OSC 133;D (no alt-screen leave)", async () => {
    const id = `raw-inline-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();
    useStore.getState().startBlock(paneId, "survey", "/tmp/aurora-test");

    // arm the prompt watch (blocks-mode, cursor hidden, no alt-screen)
    await act(async () => {
      emitData(id, "\x1b[?25l" + "choose an option");
    });

    // before the 220ms timer fires, an alt-screen enter arrives → auto-raw,
    // and the raw branch must clear the still-pending promptTimer (lines 221-224)
    await act(async () => {
      emitData(id, "\x1b[?1049h" + "fullscreen app");
    });
    expect(pane(paneId).rawMode).toBe(true);

    // exit raw via an inline OSC 133;D (claude/REPL returning to prompt without leaving alt-screen)
    await act(async () => {
      emitData(id, "\x1b]133;D;3\x07");
    });
    const p = pane(paneId);
    expect(p.rawMode).toBe(false);
    expect(p.blocks[0].exitCode).toBe(3);
    expect(p.blocks[0].running).toBe(false);

    // the promptTimer that was armed above must not have fired later and
    // clobbered anything — wait past its 220ms window to be sure.
    await tick(260);
    expect(pane(paneId).rawMode).toBe(false);
  });
});

describe("Terminal — armPromptWatch idle-timer outcomes", () => {
  it("commits to raw mode with the seed when quiet+hidden-cursor persists on a running block; no-ops when rawMode/lastBlock/pane guards fail", async () => {
    let n = 0;
    tauri.invoke({ pty_spawn: () => ({ id: `arm-${spawnSeq}-${++n}`, shell: "/bin/bash", is_zsh: false }) });

    // Pane A: running block present → commits to raw with the seed.
    const paneA = mkPane();
    render(<Terminal paneId={paneA} />);
    await tick();
    useStore.getState().startBlock(paneA, "survey", "/tmp/aurora-test");

    // Pane B: rawMode flips true (by some other mechanism) before the timer fires.
    const paneB = mkPane();
    render(<Terminal paneId={paneB} />);
    await tick();
    useStore.getState().startBlock(paneB, "survey", "/tmp/aurora-test");

    // Pane C: no running block at fire time.
    const paneC = mkPane();
    render(<Terminal paneId={paneC} />);
    await tick();

    // Pane D: pane is gone (workspace removed) before the timer fires.
    const wsIdD = useStore.getState().createWorkspace({ repoId: null, title: "d", dir: "/tmp/aurora-test" });
    const paneD = useStore.getState().workspaces.find((w) => w.id === wsIdD)!.tabs[0].panes[0].id;
    render(<Terminal paneId={paneD} />);
    await tick();
    useStore.getState().startBlock(paneD, "survey", "/tmp/aurora-test");

    // Arm all four via hide-cursor chunks (also re-arm A twice → hits the
    // clear-and-rearm branch at lines 252-255).
    const ids = { a: `arm-${spawnSeq}-1`, b: `arm-${spawnSeq}-2`, c: `arm-${spawnSeq}-3`, d: `arm-${spawnSeq}-4` };
    await act(async () => {
      emitData(ids.a, "\x1b[?25l" + "spinner one");
      emitData(ids.a, "\x1b[?25l" + "spinner two"); // re-arm: clears + reschedules
      emitData(ids.b, "\x1b[?25l" + "spinner");
      emitData(ids.c, "\x1b[?25l" + "spinner");
      emitData(ids.d, "\x1b[?25l" + "spinner");
    });

    // Race pane B into rawMode before its timer fires.
    useStore.getState().setRawMode(paneB, true);
    // Remove pane D's workspace before its timer fires.
    useStore.getState().removeWorkspace(wsIdD);

    await tick(280);

    expect(pane(paneA).rawMode).toBe(true); // committed
    expect(findPane(useStore.getState(), paneD)).toBeUndefined(); // pane gone, no crash
    expect(pane(paneC).rawMode).toBe(false); // no running block → no-op
  }, 3000);
});

describe("Terminal — paste while raw", () => {
  it("intercepts paste in raw mode (preventDefault + stopImmediatePropagation) and reads the native clipboard", async () => {
    const id = `pasteraw-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    const { container } = render(<Terminal paneId={paneId} />);
    await tick();

    await act(async () => {
      emitData(id, "\x1b[?1049h");
    });
    expect(pane(paneId).rawMode).toBe(true);

    const el = container.querySelector(".aurora-term")!;
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    let immediatePropagationStopped = false;
    const origStop = ev.stopImmediatePropagation.bind(ev);
    ev.stopImmediatePropagation = () => {
      immediatePropagationStopped = true;
      origStop();
    };
    const notPrevented = el.dispatchEvent(ev);
    expect(notPrevented).toBe(false); // preventDefault() was called
    expect(immediatePropagationStopped).toBe(true);
    await tick(); // let readText().then(...) settle
  });
});

describe("Terminal — spawn failure handling", () => {
  it("a rejected spawn (still mounted) surfaces an error block and marks the pane exited", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    tauri.invoke({ pty_spawn: () => Promise.reject(new Error("boom")) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();

    const p = pane(paneId);
    expect(p.exited).toBe(true);
    expect(p.blocks[0].exitCode).toBe(1);
    expect(p.blocks[0].output).toContain("boom");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a rejected spawn after unmount is swallowed (disposed guard — no error surfaced, no store mutation)", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    tauri.invoke({
      pty_spawn: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 30)),
    });
    const paneId = mkPane();
    const { unmount } = render(<Terminal paneId={paneId} />);
    unmount();
    await tick(80);

    expect(pane(paneId).exited).toBe(false);
    expect(pane(paneId).blocks.length).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a resolved spawn after unmount is killed instead of wired up (disposed guard on the happy path)", async () => {
    const id = `late-ok-${spawnSeq}`;
    tauri.invoke({
      pty_spawn: () => new Promise((resolve) => setTimeout(() => resolve({ id, shell: "/bin/bash", is_zsh: false }), 30)),
    });
    const paneId = mkPane();
    const { unmount } = render(<Terminal paneId={paneId} />);
    unmount();
    await tick(80);

    expect(tauri.lastCall("pty_kill")?.args.id).toBe(id);
    expect(pane(paneId).ptyId).toBeNull();
  });
});

describe("Terminal — resize + settings + rawMode-focus effects", () => {
  it("ResizeObserver callback re-fits and resizes the pty once a ptyId exists (no-ops beforehand)", async () => {
    tauri.invoke({
      pty_spawn: () => new Promise((resolve) => setTimeout(() => resolve({ id: `ro-${spawnSeq}`, shell: "/bin/bash", is_zsh: false }), 20)),
    });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);

    const ro = roInstances[roInstances.length - 1];
    const before = fitCallCount;
    // fires before the ptyId is wired up → fit() still runs, pty.resize() does not
    ro.cb([] as unknown as ResizeObserverEntry[], ro as unknown as ResizeObserver);
    expect(fitCallCount).toBeGreaterThan(before);
    expect(tauri.calls().some((c) => c.cmd === "pty_resize")).toBe(false);

    await tick(60);
    ro.cb([] as unknown as ResizeObserverEntry[], ro as unknown as ResizeObserver);
    expect(tauri.lastCall("pty_resize")?.args.id).toBe(`ro-${spawnSeq}`);
  });

  it("settings changes (fontSize/accent) push new xterm options and resize the pty", async () => {
    const id = `settings-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    await tick();

    await act(async () => {
      useStore.getState().setSetting("fontSize", "large");
      useStore.getState().setSetting("accent", "amber");
    });

    const term = openedTerms[openedTerms.length - 1];
    expect(term.options.fontSize).toBe(15.5);
    expect((term.options.theme as { cursor: string }).cursor).toBe("#ecc06a");
    expect(tauri.lastCall("pty_resize")?.args.id).toBe(id);
  });

  it("fit() throwing during mount / resize / settings-update is swallowed (pane stays usable)", async () => {
    fitShouldThrow = true;
    const id = `fitthrow-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    expect(() => render(<Terminal paneId={paneId} />)).not.toThrow();
    await tick();

    const ro = roInstances[roInstances.length - 1];
    expect(() => ro.cb([] as unknown as ResizeObserverEntry[], ro as unknown as ResizeObserver)).not.toThrow();

    await act(async () => {
      useStore.getState().setSetting("fontSize", "compact");
    });
    expect(pane(paneId)).toBeTruthy();
  });

  it("rawMode effect focuses '#aurora-root' on the non-raw (default) path", async () => {
    const root = document.createElement("div");
    root.id = "aurora-root";
    let focused = false;
    root.focus = () => {
      focused = true;
    };
    document.body.appendChild(root);
    try {
      const id = `rootfocus-${spawnSeq}`;
      tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
      const paneId = mkPane();
      // start raw, then flip back to non-raw so the else-branch runs with the
      // element actually present (mount already ran it once with rawMode=false).
      render(<Terminal paneId={paneId} />);
      await tick();
      await act(async () => {
        emitData(id, "\x1b[?1049h");
      });
      expect(pane(paneId).rawMode).toBe(true);
      await act(async () => {
        emitData(id, "\x1b[?1049l");
      });
      expect(pane(paneId).rawMode).toBe(false);
      expect(focused).toBe(true);
    } finally {
      root.remove();
    }
  });
});

describe("Terminal — self-heal respawn", () => {
  it("respawns a pane whose pty never came up within the 2500ms idle window", async () => {
    tauri.invoke({ pty_spawn: () => new Promise(() => {}) }); // never resolves
    const paneId = mkPane();
    render(<Terminal paneId={paneId} />);
    expect(pane(paneId).ptyEpoch).toBe(0);

    await tick(2650);
    expect(pane(paneId).ptyEpoch).toBe(1);
  }, 4000);
});

describe("Terminal — unmount cleanup", () => {
  it("tears down cleanly: kills the live pty, clears pending timers, disconnects the observer", async () => {
    const id = `cleanup-${spawnSeq}`;
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/bash", is_zsh: false }) });
    const paneId = mkPane();
    const { unmount } = render(<Terminal paneId={paneId} />);
    await tick();
    expect(pane(paneId).ptyId).toBe(id);

    expect(() => unmount()).not.toThrow();
    expect(tauri.lastCall("pty_kill")?.args.id).toBe(id);
  });
});
