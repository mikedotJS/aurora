// Coverage suite for src/lib/aiScripts.ts — repo signal gathering, the
// model-response validator (parseScripts), the generate pipeline, and adoption.
import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import { scriptsForRoot } from "../src/lib/scripts";
import { NoKeyError } from "../src/ai/suggest";
import { gatherRepoSignals, parseScripts, generateRepoScripts, adoptGeneratedScripts } from "../src/lib/aiScripts";

beforeEach(() => {
  tauri.reset();
  useStore.setState({ userScripts: {} }, false);
});

// ---------------------------------------------------------------------------
// gatherRepoSignals
// ---------------------------------------------------------------------------

describe("gatherRepoSignals", () => {
  it("lists root files, detects package managers, filters secrets, and includes non-blank manifest bodies", async () => {
    tauri.invoke({
      list_dir: () => [
        { name: "package.json", is_dir: false },
        { name: "bun.lockb", is_dir: false },
        { name: "pnpm-lock.yaml", is_dir: false },
        { name: ".env", is_dir: false },
        { name: "my.secret.txt", is_dir: false },
        { name: "creds.pem", is_dir: false },
        { name: "id_rsa.key", is_dir: false },
        { name: "Makefile", is_dir: false },
        { name: "src", is_dir: true },
      ],
      read_text_file: (a: Record<string, unknown>) => {
        const path = a.path as string;
        if (path.endsWith("package.json")) return '{"name":"aurora"}';
        if (path.endsWith("Makefile")) return "   "; // blank after trim -> excluded
        return "";
      },
    });
    const out = await gatherRepoSignals("/repo");
    expect(out).toContain("# Repo root files");
    expect(out).not.toContain(".env");
    expect(out).not.toContain("my.secret.txt");
    expect(out).not.toContain("creds.pem");
    expect(out).not.toContain("id_rsa.key");
    expect(out).toContain("bun, pnpm");
    expect(out).toContain("# package.json");
    expect(out).toContain('{"name":"aurora"}');
    expect(out).not.toContain("# Makefile");
    expect(tauri.lastCall("list_dir")?.args).toEqual({ path: "/repo", includeHidden: true });
    expect(tauri.calls().some((c) => c.cmd === "read_text_file" && c.args.path === "/repo/package.json")).toBe(true);
  });

  it("omits the package-manager section when no lockfile is present, and includes a plain manifest like README.md", async () => {
    tauri.invoke({
      list_dir: () => [{ name: "README.md", is_dir: false }],
      read_text_file: () => "hello there",
    });
    const out = await gatherRepoSignals("/repo");
    expect(out).not.toContain("# Package managers");
    expect(out).toContain("# README.md");
    expect(out).toContain("hello there");
  });

  it("returns just the root-files section when the directory is empty", async () => {
    tauri.invoke({ list_dir: () => [], read_text_file: () => "" });
    const out = await gatherRepoSignals("/empty");
    expect(out).toBe("# Repo root files\n");
  });
});

// ---------------------------------------------------------------------------
// parseScripts
// ---------------------------------------------------------------------------

