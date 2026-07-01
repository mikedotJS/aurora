// Coverage suite for src/term/pty.ts — the PtyHub singleton bridging Rust PTY
// commands + the global pty:data/pty:exit events to per-session callbacks.
//
// IMPORTANT: `pty` is a module-level singleton whose `ensure()` wires the
// "pty:data"/"pty:exit" listeners exactly ONCE (memoized via `this.ready`).
// We therefore never call tauri.reset() in this file (it would wipe the mock's
// `listeners` map out from under the hub, since PtyHub never re-subscribes).
// Instead every test uses a unique session id and asserts only on calls/events
// scoped to that id, so tests remain independent despite the shared instance.

import { describe, it, expect } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { pty, type SpawnResult, type ServerStatus } from "../src/term/pty";

function callsFor(cmd: string, id: string) {
  return tauri.calls().filter((c) => c.cmd === cmd && (c.args as Record<string, unknown>).id === id);
}

let seq = 0;
function nextId(prefix: string) {
  return `${prefix}-${++seq}`;
}

describe("pty.spawn", () => {
  it("invokes pty_spawn with floored/clamped cols+rows and cwd=null when unset", async () => {
    const id = nextId("spawn-basic");
    const result: SpawnResult = { id, shell: "/bin/zsh", is_zsh: true };
    tauri.invoke({ pty_spawn: () => result });
    const res = await pty.spawn({ cols: 80.9, rows: 24.2 }, () => {}, () => {});
    expect(res).toEqual(result);
    const call = callsFor("pty_spawn", id);
    // The handler doesn't see `id` in args (it's not sent) — assert on the last pty_spawn call instead.
    const last = tauri.lastCall("pty_spawn");
    expect(last?.args).toEqual({ cwd: null, cols: 80, rows: 24, shell: null, env: null });
  });

  it("forwards cwd when provided", async () => {
    tauri.invoke({ pty_spawn: () => ({ id: nextId("cwd"), shell: "/bin/bash", is_zsh: false }) });
    await pty.spawn({ cwd: "/repo", cols: 80, rows: 24 }, () => {}, () => {});
    expect(tauri.lastCall("pty_spawn")?.args.cwd).toBe("/repo");
  });

  it("clamps fractional/negative cols+rows to a minimum of 1", async () => {
    tauri.invoke({ pty_spawn: () => ({ id: nextId("clamp"), shell: "/bin/zsh", is_zsh: true }) });
    await pty.spawn({ cols: 0.5, rows: -3 }, () => {}, () => {});
    const args = tauri.lastCall("pty_spawn")?.args;
    expect(args?.cols).toBe(1);
    expect(args?.rows).toBe(1);
  });

  it("converts an env record to [k, v] entry pairs", async () => {
    tauri.invoke({ pty_spawn: () => ({ id: nextId("env"), shell: "/bin/zsh", is_zsh: true }) });
    await pty.spawn({ cols: 80, rows: 24, env: { FOO: "1", BAR: "2" } }, () => {}, () => {});
    expect(tauri.lastCall("pty_spawn")?.args.env).toEqual([["FOO", "1"], ["BAR", "2"]]);
  });

  it("registers the returned id as a live data subscriber", async () => {
    const id = nextId("live-sub");
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/zsh", is_zsh: true }) });
    const received: string[] = [];
    await pty.spawn({ cols: 80, rows: 24 }, (bytes) => received.push(new TextDecoder().decode(bytes)), () => {});
    tauri.emit("pty:data", { id, data: btoa("hello") });
    expect(received).toEqual(["hello"]);
  });

  it("flushes bytes that arrived (queued) before the subscriber existed", async () => {
    const id = nextId("queued");
    // Data arrives BEFORE spawn() resolves and registers the callback.
    tauri.emit("pty:data", { id, data: btoa("early") });
    tauri.emit("pty:data", { id, data: btoa("er2") });
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/zsh", is_zsh: true }) });
    const received: string[] = [];
    await pty.spawn({ cols: 80, rows: 24 }, (bytes) => received.push(new TextDecoder().decode(bytes)), () => {});
    expect(received).toEqual(["early", "er2"]);
    // Once flushed, the pending queue is drained — a further event goes straight through.
    tauri.emit("pty:data", { id, data: btoa("later") });
    expect(received).toEqual(["early", "er2", "later"]);
  });

  it("routes pty:exit events to the registered onExit callback", async () => {
    const id = nextId("exit");
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/zsh", is_zsh: true }) });
    let exitCode: number | null = null;
    await pty.spawn({ cols: 80, rows: 24 }, () => {}, (code) => (exitCode = code));
    tauri.emit("pty:exit", { id, code: 42 });
    expect(exitCode).toBe(42);
  });

  it("an exit event for an unknown id is a silent no-op", () => {
    expect(() => tauri.emit("pty:exit", { id: "unknown-id", code: 1 })).not.toThrow();
  });
});

describe("pty.write", () => {
  it("invokes pty_write with id + data", async () => {
    tauri.invoke({ pty_write: () => undefined });
    await pty.write("sess-1", "echo hi\n");
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "sess-1", data: "echo hi\n" });
  });
});

describe("pty.resize", () => {
  it("invokes pty_resize with floored positive cols/rows", async () => {
    tauri.invoke({ pty_resize: () => undefined });
    await pty.resize("sess-1", 100.7, 40.2);
    expect(tauri.lastCall("pty_resize")?.args).toEqual({ id: "sess-1", cols: 100, rows: 40 });
  });
  it("clamps non-positive cols/rows to a minimum of 1", async () => {
    tauri.invoke({ pty_resize: () => undefined });
    await pty.resize("sess-1", 0, -5);
    expect(tauri.lastCall("pty_resize")?.args).toEqual({ id: "sess-1", cols: 1, rows: 1 });
  });
});

describe("pty.kill", () => {
  it("invokes pty_kill and removes the session's subscribers", async () => {
    const id = nextId("kill");
    tauri.invoke({ pty_spawn: () => ({ id, shell: "/bin/zsh", is_zsh: true }), pty_kill: () => undefined });
    const received: string[] = [];
    await pty.spawn({ cols: 80, rows: 24 }, (bytes) => received.push(new TextDecoder().decode(bytes)), () => {});
    await pty.kill(id);
    expect(tauri.lastCall("pty_kill")?.args).toEqual({ id });

    // After kill, the old callback is gone — new data for that id is buffered fresh
    // (a new pending queue), not delivered to the now-removed callback.
    tauri.emit("pty:data", { id, data: btoa("post-kill") });
    expect(received).toEqual([]);
  });

  it("kill on a never-spawned id is safe (nothing to remove) and still invokes pty_kill", async () => {
    tauri.invoke({ pty_kill: () => undefined });
    await expect(pty.kill("never-spawned")).resolves.toBeUndefined();
    expect(tauri.lastCall("pty_kill")?.args).toEqual({ id: "never-spawned" });
  });
});

describe("pty.captureServerPgid", () => {
  it("invokes pty_capture_server_pgid with the session id", async () => {
    tauri.invoke({ pty_capture_server_pgid: () => undefined });
    await pty.captureServerPgid("sess-1");
    expect(tauri.lastCall("pty_capture_server_pgid")?.args).toEqual({ id: "sess-1" });
  });
});

describe("pty.serverStatus", () => {
  it.each(["capturing", "alive", "dead", "uncaptured"] as ServerStatus[])(
    "resolves the '%s' status literal",
    async (status) => {
      tauri.invoke({ pty_server_status: () => status });
      expect(await pty.serverStatus("sess-1")).toBe(status);
    },
  );
});
