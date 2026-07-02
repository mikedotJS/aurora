// The configurable branch-naming engine (workspace-config). Four sources:
//   - manual:       a token template ({key}/{type}/{slug}…) with a live preview
//   - package-json: a template read from a configured package.json field (shared)
//   - validator:    a rule parsed from the repo's validate-branch-name regex
//   - ai:           a plain-English instruction Claude applies, chained through
//                   the validator with retry
// `applyTemplate` is pure/sync (drives the live preview); `resolveBranchName` is
// async (hits the backend for package.json / validator / AI + authoritative ✓✕).

import { slugify } from "./branchName";
import { readPackageField, detectBranchValidator, validateBranchNameBackend } from "./sys";
import { claudeText, NoKeyError } from "../ai/suggest";

/** A group parsed out of a validator regex, in source order. */
export type RegexGroup =
  | { kind: "enum"; options: string[] }
  | { kind: "free"; hint?: string }
  | { kind: "literal"; text: string };

export type BranchNamingConfig =
  | { source: "manual"; template: string }
  | { source: "package-json"; field: string }
  | { source: "validator"; regex: string; groups: RegexGroup[] }
  | { source: "ai"; instruction: string; chainValidator: boolean };

export const DEFAULT_BRANCH_NAMING: BranchNamingConfig = { source: "manual", template: "{key}/{slug}" };

/** The issue context branch names are generated from. */
export interface NameIssue {
  key?: string | null;
  /** Issue type, e.g. "Bug", "Story". */
  type?: string | null;
  title: string;
  assignee?: string | null;
  sprint?: string | null;
  /** Jira component / app, used by validator + AI modes for an `<app>` segment. */
  component?: string | null;
}

export interface ResolvedName {
  name: string;
  /** What to show as a preview (same as name for most sources). */
  preview: string;
  /** ✓/✕ against the repo's validator (true when no validator enforces). */
  valid: boolean;
  /** Reasoning (AI) or the reason a name is invalid. */
  explanation?: string;
}

const KNOWN_TOKENS = new Set(["key", "type", "slug", "assignee", "sprint", "yy-mm"]);

function yyMm(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function tokenValue(token: string, issue: NameIssue): string {
  switch (token) {
    case "key":
      return (issue.key ?? "").toLowerCase();
    case "type":
      return slugify(issue.type ?? "");
    case "slug":
      return slugify(issue.title ?? "");
    case "assignee":
      return slugify(issue.assignee ?? "");
    case "sprint":
      return slugify(issue.sprint ?? "");
    case "yy-mm":
      return yyMm();
    default:
      return ""; // unknown token → dropped
  }
}

/**
 * Substitute tokens in a manual template, then normalize: lowercase, spaces→`-`,
 * unknown/unresolvable tokens dropped, and separators collapsed/trimmed so a
 * dropped token never leaves a dangling `//` or `-/`. The slug is already capped
 * at 40 chars by `slugify`. Pure + synchronous.
 */
export function applyTemplate(template: string, issue: NameIssue): string {
  const substituted = template.replace(/\{([a-z0-9-]+)\}/gi, (_, t: string) =>
    tokenValue(t.toLowerCase(), issue),
  );
  return substituted
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/-+\//g, "/") // trailing dashes before a slash
    .replace(/\/-+/g, "/") // leading dashes after a slash
    .replace(/^[-/]+|[-/]+$/g, "");
}

/** True if a template references at least one known, resolvable token. */
export function templateTokens(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{([a-z0-9-]+)\}/gi)) {
    const t = m[1].toLowerCase();
    if (KNOWN_TOKENS.has(t)) out.push(t);
  }
  return out;
}

/**
 * Parse a (JS-flavoured) validator regex into ordered groups: top-level
 * alternation groups `(feat|fix|chore)` become enum pickers, other groups become
 * free slug fields, and literal text between them is kept as separators. Anchors
 * and a few common wrappers are stripped. Best-effort — used to build a guided
 * composer, not to re-validate (the backend does that authoritatively).
 */
