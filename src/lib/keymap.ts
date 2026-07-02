// Global keyboard handling for the Aurora prompt + app shortcuts, plus the
// command runner. In normal mode Aurora owns the prompt; xterm's textarea (raw
// mode) and form fields keep their own keystrokes.

import { useStore, activePane, activeGroup, activeWorkspace, findPane, type PaneState } from "../state/store";
import { pty, SIGINT } from "../term/pty";
import { claudeSuggest, NoKeyError } from "../ai/suggest";
import { typoFix, isInteractive, splitPathToken, folderCandidates, commonPrefix, type PathToken } from "./commands";
import { keySet, keyDelete } from "./keychain";
import { resolveCd, listDir } from "./sys";
import { gatherProjectContext, formatProjectContext } from "./projectContext";
import { runScript } from "./scripts";
import { ensurePtyPoll, paneRunning } from "./running";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

function focusRoot() {
  document.getElementById("aurora-root")?.focus();
}

async function pasteClipboard() {
  let text: string;
  try {
    // Read via the native pasteboard (Rust) rather than the Web Clipboard API,
    // which on macOS WKWebView pops up a "Paste" confirmation button.
    text = (await readText()) || "";
  } catch {
    return;
  }
  const s = useStore.getState();
  const pane = activePane(s);
  if (!pane) return;
  if (s.keyEntry) {
    s.setKeyError(null);
    s.setInput(pane.id, pane.input + text.replace(/\s+/g, ""));
  } else {
    s.setInput(pane.id, pane.input + text);
  }
}

async function saveKey(pane: PaneState) {
  const s = useStore.getState();
  const raw = pane.input.trim();
  if (!raw) {
    s.cancelKeyEntry();
    s.setInput(pane.id, "");
    return;
  }
  if (!/^sk-/.test(raw) || raw.length < 12) {
    s.setKeyError("that doesn't look like an Anthropic key — expected sk-ant-…");
    return;
  }
  try {
    await keySet(raw);
    s.setApiKeyPresent(true);
    s.cancelKeyEntry();
    s.setInput(pane.id, "");
  } catch (e) {
    s.setKeyError(String(e));
  }
}

// Aurora's own commands (the `claude` name is left to the real Claude Code CLI).
function handleAurora(pane: PaneState, args: string[]) {
  const s = useStore.getState();
  const sub = (args[0] || "").toLowerCase();
  if (sub === "auth" || sub === "key" || sub === "login") {
    s.startKeyEntry();
    return;
  }
  if (sub === "logout") {
    keyDelete().then(() => s.setApiKeyPresent(false));
    if (pane.ptyId) pty.write(pane.ptyId, "printf 'aurora: key removed\\n'\n");
    return;
  }
  s.openSettings();
}

