//! Git worktree + diff/status helpers backing Aurora Workspaces. Each workspace
//! is a git worktree directory, so several branches are checked out at once.
//!
//! Everything shells out to `git`, run in the relevant directory, with the
//! user's real PATH (a Finder-launched app otherwise can't find a Homebrew git).

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

/// Run `git <args>` in `dir` with the user's real PATH. Returns trimmed stdout
/// on success, or the trimmed stderr (prefixed `git:`) on failure.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(crate::sys::expand_tilde(dir))
        .env("PATH", crate::sys::user_path())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("git: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[derive(Serialize)]
pub struct RepoInfo {
    pub root: String,
    /// The **main** worktree's root — the same for a repo and all its worktrees,
    /// so per-repo config/scripts are shared across workspaces. Equals `root`
    /// for the primary checkout.
    pub main_root: String,
    pub name: String,
    pub default_branch: String,
    pub current_branch: Option<String>,
}

/// Resolve the main repository root for any checkout (the primary worktree),
/// from a worktree or the primary. Falls back to `worktree_root` on any error.
fn main_repo_root(worktree_root: &str) -> String {
    // `--git-common-dir` points at the shared `.git` (the primary worktree's);
    // its parent is the main repo root. Relative results resolve against the root.
    let Ok(common) = git(worktree_root, &["rev-parse", "--git-common-dir"]) else {
        return worktree_root.to_string();
    };
    let common_path = if std::path::Path::new(&common).is_absolute() {
        std::path::PathBuf::from(&common)
    } else {
        std::path::Path::new(worktree_root).join(&common)
    };
    let resolved = std::fs::canonicalize(&common_path).unwrap_or(common_path);
    resolved
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| worktree_root.to_string())
}

/// Identify the repository containing `cwd`: its root, basename, default branch
/// (origin/HEAD, falling back to `main`), and the currently checked-out branch.
/// `None` when `cwd` is not inside a git repository.
#[tauri::command]
pub fn git_repo_info(cwd: String) -> Option<RepoInfo> {
    let root = git(&cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    if root.is_empty() {
        return None;
    }
    let main_root = main_repo_root(&root);
    let name = std::path::Path::new(&main_root)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| main_root.clone());
    // origin/HEAD → "origin/main"; take the last path segment. Fall back to main.
    let default_branch = git(&root, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|s| s.rsplit('/').next().map(|x| x.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string());
    let current_branch = git(&root, &["branch", "--show-current"])
        .ok()
        .filter(|s| !s.is_empty());
    Some(RepoInfo {
        root,
        main_root,
        name,
        default_branch,
        current_branch,
    })
}

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// List the repo's worktrees (`git worktree list --porcelain`).
#[tauri::command]
pub fn worktree_list(root: String) -> Result<Vec<Worktree>, String> {
    let out = git(&root, &["worktree", "list", "--porcelain"])?;
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree { path: p.to_string(), branch: None, head: None });
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(w) = cur.as_mut() {
                w.head = Some(h.to_string());
            }
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(w) = cur.as_mut() {
                // "refs/heads/foo" → "foo"
                w.branch = Some(b.rsplit('/').next().unwrap_or(b).to_string());
            }
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }
    Ok(list)
}

/// Add a worktree at `dir`. With `new_branch`, create `branch` off `base`
/// (`git worktree add -b <branch> <dir> <base>`); otherwise check out the
/// existing `branch` (`git worktree add <dir> <branch>`).
#[tauri::command]
pub fn worktree_add(
    root: String,
    dir: String,
    branch: String,
    base: String,
    new_branch: bool,
) -> Result<Worktree, String> {
    let dir_abs = crate::sys::expand_tilde(&dir);
    if new_branch {
        git(&root, &["worktree", "add", "-b", &branch, &dir_abs, &base])?;
    } else {
        git(&root, &["worktree", "add", &dir_abs, &branch])?;
    }
    Ok(Worktree {
        path: dir_abs,
        branch: Some(branch),
        head: None,
    })
}

/// Remove a worktree directory (`git worktree remove [--force] <dir>`).
#[tauri::command]
pub fn worktree_remove(root: String, dir: String, force: bool) -> Result<(), String> {
    let dir_abs = crate::sys::expand_tilde(&dir);
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&dir_abs);
    git(&root, &args).map(|_| ())
}

