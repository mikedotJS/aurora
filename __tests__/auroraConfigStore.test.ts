// Coverage suite for src/lib/auroraConfigStore.ts (managed-server-lifecycle
// task 1.3/6.2) — the aurora.json load/cache/migration-offer wiring. Drives
// the real store + the shared tauri mock's read_text_file/write_text_file.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import {
  getCachedAuroraConfig,
  isUnmigrated,
  ensureAuroraConfigLoaded,
  invalidateAuroraConfig,
  acceptAuroraMigration,
  saveAuroraConfigEdit,
  checkMigrationOffer,
} from "../src/lib/auroraConfigStore";
import { defaultAuroraConfig } from "../src/lib/auroraConfig";

function resetStore() {
  useStore.setState(
    { auroraConfigs: {}, userScripts: {}, migrationBannerRepo: null, dismissedMigrationRepos: [] } as Partial<
      ReturnType<typeof useStore.getState>
    >,
    false,
  );
}

beforeEach(() => {
  tauri.reset();
  tauri.invoke({
    read_text_file: () => {
      throw new Error("ENOENT");
    },
  });
  resetStore();
});

describe("getCachedAuroraConfig", () => {
  it("returns the default config for null / an unloaded root", () => {
    expect(getCachedAuroraConfig(null)).toEqual(defaultAuroraConfig());
    expect(getCachedAuroraConfig("/repo")).toEqual(defaultAuroraConfig());
  });

  it("returns the cached entry once populated", () => {
    const cfg = defaultAuroraConfig();
    cfg.scripts.run = [{ command: "bun" }];
    useStore.getState().setAuroraConfig("/repo", cfg);
    expect(getCachedAuroraConfig("/repo")).toEqual(cfg);
  });
});

describe("ensureAuroraConfigLoaded", () => {
  it("a committed aurora.json wins and is cached", async () => {
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [{ command: "bun" }], custom: {}, archive: null } }),
    });
    const cfg = await ensureAuroraConfigLoaded("/repo");
    expect(cfg.scripts.run).toEqual([{ command: "bun" }]);
    expect(getCachedAuroraConfig("/repo")).toEqual(cfg);
    expect(isUnmigrated("/repo")).toBe(false);
  });

  it("falls back to a legacy-migrated config when no committed file exists (no onEnter → lands in custom, not run)", async () => {
    useStore.setState({
      userScripts: { "/repo": { scripts: [{ name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }], onEnter: null } },
    } as Partial<ReturnType<typeof useStore.getState>>);
    const cfg = await ensureAuroraConfigLoaded("/repo");
    expect(cfg.scripts.run).toEqual([]);
    expect(Object.keys(cfg.scripts.custom)).toEqual(["web"]);
    expect(isUnmigrated("/repo")).toBe(true);
  });

  it("falls back to the empty default with no committed file and no legacy scripts", async () => {
    const cfg = await ensureAuroraConfigLoaded("/repo");
    expect(cfg).toEqual(defaultAuroraConfig());
    expect(isUnmigrated("/repo")).toBe(false);
  });

  it("null root resolves the default without any IO", async () => {
    const cfg = await ensureAuroraConfigLoaded(null);
    expect(cfg).toEqual(defaultAuroraConfig());
    expect(tauri.calls().some((c) => c.cmd === "read_text_file")).toBe(false);
  });

  it("is cached — a second call for the same root does not re-read the file", async () => {
    await ensureAuroraConfigLoaded("/repo");
    const readsAfterFirst = tauri.calls().filter((c) => c.cmd === "read_text_file").length;
    await ensureAuroraConfigLoaded("/repo");
    expect(tauri.calls().filter((c) => c.cmd === "read_text_file").length).toBe(readsAfterFirst);
  });

  it("concurrent callers for the same root share one in-flight load (single read)", async () => {
    let resolveRead!: (v: string) => void;
    tauri.invoke({ read_text_file: () => new Promise((res) => (resolveRead = res)) });
    const p1 = ensureAuroraConfigLoaded("/repo");
    const p2 = ensureAuroraConfigLoaded("/repo");
    resolveRead(JSON.stringify(defaultAuroraConfig()));
    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(c2); // same resolved config object
    expect(tauri.calls().filter((c) => c.cmd === "read_text_file").length).toBe(1);
  });
});

