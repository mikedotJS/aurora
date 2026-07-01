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
use tauri::{AppHandle, Emitter, Manager, State};

/// Tracks the server process group captured at launch (D7 — fire-and-forget sampler).
///
/// Default is `Idle` (no capture initiated). Transitions:
///   Idle → Pending (capture started) → Found(pgid) (success) or Failed (timeout).
enum ServerCapture {
    /// No capture started for this session.
    Idle,
    /// Sampler thread running; distinct server pgid not yet determined.
    Pending,
    /// Sampler timed out without finding a distinct foreground job.
    Failed,
    /// A distinct foreground pgid was found and recorded — kill target for Stop/⌘Q.
    Found(i32),
}

impl ServerCapture {
    /// Returns `Some(pgid)` only when a server group was captured successfully.
    fn found(&self) -> Option<i32> {
        match self {
            ServerCapture::Found(p) => Some(*p),
            _ => None,
        }
    }
}

/// One live shell session.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// pgid of the shell process (== pid because portable-pty calls setsid()).
    /// `None` only when `child.process_id()` returns `None` (should not happen in practice).
    shell_pgid: Option<i32>,
    /// Captured server process group (set by `pty_capture_server_pgid`).
    /// Included in `group_teardown` + `kill_all` so Stop and ⌘Q reach the real server.
    server: ServerCapture,
}

/// Registry of all live sessions, keyed by an opaque id handed to the UI.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    counter: AtomicU64,
}

