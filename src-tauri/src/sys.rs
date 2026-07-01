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
    // `end` is a boundary once the byte right after it doesn't continue a
    // multi-byte sequence — checking `bytes[end]` (not `bytes[end - 1]`, which
    // can't distinguish a mid-sequence cut from a legitimately complete
    // character's last byte) is what makes this correct, and the `end <
    // bytes.len()` guard makes it a no-op on an untruncated read.
    let mut end = cap;
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty temp directory for one test, removed on drop. Name is
    /// unique per-call (pid + nanosecond timestamp + a counter) so tests
    /// running in parallel (cargo test's default) never collide.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "aurora-sys-test-{tag}-{}-{n}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ── expand_tilde ─────────────────────────────────────────────────────────

    #[test]
    fn expand_tilde_bare_tilde_is_home() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        assert_eq!(expand_tilde("~"), home);
    }

    #[test]
    fn expand_tilde_prefixed_path_joins_home() {
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(expand_tilde("~/Projects/aurora"), format!("{home}/Projects/aurora"));
    }

    #[test]
    fn expand_tilde_leaves_absolute_path_untouched() {
        assert_eq!(expand_tilde("/usr/local/bin"), "/usr/local/bin");
    }

    #[test]
    fn expand_tilde_leaves_relative_path_untouched() {
        assert_eq!(expand_tilde("relative/path"), "relative/path");
    }

    #[test]
    fn expand_tilde_bare_tilde_without_slash_is_untouched() {
        // "~foo" is a different user's home in shell semantics; this helper
        // only handles the exact "~" and "~/" forms, so it passes through.
        assert_eq!(expand_tilde("~foo"), "~foo");
    }

    // ── list_dir ─────────────────────────────────────────────────────────────

    #[test]
    fn list_dir_filters_hidden_and_sorts_dirs_before_files_then_by_name() {
        let tmp = TempDir::new("list");
        for name in ["zeta.txt", "alpha.txt", "Beta", "alpha_dir", ".hidden"] {
            let p = tmp.path().join(name);
            if name == "Beta" || name == "alpha_dir" {
                std::fs::create_dir(&p).unwrap();
            } else {
                std::fs::write(&p, b"x").unwrap();
            }
        }

        let entries = list_dir(tmp.path().to_string_lossy().to_string(), None).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Dirs first (byte-wise ascending: 'B' < 'a'), then files ascending; the
        // dotfile is excluded by default.
        assert_eq!(names, vec!["Beta", "alpha_dir", "alpha.txt", "zeta.txt"]);
        assert!(entries.iter().find(|e| e.name == "Beta").unwrap().is_dir);
        assert!(!entries.iter().find(|e| e.name == "alpha.txt").unwrap().is_dir);
    }

    #[test]
    fn list_dir_includes_hidden_when_requested() {
        let tmp = TempDir::new("hidden");
        std::fs::write(tmp.path().join(".hidden"), b"x").unwrap();
        std::fs::write(tmp.path().join("visible.txt"), b"x").unwrap();

        let default = list_dir(tmp.path().to_string_lossy().to_string(), None).unwrap();
        assert!(!default.iter().any(|e| e.name == ".hidden"));

        let with_hidden =
            list_dir(tmp.path().to_string_lossy().to_string(), Some(true)).unwrap();
        assert!(with_hidden.iter().any(|e| e.name == ".hidden"));
    }

    #[test]
    fn list_dir_missing_directory_is_an_error() {
        let tmp = TempDir::new("missing-parent");
        let missing = tmp.path().join("does-not-exist");
        assert!(list_dir(missing.to_string_lossy().to_string(), None).is_err());
    }

    // ── read_text_file ───────────────────────────────────────────────────────

    #[test]
    fn read_text_file_reads_whole_small_file_by_default() {
        let tmp = TempDir::new("read-whole");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "hello world").unwrap();
        let out = read_text_file(file.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn read_text_file_truncates_to_max_bytes() {
        let tmp = TempDir::new("read-trunc");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "0123456789").unwrap();
        let out = read_text_file(file.to_string_lossy().to_string(), Some(4)).unwrap();
        assert_eq!(out, "0123");
    }

    #[test]
    fn read_text_file_truncation_backs_off_to_char_boundary() {
        let tmp = TempDir::new("read-utf8");
        let file = tmp.path().join("f.txt");
        // "é" is 2 bytes (0xC3 0xA9); cutting at byte 2 would land mid-character.
        std::fs::write(&file, "aé").unwrap(); // bytes: 'a', 0xC3, 0xA9 (3 bytes total)
        let out = read_text_file(file.to_string_lossy().to_string(), Some(2)).unwrap();
        // Backs off from byte 2 (mid "é") to byte 1 (just "a"), never panics
        // and never yields a corrupt/lossy replacement character.
        assert_eq!(out, "a");
    }

    #[test]
    fn read_text_file_full_read_never_corrupts_a_trailing_multibyte_char() {
        // Regression test: a full (non-truncating) read must return the file
        // byte-for-byte-equivalent text, even when it ends in a multi-byte
        // UTF-8 character that happens to sit right at the `max_bytes`/file-end
        // boundary. (Bug found by this test: the boundary back-off used to
        // check the *last included* byte instead of the *first excluded*
        // byte, so it couldn't tell "cut mid-character" from "this IS a
        // complete character's last byte" — corrupting e.g. any file ending
        // in an accented character like "café" into "caf<U+FFFD>".)
        let tmp = TempDir::new("read-utf8-full");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "café").unwrap();
        let out = read_text_file(file.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(out, "café");
    }

    #[test]
    fn read_text_file_truncation_excludes_multibyte_char_split_by_lead_byte_only() {
        // "€" is 3 bytes (E2 82 AC). Cutting right after its lead byte (before
        // any continuation byte is included) must still exclude the whole
        // character, not just back off one byte and stop on the lead byte.
        let tmp = TempDir::new("read-utf8-lead");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "a€").unwrap(); // bytes: 'a', 0xE2, 0x82, 0xAC
        let out = read_text_file(file.to_string_lossy().to_string(), Some(2)).unwrap();
        assert_eq!(out, "a");
    }

    #[test]
    fn read_text_file_missing_file_is_an_error() {
        let tmp = TempDir::new("read-missing");
        let missing = tmp.path().join("nope.txt");
        assert!(read_text_file(missing.to_string_lossy().to_string(), None).is_err());
    }

    // ── path_resolve ─────────────────────────────────────────────────────────

    #[test]
    fn path_resolve_canonicalizes_existing_path() {
        let tmp = TempDir::new("resolve");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let expected = std::fs::canonicalize(&file).unwrap().to_string_lossy().to_string();
        assert_eq!(path_resolve(file.to_string_lossy().to_string()), expected);
    }

    #[test]
    fn path_resolve_nonexistent_path_falls_back_to_expanded_input() {
        let p = "/definitely/does/not/exist/aurora-test-path";
        assert_eq!(path_resolve(p.to_string()), p);
    }
}
