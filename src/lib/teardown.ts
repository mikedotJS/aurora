// Workspace teardown orchestrator. Strict order (load-bearing):
//   guards → removability check → kill PTYs → remove worktree → drop from store.
// Removing the worktree before processes die risks git fighting open files;
// dropping the store entry before the FS is cleaned orphans the directory.
// Critically: the removability check runs BEFORE killing PTYs so a failed
// remove never leaves zombie cards with dead processes (M1+M2).

import { useStore } from "../state/store";
import { pty } from "../term/pty";
import { worktreeRemove, worktreeList } from "./worktree";
import { pathResolve } from "./sys";

export type TeardownResult = { ok: true } | { ok: false; error: string };

export async function deleteWorkspace(id: string): Promise<TeardownResult> {
  // 1. Snapshot
  const state = useStore.getState();
  const w = state.workspaces.find((x) => x.id === id);
  if (!w) return { ok: false, error: "workspace not found" };

  // 2. Guard: never remove the last workspace.
  if (state.workspaces.length <= 1) {
    return { ok: false, error: "cannot remove the last workspace" };
  }

  // 3. Determine removability BEFORE touching any PTYs.
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

  // 4. Kill all PTYs (fires the Rust group teardown for each).
  //    Only reached after confirming the worktree is removable (or it is a manual lane).
  const ptyIds = w.tabs.flatMap((tab) =>
    tab.panes.map((p) => p.ptyId).filter((pid): pid is string => pid !== null),
  );
  await Promise.all(ptyIds.map((pid) => pty.kill(pid)));

  // 5. Remove the worktree (worktree-backed only).
  if (worktreeBacked) {
    const r = await worktreeRemove(w.repoId!, w.dir, true);
    if (!r.ok) {
      // Do NOT drop the store entry — avoids an orphaned directory with no UI to retry.
      return { ok: false, error: `worktree removal failed: ${r.error}` };
    }
  }

  // 6. Drop from store + re-point active.
  useStore.getState().removeWorkspace(id);
  return { ok: true };
}
