//! BYOK Anthropic key (stored in the OS keychain) + natural-language → command.
//!
//! The key never reaches the webview: it is written to / read from the macOS
//! Keychain here, and Claude requests are made from Rust so the secret stays
//! out of the JS context.

use serde::Serialize;

const SERVICE: &str = "com.aurora.terminal";
const ACCOUNT: &str = "anthropic-api-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// Store the Anthropic API key in the keychain.
#[tauri::command]
pub fn key_set(key: String) -> Result<(), String> {
    entry()?.set_password(&key).map_err(|e| e.to_string())
}

/// Read the stored key, if any (used internally + to render masked previews).
#[tauri::command]
pub fn key_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a key is currently stored.
#[tauri::command]
pub fn key_present() -> bool {
    matches!(key_get(), Ok(Some(_)))
}

/// Remove the stored key.
#[tauri::command]
pub fn key_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Additional AI accounts (multi-provider) -------------------------------
// The startup Anthropic key above is the default, unremovable account. Extra
// accounts the user adds (Claude or, later, other providers) keep their secret
// under the `aurora-ai` service keyed by an opaque account id — never in config.

const AI_SERVICE: &str = "aurora-ai";

fn ai_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_SERVICE, id).map_err(|e| e.to_string())
}

/// Store an added AI account's API key in the keychain.
#[tauri::command]
pub fn ai_key_set(id: String, key: String) -> Result<(), String> {
    ai_entry(&id)?.set_password(&key).map_err(|e| e.to_string())
}

/// Whether an added AI account has a stored key.
#[tauri::command]
pub fn ai_key_present(id: String) -> bool {
    matches!(ai_entry(&id).and_then(|e| e.get_password().map_err(|x| x.to_string())), Ok(_))
}

/// Remove an added AI account's key.
#[tauri::command]
pub fn ai_key_delete(id: String) -> Result<(), String> {
    match ai_entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
pub struct Suggestion {
    pub command: String,
    pub note: String,
}

/// One-shot Claude call: send `system` + a single user `prompt`, return the
/// assistant's text. Shared by `claude_suggest` and `claude_text`. Returns
/// `Err("no-key")` when no key is stored so callers can route to key entry.
async fn call_claude(system: String, prompt: String, model: Option<String>, max_tokens: u32) -> Result<String, String> {
    let key = key_get()?.ok_or("no-key")?;
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "claude-sonnet-4-6".to_string());

    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("anthropic {}: {}", status.as_u16(), text));
    }

    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["content"][0]["text"].as_str().unwrap_or("").trim().to_string())
}

/// Translate a natural-language request into a single shell command via Claude.
///
/// Returns `Err("no-key")` when no key is stored so the UI can route to the
/// key-entry flow.
#[tauri::command]
pub async fn claude_suggest(
    prompt: String,
    cwd: String,
    model: Option<String>,
) -> Result<Suggestion, String> {
    let system = format!(
        "You are a shell-command assistant inside a macOS zsh terminal. The user's current \
working directory is {cwd}. Translate the user's natural-language request into a SINGLE, safe \
shell command. Prefer non-destructive commands; never include `rm -rf /` or anything that could \
irreversibly destroy data without the user clearly asking. Respond with ONLY a minified JSON \
object of the form {{\"command\":\"<shell command>\",\"note\":\"<one short sentence>\"}} — no \
markdown, no code fences, no surrounding prose."
    );

    let content = call_claude(system, prompt, model, 400).await?;
    let cleaned = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: serde_json::Value =
        serde_json::from_str(cleaned).map_err(|_| format!("unexpected model output: {content}"))?;

    Ok(Suggestion {
        command: parsed["command"].as_str().unwrap_or("").to_string(),
        note: parsed["note"].as_str().unwrap_or("").to_string(),
    })
}

/// Generic one-shot completion: caller supplies the system prompt and user
/// message, gets back the raw assistant text. Used by the AI branch-naming mode
/// (which owns its own prompt + validator-retry loop in JS). Returns
/// `Err("no-key")` when no key is stored.
#[tauri::command]
pub async fn claude_text(
    system: String,
    prompt: String,
    model: Option<String>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    call_claude(system, prompt, model, max_tokens.unwrap_or(300)).await
}
