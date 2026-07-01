/// <reference types="bun-types" />
/**
 * Unit tests for src/lib/useMediaQuery.ts — responsive-ui-layout OpenSpec change.
 *
 * Covers:
 *   - BP_NARROW_PX === 840 (sync with --bp-narrow in tokens.css)
 *
 * NOTE: useMediaQuery / useNarrow hooks were removed (no consumers) as part of
 * the responsive-ui-layout review fix #1 — App.tsx consumes BP_NARROW_PX directly.
 */
import { describe, it, expect } from "bun:test";

const { BP_NARROW_PX } = (await import("../src/lib/useMediaQuery.ts")) as {
  BP_NARROW_PX: number;
};

// ══════════════════════════════════════════════════════════════════════════════
// BP_NARROW_PX
// ══════════════════════════════════════════════════════════════════════════════

describe("BP_NARROW_PX", () => {
  it("equals 840 — mirrors --bp-narrow in tokens.css", () => {
    expect(BP_NARROW_PX).toBe(840);
  });
});
