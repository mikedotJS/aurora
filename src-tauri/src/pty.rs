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
    /// Controlling-tty device (`st_rdev` of this pane's pty slave), captured at
    /// spawn. Child processes that keep the pane as their controlling terminal —
    /// including a backgrounded `nx serve --no-tui` server that returned the
    /// prompt — report this same value in `proc_bsdinfo.e_tdev`, so it drives the
    /// tier-4 running scan (`tty_has_foreign_process`) when the captured pgid dies.
    /// `None` if `ptsname`/`stat` failed at spawn (scan then simply no-ops).
    tty_dev: Option<u32>,
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
            let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
    // Controlling-tty device of this pane (slave st_rdev), for the tier-4 running
    // scan. Read from the still-open master fd before the master is moved into the
    // session; `None` is a harmless no-op for the scan.
    let tty_dev = pair.master.as_raw_fd().and_then(tty_dev_of_master);
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

    manager.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(
        id.clone(),
        PtySession {
            writer,
            master: pair.master,
            killer,
            shell_pgid,
            server: ServerCapture::Idle,
            tty_dev,
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
    let mut sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
    if let Some(mut session) = manager.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
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
/// Pure predicate: `fg` is a real process group (`> 1`, never init) distinct
/// from the shell's own pgid — i.e. a foreground child is holding the tty.
/// Shared by the sampler (`sampler_step`) and `pty_foreground_state` (the
/// generic per-pane "is something running in the foreground" check) so the
/// two call sites can never drift on the definition of "non-shell".
fn fg_is_non_shell(fg: Option<i32>, shell_pgid: Option<i32>) -> bool {
    fg.map(|p| p > 1 && Some(p) != shell_pgid).unwrap_or(false)
}

fn sampler_step(
    fg: Option<i32>,
    shell_pgid: Option<i32>,
    last_non_shell: &mut Option<i32>,
    shell_consecutive: &mut u32,
    settle: u32,
) -> Option<i32> {
    let is_non_shell = fg_is_non_shell(fg, shell_pgid);
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

/// Pure decision: should a fresh `pty_capture_server_pgid` call re-arm the
/// session's capture state to `Pending` (restarting the sampler)?
///
/// Code-review fix (#1, MAJEUR): the caller re-invokes this command on EVERY
/// submitted line (see `src/lib/keymap.ts`'s `runInShell`), not just once at
/// launch. Before this guard, a second command submitted while a prior
/// `Found(pgid)` capture was still alive got unconditionally reset to
/// `Pending` — clobbering the only handle Stop/⌘Q/Ctrl+C have on the detached
/// server. Returns `false` (do not re-arm — keep the existing capture) only
/// when the current state is `Found` AND the caller has confirmed (via a
/// liveness probe taken under the same lock) that the captured pgid is still
/// alive. Returns `true` (arm/re-arm) for every other case: `Idle`, `Pending`
/// (already sampling — resetting it just restarts the same 8 s window
/// harmlessly), `Failed`, or `Found` with a pgid that's since died (the
/// process no longer holds that group, so recapturing is exactly right).
fn should_rearm(current: &ServerCapture, found_and_alive: bool) -> bool {
    !(matches!(current, ServerCapture::Found(_)) && found_and_alive)
}

/// Liveness probe for a captured process group: `killpg(pgid, 0)` sends no signal,
/// it only asks the kernel whether the group exists. `Ok(())` (0) means the group
/// exists and we can signal it. `EPERM` also means the group exists — we merely
/// lack permission to signal it (can legitimately happen for a re-parented/setuid
/// descendant) — so it counts as alive too. Any other errno (chiefly `ESRCH`)
/// means the group is gone.
///
/// Single source of truth for this decision so `should_rearm`'s caller and
/// `pty_server_status` can never drift on what "alive" means for a captured pgid.
fn pgid_alive(pgid: i32) -> bool {
    if unsafe { libc::killpg(pgid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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
    // Mark Pending under the lock (shell_pgid is re-read per-sample in the thread) —
    // UNLESS a still-alive `Found(pgid)` capture is already in place (see
    // `should_rearm`), in which case this call is a no-op that keeps the
    // existing capture instead of resetting it and spawning a redundant
    // sampler thread.
    {
        let mut sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = match sessions.get_mut(&id) {
            Some(s) => s,
            None => return Ok(()), // session already gone — no-op
        };
        let found_and_alive = match session.server {
            ServerCapture::Found(p) => pgid_alive(p),
            _ => false,
        };
        if !should_rearm(&session.server, found_and_alive) {
            return Ok(()); // still-alive capture in place — keep it, don't re-sample
        }
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
                let mut sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
                let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
                        let mut sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
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

/// `PROC_ALL_PIDS` from `<sys/proc_info.h>` — the `proc_listpids` selector for
/// "every pid". Not exported by the `libc` crate, so defined here.
const PROC_ALL_PIDS: u32 = 1;

/// Resolve the controlling-tty device (`st_rdev` of the pty **slave**) for an open
/// master fd, via `ptsname` + `stat`. Child processes that keep this pane as their
/// controlling terminal report this same value in `proc_bsdinfo.e_tdev`.
///
/// `None` on any failure (null `ptsname`, `stat` error) — the caller treats an
/// absent tty_dev as "no scan possible", never as "nothing running".
fn tty_dev_of_master(master_fd: libc::c_int) -> Option<u32> {
    unsafe {
        let name = libc::ptsname(master_fd);
        if name.is_null() {
            return None;
        }
        let mut st: libc::stat = std::mem::zeroed();
        if libc::stat(name, &mut st) != 0 {
            return None;
        }
        Some(st.st_rdev as u32)
    }
}

/// Per-process predicate for the tier-4 tty scan: a process counts as a live
/// "foreign" occupant of the pane when it shares the pane's controlling-tty
/// device (`e_tdev`) AND is not the pane's own shell. Extracted as a pure
/// function (mirrors `fg_is_non_shell`) so the decision is unit-testable without
/// a live process table.
fn is_foreign_tty_process(pid: i32, e_tdev: u32, tty_dev: u32, shell_pid: Option<i32>) -> bool {
    pid > 0 && Some(pid) != shell_pid && e_tdev == tty_dev
}

/// Tier-4 running signal: scan the process table for any **non-shell** process
/// that still holds this pane's controlling terminal (`e_tdev == tty_dev`).
///
/// This catches a detached server that the tcgetpgrp-based sampler can't freeze
/// on — e.g. `nx serve --no-tui`, which returns the prompt and re-parents its
/// server into its own process group while keeping the pane as the controlling
/// tty (that's why its logs keep streaming into the pane). The captured pgid is
/// then dead, but the server is very much alive; matching on the controlling tty
/// finds it regardless of pgid or parent.
///
/// Uses libproc (`proc_listpids` + `proc_pidinfo(PROC_PIDTBSDINFO)`). Called from
/// `pty_server_status` only when the captured pgid is gone, so idle/never-armed
/// panes never pay for the scan.
fn tty_has_foreign_process(tty_dev: u32, shell_pid: Option<i32>) -> bool {
    !foreign_tty_pgids(tty_dev, shell_pid).is_empty()
}

/// Collect the distinct **process groups** of every non-shell process that still
/// holds this pane's controlling terminal (`e_tdev == tty_dev`). Superset of
/// `tty_has_foreign_process` (which is just "is this non-empty?"): it also
/// returns the pgids so `pty_signal_server` can signal a detached job that was
/// never captured by the sampler.
///
/// The distinction matters for a job that backgrounds itself *immediately*
/// (`sleep 60 &!`, `cmd & disown`, and the nx `--no-tui` case): the job never
/// takes the PTY foreground, so the tcgetpgrp-based capture sampler
/// (`pty_capture_server_pgid`) never observes a non-shell foreground pgid to
/// freeze on — `server.found()` stays `None`. But the job DOES keep the pane's
/// controlling tty (that's how the badge lights up via `tty_has_foreign_process`
/// / `pty_server_status` → "alive"). Scanning the tty for its live pgid gives
/// Ctrl+C a real target where the capture path had none. Verified at the OS
/// level: `killpg(that_pgid, SIGINT)` reaps a `sleep 60 &!` on a real PTY.
///
/// Uses each process's own `pbi_pgid` (its real process group), so a group is
/// signalled once regardless of how many members share it, and never the shell's.
fn foreign_tty_pgids(tty_dev: u32, shell_pid: Option<i32>) -> Vec<i32> {
    let mut pgids: Vec<i32> = Vec::new();
    unsafe {
        // First call: how many bytes of pids are there? (buffer = null → size query)
        let cap = libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0);
        if cap <= 0 {
            return pgids;
        }
        let slots = cap as usize / std::mem::size_of::<libc::pid_t>();
        // Headroom for processes that appear between the two calls.
        let mut pids = vec![0 as libc::pid_t; slots + 16];
        let got = libc::proc_listpids(
            PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr() as *mut libc::c_void,
            (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
        );
        if got <= 0 {
            return pgids;
        }
        let n = got as usize / std::mem::size_of::<libc::pid_t>();
        for &pid in &pids[..n] {
            if pid <= 0 || Some(pid) == shell_pid {
                continue;
            }
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let sz = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int,
            );
            // A short read means the pid died mid-scan or we lack access — skip it.
            if sz as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
                continue;
            }
            if !is_foreign_tty_process(pid, info.e_tdev, tty_dev, shell_pid) {
                continue;
            }
            // Never signal the shell's own group, even if the shell shares the
            // tty (it always does), nor Aurora's own process group — mirrors the
            // guard `group_teardown`/`kill_all` already apply (defense in depth;
            // Aurora's own pgid should never share a pane's controlling tty in
            // practice, but this keeps all four kill paths aligned). Use the
            // process's real pgid (`pbi_pgid`).
            let pgid = info.pbi_pgid as i32;
            let our_pgid = libc::getpgrp();
            if pgid > 1 && Some(pgid) != shell_pid && pgid != our_pgid && !pgids.contains(&pgid) {
                pgids.push(pgid);
            }
        }
    }
    pgids
}

/// Probe whether the pane still has a live server (D8 liveness probe + tier-4 scan).
///
/// Maps the session's `ServerCapture` state to a status string:
/// - No session   → `"dead"`
/// - `Pending`    → `"capturing"` (boot transient; front shows Stop without flashing)
/// - `Idle`       → `"uncaptured"` (capture never armed — no server flow ran here)
/// - `Found(p)`   → `killpg(p, 0)`: success/EPERM → `"alive"`, ESRCH → fall to scan
/// - `Failed`, or `Found` whose group has died → tier-4 controlling-tty scan:
///     a non-shell process still on the pane's tty → `"alive"`, else the honest
///     fallback (`"dead"` for a dead capture, `"uncaptured"` for a failed one).
///
/// The scan runs *only* after the cheap `killpg` probe reports the captured group
/// gone (or when capture failed outright), so healthy captures and idle panes stay
/// on the fast path. `killpg(pgid, 0)` sends no signal — it only asks the kernel
/// whether the group exists.
#[tauri::command]
pub fn pty_server_status(manager: State<'_, PtyManager>, id: String) -> Result<String, String> {
    // Snapshot the pgid to probe plus the tty_dev/shell_pid the scan needs, under
    // the lock. `Idle` short-circuits: capture was never armed, so there's no
    // detached-server flow to look for — skip the scan entirely.
    let (found_pgid, tty_dev, shell_pid): (Option<i32>, Option<u32>, Option<i32>) = {
        let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = match sessions.get(&id) {
            None => return Ok("dead".to_string()),
            Some(s) => s,
        };
        match &session.server {
            ServerCapture::Pending => return Ok("capturing".to_string()),
            ServerCapture::Idle => return Ok("uncaptured".to_string()),
            ServerCapture::Failed => (None, session.tty_dev, session.shell_pgid),
            ServerCapture::Found(p) => (Some(*p), session.tty_dev, session.shell_pgid),
        }
        // lock released here before any syscall
    };

    // Fast path: a captured group that still exists (or exists but we lack
    // permission to signal it) is unambiguously alive. See `pgid_alive`.
    if let Some(p) = found_pgid {
        if pgid_alive(p) {
            return Ok("alive".to_string());
        }
        // Gone (ESRCH) — fall through to the tier-4 tty scan.
    }

    // Tier 4: a detached server nx re-parented off the captured pgid may still
    // hold this pane's tty. Scan for it before conceding "dead"/"uncaptured".
    if let Some(dev) = tty_dev {
        if tty_has_foreign_process(dev, shell_pid) {
            return Ok("alive".to_string());
        }
    }

    Ok(if found_pgid.is_some() {
        "dead".to_string() // had a capture, its group is gone, tty is clear
    } else {
        "uncaptured".to_string() // capture failed and tty is clear → OSC-133 fallback
    })
}

/// Returned by `pty_foreground_state` — generic per-pane "is a foreground
/// child running" signal, tier 1 of the sticky-running-server-tabs combined
/// running check (see `src/lib/running.ts` on the front for tiers 2/3).
#[derive(Serialize)]
pub struct ForegroundState {
    running: bool,
    pgid: Option<i32>,
}

/// Report whether the pane's PTY foreground process group currently differs
/// from its shell's — i.e. some child (vite, next dev, npm install, …) holds
/// the tty foreground right now. Command-agnostic: reads `tcgetpgrp` of the
/// PTY master via `process_group_leader()`, the same primitive `pty_kill` and
/// the capture sampler already rely on. No new state — pure readback.
#[tauri::command]
pub fn pty_foreground_state(manager: State<'_, PtyManager>, id: String) -> Result<ForegroundState, String> {
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = match sessions.get(&id) {
        None => return Ok(ForegroundState { running: false, pgid: None }),
        Some(s) => s,
    };
    let fg = session.master.process_group_leader();
    let running = fg_is_non_shell(fg, session.shell_pgid);
    Ok(ForegroundState { running, pgid: fg })
}

/// Signal the session's *captured* server process group directly — used for
/// Ctrl+C when the PTY foreground has already returned to the shell (a
/// detached server, e.g. `nx serve --no-tui`) so a raw `\x03` would hit the
/// shell instead of the real target. Reuses the exact group `pty_kill` and
/// `kill_all` already reap via `group_teardown` (D4/D7/D8) — just a single
/// signal instead of the SIGHUP→SIGKILL teardown sequence.
///
/// Guarded by a fresh `killpg(pgid, 0)` liveness probe immediately before
/// signalling (mirrors `pty_server_status`): never signals a pgid that isn't
/// confirmed alive right now, closing (most of) the recycled-pgid TOCTOU
/// window called out in the proposal. Returns `Ok(false)` — not an error —
/// when there is nothing live to signal (Idle/Pending/Failed capture, no
/// session, or the captured pgid is already dead), so the caller can surface
/// an honest "couldn't reach it" instead of a false "stopped".
///
/// Code-review fix (#4, mineur): `signal` arrives from the front end as a
/// plain `i32` — don't trust it blind before handing it to `killpg`. Rejected
/// with `Ok(false)` (same "couldn't reach it" honesty contract as the other
/// no-op branches here) unless it's one of the signals this feature actually
/// needs: `SIGINT` (Ctrl+C, the only value the front currently sends —
/// `src/lib/keymap.ts`'s `routeCtrlC`), plus `SIGTERM`/`SIGHUP` kept as
/// graceful-shutdown headroom (mirrors the SIGHUP already used by
/// `group_teardown`/`kill_all`). Deliberately excludes `SIGKILL` and anything
/// else — a hard kill has its own dedicated, already-guarded path
/// (`pty_kill`/`kill_all`); this command is Ctrl+C-shaped, not a generic
/// "send any signal to any captured pgid" primitive.
fn is_allowed_server_signal(signal: i32) -> bool {
    matches!(signal, libc::SIGINT | libc::SIGTERM | libc::SIGHUP)
}

#[tauri::command]
pub fn pty_signal_server(manager: State<'_, PtyManager>, id: String, signal: i32) -> Result<bool, String> {
    if !is_allowed_server_signal(signal) {
        return Ok(false); // not an allowlisted signal — refuse, don't forward blindly to killpg
    }
    // Snapshot the captured pgid plus the tty_dev/shell_pid the fallback scan
    // needs, under the lock; release it before any syscall.
    let (found_pgid, tty_dev, shell_pid): (Option<i32>, Option<u32>, Option<i32>) = {
        let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(&id) {
            None => return Ok(false),
            Some(s) => (s.server.found(), s.tty_dev, s.shell_pgid),
        }
        // lock released here before the killpg syscalls below
    };

    // Fast path: a captured group that's still alive is the target (foreground
    // server that detached, or a `build && serve` chain the sampler froze on).
    // `pgid != getpgrp()` mirrors the guard `group_teardown`/`kill_all`/
    // `foreign_tty_pgids` already apply — defense in depth; a captured server
    // pgid should never equal Aurora's own in practice.
    if let Some(pgid) = found_pgid {
        if pgid != unsafe { libc::getpgrp() } && unsafe { libc::killpg(pgid, 0) } == 0 {
            unsafe { libc::killpg(pgid, signal); }
            return Ok(true);
        }
        // ESRCH/gone — fall through to the tty scan (the process may have
        // re-parented off the captured pgid, nx-style, and still be alive).
    }

    // Fallback: no live captured pgid. A job that backgrounded itself before the
    // sampler ever saw it take the foreground (`sleep 60 &!`, `cmd & disown`, nx
    // `--no-tui`) leaves `server.found()` None, yet still holds this pane's tty —
    // which is exactly why the badge lit up (tier-4 `tty_has_foreign_process`).
    // Signal the live process group(s) still on the pane's tty so Ctrl+C reaches
    // the detached job the capture path couldn't, honestly reporting failure only
    // when the tty is genuinely clear.
    let dev = match tty_dev {
        Some(d) => d,
        None => return Ok(false), // no tty to scan — nothing to reach
    };
    let mut signalled = false;
    for pgid in foreign_tty_pgids(dev, shell_pid) {
        if unsafe { libc::killpg(pgid, 0) } == 0 {
            unsafe { libc::killpg(pgid, signal); }
            signalled = true;
        }
    }
    Ok(signalled)
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
    use super::{
        fg_is_non_shell, is_allowed_server_signal, is_foreign_tty_process, sampler_step,
        should_rearm, ServerCapture,
    };

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

    // ── fg_is_non_shell — the `pty_foreground_state` running predicate ───────
    // (phase 0/1 of sticky-running-server-tabs: "fg != shell && fg > 1")

    #[test]
    fn fg_is_non_shell_true_when_distinct_and_above_1() {
        assert!(fg_is_non_shell(Some(200), Some(100)));
    }

    #[test]
    fn fg_is_non_shell_false_when_fg_equals_shell() {
        assert!(!fg_is_non_shell(Some(100), Some(100)));
    }

    #[test]
    fn fg_is_non_shell_false_when_fg_is_none() {
        assert!(!fg_is_non_shell(None, Some(100)));
    }

    #[test]
    fn fg_is_non_shell_false_for_pgid_1_init() {
        assert!(!fg_is_non_shell(Some(1), Some(100)));
    }

    #[test]
    fn fg_is_non_shell_false_when_shell_pgid_unknown_and_fg_present() {
        // shell_pgid None (should not happen in practice) — Some(p) != None is
        // true, so a real fg pgid still counts as non-shell (fail open toward
        // "running" rather than silently under-reporting).
        assert!(fg_is_non_shell(Some(200), None));
    }

    // ── should_rearm — code-review fix #1 (MAJEUR): relaunching a command must
    // NOT clobber a still-alive `Found(pgid)` capture ────────────────────────

    #[test]
    fn should_rearm_false_for_a_still_alive_found_capture() {
        // This is the exact regression: resubmitting a command while a prior
        // detached server's capture is confirmed alive must NOT re-arm to
        // Pending — that would lose the only kill target Ctrl+C/Stop have.
        assert!(!should_rearm(&ServerCapture::Found(4242), true));
    }

    #[test]
    fn should_rearm_true_for_a_found_capture_whose_pgid_has_died() {
        // The captured group is gone (liveness probe says dead) — safe, and
        // correct, to recapture.
        assert!(should_rearm(&ServerCapture::Found(4242), false));
    }

    #[test]
    fn should_rearm_true_for_idle() {
        assert!(should_rearm(&ServerCapture::Idle, false));
    }

    #[test]
    fn should_rearm_true_for_pending() {
        // Resetting an in-flight sampler is harmless — it just restarts the
        // same bounded 8s window.
        assert!(should_rearm(&ServerCapture::Pending, false));
    }

    #[test]
    fn should_rearm_true_for_failed() {
        assert!(should_rearm(&ServerCapture::Failed, false));
    }

    // ── is_foreign_tty_process — tier-4 running scan predicate (sticky-running-
    // server-tabs): a detached server on the pane's tty must count as running,
    // the pane's own shell must not ────────────────────────────────────────────

    const TTY: u32 = 0x1600_0003; // arbitrary st_rdev-shaped device number

    #[test]
    fn foreign_tty_true_for_non_shell_process_on_same_tty() {
        // A detached server (pid 4242) sharing the pane's tty → running.
        assert!(is_foreign_tty_process(4242, TTY, TTY, Some(100)));
    }

    #[test]
    fn foreign_tty_false_for_the_pane_shell_itself() {
        // The shell shares the tty but must never be counted as "a server running".
        assert!(!is_foreign_tty_process(100, TTY, TTY, Some(100)));
    }

    #[test]
    fn foreign_tty_false_for_a_process_on_a_different_tty() {
        // Same-named but different device (another pane / another terminal).
        assert!(!is_foreign_tty_process(4242, 0x1600_0009, TTY, Some(100)));
    }

    #[test]
    fn foreign_tty_false_for_a_process_with_no_controlling_tty() {
        // A daemon with e_tdev == 0 (no controlling terminal) must not match a
        // real pane whose tty_dev is non-zero.
        assert!(!is_foreign_tty_process(4242, 0, TTY, Some(100)));
    }

    #[test]
    fn foreign_tty_false_for_invalid_pid() {
        assert!(!is_foreign_tty_process(0, TTY, TTY, Some(100)));
        assert!(!is_foreign_tty_process(-1, TTY, TTY, Some(100)));
    }

    #[test]
    fn foreign_tty_true_when_shell_pid_unknown() {
        // shell_pgid None (should not happen in practice) — a real process on the
        // tty still counts, failing open toward "running" (parity with
        // fg_is_non_shell_false_when_shell_pgid_unknown_and_fg_present).
        assert!(is_foreign_tty_process(4242, TTY, TTY, None));
    }

    // ── is_allowed_server_signal — code-review fix #4 (mineur): killpg must
    // never receive an unvalidated signal number straight from the front end ──

    #[test]
    fn allows_sigint_sigterm_sighup() {
        assert!(is_allowed_server_signal(libc::SIGINT));
        assert!(is_allowed_server_signal(libc::SIGTERM));
        assert!(is_allowed_server_signal(libc::SIGHUP));
    }

    #[test]
    fn rejects_sigkill_and_arbitrary_signal_numbers() {
        assert!(!is_allowed_server_signal(libc::SIGKILL));
        assert!(!is_allowed_server_signal(0));
        assert!(!is_allowed_server_signal(-1));
        assert!(!is_allowed_server_signal(9999));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-PTY integration tests (task 7.2/7.3/7.4 backend halves).
//
// The `#[tauri::command]` fns (`pty_foreground_state`, `pty_signal_server`, …)
// take `State<'_, PtyManager>` / `AppHandle` and can't be called directly
// without a running Tauri app (the `tauri` dependency here has no `test`
// feature enabled — see Cargo.toml — so `tauri::test::mock_app()` isn't
// available). Rather than change the build to get a fake AppHandle, these
// tests exercise the *real* OS primitives those commands wrap —
// `native_pty_system()`, `process_group_leader()` (tcgetpgrp), `killpg` — via
// a real spawned shell on a real PTY, and the same `fg_is_non_shell` /
// `is_allowed_server_signal` predicates the commands call. This proves the
// underlying mechanism against the live kernel (not a mock), which is the
// part that can't be faked; it does not exercise the `#[tauri::command]`
// plumbing itself (state lookup, JSON (de)serialization) — that layer is thin
// (see `pty_foreground_state`/`pty_signal_server` bodies, ~10 lines each) and
// remains a real-app / manual-check gap, called out honestly in tasks.md.
#[cfg(test)]
mod real_pty_tests {
    use super::{fg_is_non_shell, is_allowed_server_signal};
    use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// A live test session: the PTY master, the shell's pgid, a writer taken
    /// once up front (portable-pty's `take_writer()` can only be called once
    /// per master — see `UnixMasterPty::took_writer` in portable-pty's source),
    /// and the continuously-drained output buffer (see the drain-thread note
    /// on `spawn_shell` below).
    struct Session {
        master: Box<dyn MasterPty + Send>,
        shell_pgid: i32,
        writer: Box<dyn Write + Send>,
        output: Arc<Mutex<Vec<u8>>>,
        /// Controlling-tty device of this pane's slave — same value `pty_spawn`
        /// records, so the tier-4 tty scan (`foreign_tty_pgids`) can be exercised.
        tty_dev: Option<u32>,
    }

    /// Spawn `/bin/zsh` (Aurora's default shell) on a fresh PTY, mirroring
    /// `pty_spawn`'s setup (same size, same setsid-via-portable-pty behavior
    /// giving pid == pgid for the shell).
    ///
    /// Debugging note (this is why the drain thread exists, not optional):
    /// an early version of these tests returned an *undrained* reader and hit
    /// every foreground-detection assertion below — `sleep 30`'s pgid never
    /// appeared, even though a real spawned shell run separately (`cargo run
    /// --example debug_probe`, deleted after use, same setup) DID see it
    /// within ~100ms. The difference was output drainage: with nobody reading
    /// the PTY master side, the kernel's small tty output buffer fills once
    /// zsh writes its prompt/echo, and the shell's own `write()` to the slave
    /// blocks — stalling it *before* it forks `sleep` at all, so
    /// `tcgetpgrp` never sees anything but the shell's own pgid. Exactly the
    /// same reason `pty_spawn` runs a permanent reader thread in production
    /// (`src-tauri/src/pty.rs`, the `pty:data` reader thread) — a PTY master
    /// must always be drained, in tests as much as in the real app.
    fn spawn_shell() -> Session {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env("TERM", "xterm-256color");
        cmd.arg("--no-rcs"); // skip .zshrc — deterministic, fast prompt, no user config surprises
        let child = pair.slave.spawn_command(cmd).expect("spawn zsh");
        let shell_pgid = child.process_id().expect("pid") as i32;
        // Capture the controlling-tty device before the slave is dropped, the
        // same way `pty_spawn` does — this is what the tier-4 scan matches on.
        let tty_dev = pair.master.as_raw_fd().and_then(super::tty_dev_of_master);
        drop(pair.slave);

        let writer = pair.master.take_writer().expect("take_writer (once per master)");
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let output: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let output = output.clone();
            std::thread::spawn(move || {
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => return, // PTY closed (test's killpg cleanup) — drain thread exits
                        Ok(n) => output.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]),
                    }
                }
            });
        }

        // Leak the child handle deliberately (test-only): we tear the process
        // group down ourselves via killpg on shell_pgid at the end of each
        // test, which is more representative of what Aurora actually does
        // (group_teardown) than child.kill().
        std::mem::forget(child);
        Session { master: pair.master, shell_pgid, writer, output, tty_dev }
    }

    /// Write a line + newline to the shell's PTY.
    fn send_line(session: &mut Session, line: &str) {
        session.writer.write_all(format!("{line}\n").as_bytes()).expect("write");
        session.writer.flush().expect("flush");
    }

    /// Poll `process_group_leader()` until `pred` is satisfied or `timeout` elapses.
    /// Returns the last observed value (satisfying or not) so assertions give a
    /// useful failure message instead of "timed out, no info".
    fn wait_for(
        session: &Session,
        timeout: Duration,
        mut pred: impl FnMut(Option<i32>) -> bool,
    ) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        let mut last = session.master.process_group_leader();
        while Instant::now() < deadline {
            last = session.master.process_group_leader();
            if pred(last) {
                return last;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        last
    }

    /// Poll the continuously-drained output buffer until a line containing
    /// `marker` followed by a pgid is seen, or `timeout` elapses.
    ///
    /// Debugging note: the PTY has local echo on, so the shell echoes back the
    /// *typed* command (`echo DETACH_PGID_MARKER $!`) before it ever runs it —
    /// the marker text therefore appears TWICE in the buffer: once in the
    /// harmless echoed command line (`marker` immediately followed by ` $!`,
    /// which has no digits — parsing that occurrence as a pgid always fails)
    /// and once in the real `echo` output (`marker` followed by the actual
    /// digits). Using `find` (first occurrence) matched the echoed command
    /// line, found no digits after it, and silently gave up on that whole
    /// buffer snapshot instead of checking the real occurrence — search from
    /// the END (`rfind`) so we always land on the most recent, already-
    /// substituted occurrence.
    fn wait_for_marker_pgid(session: &Session, marker: &str, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            {
                let buf = session.output.lock().unwrap_or_else(|e| e.into_inner());
                let text = String::from_utf8_lossy(&buf);
                if let Some(pos) = text.rfind(marker) {
                    let rest = &text[pos + marker.len()..];
                    let digits: String = rest
                        .chars()
                        .skip_while(|c| c.is_whitespace())
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    if let Ok(pgid) = digits.parse::<i32>() {
                        return Some(pgid);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        None
    }

    /// 7.2 — foreground server: while `sleep 30` runs in the foreground, the PTY's
    /// foreground pgid must be a real, distinct-from-shell group (`fg_is_non_shell`
    /// true) — this is exactly what `pty_foreground_state` reports as `running: true`.
    #[test]
    fn foreground_child_reports_running_via_real_tcgetpgrp() {
        let mut session = spawn_shell();
        let shell_pgid = session.shell_pgid;

        // Let the shell settle to its own prompt first.
        wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));

        send_line(&mut session, "sleep 30");

        let fg = wait_for(&session, Duration::from_secs(3), |fg| {
            fg_is_non_shell(fg, Some(shell_pgid))
        });
        assert!(
            fg_is_non_shell(fg, Some(shell_pgid)),
            "expected a distinct foreground pgid for `sleep 30`, got {fg:?} (shell={shell_pgid})"
        );
        let sleep_pgid = fg.expect("sleep pgid");
        assert_ne!(sleep_pgid, shell_pgid);

        // Kill it directly (simulates group_teardown's SIGHUP path) and confirm the
        // foreground reverts to the shell — proving `sleep_pgid` really was the
        // `sleep` job's group, not a stale/unrelated pgid.
        unsafe { libc::killpg(sleep_pgid, libc::SIGHUP) };
        let fg_after = wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));
        assert_eq!(fg_after, Some(shell_pgid), "foreground should return to the shell once sleep is killed");

        unsafe { libc::killpg(shell_pgid, libc::SIGKILL) };
    }

    /// 7.2 — Ctrl+C on a foreground child: sending SIGINT to the PTY foreground
    /// group (what a raw `\x03` byte does at the tty driver level) actually kills
    /// `sleep 30` and the foreground reverts to the shell — proving the "keep
    /// writing \x03" branch of the Ctrl+C routing decision is not a leap of faith.
    #[test]
    fn sigint_to_foreground_group_kills_it_and_running_flips_false() {
        let mut session = spawn_shell();
        let shell_pgid = session.shell_pgid;
        wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));

        send_line(&mut session, "sleep 30");
        let fg = wait_for(&session, Duration::from_secs(3), |fg| {
            fg_is_non_shell(fg, Some(shell_pgid))
        });
        let sleep_pgid = fg.expect("sleep should be foreground");
        assert!(fg_is_non_shell(Some(sleep_pgid), Some(shell_pgid)));

        // SIGINT the foreground group — the real signal `\x03` triggers via the tty
        // driver's ISIG handling, but sending it directly to the pgid is the same
        // delivery path Aurora relies on for a foreground child.
        unsafe { libc::killpg(sleep_pgid, libc::SIGINT) };

        let fg_after = wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));
        assert_eq!(fg_after, Some(shell_pgid), "SIGINT must kill `sleep 30` and return the shell to the foreground");
        assert!(!fg_is_non_shell(fg_after, Some(shell_pgid)), "running must flip false after SIGINT");

        unsafe { libc::killpg(shell_pgid, libc::SIGKILL) };
    }

    /// 7.3 — detached server emulation: `sleep 30 & disown` (the macOS-native
    /// equivalent of nx's detach — Linux `setsid` isn't available on macOS; this
    /// exact pattern is what `design.md`'s task-0.2 manual verification used) backgrounds
    /// a job into its own pgid and returns the prompt. The foreground reverts to the
    /// shell (tier 1 sees "not running") while the backgrounded pgid stays alive
    /// (what tier 2's capture+liveness probe is for) — then `pty_signal_server`'s
    /// real mechanism (a fresh `killpg(pgid, 0)` liveness check + `killpg(pgid, SIGINT)`)
    /// actually reaches and kills it.
    ///
    /// Debugging note: an earlier version wrapped this in a subshell —
    /// `(sleep 30 &) ; disown` — which fails silently: the subshell backgrounds
    /// `sleep` in *its own* job table, so the parent shell's `disown` finds "no
    /// current job" (confirmed manually: `zsh --no-rcs -c '(sleep 2 &); disown;
    /// echo $!'` prints `zsh:disown:1: no current job` and `$! == 0`). Dropping
    /// the subshell wrapper (`sleep 30 & disown`) is the form that actually
    /// backgrounds+disowns in the *interactive* shell's own job table, matching
    /// what `design.md`'s manual task-0.2 probe used (`sleep 5 & disown`).
    #[test]
    fn detached_job_survives_foreground_return_and_signal_server_kills_it() {
        let mut session = spawn_shell();
        let shell_pgid = session.shell_pgid;
        wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));

        // Print the backgrounded job's pgid so the test can read back the real
        // captured target (mirrors what the sampler would freeze on) — `$!` is the
        // backgrounded job's pid, and portable-pty's shell setsid()s per-job the
        // same way it does for the top-level shell, so pid == pgid here too.
        send_line(&mut session, "sleep 30 & disown; echo DETACH_PGID_MARKER $!");

        // Foreground must return to the shell (prompt comes back) — this is the
        // "detach" tier-1-goes-false half of the behaviour.
        let fg_after = wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));
        assert_eq!(fg_after, Some(shell_pgid), "prompt must return once the job is backgrounded+disowned");
        assert!(!fg_is_non_shell(fg_after, Some(shell_pgid)), "tier 1 must report not-running once detached");

        // Read the echoed pgid back from the continuously-drained output buffer.
        let detached_pgid = wait_for_marker_pgid(&session, "DETACH_PGID_MARKER", Duration::from_secs(3))
            .expect("should observe the backgrounded job's pgid echoed by the shell");

        // Confirm it's alive (liveness probe) — this is exactly what
        // `pty_server_status`/`pty_signal_server` do before signalling.
        assert_eq!(unsafe { libc::killpg(detached_pgid, 0) }, 0, "backgrounded sleep must still be alive");

        // Now do exactly what `pty_signal_server` does: allowlist check, fresh
        // liveness re-probe, then killpg(pgid, SIGINT).
        assert!(is_allowed_server_signal(libc::SIGINT));
        assert_eq!(unsafe { libc::killpg(detached_pgid, 0) }, 0, "must still be alive immediately before signalling");
        unsafe { libc::killpg(detached_pgid, libc::SIGINT) };

        // Give it a moment to die, then confirm killpg(pgid, 0) now fails (ESRCH).
        let died = wait_for_pgid_death(detached_pgid, Duration::from_secs(3));
        assert!(died, "killpg(SIGINT) on the captured detached pgid must actually kill it (pgid {detached_pgid})");

        unsafe { libc::killpg(shell_pgid, libc::SIGKILL) };
    }

    /// A-2 regression — an *immediately* self-backgrounding job (`sleep 60 &!`,
    /// the zsh detach idiom the e2e's STICKY-DETACHED uses, equivalent to nx's
    /// `--no-tui`): the job never takes the PTY foreground, so the tcgetpgrp
    /// capture sampler never freezes on a non-shell pgid (`server.found()` stays
    /// None) — yet the job keeps the pane's controlling tty (that's why the badge
    /// still lights up via the tier-4 scan). Before the fix, `pty_signal_server`
    /// only knew how to signal a *captured* pgid, so Ctrl+C hit nothing and the
    /// process survived (the exact A-2 failure). This proves the tier-4 fallback
    /// (`foreign_tty_pgids` → `killpg(pgid, SIGINT)`) finds the detached job on
    /// the tty and actually reaps it.
    #[test]
    fn immediately_backgrounded_job_is_reachable_via_tty_scan_not_capture() {
        let mut session = spawn_shell();
        let shell_pgid = session.shell_pgid;
        let tty_dev = session.tty_dev.expect("pane must have a controlling tty");
        wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));

        // `&!` backgrounds AND disowns in one step, handing the prompt straight
        // back — the foreground never leaves the shell (that's the whole trap).
        send_line(&mut session, "sleep 60 &! ; echo done");

        // The PTY foreground must be (or return to) the shell — tier 1 is false.
        let fg_after = wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));
        assert_eq!(fg_after, Some(shell_pgid), "foreground must be the shell for an immediately-backgrounded job");
        assert!(!fg_is_non_shell(fg_after, Some(shell_pgid)), "tier 1 must report not-running");

        // The tier-4 tty scan MUST find the detached job (this is what makes the
        // badge appear) — and it must yield a live pgid distinct from the shell.
        let pgids = wait_for_foreign_pgids(tty_dev, Some(shell_pgid), Duration::from_secs(3));
        assert!(
            !pgids.is_empty(),
            "the detached `sleep 60 &!` must be found on the pane's tty (tty_dev {tty_dev:#x}), got none"
        );
        assert!(pgids.iter().all(|&p| p != shell_pgid), "scan must never return the shell's own pgid");
        assert!(pgids.iter().any(|&p| unsafe { libc::killpg(p, 0) } == 0), "scanned pgid must be alive");

        // Now do exactly what the fixed `pty_signal_server` fallback does: signal
        // every live foreign pgid on the tty with SIGINT.
        assert!(is_allowed_server_signal(libc::SIGINT));
        let mut signalled = false;
        for p in &pgids {
            if unsafe { libc::killpg(*p, 0) } == 0 {
                unsafe { libc::killpg(*p, libc::SIGINT) };
                signalled = true;
            }
        }
        assert!(signalled, "fallback must have signalled at least one live pgid");

        // The `sleep 60` must actually be dead now, and the tty scan must go
        // clean (so `pty_server_status` flips to "dead" → the badge clears).
        let cleared = {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut clear = false;
            while Instant::now() < deadline {
                if super::foreign_tty_pgids(tty_dev, Some(shell_pgid)).is_empty() {
                    clear = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            clear
        };
        assert!(cleared, "SIGINT via the tty-scan fallback must reap the detached `sleep 60 &!` (tty then clears)");

        unsafe { libc::killpg(shell_pgid, libc::SIGKILL) };
    }

    /// Poll `foreign_tty_pgids` until it returns a non-empty set or `timeout`
    /// elapses. Returns the last observed set.
    fn wait_for_foreign_pgids(tty_dev: u32, shell_pid: Option<i32>, timeout: Duration) -> Vec<i32> {
        let deadline = Instant::now() + timeout;
        let mut last = super::foreign_tty_pgids(tty_dev, shell_pid);
        while Instant::now() < deadline && last.is_empty() {
            std::thread::sleep(Duration::from_millis(50));
            last = super::foreign_tty_pgids(tty_dev, shell_pid);
        }
        last
    }

    /// 7.4 — uncaptured edge: signalling a pgid that is already dead (the
    /// TOCTOU / "capture failed" case) must be an honest no-op — exactly what
    /// `pty_signal_server` guards via its pre-signal `killpg(pgid, 0)` check.
    /// This proves the guard actually prevents a false "stopped" claim rather
    /// than asserting it by inspection only.
    #[test]
    fn signalling_an_already_dead_pgid_is_an_honest_no_op() {
        let mut session = spawn_shell();
        let shell_pgid = session.shell_pgid;
        wait_for(&session, Duration::from_secs(3), |fg| fg == Some(shell_pgid));

        send_line(&mut session, "sleep 1 & disown; echo DEAD_MARKER $!");
        let pgid = wait_for_marker_pgid(&session, "DEAD_MARKER", Duration::from_secs(3))
            .expect("should observe the short-lived job's pgid");

        // Let it die on its own (sleep 1).
        let died = wait_for_pgid_death(pgid, Duration::from_secs(4));
        assert!(died, "the 1s sleep should have exited on its own by now");

        // This mirrors `pty_signal_server`'s exact guard: liveness probe first.
        let probe = unsafe { libc::killpg(pgid, 0) };
        assert_ne!(probe, 0, "pgid must be confirmed dead (ESRCH) before we assert the no-op contract");
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        assert_eq!(errno, libc::ESRCH, "dead pgid must fail with ESRCH, not some other error");
        // pty_signal_server's contract: found_pgid dead -> return Ok(false), never calls killpg(pgid, signal).
        // We assert the precondition it relies on (the guard) rather than re-signalling a dead/possibly
        // recycled pgid ourselves, which would be exactly the TOCTOU hazard the design doc calls out.

        unsafe { libc::killpg(shell_pgid, libc::SIGKILL) };
    }

    /// Polls `killpg(pgid, 0)` until it fails with ESRCH (process group gone) or
    /// `timeout` elapses. Returns whether it died within the timeout.
    fn wait_for_pgid_death(pgid: i32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if unsafe { libc::killpg(pgid, 0) } != 0 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::ESRCH {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}
