// Per-pane PTY engine. Spawns the user's $SHELL, injects zsh integration
// (suppressed prompt + OSC 133 command markers + OSC 7 cwd), and parses output:
// in normal mode it streams into the store's command blocks (rendered as DOM by
// the Pane); full-screen programs (alt-screen) flip the pane into raw mode where
// this xterm overlay takes over input + rendering.

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { pty } from "../term/pty";
import { useStore, findPane, workspaceOfPane } from "../state/store";
import { ManagedServerPane } from "./ManagedServerPane";

// Accent hex pairs [base, bright]. xterm renders on canvas (no CSS vars), so it
// needs concrete colors; these mirror the blocks palette and track the accent.
const ACCENT_HEX: Record<string, [string, string]> = {
  teal: ["#5fe3d1", "#8ff0e3"],
  indigo: ["#9d8cff", "#b9acff"],
  green: ["#6fe0a0", "#8ff0bb"],
  amber: ["#ecc06a", "#ffd587"],
};
const FONT_PX: Record<string, number> = { compact: 13, cozy: 14, large: 15.5 };

function xtermTheme(accent: string) {
  const [ac, acBright] = ACCENT_HEX[accent] ?? ACCENT_HEX.teal;
  return {
    // transparent so the pane's Aurora --win background shows through and the
    // interactive overlay blends seamlessly instead of looking embedded
    background: "rgba(0,0,0,0)",
    foreground: "#e8eaef",
    cursor: ac,
    cursorAccent: "#171c25",
    selectionBackground: `${ac}33`,
    black: "#3a4150", red: "#f2766a", green: "#6fdfa0", yellow: "#e3b34d",
    blue: "#7e9cf0", magenta: "#c79bf0", cyan: ac, white: "#e8eaef",
    brightBlack: "#8b94a3", brightRed: "#ff8a7e", brightGreen: "#8ff0bb", brightYellow: "#ecc06a",
    brightBlue: "#9ab8ff", brightMagenta: "#d2b8ff", brightCyan: acBright, brightWhite: "#f4f6fa",
  };
}

const ZSH_INIT =
  "PROMPT='' RPROMPT='' PROMPT_EOL_MARK=''; " +
  "_aurora_pe(){ printf '\\e]133;C\\a'; }; " +
  "_aurora_pc(){ local e=$?; printf '\\e]133;D;%s\\a' \"$e\"; printf '\\e]7;file://%s%s\\a' \"${HOST:-localhost}\" \"$PWD\"; }; " +
  "autoload -Uz add-zsh-hook 2>/dev/null && { add-zsh-hook preexec _aurora_pe; add-zsh-hook precmd _aurora_pc; }; " +
  "printf '\\e]7;file://%s%s\\a' \"${HOST:-localhost}\" \"$PWD\"; printf '\\e]1337;AuroraReady\\a'; clear\n";

/** The ordinary shell-PTY path — spawns `$SHELL` via `pty_spawn` and renders
 *  its output (blocks-mode text + the raw xterm overlay for full-screen
 *  programs). Renamed from `Terminal` unchanged; `Terminal` below branches to
 *  `ManagedServerPane` instead for a Servers-tab pane (managed-server-lifecycle). */
