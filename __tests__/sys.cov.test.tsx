// Coverage suite for src/lib/sys.ts — Rust fs/git bridges + pure cwd helpers.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import {
  homeDir,
  listDir,
  readTextFile,
  gitBranch,
  gitBranches,
  gitSwitch,
  gitRoot,
  gitRepoInfo,
  gitStatusSummary,
  readPackageField,
  detectBranchValidator,
  validateBranchNameBackend,
  pathResolve,
  shortenCwd,
  resolveCd,
  type RepoInfo,
} from "../src/lib/sys";

beforeEach(() => {
  tauri.reset();
});

describe("homeDir", () => {
  it("resolves the backend's home path", async () => {
    tauri.invoke({ home_dir: () => "/Users/test" });
    expect(await homeDir()).toBe("/Users/test");
  });
});

describe("listDir", () => {
  it("passes includeHidden and returns the entries", async () => {
    tauri.invoke({ list_dir: () => [{ name: "src", is_dir: true }] });
    const res = await listDir("/repo", true);
    expect(res).toEqual([{ name: "src", is_dir: true }]);
    expect(tauri.lastCall("list_dir")?.args).toEqual({ path: "/repo", includeHidden: true });
  });
  it("defaults includeHidden to false", async () => {
    tauri.invoke({ list_dir: () => [] });
    await listDir("/repo");
    expect(tauri.lastCall("list_dir")?.args).toEqual({ path: "/repo", includeHidden: false });
  });
  it("swallows a backend error and resolves []", async () => {
    tauri.invoke({
      list_dir: () => {
        throw new Error("ENOENT");
      },
    });
    expect(await listDir("/nope")).toEqual([]);
  });
});

describe("readTextFile", () => {
  it("returns the text with default maxBytes", async () => {
    tauri.invoke({ read_text_file: () => "hello" });
    expect(await readTextFile("/f.txt")).toBe("hello");
    expect(tauri.lastCall("read_text_file")?.args).toEqual({ path: "/f.txt", maxBytes: 8192 });
  });
  it("forwards a custom maxBytes", async () => {
    tauri.invoke({ read_text_file: () => "x" });
    await readTextFile("/f.txt", 100);
    expect(tauri.lastCall("read_text_file")?.args).toEqual({ path: "/f.txt", maxBytes: 100 });
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      read_text_file: () => {
        throw new Error("unreadable");
      },
    });
    expect(await readTextFile("/nope")).toBeNull();
  });
});

describe("gitBranch", () => {
  it("resolves the branch name", async () => {
    tauri.invoke({ git_branch: () => "main" });
    expect(await gitBranch("/repo")).toBe("main");
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      git_branch: () => {
        throw new Error("boom");
      },
    });
    expect(await gitBranch("/repo")).toBeNull();
  });
});

describe("gitBranches", () => {
  it("resolves the current + branches list", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "dev"] }) });
    expect(await gitBranches("/repo")).toEqual({ current: "main", branches: ["main", "dev"] });
  });
  it("swallows a backend error and resolves the empty shape", async () => {
    tauri.invoke({
      git_branches: () => {
        throw new Error("boom");
      },
    });
    expect(await gitBranches("/repo")).toEqual({ current: null, branches: [] });
  });
});

describe("gitSwitch", () => {
  it("resolves { ok: true } on success", async () => {
    tauri.invoke({ git_switch: () => undefined });
    const res = await gitSwitch("/repo", "dev");
    expect(res).toEqual({ ok: true });
    expect(tauri.lastCall("git_switch")?.args).toEqual({ cwd: "/repo", branch: "dev" });
  });
  it("resolves { ok: false, error } when the backend rejects", async () => {
    tauri.invoke({
      git_switch: () => {
        throw new Error("uncommitted changes");
      },
    });
    const res = await gitSwitch("/repo", "dev");
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("uncommitted changes");
  });
});

describe("gitRoot", () => {
  it("resolves the repo root", async () => {
    tauri.invoke({ git_root: () => "/repo" });
    expect(await gitRoot("/repo/sub")).toBe("/repo");
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      git_root: () => {
        throw new Error("boom");
      },
    });
    expect(await gitRoot("/nope")).toBeNull();
  });
});

describe("gitRepoInfo", () => {
  const info: RepoInfo = {
    root: "/repo",
    main_root: "/repo",
    name: "repo",
    default_branch: "main",
    current_branch: "feat/x",
  };
  it("resolves the repo info on success", async () => {
    tauri.invoke({ git_repo_info: () => info });
    expect(await gitRepoInfo("/repo")).toEqual(info);
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      git_repo_info: () => {
        throw new Error("not a repo");
      },
    });
    expect(await gitRepoInfo("/nope")).toBeNull();
  });
});

