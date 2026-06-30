// Minimal, built-in branch-naming used by the create flow until the configurable
// engine (workspace-config) supersedes it.

/** lowercase, non-alphanumeric → dashes, collapse/trim, cap at 40 chars. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** `key/slug` when issue-backed, else just the slug. */
export function buildBranchName(opts: { issueKey?: string | null; title: string }): string {
  const slug = slugify(opts.title);
  if (opts.issueKey) return `${opts.issueKey.toLowerCase()}/${slug || "work"}`;
  return slug || "work";
}

export type BranchCheck = { ok: true } | { ok: false; error: string };

// git-forbidden characters: whitespace, ~ ^ : ? * [ and backslash.
const BAD_CHARS = new RegExp("[\\s~^:?*\\[\\\\]");

/** Local sanity only — the repo-validator integration lives in workspace-config. */
export function validateBranchName(name: string): BranchCheck {
  const n = name.trim();
  if (!n) return { ok: false, error: "Enter a branch name." };
  if (n.includes("..")) return { ok: false, error: "Branch names can't contain “..”." };
  if (/^[-/]/.test(n) || n.endsWith("/"))
    return { ok: false, error: "Branch names can't start with “-”/“/” or end with “/”." };
  if (BAD_CHARS.test(n)) return { ok: false, error: "Branch name has invalid characters." };
  return { ok: true };
}
