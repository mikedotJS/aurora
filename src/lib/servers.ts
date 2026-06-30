// Run/Stop orchestrator for workspace port-scripts.
//
// Design decisions (see openspec/changes/workspace-run-servers/design.md):
//   D1: unit = server pane, honoring split flag (split script → 1 pane/task, concurrent;
//       non-split → 1 pane with tasks chained &&). Parity with runScript.
//   D2: dedicated "Servers" tab per workspace
//   D3 (revised): serversUp reads the captured process group's liveness (serverStatus),
//       with block.running as fallback for uncaptured/absent panes (D8 poll).
//   D4 (revised): Stop reuses pty.kill (server pgid joined in Rust), keeps workspace
//   D5: idempotent — stale tab killed+dropped before new one is created
//   D7: capture fire-and-forget at launch via pty.captureServerPgid
//   D8: front poll (~1.5 s) keeps serverStatus map current; stops when no server tabs

import { useStore, type Workspace } from "../state/store";
import type { ServerStatus } from "../term/pty";
import { pty } from "../term/pty";
import { portScripts, serverUnits } from "./ports";
import { scriptsForRoot, runServerScript } from "./scripts";

/**
 * Pure selector: true when the workspace's dedicated server tab exists AND at least
 * one of its panes is live according to the serverStatus map (D3 revised).
 *
 * When `status` is provided:
 *   - "alive" / "capturing" → counts as up
 *   - "dead"                → counts as down
 *   - "uncaptured" / absent → falls back to pane's last block `running` flag
 *
 * When `status` is omitted (back-compat with existing tests), falls back to
 * the legacy block.running flag for all panes.
 *
 * Takes `ws` directly (no store read) — unit-testable with plain fixtures.
 */
export function serversUp(ws: Workspace, status?: Record<string, ServerStatus>): boolean {
  if (ws.serverTabId == null) return false;
  const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
  if (!tab) return false;
  return tab.panes.some((pane) => {
    const s = status?.[pane.ptyId ?? ""];
    switch (s) {
      case "alive":
      case "capturing":
        return true;
      case "dead":
        return false;
      case "uncaptured":
      default:
        // No status (or uncaptured) — fall back to the legacy OSC-133 block flag.
        return pane.blocks[pane.blocks.length - 1]?.running === true;
    }
  });
}

// ── Liveness poll (D8) ─────────────────────────────────────────────────────────

/** Module-level handle to the single active poll interval. */
let _pollInterval: ReturnType<typeof setInterval> | null = null;
/** Guard against overlapping ticks (async probe may outlast the 1.5 s interval). */
let _pollRunning = false;

/**
 * Ensure a single ~1.5 s liveness poll is running.
 * Idempotent: a second call while the interval is active is a no-op.
 *
 * Each tick: for every server pane across all workspaces that has a ptyId,
 * calls `pty.serverStatus(ptyId)` and writes the result into `store.serverStatus`.
 * Auto-stops (clearInterval) when no workspace has a `serverTabId`.
 */
export function ensureServerPoll(): void {
  if (_pollInterval !== null) return; // already running

  _pollInterval = setInterval(async () => {
    if (_pollRunning) return; // skip overlapping tick
    _pollRunning = true;
    try {
      const st = useStore.getState();

      // Collect server panes across all workspaces.
      const serverPanes: Array<{ ptyId: string }> = [];
      let hasAnyServerTab = false;
      for (const ws of st.workspaces) {
        if (ws.serverTabId == null) continue;
        hasAnyServerTab = true;
        const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
        if (!tab) continue;
        for (const p of tab.panes) {
          if (p.ptyId) serverPanes.push({ ptyId: p.ptyId });
        }
      }

      if (!hasAnyServerTab) {
        stopPoll();
        return;
      }

      // Probe all server panes in parallel.
      await Promise.all(
        serverPanes.map(async ({ ptyId }) => {
          try {
            const s = await pty.serverStatus(ptyId);
            // Guard: only write the status if the pane is still part of a live
            // server tab. The async probe may outlast a concurrent stopServers/
            // dropServerTab call, which would leave a stale entry in the map that
            // is never cleaned up (the "slow serverStatus leak" finding).
            const isStillLive = useStore.getState().workspaces.some((w) => {
              if (w.serverTabId == null) return false;
              const tab = w.tabs.find((g) => g.id === w.serverTabId);
              return tab?.panes.some((p) => p.ptyId === ptyId) ?? false;
            });
            if (isStillLive) {
              useStore.getState().setServerStatus(ptyId, s);
            }
          } catch {
            // Probe failed (session likely gone) — ignore; kill/dropServerTab will clean up.
          }
        }),
      );
    } finally {
      _pollRunning = false;
    }
  }, 1500);
}

