// Coverage suite for src/lib/dirFrecency.ts — zoxide-style frecency for the
// home terminal's `cd ` popover. Pure module: localStorage load/save, bump
// (+1/refresh/cap), score (recency decay), topDirs (substring filter + rank).
import { describe, it, expect, beforeEach } from "bun:test";
import {
  loadDirFrecency,
  saveDirFrecency,
  bumpDir,
  score,
  topDirs,
  type DirFrecency,
} from "../src/lib/dirFrecency";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  localStorage.clear();
});

describe("bumpDir", () => {
  it("creates a new entry with count 1 and lastVisit = now", () => {
    const now = 1_000_000;
    const next = bumpDir("/repo/a", {}, now);
    expect(next["/repo/a"]).toEqual({ count: 1, lastVisit: now });
  });

  it("a second bump increments count to 2 and refreshes lastVisit", () => {
    const first = bumpDir("/repo/a", {}, 1000);
    const second = bumpDir("/repo/a", first, 5000);
    expect(second["/repo/a"]).toEqual({ count: 2, lastVisit: 5000 });
  });

  it("does not mutate the input data object (returns a new object)", () => {
    const data: DirFrecency = { "/repo/a": { count: 1, lastVisit: 1000 } };
    const next = bumpDir("/repo/a", data, 2000);
    expect(data["/repo/a"]).toEqual({ count: 1, lastVisit: 1000 });
    expect(next).not.toBe(data);
  });

  it("leaves other paths untouched", () => {
    const data: DirFrecency = { "/repo/b": { count: 5, lastVisit: 1000 } };
    const next = bumpDir("/repo/a", data, 2000);
    expect(next["/repo/b"]).toEqual({ count: 5, lastVisit: 1000 });
  });
});

describe("score / decay", () => {
  it("recency beats raw count: 5 visits 30min ago outscores 10 visits 30 days ago", () => {
    const now = 40 * DAY;
    const recentButFewer = score({ count: 5, lastVisit: now - 30 * 60_000 }, now);
    const oldButMore = score({ count: 10, lastVisit: now - 30 * DAY }, now);
    expect(recentButFewer).toBeGreaterThan(oldButMore);
  });

  it("applies the ≤1h tier (×4)", () => {
    const now = 100 * DAY;
    expect(score({ count: 3, lastVisit: now - 30 * 60_000 }, now)).toBe(12);
  });

  it("applies the ≤1d tier (×2) just past the 1h boundary", () => {
    const now = 100 * DAY;
    expect(score({ count: 3, lastVisit: now - (HOUR + 1) }, now)).toBe(6);
  });

  it("applies the ≤7d tier (×0.5) just past the 1d boundary", () => {
    const now = 100 * DAY;
    expect(score({ count: 3, lastVisit: now - (DAY + 1) }, now)).toBe(1.5);
  });

  it("applies the >7d tier (×0.25) just past the 7d boundary", () => {
    const now = 100 * DAY;
    expect(score({ count: 3, lastVisit: now - (7 * DAY + 1) }, now)).toBe(0.75);
  });

  it("clamps negative age (lastVisit in the future) to the ≤1h tier instead of blowing up", () => {
    const now = 1000;
    expect(score({ count: 2, lastVisit: now + 10_000 }, now)).toBe(8);
  });
});

describe("topDirs", () => {
  // topDirs computes recency internally against the real Date.now() (it takes
  // no `now` param), so fixtures must anchor lastVisit relative to the real
  // clock — an arbitrary epoch like `100 * DAY` would put every entry decades
  // in the past (>7d tier for all), collapsing the ranking to count-only.
  const now = Date.now();
  function data(): DirFrecency {
    return {
      "/Users/me/projects/aurora": { count: 1, lastVisit: now - 30 * 60_000 }, // score 4
      "/Users/me/projects/other": { count: 10, lastVisit: now - 30 * DAY }, // score 2.5
      "/Users/me/scratch": { count: 20, lastVisit: now - 30 * DAY }, // score 5, no "pro" match
    };
  }

  it("sorts by score descending when there is no prefix filter", () => {
    const d = data();
    const out = topDirs(d, "", "/cwd", 10);
    expect(out).toEqual(["/Users/me/scratch", "/Users/me/projects/aurora", "/Users/me/projects/other"]);
  });

  it("filters to paths whose last segment or full path contains the needle", () => {
    const d = data();
    const out = topDirs(d, "pro", "/cwd", 10);
    expect(out.sort()).toEqual(["/Users/me/projects/aurora", "/Users/me/projects/other"].sort());
    expect(out).not.toContain("/Users/me/scratch");
  });

  it("respects the limit after filtering/sorting", () => {
    const d = data();
    const out = topDirs(d, "", "/cwd", 2);
    expect(out.length).toBe(2);
    expect(out).toEqual(["/Users/me/scratch", "/Users/me/projects/aurora"]);
  });

  it("matches on a path segment even when the needle isn't at the start", () => {
    const d: DirFrecency = { "/Users/me/my-aurora-fork": { count: 1, lastVisit: now } };
    expect(topDirs(d, "aurora", "/cwd", 10)).toEqual(["/Users/me/my-aurora-fork"]);
  });

  it("returns [] when nothing matches the prefix", () => {
    const d = data();
    expect(topDirs(d, "zzz-no-match", "/cwd", 10)).toEqual([]);
  });
});

