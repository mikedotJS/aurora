// Workspace teardown orchestrator. Strict order (load-bearing):
//   guards → removability check → stop managed servers + archive script →
//   kill PTYs → remove worktree → drop from store.
// Removing the worktree before processes die risks git fighting open files;
// dropping the store entry before the FS is cleaned orphans the directory.
// Critically: the removability check runs BEFORE killing PTYs so a failed
// remove never leaves zombie cards with dead processes (M1+M2). Managed dev
// servers are stopped (task 3.3: reclaims their port reservation, kills the
// Rust-tracked child — `removeWorkspace` does NOT do this on its own) and
// `scripts.archive` runs (task 4.5, best-effort/bounded) BEFORE the worktree
// is removed, since archive needs the workspace dir to still exist.

import { useStore, type Workspace } from "../state/store";
import { pty } from "../term/pty";
import { worktreeRemove, worktreeList } from "./worktree";
import { pathResolve } from "./sys";
import { stopServers } from "./servers";
import { spawnServer, serverStatus, stopServer as rustStopServer } from "./server";
import { ensureAuroraConfigLoaded } from "./auroraConfigStore";
import { commandSpecToShell } from "./auroraConfig";

export type TeardownResult = { ok: true } | { ok: false; error: string };

/** Bounded wait for `scripts.archive` (task 4.5): generous enough for a real
 *  cleanup command (`docker compose down`, `bun run clean`, …) but never lets
 *  a hung/misbehaving script deadlock teardown — it's SIGKILLed on timeout
 *  and teardown proceeds regardless (best-effort, log + proceed). */
const ARCHIVE_TIMEOUT_MS = 15_000;
const ARCHIVE_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the repo's `scripts.archive` (if configured) in the workspace's own
 * directory/env, once, before the worktree is torn down. Best-effort: a
 * missing/failing/hanging script never blocks or fails teardown — this only
 * ever logs. Uses `spawnServer`/`serverStatus` directly (lib/server.ts,
 * design.md Decision 4) rather than writing into a pane's shell, since by
 * this point in teardown the workspace's panes are about to be destroyed
 * anyway — an Aurora-owned, pane-less process is the safer primitive here.
 *
 * `opts` overrides the timeout/poll cadence — exported so tests can drive the
 * timeout branch in milliseconds instead of `deleteWorkspace`'s real 15s.
 */
export async function runArchiveScript(
  ws: Workspace,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (!ws.repoId) return;
  const config = await ensureAuroraConfigLoaded(ws.repoId);
  const command = commandSpecToShell(config.scripts.archive);
  if (!command) return;

  const timeoutMs = opts.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? ARCHIVE_POLL_MS;
  const id = `archive:${ws.id}`;
  try {
    await spawnServer(id, command, [], ws.dir, ws.env);
  } catch (e) {
    console.error(`aurora: scripts.archive failed to start for "${ws.title}" — ${String(e)}`);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await serverStatus(id);
      if (status.state === "exited") {
        // Reap the Rust-side registry entry on the happy path too — only the
        // timeout branch below used to do this, leaking a tracked entry for
        // every archive script that exits on its own before the deadline.
        await rustStopServer(id).catch(() => {});
        return;
      }
    } catch {
      return; // untracked (already reaped/removed) — treat as done
    }
    await sleep(pollMs);
  }
  console.error(`aurora: scripts.archive timed out for "${ws.title}" after ${timeoutMs}ms — killing it`);
  await rustStopServer(id).catch(() => {});
}

export async function deleteWorkspace(id: string): Promise<TeardownResult> {
  // 1. Snapshot
  const state = useStore.getState();
  const w = state.workspaces.find((x) => x.id === id);
  if (!w) return { ok: false, error: "workspace not found" };

  // 2. Guard: the Home terminal is permanent — refuse before any teardown,
  //    independent of workspace count (it has no worktree/PTY steps to reach).
  if (w.kind === "home") {
    return { ok: false, error: "the Home terminal cannot be removed" };
  }

  // 3. Guard: never remove the last workspace.
  if (state.workspaces.length <= 1) {
    return { ok: false, error: "cannot remove the last workspace" };
  }

  // 4. Determine removability BEFORE touching any PTYs.
  //    Manual lanes (repoId == null) have no worktree — closeable but not worktree-backed.
  //    For repo-linked workspaces: verify `dir` is a registered *secondary* worktree.
  //    We check via git's own registry (`worktree_list`) rather than a naive string comparison
  //    so symlinked paths (e.g. /tmp → /private/tmp) don't cause false positives that would
  //    kill PTYs before a remove that's doomed to fail.
  let worktreeBacked = false;
  if (w.repoId != null) {
    // Fast-path: exact string match → definitely the main checkout.
    if (w.dir === w.repoId) {
      return { ok: false, error: "cannot remove the main checkout workspace" };
    }
    // Full check via git's worktree registry. Canonicalize `dir` to handle symlinked paths.
    // worktree_list paths are canonical (git resolves symlinks); list[0] is always main.
    const [worktrees, resolvedDir] = await Promise.all([
      worktreeList(w.repoId),
      pathResolve(w.dir),
    ]);
    const secondaries = worktrees.slice(1);
    if (!secondaries.some((wt) => wt.path === resolvedDir)) {
      return {
        ok: false,
        error: `"${w.dir}" is not a registered removable worktree of this repo`,
      };
    }
    worktreeBacked = true;
  }

  // 5. Stop any managed dev servers tracked for this workspace — reclaims
  //    their port reservation (task 3.3) and kills the real Rust-tracked
  //    child (a leak otherwise: `removeWorkspace` only clears `serverStatus`/
  //    `foregroundState`, never `managedServers`). Then run `scripts.archive`
  //    best-effort (task 4.5): a clean archive script most plausibly wants
  //    any running dev server already stopped, and both need to happen while
  //    the worktree dir still exists — before it's removed below.
  await stopServers(id);
  await runArchiveScript(w);

  // 6. Kill all PTYs (fires the Rust group teardown for each).
  //    Only reached after confirming the worktree is removable (or it is a manual lane).
  const ptyIds = w.tabs.flatMap((tab) =>
    tab.panes.map((p) => p.ptyId).filter((pid): pid is string => pid !== null),
  );
  await Promise.all(ptyIds.map((pid) => pty.kill(pid)));

  // 7. Remove the worktree (worktree-backed only).
  if (worktreeBacked) {
    const r = await worktreeRemove(w.repoId!, w.dir, true);
    if (!r.ok) {
      // Do NOT drop the store entry — avoids an orphaned directory with no UI to retry.
      return { ok: false, error: `worktree removal failed: ${r.error}` };
    }
  }

  // 8. Drop from store + re-point active.
  useStore.getState().removeWorkspace(id);
  return { ok: true };
}
