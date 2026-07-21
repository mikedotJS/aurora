//! Managed dev-server process manager (managed-server-lifecycle).
//!
//! Each `run`/`setup`/`archive` script from `aurora.json` is spawned as its own
//! tracked child — a real pid/pgid, its own PTY for output, its own session
//! (`setsid`, via `portable-pty`, mirroring `pty_spawn` `pty.rs:142-201`) — NOT
//! text typed into an already-running interactive shell (`pty_write`). This is
//! what gives Aurora a real process handle: `server_status` reads an actual
//! `waitpid` result instead of sampling the PTY foreground pgid, and
//! `server_stop` signals the exact tracked pgid instead of guessing.
//!
//! `$SHELL -ic "<command> <args…>"` is used as the spawned program so
//! `$AURORA_PORT` and friends expand via the shell, and so the process sees the
//! same environment as a command typed into a pane (`pty_spawn` runs `$SHELL`
//! interactively too). The distinction from the old design is WHO owns the
//! process (Aurora, via its own child) not HOW the command line is interpreted
//! or what environment it gets.
//!
//! The core logic lives on `ServerManager` as plain methods (no `AppHandle`/
//! `State` in their signatures) so `#[cfg(test)]` can exercise spawn → status →
//! stop → probe against a *real* process without a Tauri app context; the
//! `#[tauri::command]` functions below are thin wrappers that additionally wire
//! output streaming to the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One managed server process.
struct ManagedServer {
    /// Kept alive so the pty master fd stays open for the reader thread; also
    /// closing it (on removal) sends a kernel SIGHUP to the foreground group,
    /// same defense-in-depth as `pty_kill` (`pty.rs:346`).
    #[allow(dead_code)]
    master: Box<dyn MasterPty + Send>,
    #[allow(dead_code)]
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Kept for parity with `SpawnResult.pid` / future diagnostics; all signaling
    /// goes through `pgid` (== `pid` here, see below), not this field directly.
    #[allow(dead_code)]
    pid: i32,
    /// `setsid` is called in `portable-pty`'s `pre_exec` (same as `pty_spawn`),
    /// so pgid == pid for this child.
    pgid: i32,
    /// Cached the first time `try_wait` reports an exit, so a reaped child's
    /// exit code survives repeated `status()` polls.
    exit_code: Option<i64>,
}

/// Registry of all live managed servers, keyed by the caller-supplied `id`
/// (the run-script's stable id, e.g. `"web"`) — also the handle used for
/// `server_status`/`server_stop`/`server_probe` and for the `server:data`
/// output-streaming event.
#[derive(Default)]
pub struct ServerManager {
    servers: Mutex<HashMap<String, ManagedServer>>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ServerStatusResult {
    Running,
    Exited { code: i64 },
}

impl ServerManager {
    /// Spawn `command args…` as a dedicated child on its own PTY/session.
    /// `app` is `None` in tests (no output streaming) and `Some` from the
    /// `server_spawn` Tauri command (streams output on `server:data`).
    /// Errors if `id` is already tracked — callers must `stop` first.
    pub fn spawn(
        &self,
        app: Option<AppHandle>,
        id: String,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: Option<Vec<(String, String)>>,
    ) -> Result<(i32, i32), String> {
        {
            let servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            if servers.contains_key(&id) {
                return Err(format!("server '{id}' is already tracked — stop it before respawning"));
            }
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        // Join command+args into one line for the shell — same convention as
        // every other script in Aurora (scripts.ts `taskCmd`, no per-arg
        // escaping there either); this is how `$AURORA_PORT` expands via the
        // shell instead of being passed as a literal 4-char argv string.
        let line = std::iter::once(command.as_str())
            .chain(args.iter().map(|s| s.as_str()))
            .collect::<Vec<_>>()
            .join(" ");

        // `$SHELL -ic`, not `sh -lc`: a managed server must see the same
        // environment as a command typed into a pane, which is what Run/Stop
        // used to be (`pty_write` into the pane's own `$SHELL`). `sh -lc` reads
        // /etc/profile + ~/.profile and never ~/.zshrc, so a version manager
        // installed there (fnm/nvm/rbenv/pyenv/asdf) never initializes and the
        // server runs on whatever interpreter happens to sit in the default
        // PATH — e.g. /usr/local/bin/node instead of the fnm-selected one.
        let shell_path = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell_path);
        cmd.args(["-ic", &line]);
        if let Some(vars) = env {
            for (k, v) in vars {
                if !k.is_empty() {
                    cmd.env(k, v);
                }
            }
        }
        if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
            cmd.cwd(crate::sys::expand_tilde(dir));
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let pid = child.process_id().map(|p| p as i32).ok_or("spawn: no pid")?;
        let pgid = pid; // portable-pty calls setsid() — pid == pgid, mirrors pty_spawn (pty.rs:189-190).
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        if let Some(app) = app {
            let ev_id = id.clone();
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 65536];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = STANDARD.encode(&buf[..n]);
                            if app.emit("server:data", ServerData { id: &ev_id, data }).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        self.servers.lock().unwrap_or_else(|e| e.into_inner()).insert(
            id,
            ManagedServer {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                pid,
                pgid,
                exit_code: None,
            },
        );

        Ok((pid, pgid))
    }

