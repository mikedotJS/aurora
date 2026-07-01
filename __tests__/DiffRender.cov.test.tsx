// Coverage suite for src/components/Diff.tsx — UnifiedDiff and SplitDiff renderers.
// Named DiffRender (not "Diff.cov.test.tsx") because macOS's default case-insensitive
// filesystem would otherwise collide with __tests__/diffParse.cov.test.tsx (which
// covers src/lib/diff.ts) — "Diff" and "diff" resolve to the same inode.
// Exercises each line-kind branch (context/add/remove), multiple hunks, and the
// split view's null-side padding (added-only / removed-only rows).
import { describe, it, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { UnifiedDiff, SplitDiff } from "../src/components/Diff";
import type { Hunk } from "../src/lib/diff";

afterEach(cleanup);

const mixedHunk: Hunk = {
  header: "@@ -1,3 +1,4 @@",
  lines: [
    { kind: " ", oldNo: 1, newNo: 1, text: "context line" },
    { kind: "-", oldNo: 2, newNo: null, text: "removed line" },
    { kind: "+", oldNo: null, newNo: 2, text: "added line" },
    { kind: "+", oldNo: null, newNo: 3, text: "" }, // blank added line -> falls back to " "
    { kind: " ", oldNo: 3, newNo: 4, text: "tail" },
  ],
};

const secondHunk: Hunk = {
  header: "@@ -10,1 +11,1 @@",
  lines: [{ kind: "-", oldNo: 10, newNo: null, text: "gone" }],
};

describe("UnifiedDiff", () => {
  it("renders hunk headers and every line kind (context, removed, added, blank-added)", () => {
    const { container } = render(<UnifiedDiff hunks={[mixedHunk]} />);
    expect(container.textContent).toContain("@@ -1,3 +1,4 @@");
    expect(container.textContent).toContain("context line");
    expect(container.textContent).toContain("removed line");
    expect(container.textContent).toContain("added line");
    expect(container.textContent).toContain("tail");
  });

  it("renders multiple hunks, each with its own header", () => {
    const { container } = render(<UnifiedDiff hunks={[mixedHunk, secondHunk]} />);
    expect(container.textContent).toContain("@@ -1,3 +1,4 @@");
    expect(container.textContent).toContain("@@ -10,1 +11,1 @@");
    expect(container.textContent).toContain("gone");
  });

  it("renders an empty hunk list without crashing", () => {
    const { container } = render(<UnifiedDiff hunks={[]} />);
    expect(container.querySelector("div")).toBeTruthy();
  });
});

describe("SplitDiff", () => {
  it("renders paired left/right rows for a mixed hunk (context both sides, remove/add split)", () => {
    const { container } = render(<SplitDiff hunks={[mixedHunk]} />);
    expect(container.textContent).toContain("@@ -1,3 +1,4 @@");
    expect(container.textContent).toContain("context line");
    expect(container.textContent).toContain("removed line");
    expect(container.textContent).toContain("added line");
    expect(container.textContent).toContain("tail");
  });

  it("renders a removal-only row with an empty right side (null right)", () => {
    const { container } = render(<SplitDiff hunks={[secondHunk]} />);
    expect(container.textContent).toContain("gone");
    expect(container.textContent).toContain("@@ -10,1 +11,1 @@");
  });

  it("renders an addition-only row with an empty left side (null left)", () => {
    const addOnly: Hunk = {
      header: "@@ -1,0 +1,1 @@",
      lines: [{ kind: "+", oldNo: null, newNo: 1, text: "brand new" }],
    };
    const { container } = render(<SplitDiff hunks={[addOnly]} />);
    expect(container.textContent).toContain("brand new");
  });

  it("renders multiple hunks in split mode", () => {
    const { container } = render(<SplitDiff hunks={[mixedHunk, secondHunk]} />);
    expect(container.textContent).toContain("@@ -1,3 +1,4 @@");
    expect(container.textContent).toContain("@@ -10,1 +11,1 @@");
  });

  it("renders an empty hunk list without crashing", () => {
    const { container } = render(<SplitDiff hunks={[]} />);
    expect(container.querySelector("div")).toBeTruthy();
  });
});
