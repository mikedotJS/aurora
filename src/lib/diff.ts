// Parse unified `git diff` text into files → hunks → lines, and pair lines for a
// side-by-side (split) view.

export interface DiffLine {
  kind: " " | "+" | "-";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
export interface Hunk {
  header: string;
  lines: DiffLine[];
}
export interface ParsedDiff {
  hunks: Hunk[];
  /** true when git reported a binary file (no textual hunks). */
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: Hunk[] = [];
  let binary = false;
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // diff/index/--- /+++ preamble
    const c = line[0];
    if (c === "+") {
      cur.lines.push({ kind: "+", oldNo: null, newNo, text: line.slice(1) });
      newNo += 1;
    } else if (c === "-") {
      cur.lines.push({ kind: "-", oldNo, newNo: null, text: line.slice(1) });
      oldNo += 1;
    } else if (c === " ") {
      cur.lines.push({ kind: " ", oldNo, newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
    // "\ No newline at end of file" and empty trailing lines are ignored
  }
  return { hunks, binary };
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pair a hunk's lines into side-by-side rows: a run of removals aligns against
 *  the following run of additions; context lines occupy both sides. */
export function pairForSplit(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === " ") {
      rows.push({ left: l, right: l });
      i += 1;
      continue;
    }
    // collect a run of removals then a run of additions
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "-") removed.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "+") added.push(lines[i++]);
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return rows;
}
