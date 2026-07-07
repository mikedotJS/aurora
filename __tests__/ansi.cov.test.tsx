// Coverage suite for src/lib/ansi.ts — pure ANSI → styled-segment parser.
// No Tauri/store dependency; exercises every SGR branch, line-splitting rule,
// and control-character handling directly against real return values.

import { describe, it, expect } from "bun:test";
import { ansiToLines, type Seg } from "../src/lib/ansi";

function text(seg: Seg[][]): string[] {
  return seg.map((line) => line.map((s) => s.text).join(""));
}

describe("ansiToLines — plain text & line splitting", () => {
  it("returns a single line with one segment for plain text", () => {
    const lines = ansiToLines("hello world");
    expect(lines.length).toBe(1);
    expect(lines[0].length).toBe(1);
    expect(lines[0][0].text).toBe("hello world");
    expect(lines[0][0].style).toEqual({});
  });

  it("empty input still yields one (empty) line", () => {
    const lines = ansiToLines("");
    expect(lines.length).toBe(1);
    expect(lines[0]).toEqual([]);
  });

  it("splits on \\n into multiple lines", () => {
    const lines = ansiToLines("a\nb\nc");
    expect(text(lines)).toEqual(["a", "b", "c"]);
  });

  it("does not push a trailing empty line when input ends with \\n", () => {
    const lines = ansiToLines("a\nb\n");
    expect(text(lines)).toEqual(["a", "b"]);
  });

  it("normalizes \\r\\n to \\n (single split, not a stray overwrite)", () => {
    const lines = ansiToLines("a\r\nb");
    expect(text(lines)).toEqual(["a", "b"]);
  });

  it("a lone \\r overwrites the current line (drops buffered content)", () => {
    const lines = ansiToLines("abcdef\rxy");
    // \r flushes "abcdef" into cur then resets cur to [] — "abcdef" segment is discarded,
    // only "xy" (written after the CR) remains in the final line.
    expect(lines.length).toBe(1);
    expect(text(lines)).toEqual(["xy"]);
  });

  it("expands tabs to two spaces", () => {
    const lines = ansiToLines("a\tb");
    expect(text(lines)).toEqual(["a  b"]);
  });

  it("backspace erases the last char of the current run", () => {
    // "abc", then \b removes the 'c', then 'd' → "abd" as one unbroken run.
    const lines = ansiToLines("abc\bd");
    expect(lines.length).toBe(1);
    expect(lines[0].map((s) => s.text)).toEqual(["abd"]);
    expect(text(lines)).toEqual(["abd"]);
  });

  it("backspace on an empty buffer is a no-op (does not throw)", () => {
    const lines = ansiToLines("\bx");
    expect(text(lines)).toEqual(["x"]);
  });
});

describe("ansiToLines — OSC & stray escape stripping", () => {
  it("strips an OSC sequence terminated by BEL", () => {
    const lines = ansiToLines("\x1b]0;window title\x07visible");
    expect(text(lines)).toEqual(["visible"]);
  });

  it("strips an OSC sequence terminated by ST (ESC \\\\)", () => {
    const lines = ansiToLines("\x1b]0;title\x1b\\visible");
    expect(text(lines)).toEqual(["visible"]);
  });

  it("skips a stray lone ESC (not CSI) plus its next byte", () => {
    // ESC 'M' (reverse index) is not a CSI ('[') sequence — flush + skip one byte.
    const lines = ansiToLines("a\x1bMb");
    expect(text(lines)).toEqual(["ab"]);
  });

  it("skips a non-SGR CSI sequence (e.g. cursor-hide) without touching style", () => {
    const lines = ansiToLines("\x1b[?25hplain");
    expect(text(lines)).toEqual(["plain"]);
    expect(lines[0][0].style).toEqual({});
  });

  it("skips an erase-display CSI (final byte 'J', not 'm')", () => {
    const lines = ansiToLines("\x1b[2Jcleared");
    expect(text(lines)).toEqual(["cleared"]);
  });
});

describe("ansiToLines — SGR text attributes", () => {
  it("bold (1) sets fontWeight 600", () => {
    const lines = ansiToLines("\x1b[1mbold");
    expect(lines[0][0].style.fontWeight).toBe(600);
  });
  it("dim (2) sets opacity 0.65", () => {
    const lines = ansiToLines("\x1b[2mdim");
    expect(lines[0][0].style.opacity).toBe(0.65);
  });
  it("italic (3) sets fontStyle italic", () => {
    const lines = ansiToLines("\x1b[3mitalic");
    expect(lines[0][0].style.fontStyle).toBe("italic");
  });
  it("underline (4) sets textDecoration underline", () => {
    const lines = ansiToLines("\x1b[4munderline");
    expect(lines[0][0].style.textDecoration).toBe("underline");
  });
  it("22 clears bold and dim", () => {
    const lines = ansiToLines("\x1b[1;2m\x1b[22mplain");
    expect(lines[0][0].style.fontWeight).toBeUndefined();
    expect(lines[0][0].style.opacity).toBeUndefined();
  });
  it("23 clears italic", () => {
    const lines = ansiToLines("\x1b[3m\x1b[23mplain");
    expect(lines[0][0].style.fontStyle).toBeUndefined();
  });
  it("24 clears underline", () => {
    const lines = ansiToLines("\x1b[4m\x1b[24mplain");
    expect(lines[0][0].style.textDecoration).toBeUndefined();
  });
  it("0 (reset) clears all attributes and colors", () => {
    const lines = ansiToLines("\x1b[1;31;4m\x1b[0mplain");
    expect(lines[0][0].style).toEqual({});
  });
  it("empty SGR param (bare ESC[m) behaves as reset (0)", () => {
    const lines = ansiToLines("\x1b[1m\x1b[mplain");
    expect(lines[0][0].style).toEqual({});
  });
});