/**
 * Stop the liveness poll. Called when no server tabs remain (eagerly in stopServers,
 * lazily on the next tick in the interval callback).
 * Safe to call multiple times.
 */
export function stopPoll(): void {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * Start all port-scripts as servers in a fresh dedicated tab (one pane each).
 * Idempotent: if servers are already up (per serverStatus + fallback), no-op (focuses tab).
 * Self-healing: if a stale server tab exists (all blocks done / dead), kills any
 * lingering PTYs, drops the tab, then opens a fresh one.
 * Capped at 4 panes; >4 port-scripts → start the first 4 + notify remainder.
 *
 * Called for the active workspace from WorkspaceContextBar.
 */
export async function runServers(wsId: string): Promise<void> {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === wsId);
  if (!ws || !ws.repoId) return;

  const scripts = scriptsForRoot(ws.repoId);
  // Visibility guard: at least one port-script must exist.
  if (!portScripts(scripts).length) return;

  // Expand to server units, honoring the split flag (split script → 1 unit/task).
  const units = serverUnits(scripts);
  if (!units.length) return;

  // Already up → focus the server tab, but only when wsId is the active workspace.
  const status = useStore.getState().serverStatus;
  if (serversUp(ws, status)) {
    const tabIdx = ws.tabs.findIndex((g) => g.id === ws.serverTabId);
    if (tabIdx !== -1 && useStore.getState().activeWs === wsId) {
      useStore.getState().selectTab(tabIdx);
    }
    return;
  }

  // Stale server tab (serverTabId set but all blocks done / dead) → kill straggler PTYs,
  // then drop the tab so prepareServerTab starts from a clean state.
  if (ws.serverTabId != null) {
    const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
    if (tab) {
      const ptyIds = tab.panes.map((p) => p.ptyId).filter((id): id is string => id !== null);
      await Promise.all(ptyIds.map((id) => pty.kill(id)));
    }
    useStore.getState().dropServerTab(wsId);
  }

  // Cap at 4 (existing per-tab pane limit); surface the remainder.
  const n = Math.min(4, units.length);
  if (units.length > 4) {
    const extra = units.length - 4;
    useStore.getState().notify({
      color: "var(--err)",
      icon: "⚡",
      headline: `${extra} server${extra > 1 ? "s" : ""} not started`,
      sub: `Aurora caps server panes at 4 — starting the first 4.`,
      repo: ws.repoId,
    });
  }

  // Create the fresh Servers tab (switches active tab to it).
  useStore.getState().prepareServerTab(wsId, n);

  // Read back fresh state to get the newly created panes.
  const freshWs = useStore.getState().workspaces.find((w) => w.id === wsId);
  if (!freshWs) return;
  const serverTab = freshWs.tabs.find((g) => g.id === freshWs.serverTabId);
  if (!serverTab) return;

  // Launch one server unit per pane, fire-and-forget the capture, start the poll.
  for (let i = 0; i < n; i++) {
    const pane = serverTab.panes[i];
    if (!pane) continue;
    const unit = units[i];
    runServerScript(pane.id, unit.name, {
      lookupRoot: ws.repoId,
      execBase: ws.dir,
      ...(unit.taskIndex != null ? { taskIndex: unit.taskIndex } : {}),
      onLaunched: (ptyId) => {
        // D7: start the pgid capture immediately at send time.
        pty.captureServerPgid(ptyId).catch(() => {
          // fire-and-forget; failure is non-fatal (falls back to "uncaptured")
        });
        // D8: ensure the liveness poll is running.
        ensureServerPoll();
      },
    });
  }
  // Also ensure the poll is running at launch time (covers the case where
  // the panes are already ready and onLaunched fired synchronously above).
  ensureServerPoll();
}

/**
 * Kill the running servers and drop the dedicated server tab.
 * No-op when serverTabId is null (servers already down).
 * Does NOT touch the worktree or call removeWorkspace.
 * Eagerly stops the liveness poll when no server tabs remain.
 */
export async function stopServers(wsId: string): Promise<void> {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === wsId);
  if (!ws || ws.serverTabId == null) return;

  const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
  if (tab) {
    const ptyIds = tab.panes.map((p) => p.ptyId).filter((id): id is string => id !== null);
    await Promise.all(ptyIds.map((id) => pty.kill(id)));
    // D9.7: clear serverStatus for stopped panes (also cleared by dropServerTab,
    // but explicit here for clarity per the design doc).
    useStore.getState().clearServerStatus(ptyIds);
  }

  useStore.getState().dropServerTab(wsId);

  // Eagerly stop the poll when no server tabs remain anywhere.
  const hasAnyServerTab = useStore.getState().workspaces.some((w) => w.serverTabId != null);
  if (!hasAnyServerTab) {
    stopPoll();
  }
}
