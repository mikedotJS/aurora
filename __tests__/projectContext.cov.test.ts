// Coverage suite for src/lib/projectContext.ts — the reusable project-context
// engine (gatherProjectContext + formatProjectContext) behind the "✦ CLAUDE ·
// SUGGESTS" prompt injection. Exercises the spec scenarios from
// openspec/changes/context-aware-suggestions/tasks.md 5.1: pnpm+nx, plain npm,
// bun/yarn, non-JS repo, non-git dir, no lockfile-body/secret reads, and the
// oversized-monorepo character budget.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { gatherProjectContext, formatProjectContext, type ProjectContext } from "../src/lib/projectContext";

beforeEach(() => {
  tauri.reset();
});

type Entry = { name: string; is_dir: boolean };

/** Build a list_dir handler keyed by exact path, defaulting to []. */
function dirMap(map: Record<string, Entry[]>) {
  return (a: Record<string, unknown>) => map[a.path as string] ?? [];
}

/** Build a read_text_file handler keyed by exact path, defaulting to null. */
function fileMap(map: Record<string, string>) {
  return (a: Record<string, unknown>) => {
    const path = a.path as string;
    return path in map ? map[path] : null;
  };
}

describe("gatherProjectContext", () => {
  it("pnpm + nx monorepo: real package manager, runner, scripts, and project/target names", async () => {
    tauri.invoke({
      git_repo_info: () => ({
        root: "/repo",
        main_root: "/repo",
        name: "repo",
        default_branch: "main",
        current_branch: "feat/x",
      }),
      git_changed_files: () => [
        { path: "apps/api/src/index.ts", old_path: null, status: "M", staged: false, added: 1, removed: 0 },
      ],
      list_dir: dirMap({
        "/repo": [
          { name: "package.json", is_dir: false },
          { name: "pnpm-lock.yaml", is_dir: false },
          { name: "nx.json", is_dir: false },
          { name: "apps", is_dir: true },
        ],
        "/repo/apps": [
          { name: "api", is_dir: true },
          { name: "welcomer", is_dir: true },
        ],
      }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({
          name: "root",
          workspaces: ["apps/*"],
          scripts: { build: "nx run-many -t build", lint: "eslint ." },
        }),
        "/repo/apps/api/project.json": JSON.stringify({ name: "api", targets: { build: {}, serve: {} } }),
        "/repo/apps/welcomer/project.json": JSON.stringify({ name: "welcomer", targets: { build: {}, serve: {} } }),
      }),
    });

    const ctx = await gatherProjectContext("/repo");

    expect(ctx.root).toBe("/repo");
    expect(ctx.toolchain?.packageManager).toBe("pnpm");
    expect(ctx.toolchain?.packageManagerAmbiguous).toBeUndefined();
    expect(ctx.toolchain?.runner).toBe("nx");
    expect(ctx.toolchain?.workspaces).toBe(true);
    expect(ctx.scripts).toEqual(["build", "lint"]);
    expect(ctx.projects).toEqual(
      expect.arrayContaining([
        { name: "api", targets: ["build", "serve"] },
        { name: "welcomer", targets: ["build", "serve"] },
      ]),
    );
    expect(ctx.git?.branch).toBe("feat/x");
    expect(ctx.git?.changedFiles).toEqual([{ path: "apps/api/src/index.ts", status: "M" }]);
    expect(ctx.git?.changedCount).toBe(1);

    const block = formatProjectContext(ctx);
    expect(block).toContain("package manager: pnpm");
    expect(block).toContain("runner: nx");
    expect(block).toContain("Scripts: build, lint");
    expect(block).toContain("api: build, serve");
    expect(block).toContain("welcomer: build, serve");
    expect(block).toContain("Branch: feat/x");
    expect(block).toContain("Changed files: M apps/api/src/index.ts");
    // The invented names from the bug report must never appear as real projects.
    expect(block).not.toContain("welcomer, api");
  });

  it("`packageManager` field takes precedence over lockfile presence", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({ "/repo": [{ name: "package-lock.json", is_dir: false }] }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({ packageManager: "pnpm@8.10.0", scripts: {} }),
      }),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain?.packageManager).toBe("pnpm");
    expect(ctx.toolchain?.packageManagerAmbiguous).toBeUndefined();
  });

  it("plain npm repo: npm + its real scripts, no runner/projects", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [{ name: "package.json", is_dir: false }, { name: "package-lock.json", is_dir: false }],
      }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({ scripts: { start: "node index.js", test: "jest" } }),
      }),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain?.packageManager).toBe("npm");
    expect(ctx.toolchain?.runner).toBeUndefined();
    expect(ctx.toolchain?.workspaces).toBe(false);
    expect(ctx.scripts).toEqual(["start", "test"]);
    expect(ctx.projects).toBeUndefined();

    const block = formatProjectContext(ctx);
    expect(block).toContain("package manager: npm");
    expect(block).toContain("Scripts: start, test");
    expect(block).not.toContain("Projects:");
  });

  it("bun repo: matches the bun lockfile", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({ "/repo": [{ name: "bun.lockb", is_dir: false }] }),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain?.packageManager).toBe("bun");
  });

  it("yarn repo: matches the yarn lockfile", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({ "/repo": [{ name: "yarn.lock", is_dir: false }] }),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain?.packageManager).toBe("yarn");
  });

  it("multiple lockfiles with no packageManager field: picks by precedence and flags ambiguous", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [{ name: "yarn.lock", is_dir: false }, { name: "package-lock.json", is_dir: false }],
      }),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain?.packageManager).toBe("yarn");
    expect(ctx.toolchain?.packageManagerAmbiguous).toBe(true);
    expect(formatProjectContext(ctx)).toContain("ambiguous");
  });

  it("non-JS repo: no toolchain/scripts/projects injected", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({ "/repo": [{ name: "Cargo.toml", is_dir: false }, { name: "Cargo.lock", is_dir: false }] }),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain).toBeUndefined();
    expect(ctx.scripts).toBeUndefined();
    expect(ctx.projects).toBeUndefined();
    expect(formatProjectContext(ctx)).toBe("");
  });

  it("non-git dir: no git section, root falls back to cwd", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({}),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/not-a-repo");
    expect(ctx.root).toBe("/not-a-repo");
    expect(ctx.git).toBeUndefined();
  });

  it("gitRepoInfo throwing is non-fatal: still returns a root/cwd-only context", async () => {
    tauri.invoke({
      git_repo_info: () => {
        throw new Error("boom");
      },
      list_dir: dirMap({}),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.root).toBe("/repo");
    expect(ctx.git).toBeUndefined();
  });

  it("a backend git_changed_files failure degrades to an empty changed-file list (gitChangedFiles itself never rejects)", async () => {
    tauri.invoke({
      git_repo_info: () => ({
        root: "/repo",
        main_root: "/repo",
        name: "repo",
        default_branch: "main",
        current_branch: "main",
      }),
      git_changed_files: () => {
        throw new Error("boom");
      },
      list_dir: dirMap({}),
      read_text_file: fileMap({}),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.git).toEqual({ branch: "main", changedFiles: [], changedCount: 0 });
  });

  it("never reads lockfile bodies or .env/secret files — only presence via list_dir", async () => {
    const readCalls: string[] = [];
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [
          { name: "package.json", is_dir: false },
          { name: "pnpm-lock.yaml", is_dir: false },
          { name: ".env", is_dir: false },
          { name: "id_rsa.key", is_dir: false },
        ],
      }),
      read_text_file: (a: Record<string, unknown>) => {
        readCalls.push(a.path as string);
        if ((a.path as string).endsWith("package.json")) return JSON.stringify({ scripts: {} });
        return null;
      },
    });
    await gatherProjectContext("/repo");
    expect(readCalls).not.toContain("/repo/pnpm-lock.yaml");
    expect(readCalls.some((p) => p.endsWith(".env"))).toBe(false);
    expect(readCalls.some((p) => p.endsWith("id_rsa.key"))).toBe(false);
  });

  it("expands workspace globs (apps/*, packages/*) and skips non-project subdirectories", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [{ name: "package.json", is_dir: false }, { name: "packages", is_dir: true }],
        "/repo/packages": [
          { name: "core", is_dir: true },
          { name: "not-a-project", is_dir: true },
          { name: "README.md", is_dir: false },
        ],
      }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({ workspaces: ["packages/*"], scripts: {} }),
        "/repo/packages/core/package.json": JSON.stringify({ name: "@repo/core" }),
      }),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.projects).toEqual([{ name: "@repo/core", targets: [] }]);
  });

  it("falls back to a directory's package.json name when project.json is absent", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [{ name: "package.json", is_dir: false }, { name: "apps", is_dir: true }],
        "/repo/apps": [{ name: "web", is_dir: true }],
      }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({ workspaces: ["apps/*"], scripts: {} }),
        "/repo/apps/web/package.json": JSON.stringify({ name: "web-app" }),
      }),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.projects).toEqual([{ name: "web-app", targets: [] }]);
  });

  it("pnpm-workspace.yaml globs are parsed when there is no workspaces field", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [
          { name: "package.json", is_dir: false },
          { name: "pnpm-workspace.yaml", is_dir: false },
          { name: "libs", is_dir: true },
        ],
        "/repo/libs": [{ name: "shared", is_dir: true }],
      }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({ scripts: {} }),
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
        "/repo/libs/shared/package.json": JSON.stringify({ name: "shared" }),
      }),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.toolchain?.workspaces).toBe(true);
    expect(ctx.projects).toEqual([{ name: "shared", targets: [] }]);
  });

  it("pnpm-workspace.yaml parsing stops at a dedented top-level key after the packages list", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({
        "/repo": [
          { name: "package.json", is_dir: false },
          { name: "pnpm-workspace.yaml", is_dir: false },
          { name: "apps", is_dir: true },
        ],
        "/repo/apps": [{ name: "web", is_dir: true }],
      }),
      read_text_file: fileMap({
        "/repo/package.json": JSON.stringify({ scripts: {} }),
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\ncatalog:\n  - 'ignored/*'\n",
        "/repo/apps/web/package.json": JSON.stringify({ name: "web" }),
      }),
    });
    const ctx = await gatherProjectContext("/repo");
    // Only the `apps/*` glob (before `catalog:`) is expanded — `ignored/*` under
    // the dedented `catalog:` key must not be picked up as a workspace glob.
    expect(ctx.projects).toEqual([{ name: "web", targets: [] }]);
  });

  it("a malformed root package.json is swallowed — no throw, no toolchain from it", async () => {
    tauri.invoke({
      git_repo_info: () => null,
      list_dir: dirMap({ "/repo": [{ name: "package.json", is_dir: false }] }),
      read_text_file: fileMap({ "/repo/package.json": "{ not valid json" }),
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx.scripts).toBeUndefined();
  });

  it("gatherProjectContext never throws even when every bridge rejects", async () => {
    tauri.invoke({
      git_repo_info: () => {
        throw new Error("x");
      },
      list_dir: () => {
        throw new Error("x");
      },
      read_text_file: () => {
        throw new Error("x");
      },
      git_changed_files: () => {
        throw new Error("x");
      },
    });
    const ctx = await gatherProjectContext("/repo");
    expect(ctx).toEqual({ root: "/repo", cwd: "/repo" });
  });
});

