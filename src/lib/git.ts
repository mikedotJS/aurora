// Bridge to the Rust diff/staging commands behind the Changes view.

import { invoke } from "@tauri-apps/api/core";

export interface ChangedFile {
  path: string;
  old_path: string | null;
  /** "A" | "M" | "D" | "R" | "C" | "?" (untracked) */
  status: string;
  staged: boolean;
  added: number | null;
  removed: number | null;
}

export function gitChangedFiles(dir: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("git_changed_files", { dir }).catch(() => []);
}

export type DiffMode = "worktree" | "staged" | "base";

export function gitDiffFile(dir: string, base: string, path: string, mode: DiffMode): Promise<string> {
  return invoke<string>("git_diff_file", { dir, base, path, mode }).catch(() => "");
}

export function gitStage(dir: string, path: string): Promise<void> {
  return invoke<void>("git_stage", { dir, path }).catch(() => undefined);
}
export function gitUnstage(dir: string, path: string): Promise<void> {
  return invoke<void>("git_unstage", { dir, path }).catch(() => undefined);
}
export function gitStageAll(dir: string): Promise<void> {
  return invoke<void>("git_stage_all", { dir }).catch(() => undefined);
}
export function gitDiscard(dir: string, path: string, untracked: boolean): Promise<void> {
  return invoke<void>("git_discard", { dir, path, untracked }).catch(() => undefined);
}

export type MrCreateResult = { ok: true } | { ok: false; error: string };
export function glabMrCreate(cwd: string, branch: string): Promise<MrCreateResult> {
  return invoke<void>("glab_mr_create", { cwd, branch })
    .then(() => ({ ok: true }) as MrCreateResult)
    .catch((e) => ({ ok: false, error: String(e) }) as MrCreateResult);
}
