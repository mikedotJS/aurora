// Accent + font-size maps, copied from the Aurora mockup, applied to the root
// as CSS variables so the whole UI re-themes live.

export type AccentKey = "teal" | "indigo" | "green" | "amber";
export type FontKey = "compact" | "cozy" | "large";

export const ACCENTS: Record<AccentKey, [string, string]> = {
  teal: ["oklch(0.83 0.115 184)", "oklch(0.68 0.085 186)"],
  indigo: ["oklch(0.78 0.11 270)", "oklch(0.67 0.1 272)"],
  green: ["oklch(0.84 0.13 150)", "oklch(0.7 0.11 152)"],
  amber: ["oklch(0.84 0.12 82)", "oklch(0.72 0.1 84)"],
};

export const FONT_SIZES: Record<FontKey, string> = {
  compact: "13px",
  cozy: "14px",
  large: "15.5px",
};

export function applyTheme(accent: AccentKey, fontSize: FontKey): void {
  const root = document.documentElement;
  const [ac, acd] = ACCENTS[accent] ?? ACCENTS.teal;
  root.style.setProperty("--ac", ac);
  root.style.setProperty("--acd", acd);
  root.style.setProperty("--fs", FONT_SIZES[fontSize] ?? FONT_SIZES.cozy);
}
