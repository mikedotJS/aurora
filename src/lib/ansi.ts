// Minimal ANSI → styled segments for rendering captured command output as DOM.
// Handles SGR colors (basic/bright/256/truecolor), bold/dim/italic/underline,
// strips OSC + non-SGR CSI, and splits into lines (honoring \r overwrite).

import type { CSSProperties } from "react";

// Bound to Aurora's design tokens (live CSS vars) where it makes the output feel
// cohesive — red→--err, yellow→--warn, cyan→accent, white→--fg — so command
// output matches the chrome and re-themes when the accent changes.
// Order: black, red, green, yellow, blue, magenta, cyan, white.
const BASIC = [
  "var(--faint)",
  "var(--err)",
  "oklch(0.8 0.13 155)",
  "var(--warn)",
  "oklch(0.74 0.1 250)",
  "oklch(0.76 0.11 310)",
  "var(--ac)",
  "var(--fg)",
];
const BRIGHT = [
  "var(--dim)",
  "oklch(0.8 0.13 24)",
  "oklch(0.85 0.13 155)",
  "var(--warn-d)",
  "oklch(0.8 0.1 250)",
  "oklch(0.82 0.11 310)",
  "var(--acd)",
  "oklch(0.97 0.01 250)",
];

const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`;

function color256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
  }
  const i = n - 16;
  const c = (x: number) => (x ? 55 + x * 40 : 0);
  return rgb(c(Math.floor(i / 36)), c(Math.floor((i % 36) / 6)), c(i % 6));
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Seg {
  text: string;
  style: CSSProperties;
}

function toCss(s: Style): CSSProperties {
  const css: CSSProperties = {};
  if (s.fg) css.color = s.fg;
  if (s.bg) css.background = s.bg;
  if (s.bold) css.fontWeight = 600;
  if (s.dim) css.opacity = 0.65;
  if (s.italic) css.fontStyle = "italic";
  if (s.underline) css.textDecoration = "underline";
  return css;
}

function applySgr(style: Style, params: string) {
  const codes = params.split(";").map((x) => (x === "" ? 0 : parseInt(x, 10)));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(style, { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false });
    else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 22) { style.bold = false; style.dim = false; }
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c >= 30 && c <= 37) style.fg = BASIC[c - 30];
    else if (c === 39) style.fg = undefined;
    else if (c >= 40 && c <= 47) style.bg = BASIC[c - 40];
    else if (c === 49) style.bg = undefined;
    else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
    else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100];
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) { style[key] = color256(codes[i + 2] ?? 0); i += 2; }
      else if (codes[i + 1] === 2) { style[key] = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0); i += 4; }
    }
  }
}

/** Parse a chunk of terminal output into lines of styled segments. */
export function ansiToLines(input: string): Seg[][] {
  // drop OSC sequences, normalize CRLF (PTYs emit \r\n; a lone \r is overwrite)
  const text = input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // eslint-disable-line no-control-regex
    .replace(/\r\n/g, "\n");
  const lines: Seg[][] = [];
  let cur: Seg[] = [];
  const style: Style = {};
  let buf = "";
  const flush = () => {
    if (buf) {
      cur.push({ text: buf, style: toCss(style) });
      buf = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\x1b" && text[i + 1] === "[") {
      flush();
      let j = i + 2;
      while (j < text.length && !/[@-~]/.test(text[j])) j++;
      if (text[j] === "m") applySgr(style, text.slice(i + 2, j));
      i = j;
    } else if (ch === "\x1b") {
      flush();
      i += 1; // skip a stray escape + its next byte
    } else if (ch === "\n") {
      flush();
      lines.push(cur);
      cur = [];
    } else if (ch === "\r") {
      flush();
      cur = []; // carriage return → overwrite current line
    } else if (ch === "\t") {
      buf += "  ";
    } else if (ch === "\b") {
      flush();
      buf = buf.slice(0, -1);
    } else {
      buf += ch;
    }
  }
  flush();
  if (cur.length || lines.length === 0) lines.push(cur);
  return lines;
}
