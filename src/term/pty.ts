// Frontend bridge to the Rust PTY commands. A single hub listens to the global
// `pty:data` / `pty:exit` events and fans them out to per-session callbacks,
// buffering any bytes that arrive before a subscriber is registered.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
    opts: { cwd?: string; cols: number; rows: number },
    onData: DataCb,
    onExit: ExitCb,
  ): Promise<SpawnResult> {
    await this.ensure();
    const res = await invoke<SpawnResult>("pty_spawn", {
      cwd: opts.cwd ?? null,
      cols: Math.max(1, Math.floor(opts.cols)),
      rows: Math.max(1, Math.floor(opts.rows)),
      shell: null,
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
}

export const pty = new PtyHub();
