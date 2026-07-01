// Coverage suite for src/lib/diff.ts — parseUnifiedDiff() over nominal, binary,
// empty, and malformed inputs, plus pairForSplit() pairing of removal/addition
// runs and context lines.
import { describe, it, expect } from "bun:test";
import { parseUnifiedDiff, pairForSplit } from "../src/lib/diff";

describe("parseUnifiedDiff", () => {
  it("parses a single hunk with context, additions and removals, tracking line numbers", () => {
    const text = [
      "diff --git a/foo.ts b/foo.ts",
      "index 111..222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " line one",
      "-line two",
      "+line two b",
      "+line two c",
      " line three",
    ].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.binary).toBe(false);
    expect(parsed.hunks).toHaveLength(1);
    const h = parsed.hunks[0];
    expect(h.header).toBe("@@ -1,3 +1,4 @@");
    expect(h.lines).toEqual([
      { kind: " ", oldNo: 1, newNo: 1, text: "line one" },
      { kind: "-", oldNo: 2, newNo: null, text: "line two" },
      { kind: "+", oldNo: null, newNo: 2, text: "line two b" },
      { kind: "+", oldNo: null, newNo: 3, text: "line two c" },
      { kind: " ", oldNo: 3, newNo: 4, text: "line three" },
    ]);
  });

  it("parses multiple hunks in one file, resetting line counters per hunk", () => {
    const text = ["@@ -1,1 +1,1 @@", "-a", "+b", "@@ -10,1 +11,1 @@", "-c", "+d"].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].lines[0]).toEqual({ kind: "-", oldNo: 1, newNo: null, text: "a" });
    expect(parsed.hunks[1].lines[0]).toEqual({ kind: "-", oldNo: 10, newNo: null, text: "c" });
    expect(parsed.hunks[1].lines[1]).toEqual({ kind: "+", oldNo: null, newNo: 11, text: "d" });
  });

  it("flags a binary file diff and returns no hunks", () => {
    const text = "diff --git a/img.png b/img.png\nindex 111..222 100644\nBinary files a/img.png and b/img.png differ";
    const parsed = parseUnifiedDiff(text);
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toHaveLength(0);
  });

  it("flags a GIT binary patch diff as binary", () => {
    const text = "diff --git a/img.png b/img.png\nGIT binary patch\nliteral 10\nabcdef";
    const parsed = parseUnifiedDiff(text);
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toHaveLength(0);
  });

  it("returns empty hunks and non-binary for an empty string", () => {
    const parsed = parseUnifiedDiff("");
    expect(parsed.binary).toBe(false);
    expect(parsed.hunks).toEqual([]);
  });

  it("ignores preamble lines (diff/index/---/+++) before the first hunk header", () => {
    const text = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1 +1 @@", " unchanged"].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].lines).toEqual([{ kind: " ", oldNo: 1, newNo: 1, text: "unchanged" }]);
  });

  it("ignores a stray content line with no preceding hunk header (no crash)", () => {
    const parsed = parseUnifiedDiff("some noise\nmore noise");
    expect(parsed.hunks).toEqual([]);
  });

  it("ignores a 'No newline at end of file' marker line inside a hunk", () => {
    const text = ["@@ -1,1 +1,1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.hunks[0].lines).toHaveLength(2);
  });

  it("matches a hunk header without explicit line counts (single-line hunks)", () => {
    const parsed = parseUnifiedDiff("@@ -5 +7 @@\n-x\n+y");
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].lines[0].oldNo).toBe(5);
    expect(parsed.hunks[0].lines[1].newNo).toBe(7);
  });
});

describe("pairForSplit", () => {
  it("pairs equal-length runs of removals and additions line by line", () => {
    const hunk = {
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { kind: "-" as const, oldNo: 1, newNo: null, text: "old1" },
        { kind: "-" as const, oldNo: 2, newNo: null, text: "old2" },
        { kind: "+" as const, oldNo: null, newNo: 1, text: "new1" },
        { kind: "+" as const, oldNo: null, newNo: 2, text: "new2" },
      ],
    };
    const rows = pairForSplit(hunk);
    expect(rows).toHaveLength(2);
    expect(rows[0].left?.text).toBe("old1");
    expect(rows[0].right?.text).toBe("new1");
    expect(rows[1].left?.text).toBe("old2");
    expect(rows[1].right?.text).toBe("new2");
  });

  it("pads the shorter side with null when removals/additions counts differ", () => {
    const hunk = {
      header: "@@ -1,1 +1,2 @@",
      lines: [
        { kind: "-" as const, oldNo: 1, newNo: null, text: "old1" },
        { kind: "+" as const, oldNo: null, newNo: 1, text: "new1" },
        { kind: "+" as const, oldNo: null, newNo: 2, text: "new2" },
      ],
    };
    const rows = pairForSplit(hunk);
    expect(rows).toHaveLength(2);
    expect(rows[0].left?.text).toBe("old1");
    expect(rows[0].right?.text).toBe("new1");
    expect(rows[1].left).toBeNull();
    expect(rows[1].right?.text).toBe("new2");
  });

  it("puts context lines on both sides", () => {
    const hunk = {
      header: "@@ -1,1 +1,1 @@",
      lines: [{ kind: " " as const, oldNo: 1, newNo: 1, text: "ctx" }],
    };
    const rows = pairForSplit(hunk);
    expect(rows).toHaveLength(1);
    expect(rows[0].left).toBe(hunk.lines[0]);
    expect(rows[0].right).toBe(hunk.lines[0]);
  });

  it("returns an empty row list for a hunk with no lines", () => {
    expect(pairForSplit({ header: "@@ -1,0 +1,0 @@", lines: [] })).toEqual([]);
  });

  it("handles removal-only runs (no matching additions)", () => {
    const hunk = {
      header: "@@ -1,2 +1,0 @@",
      lines: [
        { kind: "-" as const, oldNo: 1, newNo: null, text: "gone1" },
        { kind: "-" as const, oldNo: 2, newNo: null, text: "gone2" },
      ],
    };
    const rows = pairForSplit(hunk);
    expect(rows).toEqual([
      { left: hunk.lines[0], right: null },
      { left: hunk.lines[1], right: null },
    ]);
  });

  it("handles addition-only runs (no matching removals)", () => {
    const hunk = {
      header: "@@ -1,0 +1,2 @@",
      lines: [
        { kind: "+" as const, oldNo: null, newNo: 1, text: "add1" },
        { kind: "+" as const, oldNo: null, newNo: 2, text: "add2" },
      ],
    };
    const rows = pairForSplit(hunk);
    expect(rows).toEqual([
      { left: null, right: hunk.lines[0] },
      { left: null, right: hunk.lines[1] },
    ]);
  });

  it("mixes context and change runs across a hunk in order", () => {
    const hunk = {
      header: "@@ -1,3 +1,3 @@",
      lines: [
        { kind: " " as const, oldNo: 1, newNo: 1, text: "ctx1" },
        { kind: "-" as const, oldNo: 2, newNo: null, text: "old" },
        { kind: "+" as const, oldNo: null, newNo: 2, text: "new" },
        { kind: " " as const, oldNo: 3, newNo: 3, text: "ctx2" },
      ],
    };
    const rows = pairForSplit(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ left: hunk.lines[0], right: hunk.lines[0] });
    expect(rows[1]).toEqual({ left: hunk.lines[1], right: hunk.lines[2] });
    expect(rows[2]).toEqual({ left: hunk.lines[3], right: hunk.lines[3] });
  });
});
