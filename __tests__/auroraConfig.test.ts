// Coverage for src/lib/auroraConfig.ts — the committed `aurora.json` typed
// config: parse/validate/repair, serialize, round-trip, file IO, and the
// committed-vs-legacy load-precedence decision (managed-server-lifecycle 1.5).
//
// Reshaped for the corrected model ("1 command → 1 pane, 1 run script →
// multiple commands"): `scripts.run` is now an ORDERED ARRAY of `RunCommand`
// (`{command, cwd?, name?}`), not a Record keyed by script id — and
// `run_mode` no longer exists (a flat list is always launched concurrently).

import { describe, it, expect, mock, beforeEach } from "bun:test";

const reads: Record<string, string | null> = {};
const writes: Array<{ root: string; path: string; content: string }> = [];
mock.module("../src/lib/sys", () => ({
  readTextFile: (path: string) => Promise.resolve(reads[path] ?? null),
  writeTextFile: (root: string, path: string, content: string) => {
    writes.push({ root, path, content });
    return Promise.resolve();
  },
}));

import {
  AURORA_CONFIG_FILENAME,
  defaultAuroraConfig,
  loadAuroraConfig,
  parseAuroraConfig,
  resolveConfigSource,
  saveAuroraConfig,
  serializeAuroraConfig,
  type AuroraConfig,
} from "../src/lib/auroraConfig";

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  writes.length = 0;
});

describe("defaultAuroraConfig", () => {
  it("is a fresh, empty, valid config", () => {
    expect(defaultAuroraConfig()).toEqual({
      version: 1,
      scripts: { setup: null, run: [], custom: {}, archive: null },
    });
  });
});

describe("parseAuroraConfig — valid input", () => {
  it("parses a full config with setup/run/custom/archive", () => {
    const text = JSON.stringify({
      version: 1,
      scripts: {
        setup: "bun install",
        run: [
          { command: "bun run dev -p $AURORA_PORT", cwd: ".", name: "web" },
          { command: "bun run api" },
        ],
        custom: {
          lint: { command: "bun run lint" },
        },
        archive: "bun run clean",
      },
    });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.config).toEqual({
      version: 1,
      scripts: {
        setup: "bun install",
        run: [
          { command: "bun run dev -p $AURORA_PORT", cwd: ".", name: "web" },
          { command: "bun run api" },
        ],
        custom: {
          lint: { command: "bun run lint" },
        },
        archive: "bun run clean",
      },
    });
  });

  it("accepts setup/archive as string[] (multi-command)", () => {
    const text = JSON.stringify({
      version: 1,
      scripts: { setup: ["bun install", "bun run codegen"], run: [], custom: {}, archive: null },
    });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(true);
    expect(result.config.scripts.setup).toEqual(["bun install", "bun run codegen"]);
  });

  it("cwd/name are omitted (not defaulted) when absent, for both run and custom", () => {
    const text = JSON.stringify({ scripts: { run: [{ command: "vite" }], custom: { lint: { command: "eslint" } } } });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(true);
    expect(result.config.scripts.run).toEqual([{ command: "vite" }]);
    expect(result.config.scripts.custom.lint).toEqual({ command: "eslint" });
  });

  it("custom is {} and run is [] when absent from the input", () => {
    const text = JSON.stringify({ scripts: {} });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(true);
    expect(result.config.scripts.custom).toEqual({});
    expect(result.config.scripts.run).toEqual([]);
  });

  it("run entries keep their declared order", () => {
    const text = JSON.stringify({ scripts: { run: [{ command: "a" }, { command: "b" }, { command: "c" }] } });
    const result = parseAuroraConfig(text);
    expect(result.config.scripts.run.map((r) => r.command)).toEqual(["a", "b", "c"]);
  });
});

