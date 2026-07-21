// Frontend bridge to the Rust managed-server-process commands
// (server_spawn/status/stop/probe, src-tauri/src/server.rs). Mirrors
// term/pty.ts's PtyHub shape but for Aurora-OWNED processes (aurora.json
// setup/run/archive scripts) — a managed server has its own real pid/pgid and
// its own PTY for output, tracked by Rust's `ServerManager` (NOT `PtyManager`).
// Output streams on the "server:data" event (base64 `{id,data}`, same shape as
// "pty:data") — a SEPARATE channel, so a managed server's id is never
// confused with a shell pane's ptyId. See design.md Decision 4.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors Rust's `ServerStatusResult` (`#[serde(tag = "state", rename_all =
 *  "lowercase")]`). */
export type ServerStatusResult = { state: "running" } | { state: "exited"; code: number };

export interface ServerSpawnResult {
  pid: number;
  pgid: number;
  ptyId: string;
}

type DataCb = (bytes: Uint8Array) => void;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Fans the global "server:data" event out to per-id subscribers, buffering
 * bytes that arrive before a subscriber attaches (a spawn's output can start
 * streaming before the caller finishes wiring its listener) — same shape as
 * PtyHub in term/pty.ts.
 */
class ServerHub {
  private dataSubs = new Map<string, DataCb>();
  private pending = new Map<string, Uint8Array[]>();
  private ready: Promise<void> | null = null;
  private unlisten: UnlistenFn[] = [];

  constructor() {
    // Register the "server:data" listener EAGERLY (not lazily on first
    // subscribe): a managed process can emit output before React mounts the
    // ManagedServerPane that will subscribe to it (server_spawn is invoked
    // right after the pane is created, ahead of that pane's mount effect) —
    // if the underlying Tauri listener weren't already registered, that early
    // output would be lost, not buffered.
    void this.ensure();
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        this.unlisten.push(
          await listen<{ id: string; data: string }>("server:data", (e) => {
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
      })();
    }
    return this.ready;
  }

  /** Subscribe to `id`'s output, flushing anything buffered before this call.
   *  Returns an unsubscribe function. */
  async subscribe(id: string, onData: DataCb): Promise<() => void> {
    await this.ensure();
    this.dataSubs.set(id, onData);
    const queued = this.pending.get(id);
    if (queued) {
      this.pending.delete(id);
      for (const chunk of queued) onData(chunk);
    }
    return () => {
      this.dataSubs.delete(id);
      this.pending.delete(id);
    };
  }

  /** Drop any buffered/subscribed state for `id` without a live listener
   *  (used when a spawn fails after we've started buffering). */
  discard(id: string): void {
    this.dataSubs.delete(id);
    this.pending.delete(id);
  }
}

export const serverHub = new ServerHub();

/** Spawn `command args…` as its own tracked child (own pid/pgid/PTY/session).
 *  Rejects (does not swallow) — including "id already tracked" — so callers
 *  decide how to handle a respawn-while-live. */
export function spawnServer(
  id: string,
  command: string,
  args: string[],
  cwd?: string | null,
  env?: Record<string, string>,
): Promise<ServerSpawnResult> {
  return invoke<ServerSpawnResult>("server_spawn", {
    id,
    command,
    args,
    cwd: cwd ?? null,
    env: env ? Object.entries(env) : null,
  });
}

/** `Running` or `Exited(code)` from a real `waitpid`. Rejects when `id` isn't
 *  tracked (never was spawned, or already stopped) — callers treat a reject
 *  as "not running". */
export function serverStatus(id: string): Promise<ServerStatusResult> {
  return invoke<ServerStatusResult>("server_status", { id });
}

/** SIGHUP → verify → SIGKILL survivor, on the exact tracked pgid. No-op
 *  (resolves) when `id` isn't tracked. */
export function stopServer(id: string): Promise<void> {
  return invoke<void>("server_stop", { id });
}

/** The real listening TCP ports (if any) owned by `id`'s process group.
 *  Empty (never rejects) when `id` isn't tracked. */
export function probeServer(id: string): Promise<number[]> {
  return invoke<number[]>("server_probe", { id });
}
