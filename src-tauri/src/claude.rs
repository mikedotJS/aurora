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

#[derive(Serialize)]
pub struct Suggestion {
    pub command: String,
    pub note: String,
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
    let key = key_get()?.ok_or("no-key")?;
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "claude-sonnet-4-6".to_string());

    let system = format!(
        "You are a shell-command assistant inside a macOS zsh terminal. The user's current \
working directory is {cwd}. Translate the user's natural-language request into a SINGLE, safe \
shell command. Prefer non-destructive commands; never include `rm -rf /` or anything that could \
irreversibly destroy data without the user clearly asking. Respond with ONLY a minified JSON \
object of the form {{\"command\":\"<shell command>\",\"note\":\"<one short sentence>\"}} — no \
markdown, no code fences, no surrounding prose."
    );

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 400,
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
    let content = v["content"][0]["text"].as_str().unwrap_or("").trim();
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
