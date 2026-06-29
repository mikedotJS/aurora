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
    let parsed: Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
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
    let parsed: Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    parsed["username"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "glab: no username in response".to_string())
}