describe("formatProjectContext", () => {
  it("returns '' when there is nothing useful to inject", () => {
    const ctx: ProjectContext = { root: "/repo", cwd: "/repo" };
    expect(formatProjectContext(ctx)).toBe("");
  });

  it("shows an '+N more' marker when changed files exceed the cap", () => {
    const ctx: ProjectContext = {
      root: "/repo",
      cwd: "/repo",
      git: {
        branch: "main",
        changedFiles: [{ path: "a.ts", status: "M" }],
        changedCount: 5,
      },
    };
    const block = formatProjectContext(ctx);
    expect(block).toContain("Changed files: M a.ts (+4 more)");
  });

  it("truncates an oversized block with a marker and stays within the character budget", () => {
    const projects = Array.from({ length: 30 }, (_, i) => ({
      name: `pkg-${i}-${"x".repeat(60)}`,
      targets: Array.from({ length: 12 }, (_, j) => `target-${j}-${"y".repeat(20)}`),
    }));
    const ctx: ProjectContext = { root: "/repo", cwd: "/repo", projects };
    const block = formatProjectContext(ctx);
    expect(block).toContain("…[project context truncated]");
    // Budget (4000) + marker length, with slack for the marker itself.
    expect(block.length).toBeLessThan(4000 + 40);
  });
});