describe("ansiToLines — basic/bright fg+bg colors", () => {
  it("applies a basic fg color (30-37)", () => {
    const lines = ansiToLines("\x1b[31mred");
    expect(lines[0][0].style.color).toBe("var(--err)");
  });
  it("fg reset (39) clears fg", () => {
    const lines = ansiToLines("\x1b[31m\x1b[39mplain");
    expect(lines[0][0].style.color).toBeUndefined();
  });
  it("applies a basic bg color (40-47)", () => {
    const lines = ansiToLines("\x1b[41mred-bg");
    expect(lines[0][0].style.background).toBe("var(--err)");
  });
  it("bg reset (49) clears bg", () => {
    const lines = ansiToLines("\x1b[41m\x1b[49mplain");
    expect(lines[0][0].style.background).toBeUndefined();
  });
  it("applies a bright fg color (90-97)", () => {
    const lines = ansiToLines("\x1b[92mbright-green");
    expect(lines[0][0].style.color).toBe("oklch(0.85 0.13 155)");
  });
  it("applies a bright bg color (100-107)", () => {
    const lines = ansiToLines("\x1b[102mbright-green-bg");
    expect(lines[0][0].style.background).toBe("oklch(0.85 0.13 155)");
  });
});

describe("ansiToLines — 256-color palette (38;5;N / 48;5;N)", () => {
  it("N < 8 maps to the BASIC palette", () => {
    const lines = ansiToLines("\x1b[38;5;1mred256");
    expect(lines[0][0].style.color).toBe("var(--err)"); // BASIC[1]
  });
  it("8 <= N < 16 maps to the BRIGHT palette", () => {
    const lines = ansiToLines("\x1b[38;5;9mbright-red256");
    expect(lines[0][0].style.color).toBe("oklch(0.8 0.13 24)"); // BRIGHT[9-8]
  });
  it("N >= 232 maps to a greyscale ramp", () => {
    const lines = ansiToLines("\x1b[38;5;232mgrey");
    // v = 8 + (232-232)*10 = 8
    expect(lines[0][0].style.color).toBe("rgb(8,8,8)");
  });
  it("16 <= N < 232 maps to the 6x6x6 cube (component 0 stays 0)", () => {
    const lines = ansiToLines("\x1b[38;5;16mcube-black");
    // i = 0 -> r=g=b=0
    expect(lines[0][0].style.color).toBe("rgb(0,0,0)");
  });
  it("16 <= N < 232 maps to the 6x6x6 cube (nonzero component uses 55+x*40)", () => {
    const lines = ansiToLines("\x1b[38;5;52mcube-red");
    // i = 52-16 = 36 -> r-idx=floor(36/36)=1 -> 55+1*40=95; g-idx=floor((36%36)/6)=0; b-idx=36%6=0
    expect(lines[0][0].style.color).toBe("rgb(95,0,0)");
  });
  it("256-color bg (48;5;N) sets background", () => {
    const lines = ansiToLines("\x1b[48;5;1mbg256");
    expect(lines[0][0].style.background).toBe("var(--err)");
  });
});

describe("ansiToLines — truecolor (38;2;r;g;b / 48;2;r;g;b)", () => {
  it("sets an exact truecolor fg", () => {
    const lines = ansiToLines("\x1b[38;2;10;20;30mtruecolor");
    expect(lines[0][0].style.color).toBe("rgb(10,20,30)");
  });
  it("sets an exact truecolor bg", () => {
    const lines = ansiToLines("\x1b[48;2;1;2;3mtruecolor-bg");
    expect(lines[0][0].style.background).toBe("rgb(1,2,3)");
  });
  it("missing truecolor components default to 0", () => {
    const lines = ansiToLines("\x1b[38;2mtruncated");
    expect(lines[0][0].style.color).toBe("rgb(0,0,0)");
  });
});

describe("ansiToLines — segment boundaries & multiple styles", () => {
  it("produces separate segments when style changes mid-line", () => {
    const lines = ansiToLines("plain\x1b[31mred\x1b[0mplain2");
    expect(lines.length).toBe(1);
    const segs = lines[0];
    expect(segs.map((s) => s.text)).toEqual(["plain", "red", "plain2"]);
    expect(segs[0].style.color).toBeUndefined();
    expect(segs[1].style.color).toBe("var(--err)");
    expect(segs[2].style.color).toBeUndefined();
  });

  it("multiple SGR codes in one sequence combine (bold + red fg)", () => {
    const lines = ansiToLines("\x1b[1;31mboldred");
    expect(lines[0][0].style.fontWeight).toBe(600);
    expect(lines[0][0].style.color).toBe("var(--err)");
  });
});
