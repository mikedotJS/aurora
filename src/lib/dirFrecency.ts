// zoxide-style directory frecency for the home terminal's `cd ` popover.
// Pure module: load/save localStorage, bump on cwd change, score + rank on query.
// Mirrors the load*/save* + try/catch-silent conventions of workspace.ts.

export interface DirFrecencyEntry {
  count: number;
  lastVisit: number;
}

export type DirFrecency = Record<string, DirFrecencyEntry>;

const KEY = "aurora.dirFrecency";
/** Cap the persisted set so localStorage can't grow unbounded over long-term use. */
const MAX_ENTRIES = 200;

export function loadDirFrecency(): DirFrecency {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: DirFrecency = {};
    for (const [path, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as DirFrecencyEntry).count === "number" &&
        typeof (v as DirFrecencyEntry).lastVisit === "number"
      ) {
        out[path] = { count: (v as DirFrecencyEntry).count, lastVisit: (v as DirFrecencyEntry).lastVisit };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDirFrecency(data: DirFrecency): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

/** zoxide-like recency decay: recent visits count for more than old ones. */
function decay(ageMs: number): number {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  if (ageMs <= HOUR) return 4;
  if (ageMs <= DAY) return 2;
  if (ageMs <= 7 * DAY) return 0.5;
  return 0.25;
}

export function score(entry: DirFrecencyEntry, now: number): number {
  return entry.count * decay(Math.max(0, now - entry.lastVisit));
}

/**
 * Record a visit to `path`: +1 to its count, refresh lastVisit. Caps the store
 * at MAX_ENTRIES by dropping the lowest-scored entries (evaluated at save time)
 * so the bumped entry is never evicted by its own bump.
 */
export function bumpDir(path: string, data: DirFrecency, now: number = Date.now()): DirFrecency {
  const existing = data[path];
  const next: DirFrecency = {
    ...data,
    [path]: { count: (existing?.count ?? 0) + 1, lastVisit: now },
  };
  const paths = Object.keys(next);
  if (paths.length <= MAX_ENTRIES) return next;
  // Always retain the just-bumped path — a brand-new dir has a low score and
  // would otherwise be evicted by its own bump, dropping the visit we just
  // recorded. Rank the *others* and keep the top MAX_ENTRIES-1 alongside it.
  const others = paths.filter((p) => p !== path).sort((a, b) => score(next[b], now) - score(next[a], now));
  const capped: DirFrecency = { [path]: next[path] };
  for (const p of others.slice(0, MAX_ENTRIES - 1)) capped[p] = next[p];
  return capped;
}

/**
 * Top directories matching `prefix` (case-sensitive substring on the last path
 * segment, like zoxide's tail match), ranked by frecency score. `cwd` is
 * accepted for symmetry with the completion helpers but v1 doesn't special-case
 * it — every stored path is a candidate regardless of the current directory.
 */
export function topDirs(data: DirFrecency, prefix: string, _cwd: string, limit: number): string[] {
  const now = Date.now();
  const needle = prefix.trim();
  const paths = Object.keys(data).filter((p) => {
    if (!needle) return true;
    const seg = baseName(p);
    return seg.includes(needle) || p.includes(needle);
  });
  return paths
    .sort((a, b) => score(data[b], now) - score(data[a], now))
    .slice(0, limit);
}

function baseName(p: string): string {
  const seg = p.split("/").filter(Boolean).pop();
  return seg ?? p;
}
