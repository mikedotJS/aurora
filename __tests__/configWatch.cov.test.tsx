// Coverage for src/lib/configWatch.ts — the frontend half of the aurora.json file-watch.
//
// Verifies: (1) requestConfigWatch invokes the Rust watch command once per root (deduped);
// (2) an `aurora:config-changed` event reloads that root's config, debounced/coalesced per root;
// (3) reloadAuroraConfig drops the cache then re-reads disk (a real edit is observed).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import {
  requestConfigWatch,
  resetConfigWatch,
  startConfigWatch,
  reloadAuroraConfig,
} from "../src/lib/configWatch";
import { ensureAuroraConfigLoaded, getCachedAuroraConfig } from "../src/lib/auroraConfigStore";

beforeEach(() => {
  tauri.reset();
  resetConfigWatch();
  useStore.setState({ auroraConfigs: {}, userScripts: {} }, false);
});
afterEach(() => tauri.reset());

const watchCalls = () => tauri.calls().filter((c) => c.cmd === "watch_aurora_config");

describe("requestConfigWatch", () => {
  it("asks Rust to watch a root exactly once, even when called repeatedly", async () => {
    requestConfigWatch("/repo/a");
    requestConfigWatch("/repo/a");
    requestConfigWatch("/repo/a");
    await Promise.resolve();
    const calls = watchCalls().filter((c) => c.args.root === "/repo/a");
    expect(calls).toHaveLength(1);
  });

  it("does nothing for a null root", async () => {
    requestConfigWatch(null);
    await Promise.resolve();
    expect(watchCalls()).toHaveLength(0);
  });

  it("is invoked as a side effect of loading a repo's config", async () => {
    tauri.invoke({ read_text_file: () => "" });
    await ensureAuroraConfigLoaded("/repo/watched");
    expect(watchCalls().some((c) => c.args.root === "/repo/watched")).toBe(true);
  });
});

describe("reloadAuroraConfig", () => {
  it("drops the cache and re-reads disk, so an external edit is observed", async () => {
    // First load sees an empty (default) config.
    tauri.invoke({ read_text_file: () => "" });
    await ensureAuroraConfigLoaded("/repo/edit");
    expect(getCachedAuroraConfig("/repo/edit").scripts.setup).toBeNull();

    // The file changes on disk; reloadAuroraConfig must pick up the new content.
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: "pnpm install", run: [], custom: {}, archive: null } }),
    });
    await reloadAuroraConfig("/repo/edit");
    expect(getCachedAuroraConfig("/repo/edit").scripts.setup).toBe("pnpm install");
  });
});

describe("startConfigWatch", () => {
  it("reloads the changed root, coalescing a burst of events into one reload", async () => {
    const reloaded: string[] = [];
    const unlisten = await startConfigWatch((root) => {
      reloaded.push(root);
    });

    // A single save typically emits several fs events for one root.
    tauri.emit("aurora:config-changed", { root: "/repo/x" });
    tauri.emit("aurora:config-changed", { root: "/repo/x" });
    tauri.emit("aurora:config-changed", { root: "/repo/x" });

    await new Promise((r) => setTimeout(r, 400)); // > DEBOUNCE_MS
    expect(reloaded).toEqual(["/repo/x"]); // coalesced to one
    unlisten();
  });

  it("reloads two different roots independently", async () => {
    const reloaded: string[] = [];
    const unlisten = await startConfigWatch((root) => {
      reloaded.push(root);
    });

    tauri.emit("aurora:config-changed", { root: "/repo/a" });
    tauri.emit("aurora:config-changed", { root: "/repo/b" });

    await new Promise((r) => setTimeout(r, 400));
    expect(reloaded.sort()).toEqual(["/repo/a", "/repo/b"]);
    unlisten();
  });
});
