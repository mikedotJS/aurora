// Coverage for src/lib/envFiles.ts — the Conductor-style per-workspace env-file
// materialization: the pure template renderer (${port:BASE}/${offset}/${workspace}),
// the path-escape guard, and the best-effort materialize orchestration.

import { describe, it, expect, mock, beforeEach } from "bun:test";

// materializeEnvFiles → writeTextFile → invoke; mock the Tauri bridge so we can
// assert what would be written without a backend.
const writes: Array<{ path: string; content: string }> = [];
mock.module("../src/lib/sys", () => ({
  writeTextFile: (_root: string, path: string, content: string) => {
    if (path.includes("BOOM")) return Promise.reject(new Error("nope"));
    writes.push({ path, content });
    return Promise.resolve();
  },
}));

import { renderEnvContent, resolveEnvPath, materializeEnvFiles } from "../src/lib/envFiles";

beforeEach(() => {
  writes.length = 0;
});

describe("renderEnvContent", () => {
  it("adds the offset to a ${port:BASE} token", () => {
    expect(renderEnvContent("PORT=${port:3000}", { offset: 10, workspace: "ws" })).toBe("PORT=3010");
  });

  it("offset 0 leaves the base port unchanged", () => {
    expect(renderEnvContent("PORT=${port:3000}", { offset: 0, workspace: "ws" })).toBe("PORT=3000");
  });

  it("substitutes multiple different bases and ${offset}", () => {
    const out = renderEnvContent(
      "API=${port:3000}\nWEB=${port:4200}\nOFF=${offset}",
      { offset: 20, workspace: "ws" },
    );
    expect(out).toBe("API=3020\nWEB=4220\nOFF=20");
  });

  it("substitutes ${workspace} (namespacing) everywhere it appears", () => {
    const out = renderEnvContent(
      "COMPOSE_PROJECT_NAME=odyssey-${workspace}\nDB=${workspace}_db",
      { offset: 10, workspace: "feat-welcomer" },
    );
    expect(out).toBe("COMPOSE_PROJECT_NAME=odyssey-feat-welcomer\nDB=feat-welcomer_db");
  });

  it("leaves unknown ${...} tokens untouched (never silently blanks them)", () => {
    expect(renderEnvContent("X=${FOO}", { offset: 10, workspace: "ws" })).toBe("X=${FOO}");
  });

  it("renders the ClubMed api gap the way the fix intends", () => {
    const api = renderEnvContent("PORT=${port:3000}\n", { offset: 10, workspace: "feat-x" });
    const web = renderEnvContent("NEXT_PUBLIC_API_URL=http://localhost:${port:3000}/api\n", {
      offset: 10,
      workspace: "feat-x",
    });
    expect(api).toBe("PORT=3010\n");
    expect(web).toBe("NEXT_PUBLIC_API_URL=http://localhost:3010/api\n");
  });
});

describe("resolveEnvPath", () => {
  it("joins a normal relative path under the dir", () => {
    expect(resolveEnvPath("/ws/dir", "apps/api/.env.local")).toBe("/ws/dir/apps/api/.env.local");
  });

  it("strips a leading ./ and a trailing slash on dir", () => {
    expect(resolveEnvPath("/ws/dir/", "./.env")).toBe("/ws/dir/.env");
  });

  it("rejects an absolute path (escape)", () => {
    expect(resolveEnvPath("/ws/dir", "/etc/passwd")).toBeNull();
  });

  it("rejects a path with a .. segment (escape)", () => {
    expect(resolveEnvPath("/ws/dir", "../../secret")).toBeNull();
    expect(resolveEnvPath("/ws/dir", "apps/../../x")).toBeNull();
  });

  it("rejects an empty/blank path", () => {
    expect(resolveEnvPath("/ws/dir", "   ")).toBeNull();
  });
});

describe("materializeEnvFiles", () => {
  it("renders + writes each spec under the workspace dir", async () => {
    const results = await materializeEnvFiles(
      "/ws/dir",
      [
        { path: "apps/api/.env.local", content: "PORT=${port:3000}\n" },
        { path: "apps/web/.env.local", content: "WS=${workspace}\n" },
      ],
      { offset: 10, workspace: "feat-x" },
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(writes).toEqual([
      { path: "/ws/dir/apps/api/.env.local", content: "PORT=3010\n" },
      { path: "/ws/dir/apps/web/.env.local", content: "WS=feat-x\n" },
    ]);
  });

  it("skips blank-path specs silently", async () => {
    const results = await materializeEnvFiles(
      "/ws/dir",
      [{ path: "  ", content: "PORT=${port:3000}" }],
      { offset: 10, workspace: "ws" },
    );
    expect(results).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("reports an escaping path as a failure without throwing", async () => {
    const results = await materializeEnvFiles(
      "/ws/dir",
      [{ path: "../escape", content: "x" }],
      { offset: 10, workspace: "ws" },
    );
    expect(results).toEqual([{ path: "../escape", ok: false, error: "path escapes the workspace" }]);
    expect(writes).toHaveLength(0);
  });

  it("isolates a write failure to its own spec (others still written)", async () => {
    const results = await materializeEnvFiles(
      "/ws/dir",
      [
        { path: "good/.env", content: "A=1" },
        { path: "BOOM/.env", content: "B=2" },
      ],
      { offset: 0, workspace: "ws" },
    );
    expect(results.find((r) => r.path === "good/.env")?.ok).toBe(true);
    const bad = results.find((r) => r.path === "BOOM/.env");
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toContain("nope");
    expect(writes).toEqual([{ path: "/ws/dir/good/.env", content: "A=1" }]);
  });
});