impl PtyManager {
    /// Drain all sessions and send SIGHUP to every process group (including captured
    /// server groups), then sleep ~300 ms and SIGKILL any straggler. Bounded single
    /// sleep so ⌘Q stays fast. Collects shell_pgid + fg + server.found() per session.
    pub fn kill_all(&self) {
        let sessions: Vec<PtySession> = {
            let mut map = self.sessions.lock().unwrap();
            map.drain().map(|(_, s)| s).collect()
        };

        let our_pgid = unsafe { libc::getpgrp() };
        let mut pgids: Vec<i32> = Vec::new();
        for s in &sessions {
            let fg = s.master.process_group_leader();
            for p in [s.shell_pgid, fg, s.server.found()].into_iter().flatten() {
                if p > 1 && p != our_pgid && !pgids.contains(&p) {
                    pgids.push(p);
                }
            }
        }

        // Early-return when there are no pgids to signal: avoids spending 300 ms
        // in the grace-period sleep for the common case where the map is already
        // drained (second ExitRequested/Exit event, or quit with no open shells).
        if pgids.is_empty() {
            return; // sessions drop here, closing all masters
        }
        for &p in &pgids {
            unsafe { libc::killpg(p, libc::SIGHUP); }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for &p in &pgids {
            unsafe { libc::killpg(p, libc::SIGKILL); }
        }
        // sessions drop here, closing all masters.
    }
}

#[derive(Clone, Serialize)]
struct PtyData<'a> {
    /// Borrowed from the reader thread's owned `id` — avoids allocating a fresh
    /// `String` for every `pty:data` event on the hot output path.
    id: &'a str,
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
    env: Option<Vec<(String, String)>>,
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
    // Per-workspace env (preset vars + $AURORA_PORT_OFFSET), exported into the shell.
    if let Some(vars) = env {
        for (k, v) in vars {
            if !k.is_empty() {
                cmd.env(k, v);
            }
        }
    }
    match cwd.as_ref().filter(|d| !d.is_empty()) {
        Some(dir) => cmd.cwd(crate::sys::expand_tilde(dir)),
        None => {
            if let Ok(home) = std::env::var("HOME") {
                cmd.cwd(home);
            }
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Capture pgid BEFORE child is moved into the waiter thread.
    // portable-pty calls setsid() in pre_exec, so pid == pgid for the shell.
    let shell_pgid = child.process_id().map(|p| p as i32);
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
            // 64 KiB read buffer (heap-allocated once). A blocking read still
            // returns as soon as *any* data is available, so keystroke-echo
            // latency is unchanged; but under bulk output it drains more of the
            // kernel PTY buffer per syscall, coalescing what would otherwise be
            // several 8 KiB reads into one larger `pty:data` event. Fewer IPC
            // crossings, base64 calls and allocations; byte order/content and
            // arbitrary chunk boundaries are unchanged (already handled downstream).
            let mut buf = vec![0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = STANDARD.encode(&buf[..n]);
                        // Borrow `id` rather than cloning it into every payload.
                        if app.emit("pty:data", PtyData { id: &id, data }).is_err() {
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
            shell_pgid,
            server: ServerCapture::Idle,
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

/// Send SIGHUP to each valid pgid in the provided set, then spawn a detached grace
/// thread that SIGKILLs any straggler after 2 s.
///
/// Guards: every pgid must be `> 1` (never signal init) and `!= getpgrp()` (never
/// signal Aurora's own process group). Deduplicates automatically.
///
/// Accepts a slice of `Option<i32>` so callers can pass shell_pgid / fg / server_pgid
/// all at once without pre-filtering Nones.
fn group_teardown(pgids: &[Option<i32>]) {
    let our_pgid = unsafe { libc::getpgrp() };
    let mut to_kill: Vec<i32> = Vec::new();
    for p in pgids.iter().flatten() {
        if *p > 1 && *p != our_pgid && !to_kill.contains(p) {
            to_kill.push(*p);
        }
    }
    for &p in &to_kill {
        unsafe { libc::killpg(p, libc::SIGHUP); }
    }
    // Detached grace thread: hard-kill anything that survived the HUP.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2_000));
        for &p in &to_kill {
            unsafe { libc::killpg(p, libc::SIGKILL); }
        }
    });
}

/// Kill a session's child process group and forget the session.
///
/// Reads the foreground-job pgid from the master PTY (tcgetpgrp), then calls
/// `group_teardown` with shell_pgid + fg + captured server_pgid (D4 revised).
/// Falls back to `killer.kill()` only when `shell_pgid` is unknown.
/// Dropping `session` at the end closes the master side → kernel SIGHUP to fg group.
#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = manager.sessions.lock().unwrap().remove(&id) {
        let fg = session.master.process_group_leader();
        if session.shell_pgid.is_some() {
            group_teardown(&[session.shell_pgid, fg, session.server.found()]);
        } else {
            // Fallback: no pgid captured, resort to direct SIGKILL of the shell.
            let _ = session.killer.kill();
        }
        // session drops here → master closes → kernel sends SIGHUP to fg group.
    }
    Ok(())
}

/// Pure decision step for the server-pgid sampler.
///
/// Given the current foreground pgid (`fg`) and the shell's pgid (`shell_pgid`),
/// updates the caller's mutable state (`last_non_shell`, `shell_consecutive`) and
/// returns `Some(pgid)` when the sampler should freeze, or `None` to keep sampling.
///
/// Freeze conditions:
///   (a) Foreground has returned to the shell for `settle` consecutive samples **after**
///       at least one non-shell pgid was observed → detached server (or chain finished).
///       The `settle` debounce (default 3 × 40 ms = 120 ms) survives the brief inter-job
///       shell window in `cmd1 && cmd2` chains without triggering a premature freeze on
///       `cmd1`'s pgid — the sampler tracks `cmd2`'s pgid instead.
///   (b) Timeout (handled by the caller) → freeze on `last_non_shell` if any.
///
/// Extracted as a pure function so it can be unit-tested without a real PTY.
fn sampler_step(
    fg: Option<i32>,
    shell_pgid: Option<i32>,
    last_non_shell: &mut Option<i32>,
    shell_consecutive: &mut u32,
    settle: u32,
) -> Option<i32> {
    let is_non_shell = fg.map(|p| p > 1 && Some(p) != shell_pgid).unwrap_or(false);
    if is_non_shell {
        // Track the latest non-shell foreground group (may be cmd1, then cmd2, …).
        *last_non_shell = fg;
        *shell_consecutive = 0;
        None // keep sampling — a later stage may still take the foreground
    } else if let Some(p) = *last_non_shell {
        // Foreground returned to shell after a non-shell job was seen.
        *shell_consecutive += 1;
        if *shell_consecutive >= settle {
            Some(p) // confirmed detach / chain done — freeze on last non-shell pgid
        } else {
            None // debounce: might be the brief inter-job shell window in `cmd1 && cmd2`
        }
    } else {
        None // no non-shell pgid seen yet — keep waiting
    }
}

/// Start a fire-and-forget sampler that captures the server's real process group.
///
/// Marks the session `Pending` immediately and spawns a thread that samples the
/// PTY foreground pgid every ~40 ms for up to ~8 s.
///
/// **Corrected behaviour (was: freeze on first non-shell pgid):**
/// The sampler tracks the *last* non-shell foreground pgid observed (`last_non_shell`)
/// and freezes when:
///   (a) The foreground returns to the shell for `SHELL_SETTLE` (3) consecutive samples
///       after at least one non-shell pgid was seen. This handles both a server that
///       detaches (prompt returns) AND `build && serve` chains where two sequential
///       process groups appear: the brief inter-job shell window (< SHELL_SETTLE samples)
///       does NOT trigger a premature freeze on the build's pgid.
///   (b) Timeout (~8 s) expires — freeze on `last_non_shell` if any (foreground server
///       that never returns the prompt, e.g. a streaming API).
/// On timeout with no distinct job ever observed, records `Failed` → `"uncaptured"`.
///
/// Brief lock hold per sample (lock released before sleep) so `pty_write` is not starved.
/// Returns immediately (fire-and-forget from the front).
#[tauri::command]
pub fn pty_capture_server_pgid(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<(), String> {
    // Mark Pending under the lock (shell_pgid is re-read per-sample in the thread).
    {
        let mut sessions = manager.sessions.lock().unwrap();
        let session = match sessions.get_mut(&id) {
            Some(s) => s,
            None => return Ok(()), // session already gone — no-op
        };
        session.server = ServerCapture::Pending;
    }

    // Spawn the bounded sampler thread (fire-and-forget).
    let id2 = id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);

        // Last distinct non-shell foreground pgid observed across all samples.
        // Updated on every non-shell sample so `build && serve` eventually lands
        // on serve's pgid rather than build's.
        let mut last_non_shell: Option<i32> = None;

        // Counter of consecutive samples where fg == shell_pgid.
        // We require SHELL_SETTLE consecutive shell samples before concluding
        // "returned to shell" to survive the brief inter-job window in `cmd1 && cmd2`.
        let mut shell_consecutive: u32 = 0;

        // 3 × 40 ms = 120 ms — enough debounce for the inter-job shell window
        // (typically < 1 ms); short enough to capture a detached server promptly.
        const SHELL_SETTLE: u32 = 3;

        loop {
            if std::time::Instant::now() >= deadline {
                // Timeout — freeze on the last non-shell pgid seen (case b: a server
                // that stays in the foreground all the time, e.g. a streaming API).
                // If no non-shell pgid was ever observed, mark Failed → block-flag fallback.
                let mgr = app2.state::<PtyManager>();
                let mut sessions = mgr.sessions.lock().unwrap();
                if let Some(s) = sessions.get_mut(&id2) {
                    if matches!(s.server, ServerCapture::Pending) {
                        s.server = match last_non_shell {
                            Some(p) => ServerCapture::Found(p),
                            None    => ServerCapture::Failed,
                        };
                    }
                }
                return;
            }

            // Brief lock: read fg and shell_pgid, then release before sleeping.
            let sample: Option<(Option<i32>, Option<i32>)> = {
                let mgr = app2.state::<PtyManager>();
                let sessions = mgr.sessions.lock().unwrap();
                match sessions.get(&id2) {
                    None => None, // session removed (pane closed mid-capture)
                    Some(s) => {
                        let fg = s.master.process_group_leader();
                        Some((fg, s.shell_pgid))
                    }
                }
                // MutexGuard drops here — lock released before sleep
            };

            match sample {
                None => return, // session gone — exit cleanly
                Some((fg, shell_pgid)) => {
                    if let Some(freeze_pgid) = sampler_step(
                        fg,
                        shell_pgid,
                        &mut last_non_shell,
                        &mut shell_consecutive,
                        SHELL_SETTLE,
                    ) {
                        // Confirmed "returned to shell" — record the captured server pgid.
                        let mgr = app2.state::<PtyManager>();
                        let mut sessions = mgr.sessions.lock().unwrap();
                        if let Some(s) = sessions.get_mut(&id2) {
                            if matches!(s.server, ServerCapture::Pending) {
                                s.server = ServerCapture::Found(freeze_pgid);
                            }
                        }
                        return;
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });

    Ok(())
}

/// Probe whether the captured server process group is still alive (D8 liveness probe).
///
/// Maps the session's `ServerCapture` state to a status string:
/// - No session   → `"dead"`
/// - `Pending`    → `"capturing"` (boot transient; front shows Stop without flashing)
/// - `Found(p)`   → `killpg(p, 0)`: success/EPERM → `"alive"`, ESRCH → `"dead"`
/// - `Failed`/`Idle` → `"uncaptured"` (front falls back to OSC-133 block flag)
///
/// `killpg(pgid, 0)` sends no signal — it only asks the kernel whether the group exists.
#[tauri::command]
pub fn pty_server_status(manager: State<'_, PtyManager>, id: String) -> Result<String, String> {
    // Extract the pgid to probe (if any) while holding the lock briefly.
    let found_pgid: Option<i32> = {
        let sessions = manager.sessions.lock().unwrap();
        let session = match sessions.get(&id) {
            None => return Ok("dead".to_string()),
            Some(s) => s,
        };
        match &session.server {
            ServerCapture::Pending => return Ok("capturing".to_string()),
            ServerCapture::Failed | ServerCapture::Idle => return Ok("uncaptured".to_string()),
            ServerCapture::Found(p) => Some(*p),
        }
        // lock released here before the killpg syscall
    };

    let p = found_pgid.expect("matched Found above");
    let result = unsafe { libc::killpg(p, 0) };
    if result == 0 {
        Ok("alive".to_string())
    } else {
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if errno == libc::ESRCH {
            Ok("dead".to_string())
        } else {
            // EPERM = group exists but we can't signal it → still alive
            Ok("alive".to_string())
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the pure `sampler_step` decision function.
//
// These tests prove the corrected sampler logic without requiring a real PTY or
// shell process. The actual sampler thread (which calls `sampler_step` in a loop)
// cannot be unit-tested without a real PTY; its correctness is established by:
//   1. These tests covering every branch of `sampler_step`,
//   2. The reviewer's runtime measurement (`sleep 0.6 && sleep 5` → two pgids),
//   3. A manual smoke test on a `build && serve` non-split script (follow-up).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::sampler_step;

    const SETTLE: u32 = 3;
    const SHELL: Option<i32> = Some(100);
    const JOB_A: Option<i32> = Some(200);
    const JOB_B: Option<i32> = Some(300);

    /// Helper: feed a slice of `(fg, shell)` samples and return the first freeze pgid.
    fn feed(samples: &[(Option<i32>, Option<i32>)], settle: u32) -> Option<i32> {
        let mut lns = None;
        let mut sc = 0u32;
        for &(fg, sh) in samples {
            if let Some(p) = sampler_step(fg, sh, &mut lns, &mut sc, settle) {
                return Some(p);
            }
        }
        None
    }

    // ── Core properties ──────────────────────────────────────────────────────

    #[test]
    fn returns_none_when_only_shell_seen() {
        // Foreground never leaves the shell — no non-shell pgid ever tracked.
        assert_eq!(feed(&[(SHELL, SHELL); 20], SETTLE), None);
    }

    #[test]
    fn tracks_non_shell_without_freezing_immediately() {
        let mut lns = None;
        let mut sc = 0u32;
        // First non-shell sample: tracked, no freeze yet.
        assert_eq!(sampler_step(JOB_A, SHELL, &mut lns, &mut sc, SETTLE), None);
        assert_eq!(lns, JOB_A);
        assert_eq!(sc, 0);
    }

    #[test]
    fn freezes_after_settle_consecutive_shell_samples() {
        let mut lns = None;
        let mut sc = 0u32;
        // See non-shell once.
        sampler_step(JOB_A, SHELL, &mut lns, &mut sc, SETTLE);
        // settle-1 shell samples: not yet.
        for _ in 0..(SETTLE - 1) {
            assert_eq!(sampler_step(SHELL, SHELL, &mut lns, &mut sc, SETTLE), None);
        }
        // settle-th shell sample: freeze on JOB_A.
        assert_eq!(sampler_step(SHELL, SHELL, &mut lns, &mut sc, SETTLE), Some(200));
    }

    // ── The key regression: `build && serve` (two sequential pgids) ──────────

    #[test]
    fn build_then_serve_freezes_on_serve_not_build() {
        // build_pgid → shell (1 brief sample) → serve_pgid → shell×3 → freeze on serve
        let samples: &[(Option<i32>, Option<i32>)] = &[
            (JOB_A, SHELL), // build starts
            (JOB_A, SHELL), // build running
            (SHELL, SHELL), // build done — brief shell window (1 sample)
            (JOB_B, SHELL), // serve starts (resets counter, updates last_non_shell)
            (JOB_B, SHELL), // serve running
            (SHELL, SHELL), // serve detaches — shell+1
            (SHELL, SHELL), // shell+2
            (SHELL, SHELL), // shell+3 → freeze
        ];
        assert_eq!(feed(samples, SETTLE), Some(300)); // serve's pgid, NOT build's
    }

    #[test]
    fn inter_job_shell_window_does_not_trigger_premature_freeze() {
        // The brief shell window between build and serve (1-2 samples) must NOT
        // freeze the sampler on build's pgid — we wait for SETTLE consecutive samples.
        let samples: &[(Option<i32>, Option<i32>)] = &[
            (JOB_A, SHELL), // build
            (SHELL, SHELL), // brief shell — sc=1 (< SETTLE=3), no freeze
            (SHELL, SHELL), // sc=2, still no freeze
            (JOB_B, SHELL), // serve takes over → reset sc, update last_non_shell=JOB_B
        ];
        // After the 4 samples, no freeze yet (serve just started, hasn't detached).
        assert_eq!(feed(samples, SETTLE), None);
    }

    #[test]
    fn resets_shell_consecutive_when_new_non_shell_arrives() {
        let mut lns = None;
        let mut sc = 0u32;
        sampler_step(JOB_A, SHELL, &mut lns, &mut sc, SETTLE); // see job A
        sampler_step(SHELL, SHELL, &mut lns, &mut sc, SETTLE); // sc=1
        sampler_step(SHELL, SHELL, &mut lns, &mut sc, SETTLE); // sc=2
        // Job B starts before settle — resets sc and updates last_non_shell.
        assert_eq!(sampler_step(JOB_B, SHELL, &mut lns, &mut sc, SETTLE), None);
        assert_eq!(lns, JOB_B);
        assert_eq!(sc, 0);
    }

    // ── Foreground server (api-style — stays foreground until timeout) ────────

    #[test]
    fn timeout_path_would_freeze_on_last_non_shell() {
        // Simulate what the timeout branch does: last_non_shell is set, never returns to shell.
        let mut lns = None;
        let mut sc = 0u32;
        for _ in 0..100 {
            sampler_step(JOB_A, SHELL, &mut lns, &mut sc, SETTLE);
        }
        // Caller (timeout branch) checks lns directly — should be JOB_A.
        assert_eq!(lns, JOB_A);
    }

    // ── Guards: shell pgid and pid 1 are never captured ──────────────────────

    #[test]
    fn never_captures_shell_pgid() {
        let mut lns = None;
        let mut sc = 0u32;
        for _ in 0..20 {
            sampler_step(SHELL, SHELL, &mut lns, &mut sc, SETTLE);
        }
        assert_eq!(lns, None);
    }

    #[test]
    fn never_captures_pgid_1_init() {
        // pgid 1 = init — the `p > 1` guard must reject it.
        let mut lns = None;
        let mut sc = 0u32;
        sampler_step(Some(1), SHELL, &mut lns, &mut sc, SETTLE);
        assert_eq!(lns, None);
    }

    #[test]
    fn never_captures_none_fg() {
        let mut lns = None;
        let mut sc = 0u32;
        sampler_step(None, SHELL, &mut lns, &mut sc, SETTLE);
        assert_eq!(lns, None);
    }

    // ── Detached server (welcomer / nx — returns prompt immediately) ──────────

    #[test]
    fn detached_server_freezes_after_settle_post_detach() {
        // welcomer_pgid → then shell for SETTLE samples → freeze on welcomer_pgid
        let samples: &[(Option<i32>, Option<i32>)] = &[
            (JOB_A, SHELL), // welcomer starts
            (SHELL, SHELL), // shell+1 (detached)
            (SHELL, SHELL), // shell+2
            (SHELL, SHELL), // shell+3 → freeze
        ];
        assert_eq!(feed(samples, SETTLE), Some(200)); // welcomer's pgid
    }
}
