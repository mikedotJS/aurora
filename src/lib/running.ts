// Generic per-pane "running" detection (sticky-running-server-tabs).
//
// Generalises the workspace-run-servers capture/liveness machinery (originally
// wired only to the dedicated "Servers" tab, see src/lib/servers.ts) so ANY
// pane running ANY foreground or detached child process — not just a declared
// port-script — badges its tab and blocks its prompt. See
// openspec/changes/sticky-running-server-tabs/specs/sticky-running-server-tabs/spec.md
// for the full requirement text.
//
// Combined running signal, in priority order (spec: "detected from its PTY
// foreground process group, generically"):
//   1. current PTY foreground pgid != shell pgid (a foreground child)   → running
//   2. else serverStatus "alive" — a captured detached pgid still alive, OR
//      (Rust tier-4 fallback) a non-shell process still holding the pane's
//      controlling tty when the captured pgid has died. The tty scan is what
//      catches `nx serve --no-tui`, which returns the prompt and re-parents its
//      server off the pgid we froze on. See pty.rs `tty_has_foreign_process`.
//   3. else the pane's OSC-133 command-block `running` flag (fallback)  → running
//
// "Running" is deliberately generic (npm install / sleep 30 count, same as a
// dev server) — the wording everywhere here is "process running", never
// "server", per the proposal's honesty requirement.

import { useStore, type Group, type PaneState } from "../state/store";
import type { ForegroundState, ServerStatus } from "../term/pty";
import { pty } from "../term/pty";

/**
 * Pure 3-tier combined running check for one pane. Takes plain values (no
 * store/Tauri reads) so it's unit-testable with fixtures alone.
 */
export function paneRunning(pane: PaneState, status?: ServerStatus, fg?: ForegroundState): boolean {
  if (fg?.running) return true; // tier 1: foreground child (vite, npm install, …)
  if (status === "alive") return true; // tier 2: captured detached group still alive
  return pane.blocks[pane.blocks.length - 1]?.running === true; // tier 3: OSC-133 fallback
}

/** True when ANY pane in the tab is running (per the combined signal). */
export function tabRunning(
  tab: Group,
  serverStatus: Record<string, ServerStatus>,
  foregroundState: Record<string, ForegroundState>,
): boolean {
  return tab.panes.some((p) => paneRunning(p, p.ptyId ? serverStatus[p.ptyId] : undefined, p.ptyId ? foregroundState[p.ptyId] : undefined));
}

const RUNNING_LABEL_MAX = 24;

/**
 * Label for a running tab's badge: the auto-set Group.name (from auto-rename-tabs)
 * when present, else the running pane's raw command text (capped), else a
 * generic fallback. Deliberately never asserts a specific server type — "the
 * running command text", per the spec, describing a process truthfully.
 */
export function tabRunningLabel(
  tab: Group,
  serverStatus: Record<string, ServerStatus>,
  foregroundState: Record<string, ForegroundState>,
): string {
  const named = tab.name?.trim();
  if (named) return named;
  const runner = tab.panes.find((p) =>
    paneRunning(p, p.ptyId ? serverStatus[p.ptyId] : undefined, p.ptyId ? foregroundState[p.ptyId] : undefined),
  );
  const cmd = runner?.blocks[runner.blocks.length - 1]?.command?.trim();
  if (cmd) return cmd.length > RUNNING_LABEL_MAX ? `${cmd.slice(0, RUNNING_LABEL_MAX)}…` : cmd;
  return "process";
}

// ── Generic liveness poll ───────────────────────────────────────────────────
//
// Formerly `ensureServerPoll`/`stopPoll` in servers.ts (D8), scoped to the
// dedicated Servers tab only. Generalised here to cover every live pane in
// every workspace/tab — servers.ts re-exports these two names unchanged so
// its existing Run/Stop callers (and their tests) don't need to change.

/** Module-level handle to the single active poll interval. */
let _pollInterval: ReturnType<typeof setInterval> | null = null;
/** Guard against overlapping ticks (async probes may outlast the 1.5 s interval). */
let _pollRunning = false;

/** Every pane, across every workspace/tab, that has a live (non-exited) ptyId. */
function livePanes(): Array<{ ptyId: string }> {
  const out: Array<{ ptyId: string }> = [];
  for (const ws of useStore.getState().workspaces) {
    for (const tab of ws.tabs) {
      for (const p of tab.panes) {
        if (p.ptyId && !p.exited) out.push({ ptyId: p.ptyId });
      }
    }
  }
  return out;
}

/** True when `ptyId` still belongs to some (live or not) pane anywhere. */
function ptyStillReferenced(ptyId: string): boolean {
  return useStore
    .getState()
    .workspaces.some((w) => w.tabs.some((t) => t.panes.some((p) => p.ptyId === ptyId)));
}

/**
 * Ensure a single ~1.5 s liveness poll is running, covering every live pane
 * with a ptyId (not just Servers-tab panes — the generalisation this change
 * makes). Idempotent: a second call while the interval is active is a no-op.
 *
 * Each tick: for every live pane, calls `pty.foregroundState` (tier 1) and
 * `pty.serverStatus` (tier 2 — cheap no-op server-side for panes that never
 * had a capture started) in parallel, writing both into the store. Auto-stops
 * when no pane anywhere has a live ptyId.
 */
export function ensurePtyPoll(): void {
  if (_pollInterval !== null) return; // already running

  _pollInterval = setInterval(async () => {
    if (_pollRunning) return; // skip overlapping tick
    _pollRunning = true;
    try {
      const panes = livePanes();
      if (panes.length === 0) {
        stopPtyPoll();
        return;
      }

      await Promise.all(
        panes.map(async ({ ptyId }) => {
          try {
            const [fg, status] = await Promise.all([pty.foregroundState(ptyId), pty.serverStatus(ptyId)]);
            // Guard: the pane may have closed while the probe was in-flight —
            // don't resurrect a stale entry for a ptyId nothing references anymore.
            if (!ptyStillReferenced(ptyId)) return;
            useStore.getState().setForegroundState(ptyId, fg);
            useStore.getState().setServerStatus(ptyId, status);
          } catch {
            // Probe failed (session likely gone) — ignore; close/respawn cleans up.
          }
        }),
      );
    } finally {
      _pollRunning = false;
    }
  }, 1500);
}

/**
 * Stop the liveness poll. Called when no live panes remain (eagerly by
 * some callers, lazily on the next tick otherwise). Safe to call multiple times.
 */
export function stopPtyPoll(): void {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}
