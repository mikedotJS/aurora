//! Filesystem watcher for each repo's committed `aurora.json`.
//!
//! Aurora reads a repo's `aurora.json` once and caches it (`auroraConfigStore.ts`), so an edit on
//! disk was invisible until relaunch — a real footgun (a fixed setup/run/envFiles config appeared
//! to have no effect). This watcher closes that gap: it watches the repo-root DIRECTORY (watching
//! the file itself misses the atomic rename-replace most editors do), filters events down to
//! `aurora.json`, and hands the repo root to a callback. In production that callback emits the
//! `aurora:config-changed` Tauri event; the front end invalidates + re-reads the config for that
//! root. See the `ConfigWatcher::for_app` constructor and `watch_aurora_config` command below.
//!
//! Testability mirrors `server.rs`: the core `ConfigWatcher` takes a plain `Fn(String)` sink rather
//! than an `AppHandle`, so `#[cfg(test)]` drives it against a real temp directory with a channel and
//! no Tauri app context. Only the thin `for_app` constructor + `#[tauri::command]` wrapper know
//! about Tauri.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

pub const CONFIG_FILENAME: &str = "aurora.json";

type Sink = Arc<dyn Fn(String) + Send + Sync>;

/// Watches repo-root directories and invokes `on_change(root)` whenever that root's `aurora.json`
/// is created, modified, or removed. `root` is reported as the ORIGINAL string passed to `watch`
/// (not the event's path), so it matches exactly what the store cached the config under — symlinks
/// and trailing slashes in the event path can't cause a lookup miss on the JS side.
pub struct ConfigWatcher {
    // Created lazily on the first `watch` so the event closure can capture the shared state below.
    watcher: Mutex<Option<RecommendedWatcher>>,
    // canonicalized repo-root dir -> the original root string the caller watched it under.
    roots: Arc<Mutex<HashMap<PathBuf, String>>>,
    on_change: Sink,
}

impl ConfigWatcher {
    /// Core constructor: `on_change` is called with a repo root whenever its `aurora.json` changes.
    pub fn new(on_change: Sink) -> Self {
        ConfigWatcher { watcher: Mutex::new(None), roots: Arc::new(Mutex::new(HashMap::new())), on_change }
    }

    /// Start watching `root`'s directory for `aurora.json` changes. Idempotent — watching an
    /// already-watched root is a no-op. A root that doesn't exist / can't be canonicalized is
    /// skipped with an error (never panics).
    pub fn watch(&self, root: &str) -> Result<(), String> {
        let canonical = std::fs::canonicalize(root).map_err(|e| format!("cannot watch {root}: {e}"))?;
        {
            let mut roots = self.roots.lock().unwrap_or_else(|e| e.into_inner());
            if roots.contains_key(&canonical) {
                return Ok(());
            }
            roots.insert(canonical.clone(), root.to_string());
        }

        let mut guard = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let roots = Arc::clone(&self.roots);
            let on_change = Arc::clone(&self.on_change);
            let watcher = RecommendedWatcher::new(
                move |res: notify::Result<Event>| {
                    let Ok(event) = res else { return };
                    // Reads don't change the file — ignore them to cut noise.
                    if matches!(event.kind, EventKind::Access(_)) {
                        return;
                    }
                    for path in &event.paths {
                        if path.file_name().and_then(|n| n.to_str()) != Some(CONFIG_FILENAME) {
                            continue;
                        }
                        // The changed file is `<root>/aurora.json`; its parent is the repo root.
                        // Canonicalize the parent (it exists even when the file was just removed)
                        // and map back to the caller's original root string.
                        let Some(parent) = path.parent() else { continue };
                        let canonical_parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
                        let original = roots.lock().unwrap_or_else(|e| e.into_inner()).get(&canonical_parent).cloned();
                        if let Some(root) = original {
                            on_change(root);
                        }
                    }
                },
                Config::default(),
            )
            .map_err(|e| format!("failed to create fs watcher: {e}"))?;
            *guard = Some(watcher);
        }

