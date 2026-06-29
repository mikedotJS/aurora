//! Real PTY sessions backed by `portable-pty`.
//!
//! Each pane in the UI owns one PTY session running the user's `$SHELL`. Raw
//! bytes read from the master side are base64-encoded and streamed to the
//! webview on the `pty:data` event; process exit is reported on `pty:exit`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One live shell session.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Registry of all live sessions, keyed by an opaque id handed to the UI.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    counter: AtomicU64,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    /// base64-encoded raw bytes (avoids splitting multi-byte UTF-8 across reads)
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
    code: i64,
}

/// Returned to the UI after a successful spawn.
#[derive(Serialize)]
pub struct SpawnResult {
    id: String,
    shell: String,
    is_zsh: bool,
}

/// Spawn a shell on a fresh PTY and start streaming its output.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<SpawnResult, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell_path = shell
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AURORA_TERMINAL", "1");
    match cwd.as_ref().filter(|d| !d.is_empty()) {
        Some(dir) => cmd.cwd(crate::sys::expand_tilde(dir)),
        None => {
            if let Ok(home) = std::env::var("HOME") {
                cmd.cwd(home);
            }
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let id = format!("pty-{}", manager.counter.fetch_add(1, Ordering::Relaxed));

    // Reader thread: pump master output to the webview.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = STANDARD.encode(&buf[..n]);
                        if app.emit("pty:data", PtyData { id: id.clone(), data }).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Waiter thread: report exit and drop the session.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
            let _ = app.emit("pty:exit", PtyExit { id, code });
        });
    }

    let is_zsh = shell_path.rsplit('/').next() == Some("zsh");

    manager.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession {
            writer,
            master: pair.master,
            killer,
        },
    );

    Ok(SpawnResult {
        id,
        shell: shell_path,
        is_zsh,
    })
}

/// Write keystrokes / a command line into a session.
#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such pty session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize a session's PTY (cols/rows in character cells).
#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such pty session")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill a session's child process and forget it.
#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = manager.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}
