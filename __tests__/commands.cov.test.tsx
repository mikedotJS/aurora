/**
 * Line-coverage suite for src/lib/commands.ts — command knowledge for the smart
 * prompt: typo correction, interactive-program detection, ghost autocomplete,
 * path-token splitting for Tab folder completion, and the natural-language gate.
 * Pure logic, no store/Tauri involved — every exported function is called with
 * inputs that cover its branches and asserted against real return values.
 */
import { describe, it, expect } from "bun:test";
import {
  typoFix,
  isInteractive,
  ghostFor,
  splitPathToken,
  folderCandidates,
  commonPrefix,
  looksLikeNaturalLanguage,
  KNOWN_COMMANDS,
  type GhostContext,
} from "../src/lib/commands";
import type { DirEntry } from "../src/lib/sys";

// ── typoFix ──────────────────────────────────────────────────────────────────

describe("typoFix", () => {
  it("returns the correction for a known typo", () => {
    expect(typoFix("gti")).toBe("git");
    expect(typoFix("gs")).toBe("git status");
    expect(typoFix("cd..")).toBe("cd ..");
  });
  it("returns null for a word with no known correction", () => {
    expect(typoFix("git")).toBeNull();
    expect(typoFix("")).toBeNull();
    expect(typoFix("totallyunknown")).toBeNull();
  });
});

// ── isInteractive ────────────────────────────────────────────────────────────

describe("isInteractive", () => {
  it("is false for an empty command", () => {
    expect(isInteractive("")).toBe(false);
    expect(isInteractive("   ")).toBe(false);
  });
  it("is true for a program in the INTERACTIVE set regardless of args", () => {
    expect(isInteractive("vim")).toBe(true);
    expect(isInteractive("vim foo.txt")).toBe(true);
    expect(isInteractive("claude")).toBe(true);
    expect(isInteractive("less")).toBe(true);
  });
  it("is true for a bare REPL (no script argument)", () => {
    expect(isInteractive("python")).toBe(true);
    expect(isInteractive("node")).toBe(true);
  });
  it("is false for a REPL invoked with a script argument", () => {
    expect(isInteractive("python script.py")).toBe(false);
    expect(isInteractive("node index.js")).toBe(false);
  });
  it("is true for tool + interactive subcommand", () => {
    expect(isInteractive("glab auth login")).toBe(true);
    expect(isInteractive("gh auth status")).toBe(true);
    expect(isInteractive("npm init")).toBe(true);
    expect(isInteractive("docker login")).toBe(true);
  });
  it("npm init -y / --yes is explicitly non-interactive", () => {
    expect(isInteractive("npm init -y")).toBe(false);
    expect(isInteractive("npm init --yes")).toBe(false);
    // sanity: without the flag it's still interactive
    expect(isInteractive("npm init")).toBe(true);
  });
  it("is false for a tool with a subcommand that isn't in its interactive list", () => {
    expect(isInteractive("npm test")).toBe(false);
    expect(isInteractive("npm")).toBe(false); // no subcommand at all
  });
  it("detects inline-interactive git porcelain flags", () => {
    expect(isInteractive("git add -p")).toBe(true);
    expect(isInteractive("git add --patch")).toBe(true);
    expect(isInteractive("git rebase -i")).toBe(true);
    expect(isInteractive("git add --interactive")).toBe(true);
  });
  it("is false for plain git commands without interactive flags", () => {
    expect(isInteractive("git status")).toBe(false);
    expect(isInteractive("git commit -m x")).toBe(false);
  });
  it("is false for an unknown command", () => {
    expect(isInteractive("banana")).toBe(false);
  });
});

// ── ghostFor ─────────────────────────────────────────────────────────────────

describe("ghostFor", () => {
  const emptyCtx: GhostContext = { dirNames: [], history: [] };

  it("returns '' for empty input", () => {
    expect(ghostFor("", emptyCtx)).toBe("");
  });
  it("returns '' when input ends with whitespace", () => {
    expect(ghostFor("git ", emptyCtx)).toBe("");
  });
  it("completes a single-word command from FIRST_WORD_CANDIDATES", () => {
    expect(ghostFor("l", emptyCtx)).toBe("s"); // "ls"
    expect(ghostFor("gi", emptyCtx)).toBe("t "); // "git "
  });
  it("falls back to history for a single word with no candidate match", () => {
    const ctx: GhostContext = { dirNames: [], history: ["xylophone"] };
    expect(ghostFor("xy", ctx)).toBe("lophone");
  });
  it("returns '' for a single word with no candidate and no history match", () => {
    expect(ghostFor("zz", emptyCtx)).toBe("");
  });
  it("completes a subcommand for a known first word (git)", () => {
    expect(ghostFor("git sta", emptyCtx)).toBe("tus");
  });
  it("completes a directory-name candidate for path-taking commands", () => {
    const ctx: GhostContext = { dirNames: ["src", "scripts"], history: [] };
    expect(ghostFor("cd sr", ctx)).toBe("c");
  });
  it("falls back to history when the multi-word candidate list has no match", () => {
    const ctx: GhostContext = { dirNames: [], history: ["git status --short"] };
    expect(ghostFor("git status --s", ctx)).toBe("hort");
  });
  it("returns '' for a multi-word input with no candidates and no history match", () => {
    expect(ghostFor("foo bar", emptyCtx)).toBe("");
  });
  it("does not suggest a candidate identical to the already-typed text", () => {
    // "ls" fully typed as the first word — no further single-word ghost.
    const ctx: GhostContext = { dirNames: [], history: [] };
    expect(ghostFor("ls", ctx)).toBe("");
  });
});