    /// `Running` or `Exited(code)` from a non-blocking `waitpid` (`try_wait`) —
    /// never a heuristic. Errors when `id` isn't tracked.
    pub fn status(&self, id: &str) -> Result<ServerStatusResult, String> {
        let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        let server = servers.get_mut(id).ok_or_else(|| format!("no such server '{id}'"))?;
        if let Some(code) = server.exit_code {
            return Ok(ServerStatusResult::Exited { code });
        }
        match server.child.try_wait() {
            Ok(Some(status)) => {
                let code = status.exit_code() as i64;
                server.exit_code = Some(code);
                Ok(ServerStatusResult::Exited { code })
            }
            Ok(None) => Ok(ServerStatusResult::Running),
            Err(e) => Err(e.to_string()),
        }
    }

    /// SIGHUP the tracked pgid, wait ~200ms, re-check both waitpid AND the
    /// probed port; SIGKILL that exact pgid if either says it survived. Never a
    /// broad `pkill`. No-op (Ok) when `id` isn't tracked or already exited.
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let pgid = {
            let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            let server = match servers.get_mut(id) {
                Some(s) => s,
                None => return Ok(()),
            };
            let already_exited = server.exit_code.is_some() || !matches!(server.child.try_wait(), Ok(None));
            if already_exited {
                servers.remove(id);
                return Ok(());
            }
            server.pgid
        };

        let our_pgid = unsafe { libc::getpgrp() };
        if pgid > 1 && pgid != our_pgid {
            unsafe {
                libc::killpg(pgid, libc::SIGHUP);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));

        let still_running = {
            let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            match servers.get_mut(id) {
                Some(s) => matches!(s.child.try_wait(), Ok(None)),
                None => false,
            }
        };
        let still_bound = !probe_ports(pgid).is_empty();
        if (still_running || still_bound) && pgid > 1 && pgid != our_pgid {
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }

        self.servers.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        Ok(())
    }

    /// The real listening TCP ports (if any) owned by `id`'s process group.
    /// Empty (never an error) when `id` isn't tracked.
    pub fn probe(&self, id: &str) -> Vec<u16> {
        let pgid = {
            let servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            servers.get(id).map(|s| s.pgid)
        };
        match pgid {
            Some(p) => probe_ports(p),
            None => Vec::new(),
        }
    }

