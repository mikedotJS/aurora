//! BYO Jira Cloud integration: per-connection API tokens in the OS keychain
//! (never the webview, mirroring `claude.rs`) plus issue search/detail and
//! two-way sync (transition + remote-link) over Jira REST v3 with Basic auth
//! `email:token`.
//!
//! Tokens are keyed by **connection id** (`aurora-jira/<conn_id>`), so several
//! Jira sites coexist and a repo binds to one. The frontend passes the
//! connection's `conn_id` + `site` + `email`; the token is read from the keychain
//! here. Every call short-circuits to `Err("jira-not-connected")` when no token
//! is stored so the UI degrades to its inert state. The token is never logged.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

const SERVICE: &str = "aurora-jira";
/// Legacy single-token account name (pre connection-pool); migrated on first run.
const LEGACY_ACCOUNT: &str = "api-token";

fn entry(conn_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, conn_id).map_err(|e| e.to_string())
}

/// Store a connection's Jira API token in the keychain.
#[tauri::command]
pub fn jira_set_token(conn_id: String, token: String) -> Result<(), String> {
    entry(&conn_id)?.set_password(&token).map_err(|e| e.to_string())
}

/// Whether a token is stored for this connection.
#[tauri::command]
pub fn jira_token_present(conn_id: String) -> bool {
    matches!(entry(&conn_id).and_then(|e| e.get_password().map_err(|x| x.to_string())), Ok(_))
}