// ── splitPathToken ───────────────────────────────────────────────────────────

describe("splitPathToken", () => {
  it("treats the bare first word (no preceding word, not path-like) as not a path arg", () => {
    const t = splitPathToken("gi");
    expect(t.isPathArg).toBe(false);
    expect(t.dir).toBe("");
    expect(t.leaf).toBe("gi");
    expect(t.tokenStart).toBe(0);
  });
  it("treats a second word as a path arg (preceded by a command word)", () => {
    const t = splitPathToken("cd sr");
    expect(t.isPathArg).toBe(true);
    expect(t.dir).toBe("");
    expect(t.leaf).toBe("sr");
    expect(t.tokenStart).toBe(3);
  });
  it("splits a dir prefix out of the token", () => {
    const t = splitPathToken("cd src/comp");
    expect(t.dir).toBe("src/");
    expect(t.leaf).toBe("comp");
    expect(t.isPathArg).toBe(true);
  });
  it("treats a bare first word starting with ~ / . as path-like even with no preceding word", () => {
    expect(splitPathToken("~/proj").isPathArg).toBe(true);
    expect(splitPathToken("/usr/loc").isPathArg).toBe(true);
    expect(splitPathToken("./bin").isPathArg).toBe(true);
  });
  it("respects an explicit caret position instead of defaulting to input.length", () => {
    const t = splitPathToken("cd src foo", 6); // caret right after "src"
    expect(t.leaf).toBe("src");
    expect(t.tokenStart).toBe(3);
  });
});

// ── folderCandidates ─────────────────────────────────────────────────────────

describe("folderCandidates", () => {
  const entries: DirEntry[] = [
    { name: "src", is_dir: true },
    { name: "scripts", is_dir: true },
    { name: "readme.md", is_dir: false },
    { name: "styles", is_dir: true },
  ];
  it("filters to directories whose name starts with the leaf", () => {
    expect(folderCandidates(entries, "s").map((e) => e.name)).toEqual(["src", "scripts", "styles"]);
  });
  it("excludes files even if the name matches", () => {
    expect(folderCandidates(entries, "read")).toEqual([]);
  });
  it("returns everything for an empty leaf (dirs only)", () => {
    expect(folderCandidates(entries, "").map((e) => e.name)).toEqual(["src", "scripts", "styles"]);
  });
});

// ── commonPrefix ─────────────────────────────────────────────────────────────

describe("commonPrefix", () => {
  it("returns '' for an empty list", () => {
    expect(commonPrefix([])).toBe("");
  });
  it("returns the single name for a one-element list", () => {
    expect(commonPrefix(["scripts"])).toBe("scripts");
  });
  it("returns the shared prefix across names", () => {
    expect(commonPrefix(["scripts", "scriptable", "scr"])).toBe("scr");
  });
  it("returns '' when names diverge at the first character", () => {
    expect(commonPrefix(["src", "docs"])).toBe("");
  });
});

// ── looksLikeNaturalLanguage ─────────────────────────────────────────────────

describe("looksLikeNaturalLanguage", () => {
  it("is false for empty/whitespace input", () => {
    expect(looksLikeNaturalLanguage("")).toBe(false);
    expect(looksLikeNaturalLanguage("   ")).toBe(false);
  });
  it("is false for a known command even with args", () => {
    expect(looksLikeNaturalLanguage("git status now please")).toBe(false);
    expect(KNOWN_COMMANDS).toContain("git");
  });
  it("is false for a known typo", () => {
    expect(looksLikeNaturalLanguage("gti status")).toBe(false);
  });
  it("is false for a path-like line", () => {
    expect(looksLikeNaturalLanguage("./run.sh --flag")).toBe(false);
    expect(looksLikeNaturalLanguage("/usr/bin/env node")).toBe(false);
    expect(looksLikeNaturalLanguage("~/scripts/run.sh")).toBe(false);
  });
  it("is false for a single token, even an unknown one", () => {
    expect(looksLikeNaturalLanguage("frobnicate")).toBe(false);
  });
  it("is true for a multi-token unknown line", () => {
    expect(looksLikeNaturalLanguage("undo my last commit")).toBe(true);
  });
});