describe("parseAuroraConfig — malformed input never throws, always repairs", () => {
  it("invalid JSON syntax → default config + a non-null error", () => {
    const result = parseAuroraConfig("{not json");
    expect(result.ok).toBe(false);
    expect(result.config).toEqual(defaultAuroraConfig());
    expect(result.error).toContain("invalid JSON");
  });

  it("top-level non-object → default config + error", () => {
    const result = parseAuroraConfig(JSON.stringify([1, 2, 3]));
    expect(result.ok).toBe(false);
    expect(result.config).toEqual(defaultAuroraConfig());
  });

  it("missing scripts object → default config + error", () => {
    const result = parseAuroraConfig(JSON.stringify({ version: 1 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scripts");
  });

  it("a run entry with no command is dropped, siblings survive their position", () => {
    const text = JSON.stringify({
      scripts: { run: [{ cwd: "x" }, { command: "vite" }] },
    });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.run).toEqual([{ command: "vite" }]);
    expect(result.error).toContain("scripts.run[0]");
  });

  it("scripts.setup of the wrong type is dropped to null and reported", () => {
    const text = JSON.stringify({ scripts: { setup: 42, run: [] } });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.setup).toBeNull();
    expect(result.error).toContain("scripts.setup");
  });

  it("scripts.run of the wrong type (object, not array) is ignored, empty run list returned", () => {
    const text = JSON.stringify({ scripts: { run: { web: { command: "vite" } } } });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.run).toEqual([]);
    expect(result.error).toContain("scripts.run");
  });

  it("a non-object run entry is dropped", () => {
    const text = JSON.stringify({ scripts: { run: ["not-an-object", { command: "vite" }] } });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.run).toEqual([{ command: "vite" }]);
  });

  it("a custom entry with no command is dropped, siblings survive (same repair rule as run)", () => {
    const text = JSON.stringify({
      scripts: { custom: { broken: { cwd: "x" }, lint: { command: "eslint" } } },
    });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.custom.broken).toBeUndefined();
    expect(result.config.scripts.custom.lint).toBeDefined();
    expect(result.error).toContain("scripts.custom.broken");
  });

  it("scripts.custom of the wrong type (array) is ignored, empty custom map returned", () => {
    const text = JSON.stringify({ scripts: { custom: ["not", "a", "map"] } });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.custom).toEqual({});
    expect(result.error).toContain("scripts.custom");
  });

  it("run and custom are validated independently — a broken run entry doesn't drop a valid custom entry", () => {
    const text = JSON.stringify({
      scripts: { run: ["not-an-object"], custom: { lint: { command: "eslint" } } },
    });
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(false);
    expect(result.config.scripts.run).toEqual([]);
    expect(result.config.scripts.custom.lint).toEqual({ command: "eslint" });
  });
});

