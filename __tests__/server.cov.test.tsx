// Coverage suite for src/lib/server.ts — the frontend bridge to Rust's
// managed-server-process commands (server_spawn/status/stop/probe) and the
// "server:data" output-event hub. Drives the shared tauri mock directly
// (no store involved — servers.cov.test.tsx covers the orchestration layer
// that sits on top of this module).

import { describe, it, expect } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { serverHub, spawnServer, serverStatus, stopServer, probeServer } from "../src/lib/server";

// Deliberately NOT calling tauri.reset() here: it clears the mock's Tauri
// *event listener* registry too, but `serverHub` (a module singleton)
// registers its "server:data" listener exactly ONCE, eagerly, at import time
// (see server.ts) — a reset would permanently orphan it for the rest of this
// file (real Tauri events are never "reset" externally, so this is a
// test-harness-only concern). Each test instead re-registers only the
// `invoke` handlers it needs via `tauri.invoke({...})`, which merges over
// whatever the previous test left — safe here since every assertion below
// uses `tauri.lastCall()` (robust to accumulation), not `tauri.calls()`.

describe("spawnServer", () => {
  it("invokes server_spawn with id/command/args/cwd, and env as [k,v] pairs", async () => {
    tauri.invoke({ server_spawn: () => ({ pid: 42, pgid: 42, ptyId: "web" }) });
    const res = await spawnServer("web", "bun", ["run", "dev"], "/repo", { FOO: "bar" });
    expect(res).toEqual({ pid: 42, pgid: 42, ptyId: "web" });
    expect(tauri.lastCall("server_spawn")!.args).toEqual({
      id: "web",
      command: "bun",
      args: ["run", "dev"],
      cwd: "/repo",
      env: [["FOO", "bar"]],
    });
  });

  it("sends null cwd/env when omitted", async () => {
    await spawnServer("web", "bun", []);
    expect(tauri.lastCall("server_spawn")!.args).toEqual({ id: "web", command: "bun", args: [], cwd: null, env: null });
  });

  it("rejects when the Rust side rejects (e.g. duplicate id)", async () => {
    tauri.invoke({
      server_spawn: () => {
        throw new Error("server 'web' is already tracked");
      },
    });
    await expect(spawnServer("web", "bun", [])).rejects.toThrow("already tracked");
  });
});

describe("serverStatus", () => {
  it("resolves the running/exited result", async () => {
    tauri.invoke({ server_status: () => ({ state: "exited", code: 3 }) });
    expect(await serverStatus("web")).toEqual({ state: "exited", code: 3 });
  });

  it("rejects when the id isn't tracked", async () => {
    tauri.invoke({
      server_status: () => {
        throw new Error("no such server 'web'");
      },
    });
    await expect(serverStatus("web")).rejects.toThrow("no such server");
  });
});

describe("stopServer", () => {
  it("invokes server_stop with the id", async () => {
    await stopServer("web");
    expect(tauri.lastCall("server_stop")!.args).toEqual({ id: "web" });
  });
});

describe("probeServer", () => {
  it("resolves the probed ports", async () => {
    tauri.invoke({ server_probe: () => [3000, 3001] });
    expect(await probeServer("web")).toEqual([3000, 3001]);
  });
});

// One combined test, deliberately: `serverHub` is a module singleton that
// registers its "server:data" listener ONCE (eagerly, in its constructor —
// see server.ts, so a managed process's early output is never lost even if
// the subscribing ManagedServerPane hasn't mounted yet). `tauri.reset()`
// (this file's shared beforeEach) clears the MOCK's listener registry between
// tests — a test-harness-only concern (real Tauri events are never "reset"
// externally) — so splitting these into separate `it()`s would make every
// test after the first silently receive nothing. Keeping them sequential in
// one test with ONE reset exercises the real behavior without fighting that.
describe("serverHub", () => {
  it("delivers to the matching subscriber, ignores other ids, buffers pre-subscribe, respects unsubscribe/discard", async () => {
    const web: string[] = [];
    const unsubWeb = await serverHub.subscribe("web", (bytes) => web.push(new TextDecoder().decode(bytes)));

    tauri.emit("server:data", { id: "web", data: btoa("hello") });
    expect(web).toEqual(["hello"]);

    tauri.emit("server:data", { id: "other", data: btoa("nope") });
    expect(web).toEqual(["hello"]); // unchanged — not delivered to the wrong id

    // Buffered before its own subscribe() call, flushed once subscribed.
    tauri.emit("server:data", { id: "early", data: btoa("buffered-1") });
    tauri.emit("server:data", { id: "early", data: btoa("buffered-2") });
    const early: string[] = [];
    await serverHub.subscribe("early", (bytes) => early.push(new TextDecoder().decode(bytes)));
    expect(early).toEqual(["buffered-1", "buffered-2"]);

    unsubWeb();
    tauri.emit("server:data", { id: "web", data: btoa("late") });
    expect(web).toEqual(["hello"]); // unsubscribe stopped further delivery

    // discard() drops a buffered-but-never-subscribed id.
    tauri.emit("server:data", { id: "ghost", data: btoa("x") });
    serverHub.discard("ghost");
    const ghost: string[] = [];
    await serverHub.subscribe("ghost", (bytes) => ghost.push(new TextDecoder().decode(bytes)));
    expect(ghost).toEqual([]);
  });
});
