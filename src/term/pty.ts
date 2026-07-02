// Frontend bridge to the Rust PTY commands. A single hub listens to the global
// `pty:data` / `pty:exit` events and fans them out to per-session callbacks,
// buffering any bytes that arrive before a subscriber is registered.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Liveness status returned by `pty_server_status` (D8 probe).
 * - "capturing"  : sampler running, pgid not yet resolved (booting)
 * - "alive"      : captured pgid answers killpg(pgid, 0)
 * - "dead"       : captured pgid is ESRCH (server exited)
 * - "uncaptured" : capture gave up (no distinct job found) — front falls back to block flag
 */
export type ServerStatus = "capturing" | "alive" | "dead" | "uncaptured";

/**
 * Generic per-pane foreground signal (sticky-running-server-tabs, tier 1):
 * `running` is true when the PTY's foreground process group currently differs
 * from its shell's (a foreground child — vite, next dev, npm install, …).
 * `pgid` is the raw foreground pgid the check was based on, mostly for debugging.
 */
export interface ForegroundState {
  running: boolean;
  pgid: number | null;
}

/** SIGINT's value on macOS/BSD/Linux (Aurora is macOS-only). Used by `pty.signalServer`. */
export const SIGINT = 2;

export interface SpawnResult {
  id: string;
  shell: string;
  is_zsh: boolean;
}

type DataCb = (bytes: Uint8Array) => void;
type ExitCb = (code: number) => void;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class PtyHub {
  private dataSubs = new Map<string, DataCb>();
  private exitSubs = new Map<string, ExitCb>();
  private pending = new Map<string, Uint8Array[]>();
  private ready: Promise<void> | null = null;
  private unlisten: UnlistenFn[] = [];

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        this.unlisten.push(
          await listen<{ id: string; data: string }>("pty:data", (e) => {
            const bytes = decodeBase64(e.payload.data);
            const cb = this.dataSubs.get(e.payload.id);
            if (cb) cb(bytes);
            else {
              const q = this.pending.get(e.payload.id) ?? [];
              q.push(bytes);
              this.pending.set(e.payload.id, q);
            }
          }),
        );
        this.unlisten.push(
          await listen<{ id: string; code: number }>("pty:exit", (e) => {
            this.exitSubs.get(e.payload.id)?.(e.payload.code);
          }),
        );
      })();
    }
    return this.ready;
  }

  async spawn(
    opts: { cwd?: string; cols: number; rows: number; env?: Record<string, string> },
    onData: DataCb,
    onExit: ExitCb,
  ): Promise<SpawnResult> {
    await this.ensure();
    const res = await invoke<SpawnResult>("pty_spawn", {
      cwd: opts.cwd ?? null,
      cols: Math.max(1, Math.floor(opts.cols)),
      rows: Math.max(1, Math.floor(opts.rows)),
      shell: null,
      // Rust expects Vec<(String,String)> — send entries as [k, v] pairs.
      env: opts.env ? Object.entries(opts.env) : null,
    });
    this.dataSubs.set(res.id, onData);
    this.exitSubs.set(res.id, onExit);
    const queued = this.pending.get(res.id);
    if (queued) {
      this.pending.delete(res.id);
      for (const chunk of queued) onData(chunk);
    }
    return res;
  }

  write(id: string, data: string): Promise<void> {
    return invoke("pty_write", { id, data });
  }

  resize(id: string, cols: number, rows: number): Promise<void> {
    return invoke("pty_resize", {
      id,
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
    });
  }

  kill(id: string): Promise<void> {
    this.dataSubs.delete(id);
    this.exitSubs.delete(id);
    this.pending.delete(id);
    return invoke("pty_kill", { id });
  }

  /**
   * Fire-and-forget: start the Rust sampler that captures the server's real
   * process group for this PTY session. Safe to call and ignore the promise.
   * (D7 — invoke pty_capture_server_pgid)
   */
  captureServerPgid(id: string): Promise<void> {
    return invoke("pty_capture_server_pgid", { id });
  }

  /**
   * Probe whether the captured server process group is still alive.
   * Returns one of the `ServerStatus` literals. (D8 — invoke pty_server_status)
   */
  serverStatus(id: string): Promise<ServerStatus> {
    return invoke<ServerStatus>("pty_server_status", { id });
  }

  /**
   * Generic per-pane foreground probe (tier 1 of the combined running signal).
   * Reads the PTY's foreground process group vs the shell's — command-agnostic,
   * unlike serverStatus() which only reports on a *captured* detached group.
   */
  foregroundState(id: string): Promise<ForegroundState> {
    return invoke<ForegroundState>("pty_foreground_state", { id });
  }

  /**
   * Signal the session's captured server process group directly (Ctrl+C for a
   * detached-but-captured server, where the PTY foreground is the shell so a
   * raw `\x03` would miss the real target). Returns false — not a rejection —
   * when there's nothing live to signal (uncaptured or already dead); callers
   * must not report success in that case.
   */
  signalServer(id: string, signal: number): Promise<boolean> {
    return invoke<boolean>("pty_signal_server", { id, signal });
  }
}

export const pty = new PtyHub();