describe("parseScripts", () => {
  it("parses a clean JSON array", () => {
    const out = parseScripts(
      JSON.stringify([{ name: "dev", desc: "run dev", split: false, tasks: [{ dir: "", cmd: "vite" }] }]),
    );
    expect(out).toEqual([{ name: "dev", desc: "run dev", split: false, tasks: [{ dir: "", cmd: "vite" }] }]);
  });

  it("strips a ```json fence and surrounding prose", () => {
    const text =
      "Sure, here you go:\n```json\n" +
      JSON.stringify([{ name: "build", tasks: [{ cmd: "npm run build" }] }]) +
      "\n```\nHope that helps!";
    const out = parseScripts(text);
    expect(out).toEqual([{ name: "build", desc: "", split: false, tasks: [{ dir: "", cmd: "npm run build" }] }]);
  });

  it("throws when the response isn't parseable JSON at all", () => {
    expect(() => parseScripts("not json, sorry")).toThrow("Claude returned output that wasn't a scripts list.");
  });

  it("throws when the parsed JSON isn't an array", () => {
    expect(() => parseScripts('{"name":"dev"}')).toThrow("Claude returned output that wasn't a scripts list.");
  });

  it("drops malformed items: non-objects, blank names, non-array tasks, non-object tasks, and blank commands", () => {
    const raw = [
      null,
      42,
      { name: "  " }, // blank name
      { name: "no-tasks-field" }, // tasks missing -> []
      { name: "tasks-not-array", tasks: "nope" },
      { name: "task-not-object", tasks: [null, 5] },
      { name: "empty-cmd", tasks: [{ dir: "x", cmd: "   " }] },
      { name: "ok", tasks: [{ cmd: "echo hi" }] },
    ];
    const out = parseScripts(JSON.stringify(raw));
    expect(out).toEqual([{ name: "ok", desc: "", split: false, tasks: [{ dir: "", cmd: "echo hi" }] }]);
  });

  it("caps tasks at 6 per script and scripts at 12 total", () => {
    const manyTasks = Array.from({ length: 8 }, (_, i) => ({ cmd: `task${i}` }));
    const out1 = parseScripts(JSON.stringify([{ name: "many", tasks: manyTasks }]));
    expect(out1[0].tasks).toHaveLength(6);
    expect(out1[0].tasks.map((t) => t.cmd)).toEqual(["task0", "task1", "task2", "task3", "task4", "task5"]);

    const manyScripts = Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, tasks: [{ cmd: "x" }] }));
    const out2 = parseScripts(JSON.stringify(manyScripts));
    expect(out2).toHaveLength(12);
    expect(out2.map((s) => s.name)).toEqual(manyScripts.slice(0, 12).map((s) => s.name));
  });

  it("only sets split=true when requested AND there's more than one task", () => {
    const raw = [
      { name: "single-split-requested", split: true, tasks: [{ cmd: "one" }] },
      { name: "multi-split-requested", split: true, tasks: [{ cmd: "a" }, { cmd: "b" }] },
      { name: "multi-no-split", split: false, tasks: [{ cmd: "a" }, { cmd: "b" }] },
    ];
    const out = parseScripts(JSON.stringify(raw));
    expect(out[0].split).toBe(false);
    expect(out[1].split).toBe(true);
    expect(out[2].split).toBe(false);
  });

  it("defaults desc to empty string when missing or non-string, and trims dir/cmd", () => {
    const raw = [{ name: " padded ", desc: 7, tasks: [{ dir: " sub ", cmd: " npm run x " }] }];
    const out = parseScripts(JSON.stringify(raw));
    expect(out[0]).toEqual({ name: "padded", desc: "", split: false, tasks: [{ dir: "sub", cmd: "npm run x" }] });
  });
});

// ---------------------------------------------------------------------------
// generateRepoScripts
// ---------------------------------------------------------------------------

describe("generateRepoScripts", () => {
  it("gathers signals, asks Claude, and returns validated scripts", async () => {
    tauri.invoke({
      list_dir: () => [{ name: "package.json", is_dir: false }],
      read_text_file: () => '{"name":"aurora"}',
      claude_text: (a: Record<string, unknown>) => {
        expect(a.model).toBe("claude-sonnet-4-6");
        expect(a.maxTokens).toBe(1500);
        expect(String(a.system)).toContain("build-tooling assistant");
        expect(String(a.prompt)).toContain("Repository snapshot");
        expect(String(a.prompt)).toContain('{"name":"aurora"}');
        return JSON.stringify([{ name: "dev", tasks: [{ cmd: "npm run dev" }] }]);
      },
    });
    const out = await generateRepoScripts("/repo", "claude-sonnet-4-6");
    expect(out).toEqual([{ name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "npm run dev" }] }]);
  });

  it("propagates NoKeyError when no API key is set", async () => {
    tauri.invoke({
      list_dir: () => [],
      claude_text: () => {
        throw "no-key";
      },
    });
    await expect(generateRepoScripts("/repo", "m")).rejects.toBeInstanceOf(NoKeyError);
  });

  it("propagates a plain Error on backend failure", async () => {
    tauri.invoke({
      list_dir: () => [],
      claude_text: () => {
        throw "boom: backend exploded";
      },
    });
    await expect(generateRepoScripts("/repo", "m")).rejects.toThrow("boom: backend exploded");
  });

  it("propagates the parse error when Claude returns unusable output", async () => {
    tauri.invoke({ list_dir: () => [], claude_text: () => "nonsense, not json" });
    await expect(generateRepoScripts("/repo", "m")).rejects.toThrow(
      "Claude returned output that wasn't a scripts list.",
    );
  });
});

// ---------------------------------------------------------------------------
// adoptGeneratedScripts
// ---------------------------------------------------------------------------

describe("adoptGeneratedScripts", () => {
  it("does nothing for an empty list", () => {
    adoptGeneratedScripts("/repo", []);
    expect(scriptsForRoot("/repo")).toEqual([]);
  });

  it("appends scripts via appendScripts, suffixing name collisions", () => {
    adoptGeneratedScripts("/repo", [{ name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "vite" }] }]);
    adoptGeneratedScripts("/repo", [{ name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "vite" }] }]);
    expect(scriptsForRoot("/repo").map((s) => s.name)).toEqual(["dev", "dev-2"]);
  });
});
