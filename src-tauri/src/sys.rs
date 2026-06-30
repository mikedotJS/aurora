//! Small filesystem / git helpers the UI needs for the smart prompt and status bar.

use serde::Serialize;
use std::sync::OnceLock;

static USER_PATH: OnceLock<String> = OnceLock::new();

/// The user's real shell `PATH`. A macOS app launched from Finder/Dock only
/// inherits a minimal PATH (`/usr/bin:/bin:…`), so tools installed by Homebrew,
/// mise, asdf, npm-global, etc. are invisible to `Command`. We resolve the real
/// PATH once from a login+interactive shell, falling back to augmenting the
/// inherited PATH with the usual tool directories.
pub fn user_path() -> String {
    USER_PATH.get_or_init(resolve_user_path).clone()
}

fn resolve_user_path() -> String {
    if let Some(p) = path_from_login_shell() {
        if p.contains('/') {
            return p;
        }
    }
    augmented_path()
}

fn path_from_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // Literal markers extract PATH cleanly even if the rc files print noise.
    let out = std::process::Command::new(&shell)
        .args(["-lic", "printf 'AURORA_PATH_START%sAURORA_PATH_END' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let start = s.find("AURORA_PATH_START")? + "AURORA_PATH_START".len();
    let end = s[start..].find("AURORA_PATH_END")? + start;
    Some(s[start..end].to_string())
}

fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = vec![
        format!("{home}/.local/bin"),
        format!("{home}/bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/local/sbin".into(),
    ];
    match std::env::var("PATH") {
        Ok(p) => dirs.extend(p.split(':').map(String::from)),
        Err(_) => dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].iter().map(|s| s.to_string())),
    }
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(":")
}

/// Absolute path to an executable named `name`, searched in the user's real
/// PATH. `None` if not found.
pub fn resolve_bin(name: &str) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    for dir in user_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let cand = std::path::Path::new(dir).join(name);
        let ok = std::fs::metadata(&cand)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
        if ok {
            return Some(cand);
        }
    }
    None
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Expand a leading `~` to `$HOME`.
pub fn expand_tilde(p: &str) -> String {
    if p == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| "/".into());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        return format!("{home}/{rest}");
    }
    p.to_string()
}

/// List a directory for ghost autocomplete / folder completion. Hidden
/// (dot-prefixed) entries are skipped unless `include_hidden` is set.
#[tauri::command]
pub fn list_dir(path: String, include_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let show_hidden = include_hidden.unwrap_or(false);
    let target = expand_tilde(&path);
    let mut out = Vec::new();
    let read = std::fs::read_dir(&target).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry { name, is_dir });
    }
    out.sort_by(|a, b| (b.is_dir, &a.name).cmp(&(a.is_dir, &b.name)));
    Ok(out)
}

/// Read a UTF-8 text file, truncated to `max_bytes` (on a char boundary). Used by
/// AI script generation to feed capped manifest contents to the model. Returns an
/// error string when the file is missing or unreadable; lossily decodes non-UTF-8.
#[tauri::command]
pub fn read_text_file(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let target = expand_tilde(&path);
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let cap = max_bytes.unwrap_or(8192).min(bytes.len());
    // Back off to the previous char boundary so the lossy decode stays clean.
    let mut end = cap;
    while end > 0 && (bytes[end - 1] & 0xC0) == 0x80 {
        end -= 1;
    }
    Ok(String::from_utf8_lossy(&bytes[..end]).to_string())
}

/// Current git branch for a directory, or `None` when not a repo.
///
/// Uses `git branch --show-current` (not `rev-parse HEAD`) so it also reports the
/// branch of a freshly-initialized repo that has no commits yet.
#[tauri::command]
pub fn git_branch(cwd: String) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(expand_tilde(&cwd))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

#[derive(Serialize)]
pub struct BranchList {
    /// The checked-out branch (`None` in detached HEAD or a non-repo).
    pub current: Option<String>,
    /// Local branches, most-recently-committed first.
    pub branches: Vec<String>,
}

/// Local git branches for the branch switcher, ordered by most recent commit so
/// the branches you actually move between surface first.
#[tauri::command]
pub fn git_branches(cwd: String) -> Result<BranchList, String> {
    let dir = expand_tilde(&cwd);
    let output = std::process::Command::new("git")
        .args([
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
        ])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(BranchList {
        current: git_branch(cwd),
        branches,
    })
}

/// Switch the working tree to an existing local branch. On failure (e.g. a dirty
/// tree) the git error is returned so the UI can explain what to do.
#[tauri::command]
pub fn git_switch(cwd: String, branch: String) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args(["switch", &branch])
        .current_dir(expand_tilde(&cwd))
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Git repository root for a directory, or `None` when not in a repo.
#[tauri::command]
pub fn git_root(cwd: String) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(expand_tilde(&cwd))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        None
    } else {
        Some(root)
    }
}

/// The user's home directory.
#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Resolve a path to its canonical form via `std::fs::canonicalize` (follows symlinks).
/// Returns the tilde-expanded path unchanged when the path does not exist or canonicalization
/// fails. Used to make cross-layer path comparisons robust against symlinked prefixes
/// (e.g. `/tmp` → `/private/tmp` on macOS) where plain string equality is unreliable.
#[tauri::command]
pub fn path_resolve(path: String) -> String {
    let expanded = expand_tilde(&path);
    std::fs::canonicalize(&expanded)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(expanded)
}
