// Coverage suite for src/lib/scriptsMigration.ts (managed-server-lifecycle
// task 6.1/6.4, reshaped for the corrected model: "1 command → 1 pane, 1 run
// script → multiple commands") — pure legacy RepoScripts -> AuroraConfig
// mapping. No store, no Tauri: repoScriptsToAuroraConfig takes plain data in,
// returns plain data out.
//
// New model: the legacy `onEnter` script (if any) becomes the Run Script's
// ORDERED command list (`scripts.run: RunCommand[]`) — one RunCommand per
// task when it was a `split` script, else a single `&&`-chained command
// carrying the script's name. EVERY OTHER legacy script becomes a `custom`
// entry — an on-demand script the user triggers individually, never
// auto-launched. With no `onEnter` match, `run` stays empty and every legacy
// script lands in `custom`.

import { describe, it, expect } from "bun:test";
import { repoScriptsToAuroraConfig, scriptToRunCommands, scriptToCustomEntries } from "../src/lib/scriptsMigration";
import type { RepoScripts } from "../src/state/store";

describe("repoScriptsToAuroraConfig", () => {
  it("returns null for undefined input", () => {
    expect(repoScriptsToAuroraConfig(undefined)).toBeNull();
  });

  it("returns null when there are no scripts at all", () => {
    const rs: RepoScripts = { scripts: [], onEnter: null };
    expect(repoScriptsToAuroraConfig(rs)).toBeNull();
  });

  it("the onEnter script becomes the Run Script's command list; every OTHER script becomes a custom entry", () => {
    const rs: RepoScripts = {
      onEnter: "dev",
      scripts: [
        { name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "nx serve api" }] },
        { name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.setup).toBeNull();
    expect(cfg.scripts.run).toEqual([{ command: "nx serve api", name: "dev" }]);
    expect(Object.keys(cfg.scripts.custom)).toEqual(["web"]); // NOT run — on-demand only
    expect(cfg.scripts.custom.web.command).toBe("bun run dev");
  });

  it("no onEnter → run stays EMPTY, every legacy script lands in custom", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [
        { name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] },
        { name: "lint", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run lint" }] },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.run).toEqual([]);
    expect(Object.keys(cfg.scripts.custom).sort()).toEqual(["lint", "web"]);
  });

  it("every non-onEnter script becomes a custom.<slug> entry with a slugified id", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [{ name: "Web Server!", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(Object.keys(cfg.scripts.custom)).toEqual(["web-server"]);
    expect(cfg.scripts.custom["web-server"]).toEqual({ command: "bun run dev" });
    expect(cfg.scripts.run).toEqual([]);
  });

  it("multiple non-empty tasks (non-split) join with && into one command, whether run or custom", () => {
    const rs: RepoScripts = {
      onEnter: "web",
      scripts: [
        {
          name: "web",
          desc: "",
          split: false,
          tasks: [
            { dir: "", cmd: "bun install" },
            { dir: "apps/web", cmd: "bun run dev" },
          ],
        },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.run[0].command).toBe("bun install && cd apps/web && bun run dev");
  });

  it("drops empty-command tasks when joining", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [
        { name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "" }, { dir: "", cmd: "bun run dev" }] },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.custom.web.command).toBe("bun run dev");
  });

  it("a script whose tasks are all empty is skipped entirely (no entry, no crash)", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [{ name: "empty", desc: "", split: false, tasks: [{ dir: "", cmd: "" }] }],
    };
    expect(repoScriptsToAuroraConfig(rs)).toBeNull();
  });

  it("a split onEnter script with >1 non-empty tasks maps to ONE RunCommand PER task (concurrent processes, not one chain), name dropped", () => {
    const rs: RepoScripts = {
      onEnter: "dev",
      scripts: [
        {
          name: "dev",
          desc: "",
          split: true,
          tasks: [
            { dir: "apps/web", cmd: "bun run dev" },
            { dir: "apps/api", cmd: "bun run api" },
          ],
        },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.run).toEqual([
      { command: "cd apps/web && bun run dev" },
      { command: "cd apps/api && bun run api" },
    ]);
  });

  it("a split NON-onEnter script with >1 non-empty tasks maps to one CUSTOM entry per task", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [
        {
          name: "dev",
          desc: "",
          split: true,
          tasks: [
            { dir: "apps/web", cmd: "bun run dev" },
            { dir: "apps/api", cmd: "bun run api" },
          ],
        },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.run).toEqual([]);
    expect(Object.keys(cfg.scripts.custom)).toEqual(["dev-1", "dev-2"]);
  });

  it("a split script with exactly 1 non-empty task collapses to a single (non-split) entry", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [{ name: "dev", desc: "", split: true, tasks: [{ dir: "", cmd: "" }, { dir: "", cmd: "bun run dev" }] }],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(Object.keys(cfg.scripts.custom)).toEqual(["dev"]);
  });

  it("name collisions across scripts are auto-suffixed (build, build-2) in custom", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [
        { name: "build", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run build" }] },
        { name: "build", desc: "", split: false, tasks: [{ dir: "", cmd: "make build" }] },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.run).toEqual([]);
    expect(Object.keys(cfg.scripts.custom)).toEqual(["build", "build-2"]);
  });

  it("both scripts sharing the onEnter NAME both count as onEnter (name-based match, not identity) — both land in run, in order", () => {
    const rs: RepoScripts = {
      onEnter: "build",
      scripts: [
        { name: "build", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run build" }] },
        { name: "build", desc: "", split: false, tasks: [{ dir: "", cmd: "make build" }] },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.run).toEqual([
      { command: "bun run build", name: "build" },
      { command: "make build", name: "build" },
    ]);
    expect(cfg.scripts.custom).toEqual({});
  });

  it("archive stays null — no legacy equivalent exists", () => {
    const rs: RepoScripts = {
      onEnter: null,
      scripts: [{ name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }],
    };
    expect(repoScriptsToAuroraConfig(rs)!.scripts.archive).toBeNull();
  });

  it("setup stays null — no legacy equivalent exists (no more install-inference to shadow)", () => {
    const rs: RepoScripts = {
      onEnter: "dev",
      scripts: [{ name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }],
    };
    expect(repoScriptsToAuroraConfig(rs)!.scripts.setup).toBeNull();
  });

  it("an onEnter name that doesn't match any script is ignored (run stays empty, script lands in custom, no crash)", () => {
    const rs: RepoScripts = {
      onEnter: "nonexistent",
      scripts: [{ name: "web", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] }],
    };
    const cfg = repoScriptsToAuroraConfig(rs)!;
    expect(cfg.scripts.setup).toBeNull();
    expect(cfg.scripts.run).toEqual([]);
    expect(Object.keys(cfg.scripts.custom)).toEqual(["web"]);
  });
});

describe("scriptToRunCommands", () => {
  it("a non-split script carries its script name onto the single RunCommand", () => {
    const cmds = scriptToRunCommands({ name: "Dev Server", desc: "", split: false, tasks: [{ dir: "", cmd: "bun run dev" }] });
    expect(cmds).toEqual([{ command: "bun run dev", name: "Dev Server" }]);
  });

  it("returns [] for a script with no non-empty tasks", () => {
    expect(scriptToRunCommands({ name: "empty", desc: "", split: false, tasks: [{ dir: "", cmd: "" }] })).toEqual([]);
  });
});

describe("scriptToCustomEntries", () => {
  it("suffixes ids against the caller's taken set", () => {
    const taken = new Set(["dev"]);
    const entries = scriptToCustomEntries({ name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "x" }] }, taken);
    expect(entries).toEqual([["dev-2", { command: "x" }]]);
    expect(taken.has("dev-2")).toBe(true);
  });
});