#[derive(Serialize)]
pub struct StatusSummary {
    pub files: u32,
    pub added: u32,
    pub removed: u32,
    pub conflicted: u32,
}

/// Summarize a worktree's change against `base`: changed-file count and
/// added/removed line totals (tracked changes vs the base tip, plus untracked
/// files), and the number of conflicted paths. Powers the rail diff counts and
/// the status-bar change counter. Lenient: an unknown `base` falls back to the
/// working-tree diff so a freshly-created branch still reports sensibly.
#[tauri::command]
pub fn git_status_summary(dir: String, base: String) -> Result<StatusSummary, String> {
    // Resolve the base ref; fall back to HEAD when it doesn't exist locally.
    let base_ok = !base.is_empty()
        && git(&dir, &["rev-parse", "--verify", "--quiet", &base]).is_ok();
    let diff_arg = if base_ok { base.as_str() } else { "HEAD" };

    // "N files changed, A insertions(+), B deletions(-)" (any field may be absent).
    let shortstat = git(&dir, &["diff", "--shortstat", diff_arg]).unwrap_or_default();
    let (mut files, added, removed) = parse_shortstat(&shortstat);

    // Untracked + conflicted from porcelain status.
    let mut conflicted = 0u32;
    if let Ok(status) = git(&dir, &["status", "--porcelain"]) {
        for line in status.lines() {
            if line.len() < 2 {
                continue;
            }
            let xy = &line[..2];
            if line.starts_with("?? ") {
                files += 1; // untracked file the shortstat didn't count
            }
            if matches!(xy, "UU" | "AA" | "DD" | "AU" | "UA" | "UD" | "DU") {
                conflicted += 1;
            }
        }
    }

    Ok(StatusSummary { files, added, removed, conflicted })
}

#[derive(Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    /// "A" | "M" | "D" | "R" | "C" | "?" (untracked).
    pub status: String,
    pub staged: bool,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// Resolve a `git diff --numstat` path field to the new path so it matches the
/// `--name-status` path. Renames appear as `old => new` or `pre/{old => new}/post`.
fn numstat_new_path(field: &str) -> String {
    if !field.contains(" => ") {
        return field.to_string();
    }
    if let (Some(lb), Some(rb)) = (field.find('{'), field.find('}')) {
        if lb < rb {
            let inner = &field[lb + 1..rb]; // "old => new"
            let new = inner.split(" => ").nth(1).unwrap_or(inner);
            return format!("{}{}{}", &field[..lb], new, &field[rb + 1..]);
        }
    }
    field.split(" => ").nth(1).unwrap_or(field).to_string()
}

/// One diff side (staged = index vs HEAD, or unstaged = worktree vs index),
/// merging name-status with numstat counts.
fn collect_diff(dir: &str, cached: bool, out: &mut Vec<ChangedFile>) {
    let name_status = if cached {
        git(dir, &["diff", "--cached", "--name-status"])
    } else {
        git(dir, &["diff", "--name-status"])
    }
    .unwrap_or_default();
    let numstat = if cached {
        git(dir, &["diff", "--cached", "--numstat"])
    } else {
        git(dir, &["diff", "--numstat"])
    }
    .unwrap_or_default();

    let mut counts: HashMap<String, (Option<u32>, Option<u32>)> = HashMap::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            counts.insert(
                numstat_new_path(parts[parts.len() - 1]),
                (parts[0].parse().ok(), parts[1].parse().ok()),
            );
        }
    }

    for line in name_status.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.is_empty() || parts[0].is_empty() {
            continue;
        }
        let code = parts[0];
        let status = code.chars().next().unwrap().to_string();
        let (old_path, path) = if (status == "R" || status == "C") && parts.len() >= 3 {
            (Some(parts[1].to_string()), parts[2].to_string())
        } else {
            (None, parts.get(1).cloned().unwrap_or_default().to_string())
        };
        let (added, removed) = counts.get(&path).cloned().unwrap_or((None, None));
        out.push(ChangedFile { path, old_path, status, staged: cached, added, removed });
    }
}