describe("serializeAuroraConfig round-trip", () => {
  it("parse(serialize(config)) reproduces the same config, including custom entries", () => {
    const config: AuroraConfig = {
      version: 1,
      scripts: {
        setup: "bun install",
        run: [{ command: "bun run dev", cwd: "apps/web", name: "web" }],
        custom: { lint: { command: "bun run lint" } },
        archive: ["bun run clean"],
      },
    };
    const text = serializeAuroraConfig(config);
    expect(text.endsWith("\n")).toBe(true);
    const result = parseAuroraConfig(text);
    expect(result.ok).toBe(true);
    expect(result.config).toEqual(config);
  });

  it("round-trips the default (empty) config", () => {
    const text = serializeAuroraConfig(defaultAuroraConfig());
    expect(parseAuroraConfig(text).config).toEqual(defaultAuroraConfig());
  });

  describe("envFiles — per-workspace env files materialized on create", () => {
    it("parses a valid top-level envFiles array", () => {
      const result = parseAuroraConfig(
        JSON.stringify({
          version: 1,
          scripts: { setup: null, run: [], custom: {}, archive: null },
          envFiles: [{ path: "apps/api/.env.local", content: "PORT=${port:3000}\n" }],
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.config.envFiles).toEqual([
        { path: "apps/api/.env.local", content: "PORT=${port:3000}\n" },
      ]);
    });

    it("leaves envFiles undefined when absent (no schema churn for existing configs)", () => {
      const result = parseAuroraConfig(
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], custom: {}, archive: null } }),
      );
      expect(result.ok).toBe(true);
      expect(result.config.envFiles).toBeUndefined();
    });

    it("drops a malformed entry, reports it, and keeps its siblings", () => {
      const result = parseAuroraConfig(
        JSON.stringify({
          version: 1,
          scripts: { setup: null, run: [], custom: {}, archive: null },
          envFiles: [
            { path: "good.env", content: "A=1" },
            { path: "", content: "B=2" },
            { path: "no-content.env" },
            "nonsense",
          ],
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("envFiles");
      expect(result.config.envFiles).toEqual([{ path: "good.env", content: "A=1" }]);
    });

    it("ignores a non-array envFiles rather than crashing", () => {
      const result = parseAuroraConfig(
        JSON.stringify({
          version: 1,
          scripts: { setup: null, run: [], custom: {}, archive: null },
          envFiles: { path: "x" },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.config.envFiles).toBeUndefined();
    });

    it("round-trips envFiles through serialize → parse", () => {
      const config = defaultAuroraConfig();
      config.envFiles = [{ path: "apps/welcomer/.env.local", content: "URL=http://localhost:${port:3000}/api\n" }];
      expect(parseAuroraConfig(serializeAuroraConfig(config)).config).toEqual(config);
    });
  });

  it("serializes scripts keys in a stable order: setup, run, custom, archive", () => {
    const config = defaultAuroraConfig();
    config.scripts.run = [{ command: "vite" }];
    config.scripts.custom = { lint: { command: "eslint" } };
    const text = serializeAuroraConfig(config);
    const scriptsKeyLine = (key: string) => text.indexOf(`"${key}"`);
    expect(scriptsKeyLine("setup")).toBeGreaterThan(-1);
    expect(scriptsKeyLine("run")).toBeGreaterThan(scriptsKeyLine("setup"));
    expect(scriptsKeyLine("custom")).toBeGreaterThan(scriptsKeyLine("run"));
    expect(scriptsKeyLine("archive")).toBeGreaterThan(scriptsKeyLine("custom"));
  });
});

describe("loadAuroraConfig", () => {
  it("resolves {config: null, error: null} when the file doesn't exist", async () => {
    const result = await loadAuroraConfig("/repo/aurora");
    expect(result).toEqual({ config: null, error: null });
  });

  it("reads and parses an existing valid file", async () => {
    reads[`/repo/aurora/${AURORA_CONFIG_FILENAME}`] = JSON.stringify({
      scripts: { setup: "bun install", run: [], archive: null },
    });
    const result = await loadAuroraConfig("/repo/aurora");
    expect(result.error).toBeNull();
    expect(result.config?.scripts.setup).toBe("bun install");
  });

  it("surfaces a parse error without crashing, still returns a usable config", async () => {
    reads[`/repo/aurora/${AURORA_CONFIG_FILENAME}`] = "{ not valid json !!";
    const result = await loadAuroraConfig("/repo/aurora");
    expect(result.error).toContain("invalid JSON");
    expect(result.config).toEqual(defaultAuroraConfig());
  });
});

describe("saveAuroraConfig", () => {
  it("writes the serialized config to the ABSOLUTE <root>/aurora.json path", async () => {
    // Regression: the Rust `write_text_file(root, path, content)` treats `path`
    // as the full target (it must resolve inside `root`), so `path` MUST be the
    // absolute `<root>/aurora.json`. A bare relative filename makes Rust's
    // `Path::parent()` empty → `create_dir_all("")` → ENOENT ("os error 2"),
    // which is what surfaced in the Save-as-aurora.json banner live.
    const config = defaultAuroraConfig();
    config.scripts.setup = "bun install";
    await saveAuroraConfig("/repo/aurora", config);
    expect(writes).toEqual([
      { root: "/repo/aurora", path: `/repo/aurora/${AURORA_CONFIG_FILENAME}`, content: serializeAuroraConfig(config) },
    ]);
    // The written path resolves inside the root (the containment the Rust guard enforces).
    expect(writes[0].path.startsWith(writes[0].root + "/")).toBe(true);
  });
});

describe("resolveConfigSource — committed always wins over legacy", () => {
  const committed: AuroraConfig = { ...defaultAuroraConfig(), scripts: { ...defaultAuroraConfig().scripts, setup: "committed" } };
  const legacy: AuroraConfig = { ...defaultAuroraConfig(), scripts: { ...defaultAuroraConfig().scripts, setup: "legacy" } };

  it("committed present → committed, regardless of legacy", () => {
    expect(resolveConfigSource(committed, legacy)).toEqual({ config: committed, source: "committed" });
    expect(resolveConfigSource(committed, null)).toEqual({ config: committed, source: "committed" });
  });

  it("no committed, legacy present → legacy", () => {
    expect(resolveConfigSource(null, legacy)).toEqual({ config: legacy, source: "legacy" });
  });

  it("neither present → default", () => {
    expect(resolveConfigSource(null, null)).toEqual({ config: defaultAuroraConfig(), source: "default" });
  });
});
