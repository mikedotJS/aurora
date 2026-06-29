// Find-in-output: shared helpers for matching a query against a pane's rendered
// command-block output and re-segmenting lines so matches highlight in place
// while preserving the original ANSI styling.

import type { CSSProperties } from "react";
import { ansiToLines, type Seg } from "./ansi";
import type { Block } from "../state/store";

/** Join a line's segments back into plain text. */
export function lineText(segs: Seg[]): string {
  return segs.map((s) => s.text).join("");
}

/** The displayed lines of a block: ANSI-parsed with the echoed command line and
 *  surrounding blank padding stripped — identical to what BlockView renders, so
 *  match line indices line up with the rendered DOM. Takes the raw fields (not
 *  the Block) so callers can memoize on exactly `output` + `command`. */
export function blockLines(output: string, command: string): Seg[][] {
  const all = ansiToLines(output);
  while (all.length) {
    const t = lineText(all[0]).trim();
    if (t === "" || t === command.trim()) all.shift();
    else break;
  }
  while (all.length && lineText(all[all.length - 1]).trim() === "") all.pop();
  return all;
}

export interface Match {
  blockId: number;
  line: number; // index into blockLines(block)
  start: number; // char offset within the line text
  end: number;
}

/** Case-insensitive [start,end) ranges of `queryLower` within a line's text. */
export function findRangesInLine(text: string, queryLower: string): Array<{ start: number; end: number }> {
  if (!queryLower) return [];
  const hay = text.toLowerCase();
  const out: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(queryLower, from);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + queryLower.length });
    from = idx + queryLower.length;
  }
  return out;
}

/** All matches across blocks, in render order. */
export function collectMatches(blocks: Block[], query: string): Match[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: Match[] = [];
  for (const block of blocks) {
    const lines = blockLines(block.output, block.command);
    for (let li = 0; li < lines.length; li++) {
      for (const r of findRangesInLine(lineText(lines[li]), q)) {
        out.push({ blockId: block.id, line: li, start: r.start, end: r.end });
      }
    }
  }
  return out;
}

export interface Slice {
  text: string;
  style: CSSProperties;
  hl: "none" | "match" | "current";
}

/** Re-segment a line against match ranges: each slice keeps its segment's own
 *  style and gains a highlight flag. Correct even when a match spans segments. */
export function highlightLine(
  segs: Seg[],
  ranges: Array<{ start: number; end: number; isCurrent: boolean }>,
): Slice[] {
  if (!ranges.length) return segs.map((s) => ({ text: s.text, style: s.style, hl: "none" as const }));
  const slices: Slice[] = [];
  let offset = 0;
  for (const seg of segs) {
    const segStart = offset;
    const segEnd = offset + seg.text.length;
    const pts = new Set<number>([segStart, segEnd]);
    for (const r of ranges) {
      if (r.end <= segStart || r.start >= segEnd) continue;
      pts.add(Math.max(r.start, segStart));
      pts.add(Math.min(r.end, segEnd));
    }
    const sorted = [...pts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b <= a) continue;
      let hl: Slice["hl"] = "none";
      for (const r of ranges) {
        if (r.start <= a && r.end >= b) {
          hl = r.isCurrent ? "current" : "match";
          break;
        }
      }
      slices.push({ text: seg.text.slice(a - segStart, b - segStart), style: seg.style, hl });
    }
    offset = segEnd;
  }
  return slices;
}
