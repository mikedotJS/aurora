//! Real GitLab merge requests via the `glab` CLI (graceful degrade when absent).

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct MrItem {
    pub iid: i64,
    pub title: String,
    pub branch: String,
    pub draft: bool,
    pub author: String,
    pub web_url: String,
    pub updated: String,
}

/// `glab mr list --output json` in `cwd`, mapped to the fields the UI renders.
///
/// Returns `Err("glab-not-found")` when the CLI is missing so the UI can degrade
/// gracefully, or the trimmed stderr when glab itself fails (e.g. not authed /
/// not a GitLab repo).
#[tauri::command]
pub fn glab_mr_list(cwd: String) -> Result<Vec<MrItem>, String> {
    // A Finder-launched app gets a minimal PATH, so resolve glab in the user's
    // real PATH and pass that PATH through (glab itself shells out to git).
    let glab = crate::sys::resolve_bin("glab").ok_or_else(|| "glab-not-found".to_string())?;
    let output = std::process::Command::new(&glab)
        .args(["mr", "list", "--output", "json"])
        .current_dir(crate::sys::expand_tilde(&cwd))
        .env("PATH", crate::sys::user_path())
        .output()
        .map_err(|_| "glab-not-found".to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_mr_list(&stdout)
}

/// Parse `glab mr list --output json`'s stdout into the UI's `MrItem` shape.
/// Extracted from `glab_mr_list` so the mapping can be unit-tested without
/// spawning the real `glab` CLI.
fn parse_mr_list(stdout: &str) -> Result<Vec<MrItem>, String> {
    let parsed: Value = serde_json::from_str(stdout).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(list) = parsed.as_array() {
        for mr in list {
            out.push(MrItem {
                iid: mr["iid"].as_i64().unwrap_or(0),
                title: mr["title"].as_str().unwrap_or("").to_string(),
                branch: mr["source_branch"].as_str().unwrap_or("").to_string(),
                draft: mr["draft"].as_bool().unwrap_or(false),
                author: mr["author"]["username"].as_str().unwrap_or("").to_string(),
                web_url: mr["web_url"].as_str().unwrap_or("").to_string(),
                updated: mr["updated_at"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

/// `glab api user` → the authenticated user's `username`, for the MR sheet's
/// "mine" filter (matched against each MR's `author`).
///
/// Run in `cwd` so glab resolves the host from the repo's remote (the user may
/// be authed to a self-hosted instance but not gitlab.com, and the username is
/// per-host) — mirroring how `glab_mr_list` is host-aware.
///
/// Returns `Err("glab-not-found")` when the CLI is missing so the UI can degrade
/// gracefully (toggle disabled), or the trimmed stderr when glab itself fails
/// (e.g. not authed).
#[tauri::command]
pub fn glab_current_user(cwd: String) -> Result<String, String> {
    let glab = crate::sys::resolve_bin("glab").ok_or_else(|| "glab-not-found".to_string())?;
    let output = std::process::Command::new(&glab)
        .args(["api", "user"])
        .current_dir(crate::sys::expand_tilde(&cwd))
        .env("PATH", crate::sys::user_path())
        .output()
        .map_err(|_| "glab-not-found".to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_username(&stdout)
}

/// Parse `glab api user`'s stdout into the authenticated username. Extracted
/// from `glab_current_user` so the mapping can be unit-tested without
/// spawning the real `glab` CLI.
fn parse_username(stdout: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(stdout).map_err(|e| e.to_string())?;
    parsed["username"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "glab: no username in response".to_string())
}

/// Open the GitLab "create merge request" page in the browser for `branch`
/// (`glab mr create --web --fill`). The Changes view's "Open MR" handoff uses
/// this when no MR exists yet; an existing MR is opened directly by its URL.
///
/// Returns `Err("glab-not-found")` when the CLI is missing so the UI can degrade.
#[tauri::command]
pub fn glab_mr_create(cwd: String, branch: String) -> Result<(), String> {
    let glab = crate::sys::resolve_bin("glab").ok_or_else(|| "glab-not-found".to_string())?;
    let output = std::process::Command::new(&glab)
        .args(["mr", "create", "--web", "--fill", "--source-branch", &branch])
        .current_dir(crate::sys::expand_tilde(&cwd))
        .env("PATH", crate::sys::user_path())
        .output()
        .map_err(|_| "glab-not-found".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("glab: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mr_list, parse_username};

    // ── parse_mr_list ────────────────────────────────────────────────────────

    #[test]
    fn parse_mr_list_maps_all_fields() {
        let json = r#"[{
            "iid": 42,
            "title": "Fix login bug",
            "source_branch": "fix/login",
            "draft": true,
            "author": { "username": "mike" },
            "web_url": "https://gitlab.example.com/mr/42",
            "updated_at": "2026-06-30T10:00:00Z"
        }]"#;
        let out = parse_mr_list(json).unwrap();
        assert_eq!(out.len(), 1);
        let mr = &out[0];
        assert_eq!(mr.iid, 42);
        assert_eq!(mr.title, "Fix login bug");
        assert_eq!(mr.branch, "fix/login");
        assert!(mr.draft);
        assert_eq!(mr.author, "mike");
        assert_eq!(mr.web_url, "https://gitlab.example.com/mr/42");
        assert_eq!(mr.updated, "2026-06-30T10:00:00Z");
    }

    #[test]
    fn parse_mr_list_defaults_missing_fields() {
        let json = r#"[{}]"#;
        let out = parse_mr_list(json).unwrap();
        assert_eq!(out.len(), 1);
        let mr = &out[0];
        assert_eq!(mr.iid, 0);
        assert_eq!(mr.title, "");
        assert_eq!(mr.branch, "");
        assert!(!mr.draft);
        assert_eq!(mr.author, "");
        assert_eq!(mr.web_url, "");
        assert_eq!(mr.updated, "");
    }

    #[test]
    fn parse_mr_list_empty_array_is_empty_vec() {
        assert!(parse_mr_list("[]").unwrap().is_empty());
    }

    #[test]
    fn parse_mr_list_non_array_root_yields_empty_vec() {
        // `glab` should always emit an array, but a stray object response
        // degrades to an empty list rather than panicking.
        assert!(parse_mr_list(r#"{"not":"an array"}"#).unwrap().is_empty());
    }

    #[test]
    fn parse_mr_list_malformed_json_is_an_error() {
        assert!(parse_mr_list("not json").is_err());
    }

    #[test]
    fn parse_mr_list_multiple_entries_preserve_order() {
        let json = r#"[
            {"iid": 1, "title": "first"},
            {"iid": 2, "title": "second"}
        ]"#;
        let out = parse_mr_list(json).unwrap();
        assert_eq!(out.iter().map(|m| m.iid).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(out[0].title, "first");
        assert_eq!(out[1].title, "second");
    }

    // ── parse_username ───────────────────────────────────────────────────────

    #[test]
    fn parse_username_extracts_username() {
        assert_eq!(parse_username(r#"{"username":"mike"}"#).unwrap(), "mike");
    }

    #[test]
    fn parse_username_missing_field_is_an_error() {
        assert!(parse_username(r#"{"id": 1}"#).is_err());
    }

    #[test]
    fn parse_username_malformed_json_is_an_error() {
        assert!(parse_username("not json").is_err());
    }
}