function ShellTerminal({ paneId, isActive }: { paneId: number; isActive: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const readyRef = useRef(true);
  const decoderRef = useRef(new TextDecoder());
  const pendingRef = useRef("");
  const outBufRef = useRef("");
  const rafRef = useRef<number | null>(null);
  // interactive-prompt fallback: raw output of the running command (to seed
  // xterm on flip), whether it currently has the cursor hidden, and the idle
  // timer that decides "hid cursor + went quiet → waiting for keys".
  const rawSeedRef = useRef("");
  const cursorHiddenRef = useRef(false);
  const promptTimerRef = useRef<number | null>(null);

  const fontSize = useStore((s) => s.settings.fontSize);
  const accent = useStore((s) => s.settings.accent);
  const rawMode = useStore((s) => findPane(s, paneId)?.rawMode ?? false);
  const ptyEpoch = useStore((s) => findPane(s, paneId)?.ptyEpoch ?? 0);
  const healAttempts = useRef(0);

  useEffect(() => {
    const settings = useStore.getState().settings;
    const term = new XTerm({
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: FONT_PX[settings.fontSize] ?? 14,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
      disableStdin: true,
      theme: xtermTheme(settings.accent),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (ref.current) term.open(ref.current);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    term.onData((d) => {
      if (ptyIdRef.current) pty.write(ptyIdRef.current, d);
    });

    // Paste while a full-screen program owns the pane. xterm's default paste
    // would read the clipboard via the Web Clipboard API, which on macOS pops up
    // a "Paste" confirmation button. Intercept it (capture, so we beat xterm's
    // own textarea handler), read the native pasteboard, and feed xterm via
    // paste() so the app's bracketed-paste mode is still respected.
    const container = ref.current;
    const onPaste = (ev: ClipboardEvent) => {
      if (!(findPane(useStore.getState(), paneId)?.rawMode)) return; // blocks-mode paste is the global keymap's job
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void readText().then((t) => t && term.paste(t)).catch(() => {});
    };
    container?.addEventListener("paste", onPaste, true);

    const flush = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (outBufRef.current) {
        useStore.getState().appendOutput(paneId, outBufRef.current);
        outBufRef.current = "";
      }
    };
    const appendToBlock = (t: string) => {
      outBufRef.current += t;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          flush();
        });
      }
    };

    // A running command hid the cursor then went quiet: it's almost certainly
    // blocked on an inline arrow-key prompt (survey/inquirer/promptui) that
    // never used the alternate screen. Hand the pane to xterm and seed it with
    // the command's output so the menu shows. Spinners keep emitting, so the
    // idle timer never fires for them.
    const armPromptWatch = () => {
      promptTimerRef.current = window.setTimeout(() => {
        promptTimerRef.current = null;
        const st = useStore.getState();
        const pane = findPane(st, paneId);
        if (!pane || pane.rawMode) return;
        const lastBlock = pane.blocks[pane.blocks.length - 1];
        if (!lastBlock?.running) return; // command finished — not an input wait
        flush();
        st.setRawMode(paneId, true);
        term.write(rawSeedRef.current);
      }, 220);
    };

    const parseNormal = (text: string) => {
      let data = pendingRef.current + text;
      pendingRef.current = "";
      const lastOsc = data.lastIndexOf("\x1b]");
      if (lastOsc !== -1) {
        const tail = data.slice(lastOsc);
        if (!tail.includes("\x07") && !tail.includes("\x1b\\")) {
          pendingRef.current = tail;
          data = data.slice(0, lastOsc);
        }
      }
      // eslint-disable-next-line no-control-regex
      const re = /\x1b\](\d+);?([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
      let last = 0;
      let m: RegExpExecArray | null;
      const st = useStore.getState();
      while ((m = re.exec(data))) {
        const plain = data.slice(last, m.index);
        if (plain) appendToBlock(plain);
        last = re.lastIndex;
        const code = m[1];
        const param = m[2];
        if (code === "133") {
          // C (command start) is ignored — we append all output to the running
          // block and strip the echoed command line at render. D carries the exit.
          if (param.startsWith("D")) {
            flush();
            const n = parseInt(param.split(";")[1] ?? "", 10);
            st.endBlock(paneId, Number.isNaN(n) ? null : n);
          }
        } else if (code === "7") {
          const fm = param.match(/file:\/\/[^/]*(.*)/);
          if (fm && fm[1]) {
            try {
              st.setCwd(paneId, decodeURIComponent(fm[1]));
            } catch {
              /* malformed */
            }
          }
        }
      }
      const rest = data.slice(last);
      if (rest) appendToBlock(rest);
    };

    let disposed = false;
    let initTimer: number | undefined;

    const startCwd = findPane(useStore.getState(), paneId)?.cwd;
    const startEnv = workspaceOfPane(useStore.getState(), paneId)?.env;
    pty
      .spawn(
        { cwd: startCwd, cols: term.cols, rows: term.rows, env: startEnv },
        (bytes) => {
          const text = decoderRef.current.decode(bytes, { stream: true });
          if (!readyRef.current) {
            if (text.includes("\x1b]1337;AuroraReady")) {
              readyRef.current = true;
              useStore.getState().setReady(paneId);
            }
            return;
          }
          const st = useStore.getState();
          let raw = findPane(st, paneId)?.rawMode ?? false;
          // auto-enter raw on alternate screen (vim, less, top, …)
          if (!raw && (text.includes("\x1b[?1049h") || text.includes("\x1b[?1047h"))) {
            flush();
            st.setRawMode(paneId, true);
            raw = true;
          }
          if (raw) {
            if (promptTimerRef.current != null) {
              clearTimeout(promptTimerRef.current);
              promptTimerRef.current = null;
            }
            term.write(bytes);
            const leftAlt = text.includes("\x1b[?1049l") || text.includes("\x1b[?1047l");
            // A program returning to the prompt emits OSC 133;D. It can arrive in
            // the SAME chunk as the alt-screen-leave (vim exits → precmd fires
            // right away), so handle it independently of `leftAlt` — an if/else
            // would drop the exit marker and leave the block stuck showing
            // "running" with the prompt hidden.
            // eslint-disable-next-line no-control-regex
            const m = text.match(/\x1b\]133;D;?(\d*)/);
            if (m) st.endBlock(paneId, m[1] ? parseInt(m[1], 10) : null);
            if (leftAlt || m) st.setRawMode(paneId, false);
            return;
          }

          // normal (blocks) mode — also watch for an inline interactive prompt.
          const cIdx = text.lastIndexOf("\x1b]133;C");
          if (cIdx !== -1) {
            rawSeedRef.current = text.slice(cIdx); // new command — reset the seed
            cursorHiddenRef.current = false;
          } else {
            rawSeedRef.current = (rawSeedRef.current + text).slice(-131072);
          }
          const hideIdx = text.lastIndexOf("\x1b[?25l");
          const showIdx = text.lastIndexOf("\x1b[?25h");
          if (hideIdx !== -1 || showIdx !== -1) cursorHiddenRef.current = hideIdx > showIdx;
          if (promptTimerRef.current != null) {
            clearTimeout(promptTimerRef.current);
            promptTimerRef.current = null;
          }
          parseNormal(text);
          if (cursorHiddenRef.current) armPromptWatch();
        },
        () => useStore.getState().markExited(paneId),
      )
      .then((res) => {
        if (disposed) {
          pty.kill(res.id);
          return;
        }
        ptyIdRef.current = res.id;
        useStore.getState().setPaneRuntime(paneId, { ptyId: res.id, isZsh: res.is_zsh });
        if (res.is_zsh) {
          readyRef.current = false;
          pty.write(res.id, ZSH_INIT);
          initTimer = window.setTimeout(() => {
            readyRef.current = true;
            useStore.getState().setReady(paneId);
          }, 1200);
        } else {
          useStore.getState().setReady(paneId);
        }
      })
      .catch((err) => {
        // A failed spawn used to vanish silently, leaving ptyId null so every
        // typed command was dropped with no feedback. Surface it instead.
        if (disposed) return;
        const msg = String(err);
        console.error(`[aurora] pty spawn failed for pane ${paneId}:`, msg);
        const st = useStore.getState();
        const p = findPane(st, paneId);
        st.startBlock(paneId, "", p?.cwd ?? "");
        st.appendOutput(paneId, `\x1b[31maurora: couldn't start a shell here — ${msg}\x1b[0m\n`);
        st.endBlock(paneId, 1);
        st.markExited(paneId);
      });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
      if (ptyIdRef.current) pty.resize(ptyIdRef.current, term.cols, term.rows);
    });
    if (ref.current) ro.observe(ref.current);

    return () => {
      disposed = true;
      if (initTimer) clearTimeout(initTimer);
      if (promptTimerRef.current != null) clearTimeout(promptTimerRef.current);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      container?.removeEventListener("paste", onPaste, true);
      ro.disconnect();
      if (ptyIdRef.current) pty.kill(ptyIdRef.current);
      term.dispose();
    };
  }, [paneId, ptyEpoch]);

  // Self-heal: if a spawn was lost (e.g. a boot-time mount/dispose race left this
  // pane with no shell), respawn it once it's been mounted a moment with no PTY.
  // Capped so a genuinely failing spawn can't loop forever.
  useEffect(() => {
    healAttempts.current = 0;
  }, [paneId]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = findPane(useStore.getState(), paneId);
      if (p && !p.ptyId && !p.exited && healAttempts.current < 3) {
        healAttempts.current += 1;
        useStore.getState().respawnPane(paneId);
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [paneId, ptyEpoch]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = FONT_PX[fontSize] ?? 14;
    term.options.theme = xtermTheme(accent);
    try {
      fitRef.current?.fit();
    } catch {
      /* hidden */
    }
    if (ptyIdRef.current) pty.resize(ptyIdRef.current, term.cols, term.rows);
  }, [fontSize, accent]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !rawMode;
    // Only the active pane may grab/return keyboard focus. A background split
    // pane toggling raw mode must not steal focus and misdirect keystrokes.
    if (isActive) {
      if (rawMode) term.focus();
      else document.getElementById("aurora-root")?.focus();
    }
  }, [rawMode, isActive]);

  return (
    <div
      ref={ref}
      className="aurora-term"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: rawMode ? 2 : 0,
        opacity: rawMode ? 1 : 0,
        pointerEvents: rawMode ? "auto" : "none",
      }}
    />
  );
}

/**
 * Public entry point rendered by Pane.tsx. Branches on `pane.serverId`
 * (managed-server-lifecycle): a Servers-tab pane assigned to a managed
 * process renders `ManagedServerPane` (subscribes to that process's own
 * "server:data" stream); every other pane keeps the original shell-PTY path
 * unchanged (`ShellTerminal`).
 */
export function Terminal({ paneId, isActive }: { paneId: number; isActive: boolean }) {
  const serverId = useStore((s) => findPane(s, paneId)?.serverId ?? null);
  if (serverId) return <ManagedServerPane paneId={paneId} serverId={serverId} />;
  return <ShellTerminal paneId={paneId} isActive={isActive} />;
}