export function parseRegexToGroups(regex: string): RegexGroup[] {
  let src = regex.trim();
  if (src.startsWith("^")) src = src.slice(1);
  if (src.endsWith("$")) src = src.slice(0, -1);

  const groups: RegexGroup[] = [];
  let literal = "";
  const flushLiteral = () => {
    if (literal) {
      groups.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  // consume a (possibly lazy) quantifier starting at `from`, return the index after it.
  // NB: test the char explicitly — `"?*+".includes(undefined ?? "")` is `true`
  // (String.includes("") === true), which would run off the end forever.
  const isQuant = (ch: string | undefined) => ch === "?" || ch === "*" || ch === "+";
  const afterQuantifier = (from: number) => {
    let k = from;
    while (isQuant(src[k])) k += 1;
    return k;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1] ?? "";
      if ("dwsDWS".includes(next)) {
        // a character-class shorthand (\d, \w, …) → free atom + optional quantifier
        const k = afterQuantifier(i + 2);
        flushLiteral();
        groups.push({ kind: "free", hint: src.slice(i, k) });
        i = k - 1;
        continue;
      }
      // escaped literal char (e.g. \-, \/, \.) — keep the next char literally
      literal += next;
      i += 1;
      continue;
    }
    // `.` wildcard (+ optional quantifier like .+, .*, .*?) → free slug slot
    if (c === ".") {
      const k = afterQuantifier(i + 1);
      flushLiteral();
      groups.push({ kind: "free", hint: src.slice(i, k) });
      i = k - 1;
      continue;
    }
    if (c === "(") {
      // scan to the matching close paren (no nested groups expected in practice)
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < src.length && depth > 0) {
        const d = src[j];
        if (d === "\\") {
          body += src[j] + (src[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (d === "(") depth += 1;
        else if (d === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += d;
        j += 1;
      }
      flushLiteral();
      // drop a non-capturing prefix and a trailing quantifier
      const inner = body.replace(/^\?:/, "").replace(/[?*+]$/, "");
      if (/^[\w.-]+(\|[\w.-]+)+$/.test(inner)) {
        groups.push({ kind: "enum", options: inner.split("|") });
      } else {
        groups.push({ kind: "free", hint: inner });
      }
      i = j; // advance past the close paren
      continue;
    }
    // a free char class like [a-z]+ / \w+ — treat the run as one free group
    if (c === "[") {
      let j = i + 1;
      while (j < src.length && src[j] !== "]") j += 1;
      // consume a trailing quantifier
      const k = isQuant(src[j + 1]) ? j + 2 : j + 1;
      flushLiteral();
      groups.push({ kind: "free", hint: src.slice(i, k) });
      i = k - 1;
      continue;
    }
    literal += c;
  }
  flushLiteral();
  return groups;
}

/** Common Jira-issue-type → branch-type-keyword mappings for enum matching. */
const TYPE_SYNONYMS: Record<string, string[]> = {
  bug: ["fix", "bugfix", "hotfix"],
  story: ["feat", "feature"],
  task: ["feat", "chore", "task"],
  epic: ["feat", "feature"],
  spike: ["spike", "chore"],
  improvement: ["feat", "refactor", "improvement"],
  subtask: ["chore", "task"],
  "sub-task": ["chore", "task"],
};

/** The trailing number of an issue key, e.g. PROJ-1423 → "1423". */
function issueNumber(issue: NameIssue): string {
  const m = (issue.key ?? "").match(/(\d+)\s*$/);
  return m ? m[1] : "";
}

/** Whether a free group's regex hint constrains it to digits (e.g. `[0-9]+`, `\d+`). */
function isDigitHint(hint: string): boolean {
  return /\\d|\[0-9\]/.test(hint) && !/[a-z]/i.test(hint.replace(/\\d/g, ""));
}

/** Pick the enum option that best matches an issue's type/component (with type
 *  synonyms like Bug→fix), else the first. */
function pickEnum(options: string[], issue: NameIssue): string {
  const typeSlug = slugify(issue.type ?? "");
  const compSlug = slugify(issue.component ?? "");
  const wants = new Set([typeSlug, compSlug, ...(TYPE_SYNONYMS[typeSlug] ?? [])].filter(Boolean));
  for (const o of options) if (wants.has(slugify(o))) return o;
  for (const o of options) {
    const so = slugify(o);
    if ([...wants].some((w) => w.startsWith(so) || so.startsWith(w))) return o;
  }
  return options[0] ?? "";
}

/**
 * Split a regex into its top-level alternatives (the `|`s at paren-depth 0),
 * respecting escapes and character classes. `^a$|^b$` → [`^a$`, `^b$`].
 */
export function splitTopLevelAlternation(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      cur += c + (src[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (inClass) {
      cur += c;
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      cur += c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Parse a regex into its alternatives, each a sequence of ordered groups. */
export function parseRegexToAlternatives(regex: string): RegexGroup[][] {
  return splitTopLevelAlternation(regex.trim()).map((alt) => parseRegexToGroups(alt));
}

/** Choose the alternative whose enums best match the issue type (bug→fix etc.). */
export function pickAlternative(alts: RegexGroup[][], issue: NameIssue): number {
  const typeSlug = slugify(issue.type ?? "");
  const wants = new Set([typeSlug, ...(TYPE_SYNONYMS[typeSlug] ?? [])].filter(Boolean));
  let best = 0;
  let bestScore = -1;
  alts.forEach((alt, i) => {
    const enums = alt.filter((g) => g.kind === "enum");
    let score = enums.length; // more-structured shapes preferred as a tiebreak
    for (const g of enums) if (g.kind === "enum" && g.options.some((o) => wants.has(slugify(o)))) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Compose a name from one alternative's groups, filling from the issue. Enum
 * groups can be overridden (the editor's pickers) by group index; digit-only
 * free groups take the issue number; the issue component fills a free group only
 * when no enum already consumed it; remaining free text uses the title slug.
 */
export function composeFromGroups(
  groups: RegexGroup[],
  issue: NameIssue,
  enumChoices?: Record<number, string>,
): string {
  const num = issueNumber(issue);
  const compSlug = slugify(issue.component ?? "");
  const titleSlug = slugify(issue.title);
  const chosen = (g: Extract<RegexGroup, { kind: "enum" }>, gi: number) => enumChoices?.[gi] ?? pickEnum(g.options, issue);

  // Did an enum already consume the component? Then don't reuse it for a free slot.
  let compUsedByEnum = false;
  groups.forEach((g, gi) => {
    if (g.kind === "enum" && compSlug && slugify(chosen(g, gi)) === compSlug) compUsedByEnum = true;
  });

  let usedCompFree = false;
  let out = "";
  groups.forEach((g, gi) => {
    if (g.kind === "literal") out += g.text;
    else if (g.kind === "enum") out += chosen(g, gi);
    else if (isDigitHint(g.hint ?? "")) out += num || "1";
    else if (compSlug && !compUsedByEnum && !usedCompFree) {
      out += compSlug;
      usedCompFree = true;
    } else out += titleSlug;
  });
  return out;
}

const AI_SYSTEM =
  "You name git branches. Given an issue and a naming instruction, return ONLY a minified JSON " +
  'object {"name":"<branch>","reasoning":"<one short sentence>"} — no markdown, no prose. The name ' +
  "must be a valid git branch: lowercase, no spaces, no leading/trailing slash.";

function aiPrompt(instruction: string, issue: NameIssue, regex: string | null, lastFail: string | null): string {
  const lines = [
    `Instruction: ${instruction}`,
    `Issue key: ${issue.key ?? "(none)"}`,
    `Issue type: ${issue.type ?? "(none)"}`,
    `Issue title: ${issue.title}`,
    `Component: ${issue.component ?? "(none)"}`,
  ];
  if (regex) lines.push(`The name MUST match this regex: ${regex}`);
  if (lastFail) lines.push(`Your previous name "${lastFail}" did NOT pass the validator. Produce a different name that does.`);
  return lines.join("\n");
}

const AI_RETRY_LIMIT = 3;

/**
 * Resolve a branch name for an issue under the configured source. Returns the
 * generated name, a preview, an authoritative ✓/✕ from the repo validator, and
 * (for AI) Claude's reasoning. `repoDir` is the repo root (where package.json /
 * the validator live).
 */
export async function resolveBranchName(
  cfg: BranchNamingConfig,
  issue: NameIssue,
  repoDir: string,
  model = "claude-sonnet-4-6",
): Promise<ResolvedName> {
  if (cfg.source === "manual") {
    const name = applyTemplate(cfg.template, issue);
    return finalize(name, repoDir);
  }

  if (cfg.source === "package-json") {
    const tpl = await readPackageField(repoDir, cfg.field);
    if (!tpl) {
      return { name: "", preview: "", valid: false, explanation: `No “${cfg.field}” in package.json.` };
    }
    return finalize(applyTemplate(tpl, issue), repoDir);
  }

  if (cfg.source === "validator") {
    // The regex is a top-level alternation of branch shapes; pick the shape that
    // matches the issue, then compose from just that one.
    const alts = parseRegexToAlternatives(cfg.regex);
    const alt = alts[pickAlternative(alts, issue)] ?? parseRegexToGroups(cfg.regex);
    const name = composeFromGroups(alt, issue);
    return finalize(name, repoDir);
  }

  // ai — chain through the validator with retry.
  const validator = cfg.chainValidator ? await detectBranchValidator(repoDir) : null;
  let lastFail: string | null = null;
  let lastReasoning = "";
  try {
    for (let attempt = 0; attempt < AI_RETRY_LIMIT; attempt++) {
      const raw = await claudeText(AI_SYSTEM, aiPrompt(cfg.instruction, issue, validator?.regex ?? null, lastFail), model);
      const parsed = parseAi(raw);
      lastReasoning = parsed.reasoning;
      const check = await validateBranchNameBackend(repoDir, parsed.name);
      if (!cfg.chainValidator || check.ok) {
        return { name: parsed.name, preview: parsed.name, valid: check.ok, explanation: parsed.reasoning };
      }
      lastFail = parsed.name;
    }
    // exhausted retries — return the last attempt, flagged invalid
    return {
      name: lastFail ?? "",
      preview: lastFail ?? "",
      valid: false,
      explanation: `Couldn't satisfy the validator after ${AI_RETRY_LIMIT} tries. ${lastReasoning}`.trim(),
    };
  } catch (e) {
    if (e instanceof NoKeyError) {
      return { name: "", preview: "", valid: false, explanation: "Add an Anthropic API key to use AI branch naming." };
    }
    return { name: "", preview: "", valid: false, explanation: String(e) };
  }
}

function parseAi(raw: string): { name: string; reasoning: string } {
  const cleaned = raw
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  try {
    const v = JSON.parse(cleaned);
    return { name: String(v.name ?? "").trim(), reasoning: String(v.reasoning ?? "").trim() };
  } catch {
    // model returned a bare branch name
    return { name: cleaned.split(/\s/)[0] ?? "", reasoning: "" };
  }
}

const TITLE_SYSTEM =
  "You name workspaces. Given a plain-language description of some work, reply with ONLY a short, " +
  "concise workspace title (a few words, sentence case, no trailing punctuation, no quotes, no markdown) — nothing else.";

/**
 * Turn a plain-language description into a short workspace title via Claude.
 * Throws {@link NoKeyError} when no API key is set. Pure passthrough over
 * {@link claudeText} — trims the response and strips wrapping quotes the model
 * sometimes adds.
 */
export async function suggestWorkspaceTitle(description: string, model: string): Promise<string> {
  const raw = await claudeText(TITLE_SYSTEM, description, model);
  return raw.trim().replace(/^["']|["']$/g, "");
}

/** Run the authoritative validator and package the result. */
async function finalize(name: string, repoDir: string): Promise<ResolvedName> {
  const check = await validateBranchNameBackend(repoDir, name);
  return { name, preview: name, valid: check.ok, explanation: check.ok ? undefined : check.message ?? undefined };
}
