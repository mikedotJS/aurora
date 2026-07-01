// Line-coverage suite for src/lib/branchName.ts — pure sync helpers, no Tauri.
import { describe, it, expect } from "bun:test";
import { slugify, buildBranchName, validateBranchName } from "../src/lib/branchName";

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Login Redirect Drops The Return URL")).toBe("login-redirect-drops-the-return-url");
  });

  it("collapses runs of separators into one dash", () => {
    expect(slugify("foo   bar---baz!!!qux")).toBe("foo-bar-baz-qux");
  });

  it("trims leading/trailing dashes produced by punctuation", () => {
    expect(slugify("--hello world--")).toBe("hello-world");
  });

  it("caps at 40 chars and trims a dash left dangling by the cut", () => {
    // 50 a's -> sliced to 40 a's, no dash near the boundary so this covers the
    // slice(0,40) branch itself.
    const long = "a".repeat(50);
    const out = slugify(long);
    expect(out).toBe("a".repeat(40));
    expect(out.length).toBe(40);
  });

  it("trims a trailing dash exposed exactly at the 40-char cut", () => {
    // 39 a's + a separator run: after collapsing to one dash at position 39,
    // slicing to 40 chars keeps the dash at the very end, which the final
    // replace(/-+$/, "") must strip.
    const input = "a".repeat(39) + "----" + "b".repeat(10);
    const out = slugify(input);
    expect(out.endsWith("-")).toBe(false);
    expect(out).toBe("a".repeat(39));
  });

  it("returns empty string for input with nothing alphanumeric", () => {
    expect(slugify("!!!???")).toBe("");
  });
});

describe("buildBranchName", () => {
  it("prefixes with lowercased issue key when present", () => {
    expect(buildBranchName({ issueKey: "PROJ-1423", title: "Fix the thing" })).toBe("proj-1423/fix-the-thing");
  });

  it("falls back to 'work' slug when title slugifies empty but key present", () => {
    expect(buildBranchName({ issueKey: "ABC-1", title: "???" })).toBe("abc-1/work");
  });

  it("uses just the slug when no issue key", () => {
    expect(buildBranchName({ title: "Quick fix" })).toBe("quick-fix");
  });

  it("treats null issueKey as absent", () => {
    expect(buildBranchName({ issueKey: null, title: "Quick fix" })).toBe("quick-fix");
  });

  it("falls back to 'work' when both key and title are absent/empty", () => {
    expect(buildBranchName({ title: "" })).toBe("work");
  });
});

describe("validateBranchName", () => {
  it("rejects empty/whitespace-only names", () => {
    expect(validateBranchName("")).toEqual({ ok: false, error: "Enter a branch name." });
    expect(validateBranchName("   ")).toEqual({ ok: false, error: "Enter a branch name." });
  });

  it("rejects names containing '..'", () => {
    const r = validateBranchName("feat/foo..bar");
    expect(r).toEqual({ ok: false, error: "Branch names can't contain “..”." });
  });

  it("rejects names starting with '-'", () => {
    const r = validateBranchName("-foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("start with");
  });

  it("rejects names starting with '/'", () => {
    const r = validateBranchName("/foo");
    expect(r.ok).toBe(false);
  });

  it("rejects names ending with '/'", () => {
    const r = validateBranchName("feat/foo/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("end with");
  });

  it("rejects names with git-forbidden characters (space, ~, ^, :, ?, *, [, backslash)", () => {
    for (const bad of ["has space", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      const r = validateBranchName(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("Branch name has invalid characters.");
    }
  });

  it("accepts a well-formed branch name", () => {
    expect(validateBranchName("proj-1423/fix-the-thing")).toEqual({ ok: true });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateBranchName("  feat/valid-name  ")).toEqual({ ok: true });
  });
});
