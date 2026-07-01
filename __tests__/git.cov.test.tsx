// Coverage suite for src/lib/git.ts — Rust diff/staging command bridges.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import {
  gitChangedFiles,
  gitDiffFile,
  gitStage,
  gitUnstage,
  gitStageAll,
  gitDiscard,
  glabMrCreate,
  type ChangedFile,
} from "../src/lib/git";

beforeEach(() => {
  tauri.reset();
});

describe("gitChangedFiles", () => {
  it("returns the parsed list on success", async () => {
    const files: ChangedFile[] = [
      { path: "a.ts", old_path: null, status: "M", staged: false, added: 3, removed: 1 },
    ];
    tauri.invoke({ git_changed_files: () => files });
    const res = await gitChangedFiles("/repo");
    expect(res).toEqual(files);
    expect(tauri.lastCall("git_changed_files")?.args).toEqual({ dir: "/repo" });
  });

  it("swallows a backend error and resolves []", async () => {
    tauri.invoke({
      git_changed_files: () => {
        throw new Error("not a repo");
      },
    });
    expect(await gitChangedFiles("/nope")).toEqual([]);
  });
});

describe("gitDiffFile", () => {
  it("passes dir/base/path/mode and returns the diff text", async () => {
    tauri.invoke({ git_diff_file: () => "@@ -1 +1 @@\n-a\n+b\n" });
    const res = await gitDiffFile("/repo", "main", "a.ts", "worktree");
    expect(res).toContain("@@");
    expect(tauri.lastCall("git_diff_file")?.args).toEqual({
      dir: "/repo",
      base: "main",
      path: "a.ts",
      mode: "worktree",
    });
  });

  it("supports the staged and base diff modes", async () => {
    tauri.invoke({ git_diff_file: (a) => `mode:${a.mode}` });
    expect(await gitDiffFile("/repo", "main", "a.ts", "staged")).toBe("mode:staged");
    expect(await gitDiffFile("/repo", "main", "a.ts", "base")).toBe("mode:base");
  });

  it("swallows a backend error and resolves ''", async () => {
    tauri.invoke({
      git_diff_file: () => {
        throw new Error("boom");
      },
    });
    expect(await gitDiffFile("/repo", "main", "a.ts", "worktree")).toBe("");
  });
});

describe("gitStage / gitUnstage / gitStageAll / gitDiscard", () => {
  it("gitStage invokes git_stage and resolves undefined on success", async () => {
    tauri.invoke({ git_stage: () => undefined });
    await expect(gitStage("/repo", "a.ts")).resolves.toBeUndefined();
    expect(tauri.lastCall("git_stage")?.args).toEqual({ dir: "/repo", path: "a.ts" });
  });
  it("gitStage swallows a backend error", async () => {
    tauri.invoke({
      git_stage: () => {
        throw new Error("fail");
      },
    });
    await expect(gitStage("/repo", "a.ts")).resolves.toBeUndefined();
  });

  it("gitUnstage invokes git_unstage and swallows errors", async () => {
    tauri.invoke({ git_unstage: () => undefined });
    await expect(gitUnstage("/repo", "a.ts")).resolves.toBeUndefined();
    tauri.invoke({
      git_unstage: () => {
        throw new Error("fail");
      },
    });
    await expect(gitUnstage("/repo", "a.ts")).resolves.toBeUndefined();
  });

  it("gitStageAll invokes git_stage_all with dir only", async () => {
    tauri.invoke({ git_stage_all: () => undefined });
    await gitStageAll("/repo");
    expect(tauri.lastCall("git_stage_all")?.args).toEqual({ dir: "/repo" });
  });
  it("gitStageAll swallows a backend error", async () => {
    tauri.invoke({
      git_stage_all: () => {
        throw new Error("fail");
      },
    });
    await expect(gitStageAll("/repo")).resolves.toBeUndefined();
  });

  it("gitDiscard passes untracked flag through and swallows errors", async () => {
    tauri.invoke({ git_discard: () => undefined });
    await gitDiscard("/repo", "a.ts", true);
    expect(tauri.lastCall("git_discard")?.args).toEqual({ dir: "/repo", path: "a.ts", untracked: true });
    tauri.invoke({
      git_discard: () => {
        throw new Error("fail");
      },
    });
    await expect(gitDiscard("/repo", "a.ts", false)).resolves.toBeUndefined();
  });
});

describe("glabMrCreate", () => {
  it("resolves { ok: true } on success", async () => {
    tauri.invoke({ glab_mr_create: () => undefined });
    const res = await glabMrCreate("/repo", "feat/x");
    expect(res).toEqual({ ok: true });
    expect(tauri.lastCall("glab_mr_create")?.args).toEqual({ cwd: "/repo", branch: "feat/x" });
  });

  it("resolves { ok: false, error } when the backend rejects", async () => {
    tauri.invoke({
      glab_mr_create: () => {
        throw new Error("no glab token");
      },
    });
    const res = await glabMrCreate("/repo", "feat/x");
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("no glab token");
  });
});
