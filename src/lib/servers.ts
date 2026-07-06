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
//   D8: front poll (~1.5 s) keeps serverStatus map current; generalised to every live
//       pane (not just server tabs) by sticky-running-server-tabs, see ./running.ts

import { useStore, type Workspace } from "../state/store";
import type { ServerStatus } from "../term/pty";
import { pty } from "../term/pty";
import { portScripts, serverUnits } from "./ports";
import { scriptsForRoot, runServerScript } from "./scripts";
import { ensurePtyPoll, stopPtyPoll } from "./running";

// The D8 liveness poll used to live here, scoped to Servers-tab panes only.
// sticky-running-server-tabs generalised it to every live pane (any workspace,
// any tab) — it now lives in ./running as ensurePtyPoll/stopPtyPoll. Re-exported
// under their original names so existing Run/Stop callers (and their tests)
// don't need to change.
export { ensurePtyPoll as ensureServerPoll, stopPtyPoll as stopPoll };

/** Short repo label for a notification chip — the repo folder name, not its full
 *  path (which would overflow the compact chip). Empty when no repo. */
export function repoLabel(repoId: string | null): string {
  return repoId?.split("/").filter(Boolean).pop() ?? "";
}

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
      headline: `${extra} server${extra > 1 ? "s" : ""} not started in ${ws.title}`,
      sub: `Aurora caps server panes at 4 — started the first 4, skipped ${extra}.`,
      repo: repoLabel(ws.repoId),
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
        ensurePtyPoll();
      },
    });
  }
  // Also ensure the poll is running at launch time (covers the case where
  // the panes are already ready and onLaunched fired synchronously above).
  ensurePtyPoll();
}

/**
 * Kill the running servers and drop the dedicated server tab.
 * No-op when serverTabId is null (servers already down).
 * Does NOT touch the worktree or call removeWorkspace.
 */
export async function stopServers(wsId: string): Promise<void> {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === wsId);
  if (!ws || ws.serverTabId == null) return;

  const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
  if (tab) {
    const ptyIds = tab.panes.map((p) => p.ptyId).filter((id): id is string => id !== null);
    await Promise.all(ptyIds.map((id) => pty.kill(id)));
    // D9.7: clear serverStatus/foregroundState for stopped panes (also cleared
    // by dropServerTab, but explicit here for clarity per the design doc).
    useStore.getState().clearServerStatus(ptyIds);
    useStore.getState().clearForegroundState(ptyIds);
  }

  useStore.getState().dropServerTab(wsId);

  // No eager poll-stop here (sticky-running-server-tabs): the poll is no
  // longer scoped to server tabs — it covers every live pane in every
  // workspace, so "no server tab left" no longer implies "nothing to poll".
  // Its own tick auto-stops once no pane anywhere has a live ptyId.
}
