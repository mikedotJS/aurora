// Coverage suite for src/lib/find.ts — pure logic: line-joining, block-line
// trimming (echoed command + surrounding blank padding), case-insensitive
// range finding, cross-block match collection, and segment-preserving
// highlight re-slicing (including matches that span multiple segments).

import { describe, it, expect } from "bun:test";
import {
  lineText,
  blockLines,
  findRangesInLine,
  collectMatches,
  highlightLine,
} from "../src/lib/find";
import type { Seg } from "../src/lib/ansi";
import type { Block } from "../src/state/store";

function mkBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 1,
    command: "echo hi",
    cwd: "/repo",
    output: "",
    exitCode: 0,
    running: false,
    ...overrides,
  };
}

describe("lineText", () => {
  it("joins segment text in order", () => {
    expect(lineText([{ text: "foo", style: {} }, { text: "bar", style: {} }])).toBe("foobar");
  });

  it("returns empty string for an empty line", () => {
    expect(lineText([])).toBe("");
  });
});

describe("blockLines", () => {
  it("strips a leading blank line and the echoed command line, and a trailing blank line", () => {
    const lines = blockLines("\nls -la\nfile1.txt\nfile2.txt\n\n", "ls -la");
    expect(lines.map(lineText)).toEqual(["file1.txt", "file2.txt"]);
  });

  it("strips the echoed command even with surrounding whitespace differences (trimmed compare)", () => {
    const lines = blockLines("ls -la\nresult\n", "  ls -la  ");
    expect(lines.map(lineText)).toEqual(["result"]);
  });

  it("stops stripping at the first non-blank, non-command line (leading) and leaves a trailing content line alone", () => {
    const lines = blockLines("bar\nbaz\n", "foo");
    expect(lines.map(lineText)).toEqual(["bar", "baz"]);
  });

  it("returns an empty array when every line is blank", () => {
    const lines = blockLines("\n\n\n", "x");
    expect(lines).toEqual([]);
  });
});

describe("findRangesInLine", () => {
  it("returns no ranges for an empty query", () => {
    expect(findRangesInLine("hello world", "")).toEqual([]);
  });

  it("returns no ranges when there is no match", () => {
    expect(findRangesInLine("hello world", "zzz")).toEqual([]);
  });

  it("finds a single match", () => {
    expect(findRangesInLine("hello world", "world")).toEqual([{ start: 6, end: 11 }]);
  });

  it("finds multiple non-overlapping matches", () => {
    expect(findRangesInLine("ababab", "ab")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
    ]);
  });

  it("matches case-insensitively", () => {
    expect(findRangesInLine("Hello World", "world")).toEqual([{ start: 6, end: 11 }]);
  });
});

describe("collectMatches", () => {
  it("returns no matches for an empty query", () => {
    const blocks = [mkBlock({ output: "foo bar\n" })];
    expect(collectMatches(blocks, "")).toEqual([]);
  });

  it("returns no matches for an empty block list", () => {
    expect(collectMatches([], "foo")).toEqual([]);
  });

  it("collects matches across multiple blocks and lines, in render order", () => {
    const blocks = [
      mkBlock({ id: 10, command: "cmd1", output: "cmd1\nfoo bar\nbaz\n" }),
      mkBlock({ id: 20, command: "cmd2", output: "cmd2\nfoo foo\n" }),
    ];
    const matches = collectMatches(blocks, "foo");
    expect(matches).toEqual([
      { blockId: 10, line: 0, start: 0, end: 3 },
      { blockId: 20, line: 0, start: 0, end: 3 },
      { blockId: 20, line: 0, start: 4, end: 7 },
    ]);
  });
});

describe("highlightLine", () => {
  const segs: Seg[] = [
    { text: "foo ", style: { color: "red" } },
    { text: "bar baz", style: { color: "blue" } },
    { text: "qux", style: { color: "green" } },
  ];

  it("returns the segments unhighlighted when there are no ranges", () => {
    expect(highlightLine(segs, [])).toEqual([
      { text: "foo ", style: { color: "red" }, hl: "none" },
      { text: "bar baz", style: { color: "blue" }, hl: "none" },
      { text: "qux", style: { color: "green" }, hl: "none" },
    ]);
  });

  it("re-slices matches that span multiple segments, classifies current vs match, and skips segments the range doesn't touch", () => {
    // Full text is "foo bar bazqux" (positions: "foo "[0,4) "bar baz"[4,11) "qux"[11,14)).
    // Range A [2,6) spans segment 1→2 and is the "current" match.
    // Range B [12,13) sits entirely inside segment 3 and is a plain match. It
    // exercises both "continue" skip directions: segment 1 skips range B via
    // r.start>=segEnd, and segment 3 skips range A via r.end<=segStart.
    const slices = highlightLine(segs, [
      { start: 2, end: 6, isCurrent: true },
      { start: 12, end: 13, isCurrent: false },
    ]);

    expect(slices).toEqual([
      { text: "fo", style: { color: "red" }, hl: "none" },
      { text: "o ", style: { color: "red" }, hl: "current" },
      { text: "ba", style: { color: "blue" }, hl: "current" },
      { text: "r baz", style: { color: "blue" }, hl: "none" },
      { text: "q", style: { color: "green" }, hl: "none" },
      { text: "u", style: { color: "green" }, hl: "match" },
      { text: "x", style: { color: "green" }, hl: "none" },
    ]);

    // Sanity: the re-sliced text reconstructs the original line exactly.
    expect(slices.map((s) => s.text).join("")).toBe("foo bar bazqux");
  });

  it("handles a match confined to a single segment", () => {
    const slices = highlightLine(segs, [{ start: 4, end: 7, isCurrent: false }]);
    expect(slices).toEqual([
      { text: "foo ", style: { color: "red" }, hl: "none" },
      { text: "bar", style: { color: "blue" }, hl: "match" },
      { text: " baz", style: { color: "blue" }, hl: "none" },
      { text: "qux", style: { color: "green" }, hl: "none" },
    ]);
  });
});
