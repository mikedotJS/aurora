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

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty temp directory for one test, removed on drop. Unique
    /// per-call so parallel `cargo test` runs never collide.
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
                "aurora-repoconfig-test-{tag}-{}-{n}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ── dig ──────────────────────────────────────────────────────────────────

    #[test]
    fn dig_walks_nested_dot_path() {
        let v = serde_json::json!({ "a": { "b": { "c": "leaf" } } });
        assert_eq!(dig(&v, "a.b.c").unwrap().as_str(), Some("leaf"));
    }

    #[test]
    fn dig_missing_segment_is_none() {
        let v = serde_json::json!({ "a": { "b": 1 } });
        assert!(dig(&v, "a.x").is_none());
        assert!(dig(&v, "a.b.c").is_none());
    }

    #[test]
    fn dig_single_segment_top_level() {
        let v = serde_json::json!({ "name": "aurora" });
        assert_eq!(dig(&v, "name").unwrap().as_str(), Some("aurora"));
    }

    // ── pattern_from_package ────────────────────────────────────────────────

    #[test]
    fn pattern_from_package_finds_config_validate_branch_name() {
        let v = serde_json::json!({
            "config": { "validate-branch-name": { "pattern": "^(feature|fix)/.+" } }
        });
        assert_eq!(pattern_from_package(&v).as_deref(), Some("^(feature|fix)/.+"));
    }

    #[test]
    fn pattern_from_package_finds_aurora_branch_pattern_key() {
        let v = serde_json::json!({ "aurora": { "branchPattern": "^team/.+" } });
        assert_eq!(pattern_from_package(&v).as_deref(), Some("^team/.+"));
    }

    #[test]
    fn pattern_from_package_ignores_empty_string_pattern() {
        let v = serde_json::json!({
            "config": { "validate-branch-name": { "pattern": "" } }
        });
        assert_eq!(pattern_from_package(&v), None);
    }

    #[test]
    fn pattern_from_package_none_when_absent() {
        let v = serde_json::json!({ "name": "some-repo" });
        assert_eq!(pattern_from_package(&v), None);
    }

    #[test]
    fn pattern_from_package_prefers_first_matching_location() {
        // Both `config.validate-branch-name.pattern` and the flat
        // `validate-branch-name.pattern` are present — the documented
        // priority order picks the first one checked.
        let v = serde_json::json!({
            "config": { "validate-branch-name": { "pattern": "^config/.+" } },
            "validate-branch-name": { "pattern": "^flat/.+" }
        });
        assert_eq!(pattern_from_package(&v).as_deref(), Some("^config/.+"));
    }

    // ── read_package_field ───────────────────────────────────────────────────

    #[test]
    fn read_package_field_literal_key_with_dot_wins_over_dot_path() {
        let tmp = TempDir::new("field-literal");
        tmp.write("package.json", r#"{ "aurora.branchPattern": "literal-value" }"#);
        assert_eq!(
            read_package_field(tmp.path(), "aurora.branchPattern".into()),
            Some("literal-value".into())
        );
    }

    #[test]
    fn read_package_field_falls_back_to_dot_path() {
        let tmp = TempDir::new("field-dotpath");
        tmp.write("package.json", r#"{ "aurora": { "branchPattern": "nested-value" } }"#);
        assert_eq!(
            read_package_field(tmp.path(), "aurora.branchPattern".into()),
            Some("nested-value".into())
        );
    }

    #[test]
    fn read_package_field_stringifies_non_string_values() {
        let tmp = TempDir::new("field-nonstring");
        tmp.write("package.json", r#"{ "version": "1.2.3", "private": true }"#);
        assert_eq!(read_package_field(tmp.path(), "private".into()), Some("true".into()));
    }

    #[test]
    fn read_package_field_null_value_is_none() {
        let tmp = TempDir::new("field-null");
        tmp.write("package.json", r#"{ "homepage": null }"#);
        assert_eq!(read_package_field(tmp.path(), "homepage".into()), None);
    }

    #[test]
    fn read_package_field_missing_file_is_none() {
        let tmp = TempDir::new("field-missing-file");
        assert_eq!(read_package_field(tmp.path(), "name".into()), None);
    }

    #[test]
    fn read_package_field_malformed_json_is_none() {
        let tmp = TempDir::new("field-malformed");
        tmp.write("package.json", "{ not valid json");
        assert_eq!(read_package_field(tmp.path(), "name".into()), None);
    }

    // ── detect_branch_validator ──────────────────────────────────────────────

    #[test]
    fn detect_branch_validator_from_package_json_without_husky() {
        let tmp = TempDir::new("detect-pkg");
        tmp.write(
            "package.json",
            r#"{ "config": { "validate-branch-name": { "pattern": "^feat/.+" } } }"#,
        );
        let bv = detect_branch_validator(tmp.path()).unwrap();
        assert_eq!(bv.regex, "^feat/.+");
        assert_eq!(bv.source, "package.json");
    }

    #[test]
    fn detect_branch_validator_labels_husky_source_when_hook_present() {
        let tmp = TempDir::new("detect-husky");
        tmp.write(
            "package.json",
            r#"{ "config": { "validate-branch-name": { "pattern": "^feat/.+" } } }"#,
        );
        tmp.write(".husky/pre-push", "#!/bin/sh\nnpx validate-branch-name\n");
        let bv = detect_branch_validator(tmp.path()).unwrap();
        assert_eq!(bv.source, "husky");
    }

    #[test]
    fn detect_branch_validator_from_rc_file() {
        let tmp = TempDir::new("detect-rc");
        tmp.write(".validate-branch-namerc", r#"{ "pattern": "^rc/.+" }"#);
        let bv = detect_branch_validator(tmp.path()).unwrap();
        assert_eq!(bv.regex, "^rc/.+");
        assert_eq!(bv.source, "rc");
    }

    #[test]
    fn detect_branch_validator_from_rc_json_file() {
        let tmp = TempDir::new("detect-rc-json");
        tmp.write(".validate-branch-namerc.json", r#"{ "pattern": "^rcjson/.+" }"#);
        let bv = detect_branch_validator(tmp.path()).unwrap();
        assert_eq!(bv.regex, "^rcjson/.+");
        assert_eq!(bv.source, "rc");
    }

    #[test]
    fn detect_branch_validator_none_when_nothing_present() {
        let tmp = TempDir::new("detect-none");
        tmp.write("package.json", r#"{ "name": "plain-repo" }"#);
        assert!(detect_branch_validator(tmp.path()).is_none());
    }

    // ── validate_branch_name ─────────────────────────────────────────────────

    #[test]
    fn validate_branch_name_passes_permissively_when_no_validator() {
        let tmp = TempDir::new("validate-none");
        let res = validate_branch_name(tmp.path(), "anything-goes".into());
        assert!(res.ok);
        assert!(!res.enforced);
        assert!(res.message.is_none());
    }

    #[test]
    fn validate_branch_name_accepts_matching_name() {
        let tmp = TempDir::new("validate-match");
        tmp.write(
            "package.json",
            r#"{ "config": { "validate-branch-name": { "pattern": "^(feature|fix)/.+" } } }"#,
        );
        let res = validate_branch_name(tmp.path(), "feature/login".into());
        assert!(res.ok);
        assert!(res.enforced);
    }

    #[test]
    fn validate_branch_name_rejects_non_matching_name_with_message() {
        let tmp = TempDir::new("validate-nomatch");
        tmp.write(
            "package.json",
            r#"{ "config": { "validate-branch-name": { "pattern": "^(feature|fix)/.+" } } }"#,
        );
        let res = validate_branch_name(tmp.path(), "whatever".into());
        assert!(!res.ok);
        assert!(res.enforced);
        assert!(res.message.unwrap().contains("^(feature|fix)/.+"));
    }

    #[test]
    fn validate_branch_name_uncompilable_regex_passes_permissively() {
        let tmp = TempDir::new("validate-badregex");
        // A JS-only negative lookahead the `regex` crate cannot compile.
        tmp.write(
            "package.json",
            r#"{ "config": { "validate-branch-name": { "pattern": "^(?!main).+" } } }"#,
        );
        let res = validate_branch_name(tmp.path(), "main".into());
        assert!(res.ok);
        assert!(!res.enforced);
    }
}
