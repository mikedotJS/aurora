// Bridges to the Rust filesystem/git helpers.

import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export function homeDir(): Promise<string> {
  return invoke("home_dir");
}

export function listDir(path: string, includeHidden = false): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path, includeHidden }).catch(() => []);
}

/** Read a text file, truncated to `maxBytes`. Resolves to null when unreadable. */
export function readTextFile(path: string, maxBytes = 8192): Promise<string | null> {
  return invoke<string>("read_text_file", { path, maxBytes }).catch(() => null);
}

/**
 * Write `content` to `path` (which must resolve inside `root`), creating parent
 * dirs. Rejects (does not swallow) on failure — including when `path` escapes
 * `root` — so callers can surface the error. Used to materialize per-workspace
 * env files on worktree create (see lib/envFiles.ts); `root` is the workspace dir.
 */
export function writeTextFile(root: string, path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { root, path, content });
}

export function gitBranch(cwd: string): Promise<string | null> {
  return invoke<string | null>("git_branch", { cwd }).catch(() => null);
}

export interface BranchList {
  current: string | null;
  branches: string[];
}

export function gitBranches(cwd: string): Promise<BranchList> {
  return invoke<BranchList>("git_branches", { cwd }).catch(() => ({ current: null, branches: [] }));
}

export type SwitchResult = { ok: true } | { ok: false; error: string };

/** Switch to a local branch; resolves with the git error message on failure. */
export function gitSwitch(cwd: string, branch: string): Promise<SwitchResult> {
  return invoke<null>("git_switch", { cwd, branch })
    .then(() => ({ ok: true }) as SwitchResult)
    .catch((e) => ({ ok: false, error: String(e) }) as SwitchResult);
}

export function gitRoot(cwd: string): Promise<string | null> {
  return invoke<string | null>("git_root", { cwd }).catch(() => null);
}

export interface RepoInfo {
  root: string;
  /** The main worktree root — shared by a repo and all its worktrees (the
   *  canonical key for per-repo config, scripts, and AI accounts). */
  main_root: string;
  name: string;
  default_branch: string;
  current_branch: string | null;
}

/** Identify the repo containing `cwd` (root, name, default + current branch), or null. */
export function gitRepoInfo(cwd: string): Promise<RepoInfo | null> {
  return invoke<RepoInfo | null>("git_repo_info", { cwd }).catch(() => null);
}

export interface StatusSummary {
  files: number;
  added: number;
  removed: number;
  conflicted: number;
}

/** Summarize a worktree's change vs `base` (changed files, ±lines, conflicts). */
export function gitStatusSummary(dir: string, base: string): Promise<StatusSummary | null> {
  return invoke<StatusSummary>("git_status_summary", { dir, base }).catch(() => null);
}

/** Read a `package.json` field (literal key or dot-path) from `dir`, or null. */
export function readPackageField(dir: string, field: string): Promise<string | null> {
  return invoke<string | null>("read_package_field", { dir, field }).catch(() => null);
}

export interface BranchValidator {
  regex: string;
  source: string;
}

/** Detect the repo's `validate-branch-name` rule (regex + where it's defined). */
export function detectBranchValidator(dir: string): Promise<BranchValidator | null> {
  return invoke<BranchValidator | null>("detect_branch_validator", { dir }).catch(() => null);
}

export interface ValidateResult {
  ok: boolean;
  message?: string | null;
  /** True when a real repo validator was found and applied. */
  enforced: boolean;
}

/** Validate a branch name against the repo's detected rule (authoritative). */
export function validateBranchNameBackend(dir: string, name: string): Promise<ValidateResult> {
  return invoke<ValidateResult>("validate_branch_name", { dir, name }).catch(() => ({
    ok: true,
    message: null,
    enforced: false,
  }));
}

/** Resolve a path to its canonical form (follows symlinks, e.g. /tmp → /private/tmp on macOS).
 *  Falls back to the input unchanged when the path does not exist or canonicalization fails. */
export function pathResolve(path: string): Promise<string> {
  return invoke<string>("path_resolve", { path }).catch(() => path);
}

/** Collapse `$HOME` to `~` for display. */
export function shortenCwd(cwd: string, home: string): string {
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

/** Optimistically resolve a `cd <arg>` target to an absolute path. */
export function resolveCd(cwd: string, arg: string | undefined, home: string): string {
  if (!arg || arg === "~") return home;
  if (arg.startsWith("~/")) return home + arg.slice(1);
  if (arg === "~") return home;
  if (arg.startsWith("/")) return arg.replace(/\/+$/, "") || "/";
  const base = cwd.split("/").filter(Boolean);
  for (const seg of arg.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return "/" + base.join("/");
}
