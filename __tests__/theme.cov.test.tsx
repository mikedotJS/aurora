// Coverage suite for src/lib/theme.ts — accent/font-size maps applied as CSS vars.

import { describe, it, expect, afterEach } from "bun:test";
import { ACCENTS, FONT_SIZES, applyTheme, type AccentKey, type FontKey } from "../src/lib/theme";

afterEach(() => {
  // Leave a clean root style between tests.
  for (const prop of ["--ac", "--acd", "--fs"]) {
    document.documentElement.style.removeProperty(prop);
  }
});

describe("ACCENTS / FONT_SIZES maps", () => {
  it("has an entry for every AccentKey", () => {
    const keys: AccentKey[] = ["teal", "indigo", "green", "amber"];
    for (const k of keys) {
      expect(ACCENTS[k]).toBeDefined();
      expect(ACCENTS[k].length).toBe(2);
    }
  });
  it("has an entry for every FontKey", () => {
    const keys: FontKey[] = ["compact", "cozy", "large"];
    for (const k of keys) {
      expect(FONT_SIZES[k]).toBeDefined();
    }
  });
});

describe("applyTheme", () => {
  it("sets --ac/--acd from the accent's [light, dark] pair", () => {
    applyTheme("indigo", "cozy");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--ac")).toBe(ACCENTS.indigo[0]);
    expect(root.style.getPropertyValue("--acd")).toBe(ACCENTS.indigo[1]);
  });

  it("sets --fs from the font size map", () => {
    applyTheme("teal", "large");
    expect(document.documentElement.style.getPropertyValue("--fs")).toBe(FONT_SIZES.large);
  });

  it("each accent key produces its own --ac/--acd pair", () => {
    for (const key of Object.keys(ACCENTS) as AccentKey[]) {
      applyTheme(key, "cozy");
      expect(document.documentElement.style.getPropertyValue("--ac")).toBe(ACCENTS[key][0]);
      expect(document.documentElement.style.getPropertyValue("--acd")).toBe(ACCENTS[key][1]);
    }
  });

  it("each font key produces its own --fs", () => {
    for (const key of Object.keys(FONT_SIZES) as FontKey[]) {
      applyTheme("teal", key);
      expect(document.documentElement.style.getPropertyValue("--fs")).toBe(FONT_SIZES[key]);
    }
  });

  it("falls back to teal when accent is not a known key (defensive ?? guard)", () => {
    applyTheme("nope" as AccentKey, "cozy");
    expect(document.documentElement.style.getPropertyValue("--ac")).toBe(ACCENTS.teal[0]);
    expect(document.documentElement.style.getPropertyValue("--acd")).toBe(ACCENTS.teal[1]);
  });

  it("falls back to cozy font size when fontSize is not a known key (defensive ?? guard)", () => {
    applyTheme("teal", "nope" as FontKey);
    expect(document.documentElement.style.getPropertyValue("--fs")).toBe(FONT_SIZES.cozy);
  });
});
