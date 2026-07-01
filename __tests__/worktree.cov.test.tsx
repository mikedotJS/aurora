// Coverage suite for src/lib/worktree.ts — Rust git-worktree command bridges.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { worktreeList, worktreeAdd, worktreeSafety, worktreeRemove, type Worktree } from "../src/lib/worktree";

beforeEach(() => {
  tauri.reset();
});

describe("worktreeList", () => {
  it("returns the parsed worktree list on success", async () => {
    const list: Worktree[] = [{ path: "/repo", branch: "main", head: "abc123" }];
    tauri.invoke({ worktree_list: () => list });
    const res = await worktreeList("/repo");
    expect(res).toEqual(list);
    expect(tauri.lastCall("worktree_list")?.args).toEqual({ root: "/repo" });
  });

  it("swallows a backend error and resolves []", async () => {
    tauri.invoke({
      worktree_list: () => {
        throw new Error("not a repo");
      },
    });
    expect(await worktreeList("/nope")).toEqual([]);
  });
});

describe("worktreeAdd", () => {
  it("resolves { ok: true, worktree } on success, forwarding all args", async () => {
    const wt: Worktree = { path: "/repo/.aurora-worktrees/feat-x", branch: "feat/x", head: null };
    tauri.invoke({ worktree_add: () => wt });
    const res = await worktreeAdd("/repo", "/repo/.aurora-worktrees/feat-x", "feat/x", "main", true);
    expect(res).toEqual({ ok: true, worktree: wt });
    expect(tauri.lastCall("worktree_add")?.args).toEqual({
      root: "/repo",
      dir: "/repo/.aurora-worktrees/feat-x",
      branch: "feat/x",
      base: "main",
      newBranch: true,
    });
  });

  it("resolves { ok: false, error } when the backend rejects", async () => {
    tauri.invoke({
      worktree_add: () => {
        throw new Error("branch already exists");
      },
    });
    const res = await worktreeAdd("/repo", "/dir", "feat/x", "main", false);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("branch already exists");
  });
});

describe("worktreeSafety", () => {
  it("maps snake_case has_upstream to camelCase hasUpstream", async () => {
    tauri.invoke({
      git_worktree_safety: () => ({ dirty: true, ahead: 2, has_upstream: false }),
    });
    const res = await worktreeSafety("/repo/wt");
    expect(res).toEqual({ dirty: true, ahead: 2, hasUpstream: false });
    expect(tauri.lastCall("git_worktree_safety")?.args).toEqual({ dir: "/repo/wt" });
  });

  it("reflects a clean worktree with an upstream", async () => {
    tauri.invoke({
      git_worktree_safety: () => ({ dirty: false, ahead: 0, has_upstream: true }),
    });
    expect(await worktreeSafety("/repo/wt")).toEqual({ dirty: false, ahead: 0, hasUpstream: true });
  });
});

describe("worktreeRemove", () => {
  it("resolves { ok: true } on success and defaults force to false", async () => {
    tauri.invoke({ worktree_remove: () => undefined });
    const res = await worktreeRemove("/repo", "/repo/wt");
    expect(res).toEqual({ ok: true });
    expect(tauri.lastCall("worktree_remove")?.args).toEqual({ root: "/repo", dir: "/repo/wt", force: false });
  });

  it("forwards force=true when passed explicitly", async () => {
    tauri.invoke({ worktree_remove: () => undefined });
    await worktreeRemove("/repo", "/repo/wt", true);
    expect(tauri.lastCall("worktree_remove")?.args).toEqual({ root: "/repo", dir: "/repo/wt", force: true });
  });

  it("resolves { ok: false, error } when the backend rejects", async () => {
    tauri.invoke({
      worktree_remove: () => {
        throw new Error("dirty worktree");
      },
    });
    const res = await worktreeRemove("/repo", "/repo/wt", true);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("dirty worktree");
  });
});