async function askClaude(pane: PaneState, text: string) {
  const s = useStore.getState();
  s.setSuggestionLoading(pane.id, true);
  try {
    // Best-effort repo context (toolchain, real scripts/targets, git state) so
    // the suggestion matches the repo instead of guessing `npm`. Detection
    // failure is non-fatal — fall back to the context-free call below.
    let context: string | undefined;
    try {
      context = formatProjectContext(await gatherProjectContext(pane.cwd)) || undefined;
    } catch {
      context = undefined;
    }
    const sug = await claudeSuggest(text, pane.cwd, s.settings.model, context);
    s.setSuggestion(pane.id, sug);
  } catch (e) {
    if (e instanceof NoKeyError) {
      s.setSuggestion(pane.id, {
        command: "",
        note: "Bring your own key to get Claude command suggestions.",
        needsKey: true,
      });
    } else {
      s.setSuggestion(pane.id, {
        command: "",
        note: `claude: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

function runInShell(pane: PaneState, cmd: string) {
  const s = useStore.getState();
  const trimmed = cmd.trim();
  if (trimmed === "clear" || trimmed === "cls") {
    s.clearBlocks(pane.id);
    if (pane.ptyId) pty.write(pane.ptyId, "clear\n");
    return;
  }
  const parts = trimmed.split(/\s+/);
  if (parts[0] === "cd") {
    s.setCwd(pane.id, resolveCd(pane.cwd, parts[1], s.home));
  }
  s.startBlock(pane.id, cmd, pane.cwd);
  // Hand the pane to interactive programs that don't use the alternate screen.
  if (isInteractive(trimmed)) s.setRawMode(pane.id, true);
  if (pane.ptyId) {
    pty.write(pane.ptyId, cmd + "\n");
    // sticky-running-server-tabs: capture this command's process group too, not
    // just the dedicated "Run servers" flow — a typed `nx serve --no-tui` (or
    // any other command that detaches into its own pgid) needs the same
    // fire-and-forget sampler so its running state + Ctrl+C can target it once
    // the prompt returns. Ordinary commands resolve to "uncaptured" (no-op).
    //
    // Code-review fix (#1, MAJEUR): only re-arm the sampler when the poll
    // hasn't already got a confirmed-alive capture for this ptyId. Without this
    // guard, running a SECOND command in the same pane (e.g. hitting Enter on
    // an already-detached `nx serve`) re-triggered a Rust-side `Pending` reset
    // that clobbered the still-alive `Found(pgid)` capture — losing the only
    // handle Ctrl+C/Stop has on the detached server (false "Couldn't reach the
    // process"). The Rust side (`pty_capture_server_pgid`) now also refuses to
    // re-arm over a live `Found` capture, so this is defense-in-depth: it just
    // avoids the redundant round-trip in the common case.
    if (s.serverStatus[pane.ptyId] !== "alive") {
      pty.captureServerPgid(pane.ptyId).catch(() => {});
    }
    ensurePtyPoll();
  } else {
    // No live shell (e.g. a boot-time spawn was lost) — don't drop the command
    // silently. Tell the user and kick off a respawn so the pane self-heals.
    s.appendOutput(pane.id, "\x1b[33maurora: this pane lost its shell — restarting it, run your command again\x1b[0m\n");
    s.endBlock(pane.id, 1);
    s.respawnPane(pane.id);
  }
}

/**
 * Ctrl+C, routed by what's actually running (sticky-running-server-tabs):
 *  - not running, or the running process IS the PTY foreground → \x03 (the tty
 *    already delivers SIGINT to whichever group holds the foreground — correct
 *    for an idle shell AND for a foreground server alike).
 *  - a detached-but-captured server (PTY foreground is the shell, captured
 *    group still alive) → killpg(pgid, SIGINT) via pty.signalServer, since a
 *    raw \x03 would hit the shell instead of the real target.
 * Escalation policy (design.md D-CtrlC): a single SIGINT, not SIGINT→SIGTERM/
 * SIGKILL — matches the existing Stop/⌘Q first step and keeps a second Ctrl+C
 * press meaning "try again", not "escalate to a harder kill".
 */
function routeCtrlC(pane: PaneState) {
  if (!pane.ptyId) return;
  const ptyId = pane.ptyId;
  const st = useStore.getState();
  const fg = st.foregroundState[ptyId];
  const status = st.serverStatus[ptyId];
  if (fg?.running) {
    // Foreground child holds the tty — the kernel already routes \x03 to it.
    pty.write(ptyId, "\x03");
    return;
  }
  if (!paneRunning(pane, status, fg)) {
    // Idle shell (or nothing detected as running) — plain \x03, unchanged behavior.
    pty.write(ptyId, "\x03");
    return;
  }
  // Running, but NOT the PTY foreground -> a detached server. Signal its
  // captured group directly; the Rust side re-checks liveness immediately
  // before signalling (recycled-pgid guard) and reports back honestly.
  pty.signalServer(ptyId, SIGINT).then((ok) => {
    if (ok) return;
    // Uncaptured or already dead — do NOT claim success (spec: never falsely
    // report the process as stopped).
    useStore.getState().notify({
      color: "var(--warn)",
      icon: "⚠",
      headline: "Couldn't reach the process",
      sub: "Ctrl+C had no live captured process group to signal.",
      repo: "",
    });
  });
}

function submit(pane: PaneState, value: string) {
  const s = useStore.getState();
  const trimmed = value.trim();
  if (!trimmed) {
    if (pane.ptyId) pty.write(pane.ptyId, "\n");
    return;
  }
  s.pushHistory(pane.id, trimmed);

  // explicit Claude ask — a leading `?` (e.g. `? undo my last commit`)
  if (trimmed.startsWith("?")) {
    const q = trimmed.slice(1).trim();
    if (q) askClaude(pane, q);
    return;
  }

  const parts = trimmed.split(/\s+/);
  const c = parts[0];

  if (c === "aurora") return handleAurora(pane, parts.slice(1));
  if (c === "settings" || c === "config" || c === "prefs") return s.openSettings();
  if (c === "run") {
    if (parts[1]) runScript(pane.id, parts[1]);
    else s.openPanel("scripts");
    return;
  }
  if (c === "scripts") return s.openScriptsSetup();

  const fix = typoFix(c);
  if (fix) {
    const corrected = fix.includes(" ") && parts.length === 1 ? fix : [fix, ...parts.slice(1)].join(" ");
    if (corrected !== trimmed) {
      s.setSuggestion(pane.id, { command: corrected, note: "Looks like a typo — run the corrected command?" });
      return;
    }
  }
  runInShell(pane, trimmed);
}

/** Resolve a token's typed dir prefix to a path to read (cwd-relative, `~`, or absolute). */
function completionBase(cwd: string, dir: string): string {
  if (!dir) return cwd;
  if (dir.startsWith("~") || dir.startsWith("/")) return dir; // Rust expands `~`
  return cwd.replace(/\/+$/, "") + "/" + dir;
}

/**
 * Tab folder completion for a path token: read the relevant directory and either
 * complete inline (1 match), complete the common prefix then open a selectable
 * list (many), or do nothing (none — falling back to an existing ghost). Async,
 * so it re-reads the pane and bails if the input changed while reading.
 */
async function triggerFolderCompletion(pane: PaneState, tok: PathToken) {
  const s = useStore.getState();
  const entries = await listDir(completionBase(pane.cwd, tok.dir), tok.leaf.startsWith("."));

  // Freshness guard: drop the result if the user kept typing.
  const cur: PaneState | undefined = findPane(useStore.getState(), pane.id);
  if (!cur || cur.input !== pane.input) return;

  const matches = folderCandidates(entries, tok.leaf);
  if (matches.length === 0) {
    if (cur.ghost) s.setInput(pane.id, cur.input + cur.ghost); // nothing to list — honor a ghost
    return;
  }
  if (matches.length === 1) {
    s.setInput(pane.id, cur.input.slice(0, tok.tokenStart) + tok.dir + matches[0].name + "/");
    return;
  }
  // Many: extend to the longest shared prefix, then list the candidates.
  const cp = commonPrefix(matches.map((m) => m.name));
  if (cp.length > tok.leaf.length) {
    s.setInput(pane.id, cur.input.slice(0, tok.tokenStart) + tok.dir + cp);
  }
  s.openCompletion(pane.id, { items: matches, tokenStart: tok.tokenStart, dir: tok.dir });
}

export function handleKeyDown(e: KeyboardEvent) {
  const s = useStore.getState();

  // The one-time "Introducing Workspaces" dialog is the top-most overlay
  // (zIndex 100) and keyboard-modal: while it's open (introSeen === false),
  // every key is swallowed here — only Escape acts, equivalent to "Got it"
  // (persists + closes). Placed above the form-field guard below so Esc still
  // dismisses even when focus is inside an input/textarea — e.g. the xterm
  // textarea mounted behind the intro on first launch inside a repo. Note the
  // dialog's own focus-trap (WorkspacesIntro.tsx) is what actually keeps
  // keystrokes from reaching that textarea in the first place; this early
  // Esc guard is belt-and-braces in case focus ever lands there. Also placed
  // above the app-level ⌘ block and the `if (!pane) return` bail so Esc
  // works at first-run with no active pane.
  if (!s.settings.introSeen) {
    if (e.key === "Escape") {
      e.preventDefault();
      s.dismissIntro();
    }
    return;
  }

  const tag = (e.target as HTMLElement | null)?.tagName ?? "";
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return; // form fields / xterm own these

  const k = e.key;

  if (s.scriptsSetupOpen) {
    if (k === "Escape") {
      e.preventDefault();
      s.closeScriptsSetup();
    }
    return;
  }
  if (s.settingsOpen) {
    if (k === "Escape") {
      e.preventDefault();
      s.closeSettings();
    }
    return;
  }
  // The command palette owns its keys via its focused input; this only catches
  // Esc when focus has left the field.
  if (s.command) {
    if (k === "Escape") {
      e.preventDefault();
      s.closeCommand();
    }
    return;
  }
  if (s.panel) {
    if (k === "Escape") {
      e.preventDefault();
      s.closePanel();
    }
    return;
  }
  // Esc closes the find bar even when focus has left its input (e.g. clicked
  // into the output). When the input is focused the FindBar handles its own keys
  // and this listener never runs (it bails on INPUT targets above).
  if (s.find.open && k === "Escape") return void (e.preventDefault(), s.closeFind());

  // ⌘, / ⌘K / ⌘B need no active pane (openSettings/openCommand/toggleRail don't
  // touch the pane) — handle them here, above the active-pane bail below, so they
  // stay reachable even if `activeWs` is ever null (defensive: `init` always
  // resolves to a live workspace via the Home terminal, but the rail's own
  // "Create a workspace" affordance still advertises ⌘K). Handled here, they're
  // removed from the pane-dependent ⌘ block further down to avoid a double dispatch.
  if (e.metaKey) {
    if (k === ",") return void (e.preventDefault(), s.openSettings());
    if (k === "k" || k === "K") return void (e.preventDefault(), s.openCommand());
    if (k === "b" || k === "B") return void (e.preventDefault(), s.toggleRail());
    // ⌘0 — jump to the Home terminal (~), regardless of whether a pane is active.
    // Match the physical Digit0 key (e.code), not just the produced char (e.key):
    // on AZERTY the top row is unshifted à/é/"/… so ⌘+0 would otherwise demand ⌘⇧0.
    // e.code === "Digit0" fires on ⌘ + the 0 key with no Shift, on every layout.
    if (k === "0" || e.code === "Digit0") {
      e.preventDefault();
      const home = s.workspaces.find((w) => w.kind === "home");
      if (home) {
        s.switchWorkspace(home.id);
        focusRoot();
      }
      return;
    }
  }

  const pane = activePane(s);
  if (!pane) return;

  if (e.altKey && !e.metaKey && !e.ctrlKey && k.startsWith("Arrow")) {
    e.preventDefault();
    s.cyclePane(k === "ArrowRight" || k === "ArrowDown" ? 1 : -1);
    return;
  }

  // ⌃Tab cycles tabs
  if (e.ctrlKey && k === "Tab") return void (e.preventDefault(), s.cycleTab(e.shiftKey ? -1 : 1), focusRoot());

  // ⌘ — Aurora app shortcuts
  if (e.metaKey && (k === "v" || k === "V")) return void (e.preventDefault(), pasteClipboard());
  if (e.metaKey && (k === "f" || k === "F")) return void (e.preventDefault(), s.openFind());
  if (e.metaKey && (k === "a" || k === "A")) {
    // Select the current prompt input (like a real field) — never the output.
    // Always consume so the webview's native Select All can't run.
    e.preventDefault();
    if (!s.keyEntry) s.selectAllInput(pane.id);
    return;
  }
  if (e.metaKey && (k === "c" || k === "C") && pane.inputSelected && pane.input) {
    e.preventDefault();
    void writeText(pane.input).catch(() => {});
    return;
  }
  if (e.metaKey) {
    if (k === "Enter") {
      // ⌘↵ — send the current line to Claude (explicit ask)
      e.preventDefault();
      const v = pane.input.trim().replace(/^\?\s*/, "");
      if (v) {
        s.setInput(pane.id, "");
        askClaude(pane, v);
      }
      return;
    }
    if (k === "g" || k === "G") return void (e.preventDefault(), s.openChanges());
    if (k === "d" || k === "D") {
      e.preventDefault();
      if (e.altKey) s.toggleChanges();
      else {
        s.splitPane(e.shiftKey ? "v" : "h");
        focusRoot();
      }
      return;
    }
    if (k === "t" || k === "T") return void (e.preventDefault(), s.newTab(), focusRoot());
    if (k === "w" || k === "W") {
      e.preventDefault();
      const w = activeWorkspace(s);
      const gg = activeGroup(s);
      if (gg && gg.panes.length > 1) s.closePane();
      else if (w) s.closeTab(w.active);
      focusRoot();
      return;
    }
    if (/^[1-9]$/.test(k)) return void (e.preventDefault(), s.selectTab(parseInt(k, 10) - 1), focusRoot());
    if (k === "}" || k === "]") return void (e.preventDefault(), s.cycleTab(1), focusRoot());
    if (k === "{" || k === "[") return void (e.preventDefault(), s.cycleTab(-1), focusRoot());
    return;
  }

  // The Changes overlay is up: app shortcuts (⌘…) already ran above; here we only
  // let Esc close it and swallow every other key so neither the prompt nor a
  // full-screen program (rawMode) painted behind the overlay is touched. Checked
  // before the ⌃ block so control keys can't leak to the program behind it.
  if (s.changesWsId) {
    if (k === "Escape") return void (e.preventDefault(), s.closeChanges());
    return;
  }

  // ⌃ — terminal control codes forwarded to the foreground process (^C ^D ^Z …)
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (k === "l" || k === "L") {
      e.preventDefault();
      s.clearBlocks(pane.id);
      if (pane.ptyId) pty.write(pane.ptyId, "\x0c");
      return;
    }
    if (k === "c" || k === "C") {
      // sticky-running-server-tabs: route by WHAT is actually running, not just
      // "write \x03 and hope" — a foreground child still gets \x03 (the tty
      // already delivers SIGINT correctly); a detached-but-captured server (the
      // shell has the PTY foreground back) gets killpg(pgid, SIGINT) instead,
      // the same group Stop/⌘Q already reap. See routeCtrlC below.
      e.preventDefault();
      s.setInput(pane.id, "");
      routeCtrlC(pane);
      return;
    }
    if (/^[a-z]$/i.test(k)) {
      e.preventDefault();
      const code = k.toLowerCase().charCodeAt(0) - 96; // ^A=1 … ^Z=26
      if (pane.ptyId) pty.write(pane.ptyId, String.fromCharCode(code));
      return;
    }
    return;
  }

  if (s.keyEntry) {
    if (k === "Enter") return void (e.preventDefault(), saveKey(pane));
    if (k === "Escape") return void (e.preventDefault(), s.cancelKeyEntry(), s.setInput(pane.id, ""));
    if (k === "Backspace")
      return void (e.preventDefault(), s.setKeyError(null), s.setInput(pane.id, pane.input.slice(0, -1)));
    if (k.length === 1 && !e.altKey)
      return void (e.preventDefault(), s.setKeyError(null), s.setInput(pane.id, pane.input + k));
    return;
  }

  if (pane.suggestion) {
    const sug = pane.suggestion;
    if (sug.command) {
      if (k === "Enter") {
        e.preventDefault();
        s.setSuggestion(pane.id, null);
        s.setInput(pane.id, "");
        runInShell(pane, sug.command);
        return;
      }
      if (k === "Tab") return void (e.preventDefault(), s.setInput(pane.id, sug.command), s.setSuggestion(pane.id, null));
      if (k === "Escape") return void (e.preventDefault(), s.setSuggestion(pane.id, null));
    } else if (sug.needsKey) {
      if (k === "Enter" || k === "Tab")
        return void (e.preventDefault(), s.setSuggestion(pane.id, null), s.startKeyEntry());
      if (k === "Escape") return void (e.preventDefault(), s.setSuggestion(pane.id, null));
    } else if (k === "Escape" || k === "Enter") {
      return void (e.preventDefault(), s.setSuggestion(pane.id, null));
    }
  }

  // Folder-completion list is open: it owns navigation/accept/dismiss. Any other
  // key (typing, Backspace) falls through; setInput then clears the list.
  if (pane.completion) {
    if (k === "ArrowDown") return void (e.preventDefault(), s.moveCompletion(pane.id, 1));
    if (k === "ArrowUp") return void (e.preventDefault(), s.moveCompletion(pane.id, -1));
    if (k === "Tab" || k === "Enter") return void (e.preventDefault(), s.acceptCompletion(pane.id));
    if (k === "Escape") return void (e.preventDefault(), s.closeCompletion(pane.id));
  }

  // With the whole input selected (⌘A), editing keys act on the selection like
  // a real text field. Enter falls through to submit (setInput clears the flag).
  if (pane.inputSelected) {
    if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
      return void (e.preventDefault(), s.collapseInputSelection(pane.id));
    }
    if (k === "Backspace" || k === "Delete") return void (e.preventDefault(), s.setInput(pane.id, ""));
    if (k.length === 1 && !e.altKey) return void (e.preventDefault(), s.setInput(pane.id, k));
  }

  if (k === "Enter") {
    e.preventDefault();
    const v = pane.input;
    s.setInput(pane.id, "");
    submit(pane, v);
    return;
  }
  if (k === "Tab") {
    e.preventDefault();
    if (pane.pendingFix) {
      s.setInput(pane.id, pane.pendingFix);
      s.setPendingFix(pane.id, null);
      return;
    }
    // On a path argument, complete folders (lists even when no ghost exists);
    // otherwise keep the existing command/subcommand ghost-accept behavior.
    const tok = splitPathToken(pane.input);
    if (tok.isPathArg) {
      void triggerFolderCompletion(pane, tok);
      return;
    }
    if (pane.ghost) s.setInput(pane.id, pane.input + pane.ghost);
    return;
  }
  if (k === "ArrowRight") {
    if (pane.ghost) {
      e.preventDefault();
      s.setInput(pane.id, pane.input + pane.ghost);
    }
    return;
  }
  if (k === "ArrowUp") return void (e.preventDefault(), s.histNav(pane.id, -1));
  if (k === "ArrowDown") return void (e.preventDefault(), s.histNav(pane.id, 1));
  if (k === "Backspace") return void (e.preventDefault(), s.setInput(pane.id, pane.input.slice(0, -1)));
  if (k === "Escape") return void (e.preventDefault(), s.setInput(pane.id, ""));
  if (k.length === 1 && !e.altKey) return void (e.preventDefault(), s.setInput(pane.id, pane.input + k));
}