/// Remove a connection's stored token.
#[tauri::command]
pub fn jira_clear_token(conn_id: String) -> Result<(), String> {
    match entry(&conn_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// One-time migration of the legacy single token (`aurora-jira/api-token`) to a
/// connection id. Returns true when a token was moved (so the caller knows the
/// new connection is live). Idempotent: a no-op once the legacy entry is gone.
#[tauri::command]
pub fn jira_migrate_token(conn_id: String) -> Result<bool, String> {
    let legacy = keyring::Entry::new(SERVICE, LEGACY_ACCOUNT).map_err(|e| e.to_string())?;
    let token = match legacy.get_password() {
        Ok(t) => t,
        Err(keyring::Error::NoEntry) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    entry(&conn_id)?.set_password(&token).map_err(|e| e.to_string())?;
    let _ = legacy.delete_credential();
    Ok(true)
}

/// Read a connection's token, or `Err("jira-not-connected")` when absent.
fn token(conn_id: &str) -> Result<String, String> {
    match entry(conn_id)?.get_password() {
        Ok(t) => Ok(t),
        Err(keyring::Error::NoEntry) => Err("jira-not-connected".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// `Basic base64(email:token)` for the Authorization header.
fn basic_auth(conn_id: &str, email: &str) -> Result<String, String> {
    let token = token(conn_id)?;
    let raw = format!("{email}:{token}");
    Ok(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw)))
}

/// Normalize a site to its `https://host` origin (tolerate trailing slash / path).
fn origin(site: &str) -> String {
    site.trim().trim_end_matches('/').to_string()
}

async fn get(conn_id: &str, site: &str, email: &str, path: &str) -> Result<Value, String> {
    let auth = basic_auth(conn_id, email)?;
    let url = format!("{}{}", origin(site), path);
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("jira {}: {}", status.as_u16(), text.chars().take(300).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

async fn post(conn_id: &str, site: &str, email: &str, path: &str, body: Value) -> Result<Value, String> {
    let auth = basic_auth(conn_id, email)?;
    let url = format!("{}{}", origin(site), path);
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("jira {}: {}", status.as_u16(), text.chars().take(300).collect::<String>()));
    }
    // Some endpoints (transitions) return 204 with an empty body.
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[derive(Serialize)]
pub struct JiraUser {
    pub account_id: String,
    pub display_name: String,
}

/// Validate credentials via `GET /rest/api/3/myself`. Used by the connect flow.
#[tauri::command]
pub async fn jira_validate(conn_id: String, site: String, email: String) -> Result<JiraUser, String> {
    let v = get(&conn_id, &site, &email, "/rest/api/3/myself").await?;
    Ok(JiraUser {
        account_id: v["accountId"].as_str().unwrap_or("").to_string(),
        display_name: v["displayName"].as_str().unwrap_or("").to_string(),
    })
}

/// Distinct status names available across a project's issue-type workflows, for
/// the sync-status pickers. Flattens `GET /project/{key}/statuses` and dedupes
/// (first-seen order). Empty list (not an error) when the project has none.
#[tauri::command]
pub async fn jira_project_statuses(conn_id: String, site: String, email: String, project: String) -> Result<Vec<String>, String> {
    let path = format!("/rest/api/3/project/{}/statuses", project.trim());
    let v = get(&conn_id, &site, &email, &path).await?;
    let mut out: Vec<String> = Vec::new();
    if let Some(types) = v.as_array() {
        for t in types {
            if let Some(statuses) = t["statuses"].as_array() {
                for s in statuses {
                    if let Some(name) = s["name"].as_str() {
                        if !name.is_empty() && !out.iter().any(|x| x == name) {
                            out.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct JiraIssue {
    pub key: String,
    pub summary: String,
    pub issue_type: String,
    pub status: String,
    pub assignee: Option<String>,
    pub component: Option<String>,
    pub fix_version: Option<String>,
    pub sprint: Option<String>,
}

fn map_issue(key: &str, fields: &Value) -> JiraIssue {
    JiraIssue {
        key: key.to_string(),
        summary: fields["summary"].as_str().unwrap_or("").to_string(),
        issue_type: fields["issuetype"]["name"].as_str().unwrap_or("").to_string(),
        status: fields["status"]["name"].as_str().unwrap_or("").to_string(),
        assignee: fields["assignee"]["displayName"].as_str().map(|s| s.to_string()),
        component: fields["components"][0]["name"].as_str().map(|s| s.to_string()),
        fix_version: fields["fixVersions"][0]["name"].as_str().map(|s| s.to_string()),
        sprint: None,
    }
}

/// `\"`-escape a JQL string literal.
fn jql_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn looks_like_key(q: &str) -> bool {
    let q = q.trim();
    if let Some((proj, num)) = q.split_once('-') {
        return !proj.is_empty()
            && proj.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && proj.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
            && !num.is_empty()
            && num.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Search issues for the create palette: a direct key, free text, or — empty
/// query — the user's issues (the current open sprint when the project has one,
/// else all unresolved), most-recently-updated first.
#[tauri::command]
pub async fn jira_search(conn_id: String, site: String, email: String, query: String) -> Result<Vec<JiraIssue>, String> {
    let q = query.trim();
    if q.is_empty() {
        // Prefer the open sprint, but Kanban / team-managed / business projects
        // have no sprint field (that JQL errors), so fall back to all unresolved.
        let sprint = "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC";
        if let Ok(list) = run_search(&conn_id, &site, &email, sprint).await {
            if !list.is_empty() {
                return Ok(list);
            }
        }
        let mine = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
        return run_search(&conn_id, &site, &email, mine).await;
    }
    let jql = if looks_like_key(q) {
        format!("key = {}", q.to_uppercase())
    } else {
        format!("summary ~ \"{}\" ORDER BY updated DESC", jql_escape(q))
    };
    run_search(&conn_id, &site, &email, &jql).await
}

/// Execute one JQL search. Uses the current enhanced-search endpoint
/// (`POST /search/jql`), falling back to the legacy `GET /search` (removed on
/// Jira Cloud in May 2025, but still present on older Server/DC) for resilience.
async fn run_search(conn_id: &str, site: &str, email: &str, jql: &str) -> Result<Vec<JiraIssue>, String> {
    let fields = ["summary", "status", "issuetype", "assignee", "components", "fixVersions"];
    let body = serde_json::json!({ "jql": jql, "maxResults": 25, "fields": fields });
    let v = match post(conn_id, site, email, "/rest/api/3/search/jql", body).await {
        Ok(v) => v,
        Err(_) => {
            let path = format!(
                "/rest/api/3/search?maxResults=25&fields={}&jql={}",
                fields.join(","),
                urlencode(jql)
            );
            get(conn_id, site, email, &path).await?
        }
    };
    let mut out = Vec::new();
    if let Some(list) = v["issues"].as_array() {
        for issue in list {
            let key = issue["key"].as_str().unwrap_or("");
            out.push(map_issue(key, &issue["fields"]));
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct JiraComment {
    pub author: String,
    pub body: String,
    pub ts: String,
}

#[derive(Serialize)]
pub struct JiraIssueDetail {
    #[serde(flatten)]
    pub issue: JiraIssue,
    pub description: String,
    pub url: String,
    pub comments: Vec<JiraComment>,
}

/// Recursively flatten an Atlassian Document Format (ADF) node to plain text,
/// inserting newlines at block boundaries.
fn flatten_adf(node: &Value, out: &mut String) {
    match node {
        Value::Object(map) => {
            let node_type = map.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if node_type == "text" {
                if let Some(t) = map.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
            if node_type == "hardBreak" {
                out.push('\n');
            }
            if let Some(content) = map.get("content").and_then(|c| c.as_array()) {
                for child in content {
                    flatten_adf(child, out);
                }
            }
            // block-level nodes end with a newline
            if matches!(node_type, "paragraph" | "heading" | "listItem" | "blockquote" | "codeBlock") {
                out.push('\n');
            }
        }
        Value::Array(arr) => {
            for child in arr {
                flatten_adf(child, out);
            }
        }
        _ => {}
    }
}

fn adf_text(node: &Value) -> String {
    let mut s = String::new();
    flatten_adf(node, &mut s);
    s.trim().to_string()
}

/// Full issue detail + recent comments for the create flow's context block.
#[tauri::command]
pub async fn jira_issue(conn_id: String, site: String, email: String, key: String) -> Result<JiraIssueDetail, String> {
    let path = format!(
        "/rest/api/3/issue/{}?fields=summary,status,issuetype,assignee,components,fixVersions,description,comment",
        key
    );
    let v = get(&conn_id, &site, &email, &path).await?;
    let fields = &v["fields"];
    let issue = map_issue(&key, fields);
    let description = adf_text(&fields["description"]);
    let mut comments = Vec::new();
    if let Some(list) = fields["comment"]["comments"].as_array() {
        // most recent few
        for c in list.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev() {
            comments.push(JiraComment {
                author: c["author"]["displayName"].as_str().unwrap_or("").to_string(),
                body: adf_text(&c["body"]),
                ts: c["created"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    let url = format!("{}/browse/{}", origin(&site), key);
    Ok(JiraIssueDetail { issue, description, url, comments })
}

/// Transition an issue to the transition whose target status name matches
/// `to_name` (case-insensitive). No-op success when already there / no match
/// is surfaced as an error the caller treats as best-effort.
#[tauri::command]
pub async fn jira_transition(conn_id: String, site: String, email: String, key: String, to_name: String) -> Result<(), String> {
    let list = get(&conn_id, &site, &email, &format!("/rest/api/3/issue/{}/transitions", key)).await?;
    let target = to_name.trim().to_lowercase();
    let mut id: Option<String> = None;
    if let Some(arr) = list["transitions"].as_array() {
        for t in arr {
            let to_status = t["to"]["name"].as_str().unwrap_or("").to_lowercase();
            let name = t["name"].as_str().unwrap_or("").to_lowercase();
            if to_status == target || name == target {
                id = t["id"].as_str().map(|s| s.to_string());
                break;
            }
        }
    }
    let id = id.ok_or_else(|| format!("no transition to \"{to_name}\" available"))?;
    let body = serde_json::json!({ "transition": { "id": id } });
    post(&conn_id, &site, &email, &format!("/rest/api/3/issue/{}/transitions", key), body).await?;
    Ok(())
}

/// Attach a remote link (e.g. an MR) to an issue. Falls back to posting a comment
/// when remote links are unavailable.
#[tauri::command]
pub async fn jira_add_remote_link(
    conn_id: String,
    site: String,
    email: String,
    key: String,
    url: String,
    title: String,
) -> Result<(), String> {
    // `globalId` = the URL so repeated posts upsert the same link (idempotent
    // across app restarts) rather than creating duplicates.
    let body = serde_json::json!({
        "globalId": url,
        "object": { "url": url, "title": title }
    });
    let path = format!("/rest/api/3/issue/{}/remotelink", key);
    if post(&conn_id, &site, &email, &path, body).await.is_ok() {
        return Ok(());
    }
    // Fallback: a comment with the link (ADF).
    let comment = serde_json::json!({
        "body": {
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": format!("{title}: {url}") }]
            }]
        }
    });
    post(&conn_id, &site, &email, &format!("/rest/api/3/issue/{}/comment", key), comment).await?;
    Ok(())
}

/// Minimal percent-encoding for a JQL query string (encode everything that isn't
/// an RFC-3986 unreserved char).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
