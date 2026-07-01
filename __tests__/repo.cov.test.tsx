// Coverage suite for src/lib/repo.ts — "Add a repository" folder-pick flow.
//
// The shared Tauri mock hardcodes plugin-dialog's `open()` to always resolve
// null (see test/mocks/tauri.ts), so there's no way to reach the
// picked/cancelled branches of pickFolder() through it. We re-register
// @tauri-apps/plugin-dialog with a controllable `open` BEFORE importing
// src/lib/repo.ts (module mocks apply to subsequent dynamic imports).

import { mock, describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";

let openResult: unknown = null;
let openArgs: unknown[] = [];
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => {
    openArgs.push(args[0]);
    return Promise.resolve(openResult);
  },
  save: () => Promise.resolve(null),
  ask: () => Promise.resolve(true),
  confirm: () => Promise.resolve(true),
  message: () => Promise.resolve(undefined),
}));

const { pickFolder, addRepoFromFolder } = await import("../src/lib/repo");
const { useStore } = await import("../src/state/store");

beforeEach(() => {
  tauri.reset();
  openResult = null;
  openArgs = [];
  useStore.setState({ repos: [] }, false);
});

describe("pickFolder", () => {
  it("opens the native directory picker with the expected options", async () => {
    openResult = "/Users/me/projects/aurora";
    const dir = await pickFolder();
    expect(dir).toBe("/Users/me/projects/aurora");
    expect(openArgs[0]).toEqual({ directory: true, multiple: false, title: "Add a repository" });
  });

  it("forwards a custom title", async () => {
    openResult = "/x";
    await pickFolder("Pick something else");
    expect((openArgs[0] as { title: string }).title).toBe("Pick something else");
  });

  it("returns null when the picker is cancelled (non-string result)", async () => {
    openResult = null;
    expect(await pickFolder()).toBeNull();
  });

  it("returns null when the result is an array (multi-select edge case)", async () => {
    openResult = ["/a", "/b"];
    expect(await pickFolder()).toBeNull();
  });
});

describe("addRepoFromFolder", () => {
  it("resolves { cancelled: true } when the dialog is cancelled", async () => {
    openResult = null;
    const res = await addRepoFromFolder();
    expect(res).toEqual({ cancelled: true });
  });

  it("resolves { ok: false, error } when the picked folder isn't a git repo", async () => {
    openResult = "/not/a/repo";
    tauri.invoke({ git_repo_info: () => null });
    const res = await addRepoFromFolder();
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("isn't inside a git repository");
  });

  it("resolves { ok: true } and registers the repo (using main_root as the canonical id)", async () => {
    openResult = "/Users/me/projects/aurora/subdir";
    tauri.invoke({
      git_repo_info: () => ({
        root: "/Users/me/projects/aurora/subdir",
        main_root: "/Users/me/projects/aurora",
        name: "aurora",
        default_branch: "main",
        current_branch: "main",
      }),
    });
    const res = await addRepoFromFolder();
    expect(res).toEqual({ ok: true, root: "/Users/me/projects/aurora", name: "aurora" });
    expect(useStore.getState().repos).toEqual([
      { id: "/Users/me/projects/aurora", root: "/Users/me/projects/aurora", name: "aurora", defaultBranch: "main" },
    ]);
  });

  it("falls back to info.root when main_root is empty", async () => {
    openResult = "/repo";
    tauri.invoke({
      git_repo_info: () => ({
        root: "/repo",
        main_root: "",
        name: "repo",
        default_branch: "main",
        current_branch: null,
      }),
    });
    const res = await addRepoFromFolder();
    expect(res).toEqual({ ok: true, root: "/repo", name: "repo" });
  });

  it("does not register a duplicate repo (store.addRepo is a no-op on id collision)", async () => {
    useStore.setState({ repos: [{ id: "/repo", root: "/repo", name: "repo", defaultBranch: "main" }] }, false);
    openResult = "/repo";
    tauri.invoke({
      git_repo_info: () => ({
        root: "/repo",
        main_root: "/repo",
        name: "repo-renamed",
        default_branch: "main",
        current_branch: null,
      }),
    });
    await addRepoFromFolder();
    expect(useStore.getState().repos.length).toBe(1);
    expect(useStore.getState().repos[0].name).toBe("repo"); // original wins, not overwritten
  });
});