        guard
            .as_mut()
            .expect("watcher just created")
            .watch(Path::new(root), RecursiveMode::NonRecursive)
            .map_err(|e| format!("failed to watch {root}: {e}"))
    }
}

/// Tauri state wrapper. Lazily holds a `ConfigWatcher` whose sink emits `aurora:config-changed`.
/// (Separate from the core type so `#[cfg(test)]` never needs an `AppHandle`.)
#[derive(Default)]
pub struct ConfigWatcherState(Mutex<Option<ConfigWatcher>>);

#[tauri::command]
pub fn watch_aurora_config(
    state: tauri::State<'_, ConfigWatcherState>,
    app: tauri::AppHandle,
    root: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let handle = app.clone();
        *guard = Some(ConfigWatcher::new(Arc::new(move |root: String| {
            let _ = handle.emit("aurora:config-changed", ConfigChanged { root });
        })));
    }
    guard.as_ref().expect("watcher just created").watch(&root)
}

#[derive(Clone, serde::Serialize)]
struct ConfigChanged {
    root: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("aurora-cfgwatch-{tag}-{}-{n}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Wait up to ~5s for the sink to report `expected`, returning whether it did. Polls a channel
    /// rather than sleeping a fixed time — FSEvents/inotify latency varies under load.
    fn wait_for(rx: &mpsc::Receiver<String>, expected: &str) -> bool {
        for _ in 0..100 {
            if let Ok(root) = rx.recv_timeout(Duration::from_millis(50)) {
                if root == expected {
                    return true;
                }
            }
        }
        false
    }

    fn watcher_into_channel() -> (ConfigWatcher, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel::<String>();
        let tx = Mutex::new(tx);
        let watcher = ConfigWatcher::new(Arc::new(move |root: String| {
            let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(root);
        }));
        (watcher, rx)
    }

    #[test]
    fn fires_on_aurora_json_write() {
        let dir = TempDir::new("write");
        let root = dir.path().to_string_lossy().to_string();
        let (watcher, rx) = watcher_into_channel();
        watcher.watch(&root).expect("watch should start");

        std::fs::write(dir.path().join(CONFIG_FILENAME), r#"{"version":1,"scripts":{}}"#).unwrap();

        // Report the ORIGINAL root string, not a canonicalized event path.
        assert!(wait_for(&rx, &root), "expected a change event for {root}");
    }

    #[test]
    fn ignores_an_unrelated_file_in_the_same_dir() {
        let dir = TempDir::new("unrelated");
        let root = dir.path().to_string_lossy().to_string();
        let (watcher, rx) = watcher_into_channel();
        watcher.watch(&root).expect("watch should start");

        std::fs::write(dir.path().join("package.json"), "{}").unwrap();

        // No aurora.json touched → the sink must stay silent.
        assert!(!wait_for(&rx, &root), "an unrelated file must not fire a config change");
    }

    #[test]
    fn fires_on_remove_of_aurora_json() {
        let dir = TempDir::new("remove");
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join(CONFIG_FILENAME);
        std::fs::write(&file, r#"{"version":1,"scripts":{}}"#).unwrap();

        let (watcher, rx) = watcher_into_channel();
        watcher.watch(&root).expect("watch should start");
        std::fs::remove_file(&file).unwrap();

        // Deleting a committed config must also re-read (falls back to legacy/default on the JS side).
        assert!(wait_for(&rx, &root), "expected a change event on remove");
    }

    #[test]
    fn watch_is_idempotent_for_the_same_root() {
        let dir = TempDir::new("idem");
        let root = dir.path().to_string_lossy().to_string();
        let (watcher, _rx) = watcher_into_channel();
        watcher.watch(&root).expect("first watch");
        watcher.watch(&root).expect("second watch must be a no-op, not an error");
    }
}
