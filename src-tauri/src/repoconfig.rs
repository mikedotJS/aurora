//! Per-repo config helpers backing `workspace-config`: read a branch-naming
//! pattern from `package.json`, detect an existing `validate-branch-name`
//! validator, and authoritatively validate a candidate branch name against it.
//!
//! Everything reads files under the repo root directly (no shelling out). The
//! detected regex is the same one the team's `validate-branch-name` binary
//! tests, so a name we accept here also passes the repo's pre-push hook.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// Read `package.json` at `dir` as JSON, if present and parseable.
fn package_json(dir: &str) -> Option<Value> {
    let path = Path::new(&crate::sys::expand_tilde(dir)).join("package.json");
    let txt = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&txt).ok()
}

/// Walk a dot-path (`config.validate-branch-name.pattern`) through a JSON value.
fn dig<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = root;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    Some(cur)
}

/// Read a `package.json` field, by literal key first (so a flat key containing a
/// dot like `"aurora.branchPattern"` works) then by dot-path. Returns the value
/// as a string (strings verbatim, other JSON stringified). `None` when absent.
#[tauri::command]
pub fn read_package_field(dir: String, field: String) -> Option<String> {
    let v = package_json(&dir)?;
    let found = v
        .get(&field)
        .or_else(|| dig(&v, &field))?;
    match found {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

#[derive(Serialize)]
pub struct BranchValidator {
    pub regex: String,
    /// Where the rule was found: "package.json" | "husky" | "rc".
    pub source: String,
}

/// Extract a `validate-branch-name` pattern from a parsed `package.json`, trying
/// the documented config locations.
fn pattern_from_package(v: &Value) -> Option<String> {
    for path in [
        "config.validate-branch-name.pattern",
        "validate-branch-name.pattern",
        "aurora.branchValidator",
        "aurora.branchPattern",
    ] {
        if let Some(Value::String(s)) = dig(v, path) {
            if !s.is_empty() {
                return Some(s.clone());
            }
        }
    }
    None
}

/// Detect an existing branch-name validator: a `validate-branch-name` pattern in
/// `package.json`, a `.validate-branch-namerc(.json)`, or a husky hook that runs
/// the validator (whose pattern still lives in `package.json`). Returns the regex
/// and where it came from, or `None`.
#[tauri::command]
pub fn detect_branch_validator(dir: String) -> Option<BranchValidator> {
    let base = crate::sys::expand_tilde(&dir);

    // 1. package.json config.
    if let Some(v) = package_json(&dir) {
        if let Some(regex) = pattern_from_package(&v) {
            // A husky pre-push hook invoking the validator → label the source husky.
            let husky = std::fs::read_to_string(Path::new(&base).join(".husky/pre-push"))
                .ok()
                .map(|h| h.contains("validate-branch-name"))
                .unwrap_or(false);
            return Some(BranchValidator {
                regex,
                source: if husky { "husky".into() } else { "package.json".into() },
            });
        }
    }

    // 2. .validate-branch-namerc / .validate-branch-namerc.json
    for rc in [".validate-branch-namerc", ".validate-branch-namerc.json"] {
        if let Ok(txt) = std::fs::read_to_string(Path::new(&base).join(rc)) {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                if let Some(Value::String(s)) = v.get("pattern") {
                    if !s.is_empty() {
                        return Some(BranchValidator { regex: s.clone(), source: "rc".into() });
                    }
                }
            }
        }
    }

    None
}

#[derive(Serialize)]
pub struct ValidateResult {
    pub ok: bool,
    pub message: Option<String>,
    /// True when a real validator was found and applied (vs. a permissive pass).
    pub enforced: bool,
}

/// Validate `name` against the repo's detected branch-name rule. When no rule is
/// found — or its regex can't be compiled — this passes permissively (the JS
/// layer still applies a local sanity check). A failing name reports the regex.
#[tauri::command]
pub fn validate_branch_name(dir: String, name: String) -> ValidateResult {
    let Some(bv) = detect_branch_validator(dir) else {
        return ValidateResult { ok: true, message: None, enforced: false };
    };
    match regex::Regex::new(&bv.regex) {
        Ok(re) => {
            if re.is_match(&name) {
                ValidateResult { ok: true, message: None, enforced: true }
            } else {
                ValidateResult {
                    ok: false,
                    message: Some(format!("Branch must match the repo rule: {}", bv.regex)),
                    enforced: true,
                }
            }
        }
        // Can't compile the team's regex (e.g. JS-only lookahead) → don't block.
        Err(_) => ValidateResult { ok: true, message: None, enforced: false },
    }
}