    /// SIGHUP every tracked pgid, then SIGKILL survivors after a bounded grace
    /// sleep — same shape as `PtyManager::kill_all` (`pty.rs:83-115`). Called
    /// from ⌘Q / app-exit alongside `PtyManager::kill_all` so managed servers
    /// don't outlive the app.
    pub fn kill_all(&self) {
        let servers: Vec<ManagedServer> = {
            let mut map = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, s)| s).collect()
        };
        let our_pgid = unsafe { libc::getpgrp() };
        let pgids: Vec<i32> = servers
            .iter()
            .map(|s| s.pgid)
            .filter(|&p| p > 1 && p != our_pgid)
            .collect();
        if pgids.is_empty() {
            return;
        }
        for &p in &pgids {
            unsafe {
                libc::killpg(p, libc::SIGHUP);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for &p in &pgids {
            unsafe {
                libc::killpg(p, libc::SIGKILL);
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct ServerData<'a> {
    id: &'a str,
    /// base64-encoded raw bytes, same convention as `pty:data` (`pty.rs:118-124`).
    data: String,
}

/// Enumerate the live pids belonging to a process group: `ps -g <pgid> -o pid=`.
/// Critically this returns EVERY pid in the group, not just the leader — a
/// forking server (`nx --no-tui`-style) whose leader never binds a socket but
/// whose forked child does needs every pid probed, or the port is invisible.
fn list_pgid_pids(pgid: i32) -> Vec<String> {
    let out = StdCommand::new("ps").args(["-g", &pgid.to_string(), "-o", "pid="]).output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// The real listening TCP ports owned by any pid in `pgid`, via
/// `lsof -nP -a -p <pids> -iTCP -sTCP:LISTEN`.
///
/// The `-a` flag is load-bearing and was verified empirically (not assumed):
/// without it, macOS `lsof` OR-combines `-p`/`-i` selectors instead of ANDing
/// them, so a bare `-p <pid> -iTCP -sTCP:LISTEN` returns every LISTEN socket on
/// the whole machine (verified: 30+ unrelated system ports for an unrelated
/// pid). With `-a`, only sockets owned by the given pids are returned
/// (verified against a real spawned `python3 -m http.server`, and against a
/// forking parent/child pair sharing one pgid — see `server.rs` tests).
fn probe_ports(pgid: i32) -> Vec<u16> {
    let pids = list_pgid_pids(pgid);
    if pids.is_empty() {
        return Vec::new();
    }
    let pid_arg = pids.join(",");
    let output = StdCommand::new("lsof")
        .args(["-nP", "-a", "-p", &pid_arg, "-iTCP", "-sTCP:LISTEN"])
        .output();
    let mut ports = Vec::new();
    if let Ok(o) = output {
        let text = String::from_utf8_lossy(&o.stdout);
        // Data rows look like: `Python 33081 user 4u IPv6 0x... 0t0 TCP *:18923 (LISTEN)`
        // — the NAME field (`*:PORT` / `127.0.0.1:PORT` / `[::1]:PORT`) and the
        // `(LISTEN)` state are separate whitespace-delimited tokens, so scan all
        // tokens on the line rather than assuming a fixed trailing position.
        for line in text.lines().skip(1) {
            for tok in line.split_whitespace() {
                if let Some(idx) = tok.rfind(':') {
                    if let Ok(p) = tok[idx + 1..].parse::<u16>() {
                        if !ports.contains(&p) {
                            ports.push(p);
                        }
                    }
                }
            }
        }
    }
    ports
}

/// Returned to the UI after a successful spawn.
#[derive(Serialize)]
pub struct SpawnResult {
    pid: i32,
    pgid: i32,
    #[serde(rename = "ptyId")]
    pty_id: String,
}

#[tauri::command]
pub fn server_spawn(
    app: AppHandle,
    manager: State<'_, ServerManager>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<Vec<(String, String)>>,
) -> Result<SpawnResult, String> {
    let pty_id = id.clone();
    let (pid, pgid) = manager.spawn(Some(app), id, command, args, cwd, env)?;
    Ok(SpawnResult { pid, pgid, pty_id })
}

#[tauri::command]
pub fn server_status(manager: State<'_, ServerManager>, id: String) -> Result<ServerStatusResult, String> {
    manager.status(&id)
}

#[tauri::command]
pub fn server_stop(manager: State<'_, ServerManager>, id: String) -> Result<(), String> {
    manager.stop(&id)
}

#[tauri::command]
pub fn server_probe(manager: State<'_, ServerManager>, id: String) -> Result<Vec<u16>, String> {
    Ok(manager.probe(&id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-process integration tests (design.md "Test strategy", item 2 — these are
// NOT counted in the JS `bun test/cov.ts` number; they independently prove what
// the JS process-manager double claims). Spawns real `python3` listeners.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// An OS-assigned free port. Bind-then-drop has a theoretical TOCTOU race
    /// (another process could grab it before we rebind) but is the standard,
    /// low-flake way to pick a free port for a test.
    fn free_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        port
    }

    /// Poll `probe_ports(pgid)` until it reports `port`, up to ~3s. A fixed
    /// sleep before the first probe was observed to flake under load (a
    /// `cargo build` running concurrently delayed `python3`'s bind past a
    /// single 500ms sleep) — polling is the robust fix.
    fn wait_for_port(pgid: i32, port: u16) -> Vec<u16> {
        for _ in 0..30 {
            let ports = probe_ports(pgid);
            if ports.contains(&port) {
                return ports;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        probe_ports(pgid)
    }

    /// Poll `probe_ports(pgid)` until it reports empty, up to ~3s.
    fn wait_for_port_freed(pgid: i32) -> Vec<u16> {
        for _ in 0..30 {
            let ports = probe_ports(pgid);
            if ports.is_empty() {
                return ports;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        probe_ports(pgid)
    }

    #[test]
    fn spawn_reports_running_then_probe_finds_the_real_port() {
        let mgr = ServerManager::default();
        let port = free_port();
        let (pid, pgid) = mgr
            .spawn(
                None,
                "test-http".into(),
                "python3".into(),
                vec!["-m".into(), "http.server".into(), port.to_string()],
                None,
                None,
            )
            .expect("spawn failed");
        assert!(pid > 0);
        assert_eq!(pid, pgid, "portable-pty setsid()s the child — pid must equal pgid");

        let ports = wait_for_port(pgid, port);
        assert_eq!(mgr.status("test-http").unwrap(), ServerStatusResult::Running);
        assert!(ports.contains(&port), "expected {port} in probed ports {ports:?}");

        mgr.stop("test-http").unwrap();
    }

    /// A managed server must run under the user's `$SHELL`, interactively, so it inherits the same
    /// environment as a command typed into a pane. `sh -lc` reads /etc/profile + ~/.profile and
    /// never ~/.zshrc, so a version manager installed there (fnm/nvm/rbenv/…) never initializes and
    /// the server silently runs on the wrong interpreter.
    ///
    /// Proven without touching the developer's real rc file: `$ZDOTDIR` relocates zsh's rc lookup,
    /// so an interactive zsh sources the marker below and a non-interactive `sh` cannot.
    #[test]
    fn spawn_sources_the_interactive_shell_rc_so_version_managers_initialize() {
        let shell = std::env::var("SHELL").unwrap_or_default();
        if !shell.ends_with("zsh") {
            eprintln!("skipping: $SHELL is {shell:?}, not zsh");
            return;
        }

        let dir = std::env::temp_dir().join(format!("aurora-rc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".zshrc"), "export AURORA_RC_MARKER=sourced\n").unwrap();
        let out = dir.join("marker.txt");

        let mgr = ServerManager::default();
        mgr.spawn(
            None,
            "test-rc".into(),
            format!("printf '%s' \"${{AURORA_RC_MARKER:-MISSING}}\" > {}", out.display()),
            vec![],
            None,
            Some(vec![("ZDOTDIR".into(), dir.to_string_lossy().into_owned())]),
        )
        .expect("spawn failed");

        let mut got = String::new();
        for _ in 0..50 {
            if let Ok(s) = std::fs::read_to_string(&out) {
                if !s.is_empty() {
                    got = s;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = mgr.stop("test-rc");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(got, "sourced", "managed server did not source the interactive shell's rc");
    }

    #[test]
    fn stop_verifies_the_port_is_freed() {
        let mgr = ServerManager::default();
        let port = free_port();
        let (_, pgid) = mgr
            .spawn(
                None,
                "test-stop".into(),
                "python3".into(),
                vec!["-m".into(), "http.server".into(), port.to_string()],
                None,
                None,
            )
            .expect("spawn failed");
        let ports = wait_for_port(pgid, port);
        assert!(ports.contains(&port), "server should be listening before stop, got {ports:?}");

        mgr.stop("test-stop").unwrap();

        // status() must now report "not tracked" (removed from the registry).
        assert!(mgr.status("test-stop").is_err());
        assert!(
            wait_for_port_freed(pgid).is_empty(),
            "stop() must leave the port freed"
        );
    }

    #[test]
    fn stop_sigkills_a_sighup_survivor() {
        let mgr = ServerManager::default();
        let port = free_port();
        // `trap '' HUP` makes the shell (and the http.server it execs into via
        // Python not re-execing sh — so actually the shell itself survives the
        // HUP and keeps its child alive) ignore SIGHUP, forcing stop() to
        // escalate to SIGKILL to actually free the port.
        let (_, pgid) = mgr
            .spawn(
                None,
                "test-survivor".into(),
                "sh".into(),
                vec!["-c".into(), format!("trap '' HUP; exec python3 -m http.server {port}")],
                None,
                None,
            )
            .expect("spawn failed");
        let ports = wait_for_port(pgid, port);
        assert!(ports.contains(&port), "server should be listening before stop, got {ports:?}");

        mgr.stop("test-survivor").unwrap();
        assert!(
            wait_for_port_freed(pgid).is_empty(),
            "SIGKILL must have freed the port after the SIGHUP survivor test"
        );
    }

    #[test]
    fn probe_finds_a_port_bound_by_a_forked_grandchild_not_the_leader() {
        // Regression coverage for the exact caveat flagged in design.md Decision 5
        // and tasks.md 3.5: a forking server (nx --no-tui-style) whose LEADER
        // never binds a socket — a forked child in the same pgid does. `ps -g
        // <pgid>` must enumerate every pid in the group, or `lsof -a -p <pids>`
        // never sees the child's port. Verified manually before writing this
        // module (parent pid X, forked child pid X+1, same pgid X; `ps -g X`
        // returned both pids; `lsof -a -p X,X+1 ...` found the child's port).
        let mgr = ServerManager::default();
        let port = free_port();
        let script_path = std::env::temp_dir().join(format!("aurora-fork-listener-test-{port}.py"));
        let script = format!(
            "import os, socket, time\n\
pid = os.fork()\n\
if pid == 0:\n\
\x20\x20\x20\x20s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n\
\x20\x20\x20\x20s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n\
\x20\x20\x20\x20s.bind((\"0.0.0.0\", {port}))\n\
\x20\x20\x20\x20s.listen(5)\n\
\x20\x20\x20\x20time.sleep(30)\n\
else:\n\
\x20\x20\x20\x20time.sleep(30)\n"
        );
        std::fs::write(&script_path, script).expect("write fork-listener fixture script");

        let (_, pgid) = mgr
            .spawn(
                None,
                "test-fork".into(),
                "python3".into(),
                vec![script_path.to_string_lossy().to_string(), port.to_string()],
                None,
                None,
            )
            .expect("spawn failed");
        let ports = wait_for_port(pgid, port);
        let pids = list_pgid_pids(pgid);

        mgr.stop("test-fork").unwrap();
        let _ = std::fs::remove_file(&script_path);

        assert!(pids.len() >= 2, "expected leader + forked child in the pgid, got {pids:?}");
        assert!(ports.contains(&port), "expected forked child's port {port} in {ports:?}");
    }

    #[test]
    fn status_errors_for_an_untracked_id() {
        let mgr = ServerManager::default();
        assert!(mgr.status("nope").is_err());
    }

    #[test]
    fn stop_is_a_noop_for_an_untracked_id() {
        let mgr = ServerManager::default();
        assert!(mgr.stop("nope").is_ok());
    }

    #[test]
    fn probe_is_empty_for_an_untracked_id() {
        let mgr = ServerManager::default();
        assert!(mgr.probe("nope").is_empty());
    }

    #[test]
    fn probe_ports_empty_for_a_pgid_with_no_live_processes() {
        assert!(probe_ports(999_999).is_empty());
    }

    #[test]
    fn spawn_rejects_a_duplicate_id_while_still_tracked() {
        let mgr = ServerManager::default();
        let port = free_port();
        mgr.spawn(
            None,
            "test-dup".into(),
            "python3".into(),
            vec!["-m".into(), "http.server".into(), port.to_string()],
            None,
            None,
        )
        .expect("first spawn failed");

        let second = mgr.spawn(
            None,
            "test-dup".into(),
            "python3".into(),
            vec!["-m".into(), "http.server".into(), free_port().to_string()],
            None,
            None,
        );
        assert!(second.is_err(), "spawning the same id twice while tracked must error");

        mgr.stop("test-dup").unwrap();
    }
}
