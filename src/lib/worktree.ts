// Bridge to the Rust git-worktree commands backing workspaces.

import { invoke } from "@tauri-apps/api/core";

export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
}

export function worktreeList(root: string): Promise<Worktree[]> {
  return invoke<Worktree[]>("worktree_list", { root }).catch(() => []);
}

export type WorktreeResult = { ok: true; worktree: Worktree } | { ok: false; error: string };

/** Add a worktree at `dir`. With `newBranch`, creates `branch` off `base`. */
export function worktreeAdd(
  root: string,
  dir: string,
  branch: string,
  base: string,
  newBranch: boolean,
): Promise<WorktreeResult> {
  return invoke<Worktree>("worktree_add", { root, dir, branch, base, newBranch })
    .then((worktree) => ({ ok: true, worktree }) as WorktreeResult)
    .catch((e) => ({ ok: false, error: String(e) }) as WorktreeResult);
}

export interface Safety {
  dirty: boolean;
  ahead: number;
  hasUpstream: boolean;
}

/** Check git state of a worktree: uncommitted changes and unpushed commits. */
export function worktreeSafety(dir: string): Promise<Safety> {
  return invoke<{ dirty: boolean; ahead: number; has_upstream: boolean }>(
    "git_worktree_safety",
    { dir },
  ).then((r) => ({ dirty: r.dirty, ahead: r.ahead, hasUpstream: r.has_upstream }));
}

export type RemoveResult = { ok: true } | { ok: false; error: string };

/** Remove a worktree. Returns `{ ok: true }` on success or `{ ok: false, error }` on failure.
 *  The sole rollback caller in create.ts ignores the return value, which is fine. */
export function worktreeRemove(root: string, dir: string, force = false): Promise<RemoveResult> {
  return invoke<void>("worktree_remove", { root, dir, force })
    .then(() => ({ ok: true }) as RemoveResult)
    .catch((e) => ({ ok: false, error: String(e) }) as RemoveResult);
}