describe("invalidateAuroraConfig", () => {
  it("drops the cache entry so the next load re-reads disk", async () => {
    await ensureAuroraConfigLoaded("/repo");
    invalidateAuroraConfig("/repo");
    expect(useStore.getState().auroraConfigs["/repo"]).toBeUndefined();
    await ensureAuroraConfigLoaded("/repo");
    expect(tauri.calls().filter((c) => c.cmd === "read_text_file").length).toBe(2);
  });
});

describe("acceptAuroraMigration", () => {
  it("writes the cached (legacy-derived) config to aurora.json and marks it committed", async () => {
    let written: { root: string; path: string; content: string } | null = null;
    tauri.invoke({
      write_text_file: (a) => {
        written = { root: a.root as string, path: a.path as string, content: a.content as string };
      },
    });
    useStore.setState({
      userScripts: { "/repo": { scripts: [{ name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }], onEnter: null } },
    } as Partial<ReturnType<typeof useStore.getState>>);
    await ensureAuroraConfigLoaded("/repo");
    expect(isUnmigrated("/repo")).toBe(true);

    await acceptAuroraMigration("/repo");

    expect(written).not.toBeNull();
    expect(written!.root).toBe("/repo");
    expect(written!.path).toBe("/repo/aurora.json"); // absolute path inside root (Rust write_text_file contract)
    // No onEnter in this fixture → "web" migrated into custom, not run (see the
    // "falls back to a legacy-migrated config" test above for the same mapping).
    expect(JSON.parse(written!.content).scripts.custom.web).toBeTruthy();
    expect(isUnmigrated("/repo")).toBe(false);
  });
});

describe("saveAuroraConfigEdit (task 5.4 — the scripts editor's Save)", () => {
  it("writes the caller's draft (not the cache), caches it, and marks the source committed", async () => {
    let written: { root: string; path: string; content: string } | null = null;
    tauri.invoke({
      write_text_file: (a) => {
        written = { root: a.root as string, path: a.path as string, content: a.content as string };
      },
    });
    // Cache starts as the (unrelated) default — proves the write uses the
    // passed-in draft, not whatever happens to be cached.
    await ensureAuroraConfigLoaded("/repo");
    const draft = defaultAuroraConfig();
    draft.scripts.setup = "bun install";
    draft.scripts.run = [{ command: "bun run dev", name: "web" }];

    await saveAuroraConfigEdit("/repo", draft);

    expect(written).not.toBeNull();
    expect(written!.root).toBe("/repo");
    expect(written!.path).toBe("/repo/aurora.json"); // absolute path inside root (Rust write_text_file contract)
    expect(JSON.parse(written!.content).scripts.setup).toBe("bun install");
    expect(getCachedAuroraConfig("/repo")).toEqual(draft);
    expect(isUnmigrated("/repo")).toBe(false); // now committed, never re-offered
  });
});

describe("checkMigrationOffer (task 6.2 — repo-open banner hook)", () => {
  it("sets migrationBannerRepo when the repo has legacy scripts but no committed aurora.json", async () => {
    useStore.setState({
      userScripts: { "/repo": { scripts: [{ name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }], onEnter: null } },
    } as Partial<ReturnType<typeof useStore.getState>>);
    await checkMigrationOffer("/repo");
    expect(useStore.getState().migrationBannerRepo).toBe("/repo");
  });

  it("does nothing when the repo has a committed aurora.json already", async () => {
    tauri.invoke({
      read_text_file: () => JSON.stringify(defaultAuroraConfig()),
    });
    await checkMigrationOffer("/repo");
    expect(useStore.getState().migrationBannerRepo).toBeNull();
  });

  it("does nothing when the repo has no scripts at all (nothing to migrate)", async () => {
    await checkMigrationOffer("/repo");
    expect(useStore.getState().migrationBannerRepo).toBeNull();
  });

  it("does not re-offer a repo the user already dismissed this session", async () => {
    useStore.setState({
      userScripts: { "/repo": { scripts: [{ name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }], onEnter: null } },
      dismissedMigrationRepos: ["/repo"],
    } as Partial<ReturnType<typeof useStore.getState>>);
    await checkMigrationOffer("/repo");
    expect(useStore.getState().migrationBannerRepo).toBeNull();
  });
});