describe("cap at MAX_ENTRIES (200)", () => {
  it("bumpDir keeps at most 200 entries after exceeding the cap", () => {
    let data: DirFrecency = {};
    const now = 1_000_000;
    for (let i = 0; i < 205; i++) {
      data = bumpDir(`/repo/dir${i}`, data, now + i);
    }
    expect(Object.keys(data).length).toBe(200);
  });

  it("never evicts the just-bumped path even if its score is the lowest", () => {
    // Seed 200 entries with a high score (many visits, very recent).
    let data: DirFrecency = {};
    const now = 1_000_000;
    for (let i = 0; i < 200; i++) {
      data[`/repo/dir${i}`] = { count: 1000, lastVisit: now };
    }
    // Bump a brand-new path once — its score (1 * decay) is far lower than the
    // seeded entries', but it must still survive its own bump.
    const next = bumpDir("/repo/fresh", data, now);
    expect(Object.keys(next).length).toBe(200);
    expect(next["/repo/fresh"]).toEqual({ count: 1, lastVisit: now });
  });

  it("evicts the lowest-scored entries, not arbitrary ones", () => {
    let data: DirFrecency = {};
    const now = 1_000_000;
    // 200 old, low-value entries (visited 30 days ago, count 1 => low score).
    for (let i = 0; i < 200; i++) {
      data[`/repo/old${i}`] = { count: 1, lastVisit: now - 30 * DAY };
    }
    // One bump of a new path — highest possible score (count 1, age 0 => ×4).
    const next = bumpDir("/repo/newest", data, now);
    expect(Object.keys(next).length).toBe(200);
    expect(next["/repo/newest"]).toBeDefined();
    // Exactly one old entry must have been evicted to make room.
    const oldSurvivors = Object.keys(next).filter((p) => p.startsWith("/repo/old")).length;
    expect(oldSurvivors).toBe(199);
  });
});

describe("loadDirFrecency / saveDirFrecency", () => {
  it("returns {} when nothing is stored", () => {
    expect(loadDirFrecency()).toEqual({});
  });

  it("round-trips data through saveDirFrecency/loadDirFrecency", () => {
    const data: DirFrecency = { "/repo/a": { count: 3, lastVisit: 1234 } };
    saveDirFrecency(data);
    expect(loadDirFrecency()).toEqual(data);
  });

  it("returns {} when the stored value is not an object (e.g. an array or primitive)", () => {
    localStorage.setItem("aurora.dirFrecency", JSON.stringify([1, 2, 3]));
    // An array IS typeof "object" in JS, but has no valid entries per-shape.
    expect(loadDirFrecency()).toEqual({});
    localStorage.setItem("aurora.dirFrecency", JSON.stringify(42));
    expect(loadDirFrecency()).toEqual({});
  });

  it("filters out malformed entries (missing/mistyped count or lastVisit) but keeps valid ones", () => {
    localStorage.setItem(
      "aurora.dirFrecency",
      JSON.stringify({
        "/repo/good": { count: 2, lastVisit: 1000 },
        "/repo/bad1": { count: "two", lastVisit: 1000 },
        "/repo/bad2": { count: 2 },
        "/repo/bad3": null,
        "/repo/bad4": "not-an-object",
      }),
    );
    expect(loadDirFrecency()).toEqual({ "/repo/good": { count: 2, lastVisit: 1000 } });
  });

  it("swallows malformed JSON and returns {}", () => {
    localStorage.setItem("aurora.dirFrecency", "{not json");
    expect(loadDirFrecency()).toEqual({});
  });

  it("saveDirFrecency swallows a localStorage.setItem failure", () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => saveDirFrecency({ "/repo/a": { count: 1, lastVisit: 1 } })).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });
});