describe("gitStatusSummary", () => {
  it("resolves the summary on success", async () => {
    tauri.invoke({ git_status_summary: () => ({ files: 2, added: 10, removed: 3, conflicted: 0 }) });
    const res = await gitStatusSummary("/repo/wt", "main");
    expect(res).toEqual({ files: 2, added: 10, removed: 3, conflicted: 0 });
    expect(tauri.lastCall("git_status_summary")?.args).toEqual({ dir: "/repo/wt", base: "main" });
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      git_status_summary: () => {
        throw new Error("boom");
      },
    });
    expect(await gitStatusSummary("/repo/wt", "main")).toBeNull();
  });
});

describe("readPackageField", () => {
  it("resolves the field value", async () => {
    tauri.invoke({ read_package_field: () => "1.2.3" });
    expect(await readPackageField("/repo", "version")).toBe("1.2.3");
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      read_package_field: () => {
        throw new Error("boom");
      },
    });
    expect(await readPackageField("/repo", "version")).toBeNull();
  });
});

describe("detectBranchValidator", () => {
  it("resolves the validator rule", async () => {
    tauri.invoke({ detect_branch_validator: () => ({ regex: "^feat/", source: "husky" }) });
    expect(await detectBranchValidator("/repo")).toEqual({ regex: "^feat/", source: "husky" });
  });
  it("swallows a backend error and resolves null", async () => {
    tauri.invoke({
      detect_branch_validator: () => {
        throw new Error("boom");
      },
    });
    expect(await detectBranchValidator("/repo")).toBeNull();
  });
});

describe("validateBranchNameBackend", () => {
  it("resolves the validation result on success", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: false, message: "bad name", enforced: true }) });
    const res = await validateBranchNameBackend("/repo", "bad name!");
    expect(res).toEqual({ ok: false, message: "bad name", enforced: true });
  });
  it("falls back to an unenforced ok:true when the backend rejects", async () => {
    tauri.invoke({
      validate_branch_name: () => {
        throw new Error("boom");
      },
    });
    const res = await validateBranchNameBackend("/repo", "feat/x");
    expect(res).toEqual({ ok: true, message: null, enforced: false });
  });
});

describe("pathResolve", () => {
  it("resolves the canonical path", async () => {
    tauri.invoke({ path_resolve: () => "/private/tmp" });
    expect(await pathResolve("/tmp")).toBe("/private/tmp");
  });
  it("falls back to the input path when the backend rejects", async () => {
    tauri.invoke({
      path_resolve: () => {
        throw new Error("ENOENT");
      },
    });
    expect(await pathResolve("/does/not/exist")).toBe("/does/not/exist");
  });
});

describe("shortenCwd", () => {
  it("collapses a path under home to ~", () => {
    expect(shortenCwd("/Users/test/proj", "/Users/test")).toBe("~/proj");
  });
  it("leaves a path outside home unchanged", () => {
    expect(shortenCwd("/opt/other", "/Users/test")).toBe("/opt/other");
  });
  it("leaves the path unchanged when home is empty", () => {
    expect(shortenCwd("/Users/test/proj", "")).toBe("/Users/test/proj");
  });
});

describe("resolveCd", () => {
  const home = "/Users/test";
  it("no arg resolves to home", () => {
    expect(resolveCd("/anywhere", undefined, home)).toBe(home);
  });
  it("bare ~ resolves to home", () => {
    expect(resolveCd("/anywhere", "~", home)).toBe(home);
  });
  it("~/sub resolves under home", () => {
    expect(resolveCd("/anywhere", "~/proj/sub", home)).toBe("/Users/test/proj/sub");
  });
  it("an absolute path is used as-is (trailing slashes trimmed)", () => {
    expect(resolveCd("/anywhere", "/opt/app/", home)).toBe("/opt/app");
  });
  it("an absolute path of just '/' collapses to '/'", () => {
    expect(resolveCd("/anywhere", "/", home)).toBe("/");
  });
  it("a relative path is joined onto cwd", () => {
    expect(resolveCd("/repo/src", "lib", home)).toBe("/repo/src/lib");
  });
  it("'..' pops a segment off cwd", () => {
    expect(resolveCd("/repo/src/lib", "..", home)).toBe("/repo/src");
  });
  it("'.' segments are ignored", () => {
    expect(resolveCd("/repo/src", "./lib/./x", home)).toBe("/repo/src/lib/x");
  });
  it("combines '..' and nested segments", () => {
    expect(resolveCd("/repo/src/lib", "../../other", home)).toBe("/repo/other");
  });
  it("empty segments (double slashes) are skipped", () => {
    expect(resolveCd("/repo", "a//b", home)).toBe("/repo/a/b");
  });
});