/// All changed files in a worktree, grouped (by `staged`) into the Changes view's
/// Staged / Changes sections. Untracked files are reported with status "?".
#[tauri::command]
pub fn git_changed_files(dir: String) -> Result<Vec<ChangedFile>, String> {
    let mut out = Vec::new();
    collect_diff(&dir, true, &mut out);
    collect_diff(&dir, false, &mut out);
    if let Ok(s) = git(&dir, &["ls-files", "--others", "--exclude-standard"]) {
        for line in s.lines() {
            if !line.is_empty() {
                out.push(ChangedFile {
                    path: line.to_string(),
                    old_path: None,
                    status: "?".into(),
                    staged: false,
                    added: None,
                    removed: None,
                });
            }
        }
    }
    Ok(out)
}

/// Unified diff text for one file. `mode`: "worktree" (unstaged), "staged"
/// (index vs HEAD), or "base" (the full workspace diff `base...HEAD`).
#[tauri::command]
pub fn git_diff_file(dir: String, base: String, path: String, mode: String) -> Result<String, String> {
    let out = match mode.as_str() {
        "staged" => git(&dir, &["diff", "--cached", "--", &path]),
        "base" => {
            let spec = format!("{base}...HEAD");
            git(&dir, &["diff", &spec, "--", &path])
        }
        _ => git(&dir, &["diff", "--", &path]),
    }?;
    Ok(out)
}

#[tauri::command]
pub fn git_stage(dir: String, path: String) -> Result<(), String> {
    git(&dir, &["add", "--", &path]).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(dir: String, path: String) -> Result<(), String> {
    git(&dir, &["restore", "--staged", "--", &path]).map(|_| ())
}

#[tauri::command]
pub fn git_stage_all(dir: String) -> Result<(), String> {
    git(&dir, &["add", "-A"]).map(|_| ())
}

/// Discard a file's changes (destructive — the UI confirms first). Untracked
/// files are removed; tracked files are restored from HEAD (index + worktree).
#[tauri::command]
pub fn git_discard(dir: String, path: String, untracked: bool) -> Result<(), String> {
    if untracked {
        git(&dir, &["clean", "-fd", "--", &path]).map(|_| ())
    } else {
        git(&dir, &["restore", "--staged", "--worktree", "--", &path]).map(|_| ())
    }
}

/// Git state of a worktree: uncommitted changes and commits not yet pushed.
/// Powers the destructive confirm before workspace teardown.
#[derive(Serialize)]
pub struct Safety {
    pub dirty: bool,
    pub ahead: u32,
    pub has_upstream: bool,
}

/// Check whether a worktree has uncommitted changes or unpushed commits.
/// `dirty` = `git status --porcelain` yields a non-empty result.
/// `ahead` / `has_upstream` from `git rev-list --count @{upstream}..HEAD`
/// (no upstream → `has_upstream=false`, `ahead=0`).
#[tauri::command]
pub fn git_worktree_safety(dir: String) -> Result<Safety, String> {
    let porcelain = git(&dir, &["status", "--porcelain"])?;
    let dirty = !porcelain.is_empty();
    match git(&dir, &["rev-list", "--count", "@{upstream}..HEAD"]) {
        Ok(s) => {
            let ahead = s.trim().parse::<u32>().unwrap_or(0);
            Ok(Safety { dirty, ahead, has_upstream: true })
        }
        Err(_) => Ok(Safety { dirty, ahead: 0, has_upstream: false }),
    }
}

/// Parse a `git diff --shortstat` line into (files, insertions, deletions).
fn parse_shortstat(s: &str) -> (u32, u32, u32) {
    let mut files = 0u32;
    let mut added = 0u32;
    let mut removed = 0u32;
    // tokens like "3 files changed, 12 insertions(+), 4 deletions(-)"
    let parts: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
    for p in parts {
        let n: u32 = p
            .split_whitespace()
            .next()
            .and_then(|x| x.parse().ok())
            .unwrap_or(0);
        if p.contains("file") {
            files = n;
        } else if p.contains("insertion") {
            added = n;
        } else if p.contains("deletion") {
            removed = n;
        }
    }
    (files, added, removed)
}
