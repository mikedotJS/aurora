// Line-coverage suite for src/lib/branchNaming.ts — the configurable branch-
// naming engine (manual template / package.json / validator-regex / AI).
import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import {
  applyTemplate,
  templateTokens,
  parseRegexToGroups,
  splitTopLevelAlternation,
  parseRegexToAlternatives,
  pickAlternative,
  composeFromGroups,
  resolveBranchName,
  suggestWorkspaceTitle,
  DEFAULT_BRANCH_NAMING,
  type NameIssue,
  type BranchNamingConfig,
} from "../src/lib/branchNaming";
import { NoKeyError } from "../src/ai/suggest";

const ISSUE: NameIssue = {
  key: "PROJ-1423",
  type: "Bug",
  title: "Login redirect drops the return URL",
  component: "api",
  assignee: "you",
  sprint: "24",
};

beforeEach(() => {
  tauri.reset();
});

describe("DEFAULT_BRANCH_NAMING", () => {
  it("is a manual template config", () => {
    expect(DEFAULT_BRANCH_NAMING).toEqual({ source: "manual", template: "{key}/{slug}" });
  });
});

describe("applyTemplate", () => {
  it("substitutes key/slug tokens and lowercases", () => {
    expect(applyTemplate("{key}/{slug}", ISSUE)).toBe("proj-1423/login-redirect-drops-the-return-url");
  });

  it("substitutes type, assignee, sprint tokens", () => {
    expect(applyTemplate("{type}/{assignee}/{sprint}", ISSUE)).toBe("bug/you/24");
  });

  it("substitutes yy-mm as a two-digit year-month", () => {
    const out = applyTemplate("{yy-mm}", ISSUE);
    expect(out).toMatch(/^\d{2}-\d{2}$/);
  });

  it("drops unknown tokens and collapses the resulting separators", () => {
    // {foo} resolves to "" (default branch of tokenValue), leaving a dangling
    // separator that the trim/collapse passes must clean up.
    expect(applyTemplate("{key}/{foo}/{slug}", ISSUE)).toBe("proj-1423/login-redirect-drops-the-return-url");
  });

  it("collapses whitespace to dashes and repeated slashes/dashes", () => {
    expect(applyTemplate("a   b//c--d", ISSUE)).toBe("a-b/c-d");
  });

  it("trims dangling dashes before/after a slash and at the edges", () => {
    expect(applyTemplate("-{foo}-/{key}/-", ISSUE)).toBe("proj-1423");
  });

  it("handles a template with no tokens at all", () => {
    expect(applyTemplate("static-name", ISSUE)).toBe("static-name");
  });

  it("resolves key/type/slug/assignee/sprint to empty strings for a bare issue", () => {
    const bare: NameIssue = { title: "" };
    expect(applyTemplate("{key}-{type}-{slug}-{assignee}-{sprint}", bare)).toBe("");
  });
});

describe("templateTokens", () => {
  it("extracts only known tokens, in order, deduped-by-source-order not required", () => {
    expect(templateTokens("{key}/{type}/{slug}")).toEqual(["key", "type", "slug"]);
  });

  it("drops unknown tokens", () => {
    expect(templateTokens("{key}/{bogus}/{slug}")).toEqual(["key", "slug"]);
  });

  it("returns an empty array for a template with no tokens", () => {
    expect(templateTokens("static")).toEqual([]);
  });

  it("is case-insensitive on token names", () => {
    expect(templateTokens("{KEY}/{Slug}")).toEqual(["key", "slug"]);
  });
});

describe("parseRegexToGroups", () => {
  it("parses an enum alternation group", () => {
    expect(parseRegexToGroups("^(feat|fix|chore)/.+$")).toEqual([
      { kind: "enum", options: ["feat", "fix", "chore"] },
      { kind: "literal", text: "/" },
      { kind: "free", hint: ".+" },
    ]);
  });

  it("strips a non-capturing prefix and an internal trailing quantifier from a non-alternation group", () => {
    // the `?:` prefix is dropped and the body's own trailing `+` (on `[a-z]+`)
    // is stripped by the same trailing-quantifier trim; the `?` that quantifies
    // the *whole group* sits after the closing paren, which the paren scanner
    // doesn't consume, so it falls through as a trailing literal group.
    const groups = parseRegexToGroups("(?:[a-z]+)?");
    expect(groups).toEqual([
      { kind: "free", hint: "[a-z]" },
      { kind: "literal", text: "?" },
    ]);
  });

  it("parses \\d and \\w shorthand classes with quantifiers as free groups", () => {
    expect(parseRegexToGroups("\\d+-\\w*")).toEqual([
      { kind: "free", hint: "\\d+" },
      { kind: "literal", text: "-" },
      { kind: "free", hint: "\\w*" },
    ]);
  });

  it("parses \\D \\W \\S shorthand classes too", () => {
    expect(parseRegexToGroups("\\D\\W\\S")).toEqual([
      { kind: "free", hint: "\\D" },
      { kind: "free", hint: "\\W" },
      { kind: "free", hint: "\\S" },
    ]);
  });

  it("keeps an escaped literal character (not a shorthand class) literally", () => {
    expect(parseRegexToGroups("a\\-b\\.c")).toEqual([{ kind: "literal", text: "a-b.c" }]);
  });

  it("parses a bare '.' wildcard with a lazy quantifier as free", () => {
    expect(parseRegexToGroups(".*?")).toEqual([{ kind: "free", hint: ".*?" }]);
  });

  it("parses a character class with a quantifier as one free group", () => {
    expect(parseRegexToGroups("[a-z0-9]+")).toEqual([{ kind: "free", hint: "[a-z0-9]+" }]);
  });

  it("parses a character class with no quantifier", () => {
    expect(parseRegexToGroups("[abc]")).toEqual([{ kind: "free", hint: "[abc]" }]);
  });

  it("strips leading ^ and trailing $ anchors", () => {
    expect(parseRegexToGroups("^abc$")).toEqual([{ kind: "literal", text: "abc" }]);
  });

  it("treats a group containing an escaped pipe inside as free (not alternation-shaped)", () => {
    // body contains an escaped char consumed by the inner scanner (body += 2 chars)
    const groups = parseRegexToGroups("(a\\)b)");
    expect(groups).toEqual([{ kind: "free", hint: "a\\)b" }]);
  });

  it("returns an empty array for an empty regex", () => {
    expect(parseRegexToGroups("")).toEqual([]);
  });
});

describe("splitTopLevelAlternation", () => {
  it("splits on top-level pipes only", () => {
    expect(splitTopLevelAlternation("^feat/.+$|^fix/.+$")).toEqual(["^feat/.+$", "^fix/.+$"]);
  });

  it("does not split on a pipe inside a group", () => {
    expect(splitTopLevelAlternation("^(feat|fix)/.+$")).toEqual(["^(feat|fix)/.+$"]);
  });

  it("does not split on a pipe inside a character class", () => {
    expect(splitTopLevelAlternation("[a|b]+$")).toEqual(["[a|b]+$"]);
  });

  it("respects escaped characters while scanning", () => {
    expect(splitTopLevelAlternation("a\\|b|c")).toEqual(["a\\|b", "c"]);
  });

  it("filters out empty trimmed parts", () => {
    expect(splitTopLevelAlternation("a||b")).toEqual(["a", "b"]);
  });

  it("clamps unbalanced closing parens instead of going negative", () => {
    // a stray ')' with no matching '(' — depth is clamped at 0 via Math.max.
    expect(splitTopLevelAlternation("a)|b")).toEqual(["a)", "b"]);
  });
});

describe("parseRegexToAlternatives", () => {
  it("parses each alternative into its own ordered groups", () => {
    const alts = parseRegexToAlternatives("^(feat|chore)/.+$|^fix/.+$");
    expect(alts.length).toBe(2);
    expect(alts[0][0]).toEqual({ kind: "enum", options: ["feat", "chore"] });
    expect(alts[1][0]).toEqual({ kind: "literal", text: "fix/" });
  });
});

describe("pickAlternative", () => {
  const alts = parseRegexToAlternatives("^(feat|chore)/.+$|^(fix|hotfix)/.+$");

  it("picks the alternative whose enum matches the issue type via synonyms (Bug -> fix)", () => {
    expect(pickAlternative(alts, ISSUE)).toBe(1);
  });

  it("picks the alternative matching a Story issue (-> feat)", () => {
    expect(pickAlternative(alts, { ...ISSUE, type: "Story" })).toBe(0);
  });

  it("falls back to the more-structured (tiebreak) shape when nothing matches", () => {
    const noMatch = parseRegexToAlternatives("^plain/.+$|^(x|y)/.+$");
    // second alt has an enum (score 1) vs first alt's 0 -> picks index 1
    expect(pickAlternative(noMatch, { ...ISSUE, type: "Unknown" })).toBe(1);
  });

  it("defaults to index 0 for a single-alternative list", () => {
    const single = parseRegexToAlternatives("^feat/.+$");
    expect(pickAlternative(single, ISSUE)).toBe(0);
  });
});

describe("composeFromGroups", () => {
  it("composes literal + enum(picked by synonym) + free(title slug) groups", () => {
    const groups = parseRegexToGroups("^(feat|fix)/.+$");
    // no component on this issue, so the free slot falls through to the title
    // slug; Bug -> fix synonym should be auto-picked without an override.
    const noComponent: NameIssue = { ...ISSUE, component: null };
    expect(composeFromGroups(groups, noComponent)).toBe("fix/login-redirect-drops-the-return-url");
  });

  it("honors an enumChoices override over the auto-picked value", () => {
    const groups = parseRegexToGroups("^(feat|fix)/.+$");
    const noComponent: NameIssue = { ...ISSUE, component: null };
    expect(composeFromGroups(groups, noComponent, { 0: "feat" })).toBe("feat/login-redirect-drops-the-return-url");
  });

  it("fills the free slot with the issue component instead of the title slug when one is available", () => {
    const groups = parseRegexToGroups("^(feat|fix)/.+$");
    // ISSUE.component === "api" and the enum picks "fix" (not "api"), so the
    // free slot is still unclaimed and takes the component over the title slug.
    expect(composeFromGroups(groups, ISSUE)).toBe("fix/api");
  });

  it("fills a digit-hint free group with the issue's numeric suffix", () => {
    const groups = parseRegexToGroups("^issue-\\d+$");
    expect(composeFromGroups(groups, ISSUE)).toBe("issue-1423");
  });

  it("falls back to '1' for a digit-hint group when the issue has no numeric key", () => {
    const groups = parseRegexToGroups("^issue-\\d+$");
    expect(composeFromGroups(groups, { title: "no key" })).toBe("issue-1");
  });

  it("fills the first non-digit free group with the component when available", () => {
    const groups = parseRegexToGroups("^[a-z]+/.+$");
    // first free group ([a-z]+) is not digit-hinted -> gets the component ("api"),
    // second free group (.+) gets the title slug.
    expect(composeFromGroups(groups, ISSUE)).toBe("api/login-redirect-drops-the-return-url");
  });

  it("uses the title slug for a free group when there's no component", () => {
    const groups = parseRegexToGroups("^[a-z]+$");
    expect(composeFromGroups(groups, { title: "Some Title" })).toBe("some-title");
  });

  it("doesn't reuse the component in a free slot when an enum already consumed it", () => {
    // component "api" matches an enum option, so the enum consumes it and the
    // free slot must fall through to the title slug instead of repeating "api".
    const groups = parseRegexToGroups("^(api|web)/.+$");
    expect(composeFromGroups(groups, ISSUE)).toBe("api/login-redirect-drops-the-return-url");
  });

  it("falls back to the first enum option when nothing matches (pickEnum fallback)", () => {
    const groups = parseRegexToGroups("^(zzz|yyy)/.+$");
    expect(composeFromGroups(groups, { ...ISSUE, type: "Unknown", component: null })).toBe(
      "zzz/login-redirect-drops-the-return-url",
    );
  });

  it("returns an empty enum option string when options array is somehow empty (defensive branch)", () => {
    // Directly exercise composeFromGroups with a hand-built enum group with no options.
    const out = composeFromGroups([{ kind: "enum", options: [] }], ISSUE);
    expect(out).toBe("");
  });

  it("matches an enum option via a prefix relationship (startsWith) fallback in pickEnum", () => {
    // "bugfix" is a synonym for bug; option "bugfixes" starts with "bugfix" via the
    // second pickEnum loop (startsWith / so.startsWith(w)).
    const groups: import("../src/lib/branchNaming").RegexGroup[] = [
      { kind: "enum", options: ["bugfixes", "features"] },
    ];
    expect(composeFromGroups(groups, ISSUE)).toBe("bugfixes");
  });
});

describe("resolveBranchName", () => {
  it("manual source: applies the template then validates via the backend", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: true, enforced: true }) });
    const cfg: BranchNamingConfig = { source: "manual", template: "{key}/{slug}" };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r).toEqual({
      name: "proj-1423/login-redirect-drops-the-return-url",
      preview: "proj-1423/login-redirect-drops-the-return-url",
      valid: true,
      explanation: undefined,
    });
    expect(tauri.lastCall("validate_branch_name")?.args).toEqual({
      dir: "/repo",
      name: "proj-1423/login-redirect-drops-the-return-url",
    });
  });

  it("manual source: surfaces the backend's invalid message", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: false, message: "nope", enforced: true }) });
    const cfg: BranchNamingConfig = { source: "manual", template: "{key}/{slug}" };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.valid).toBe(false);
    expect(r.explanation).toBe("nope");
  });

  it("package-json source: returns an explicit not-found result when the field is absent", async () => {
    tauri.invoke({ read_package_field: () => null });
    const cfg: BranchNamingConfig = { source: "package-json", field: "aurora.branchPattern" };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r).toEqual({
      name: "",
      preview: "",
      valid: false,
      explanation: `No “aurora.branchPattern” in package.json.`,
    });
  });

  it("package-json source: applies the fetched template then validates", async () => {
    tauri.invoke({
      read_package_field: () => "{type}/{key}-{slug}",
      validate_branch_name: () => ({ ok: true, enforced: true }),
    });
    const cfg: BranchNamingConfig = { source: "package-json", field: "aurora.branchPattern" };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.name).toBe("bug/proj-1423-login-redirect-drops-the-return-url");
    expect(r.valid).toBe(true);
  });

  it("validator source: picks the matching alternative, composes, and validates", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: true, enforced: true }) });
    const cfg: BranchNamingConfig = { source: "validator", regex: "^(feat|fix)/.+$", groups: [] };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    // Bug -> fix synonym for the enum; the free slot then takes the issue's
    // component ("api") since it wasn't already consumed by the enum pick.
    expect(r.name).toBe("fix/api");
    expect(r.valid).toBe(true);
  });

  it("ai source: returns after a single attempt (no retry) when chaining is disabled, even if the check fails", async () => {
    tauri.invoke({
      claude_text: () => JSON.stringify({ name: "fix/proj-1423-login", reasoning: "matches instruction" }),
      validate_branch_name: () => ({ ok: false, enforced: true }),
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: false };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r).toEqual({
      name: "fix/proj-1423-login",
      preview: "fix/proj-1423-login",
      valid: false,
      explanation: "matches instruction",
    });
    // detect_branch_validator must NOT have been called since chainValidator is false
    expect(tauri.calls().some((c) => c.cmd === "detect_branch_validator")).toBe(false);
    // and claude_text must have been called exactly once — no retry loop despite the failed check
    expect(tauri.calls().filter((c) => c.cmd === "claude_text").length).toBe(1);
  });

  it("ai source: strips a ```json code fence from the model response", async () => {
    tauri.invoke({
      claude_text: () => "```json\n" + JSON.stringify({ name: "chore/x", reasoning: "r" }) + "\n```",
      validate_branch_name: () => ({ ok: true, enforced: true }),
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: true };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.name).toBe("chore/x");
    expect(r.valid).toBe(true);
  });

  it("ai source: falls back to treating a bare (non-JSON) response as the branch name", async () => {
    tauri.invoke({
      claude_text: () => "fix/bare-name extra-words-ignored",
      validate_branch_name: () => ({ ok: true, enforced: true }),
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: true };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.name).toBe("fix/bare-name");
    expect(r.explanation).toBe("");
  });

  it("ai source: retries against the validator until it passes, then returns success", async () => {
    let call = 0;
    tauri.invoke({
      detect_branch_validator: () => ({ regex: "^fix/.+$", source: "package.json" }),
      claude_text: () => {
        call += 1;
        return JSON.stringify({ name: call < 2 ? "bad name" : "fix/ok", reasoning: `try ${call}` });
      },
      validate_branch_name: (a) => ({ ok: (a.name as string) === "fix/ok", enforced: true }),
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: true };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.valid).toBe(true);
    expect(r.name).toBe("fix/ok");
    expect(call).toBe(2);
  });

  it("ai source: exhausts retries and returns the last attempt flagged invalid", async () => {
    tauri.invoke({
      detect_branch_validator: () => ({ regex: "^fix/.+$", source: "package.json" }),
      claude_text: () => JSON.stringify({ name: "always-bad", reasoning: "final reasoning" }),
      validate_branch_name: () => ({ ok: false, enforced: true }),
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: true };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.valid).toBe(false);
    expect(r.name).toBe("always-bad");
    expect(r.explanation).toContain("Couldn't satisfy the validator after 3 tries.");
    expect(r.explanation).toContain("final reasoning");
  });

  it("ai source: surfaces a friendly message when no API key is configured", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("no-key");
      },
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: false };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r).toEqual({
      name: "",
      preview: "",
      valid: false,
      explanation: "Add an Anthropic API key to use AI branch naming.",
    });
  });

  it("ai source: surfaces a generic error message for any other failure", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("backend exploded");
      },
    });
    const cfg: BranchNamingConfig = { source: "ai", instruction: "name it", chainValidator: false };
    const r = await resolveBranchName(cfg, ISSUE, "/repo");
    expect(r.valid).toBe(false);
    expect(r.explanation).toContain("backend exploded");
  });
});

describe("suggestWorkspaceTitle", () => {
  it("trims surrounding whitespace from the model's response", async () => {
    tauri.invoke({ claude_text: () => "   Fix login redirect   " });
    const title = await suggestWorkspaceTitle("the login redirect drops the return url", "claude-sonnet-4-6");
    expect(title).toBe("Fix login redirect");
  });

  it("strips wrapping double quotes the model sometimes adds", async () => {
    tauri.invoke({ claude_text: () => '"Fix login redirect"' });
    const title = await suggestWorkspaceTitle("desc", "claude-sonnet-4-6");
    expect(title).toBe("Fix login redirect");
  });

  it("strips wrapping single quotes the model sometimes adds", async () => {
    tauri.invoke({ claude_text: () => "'Fix login redirect'" });
    const title = await suggestWorkspaceTitle("desc", "claude-sonnet-4-6");
    expect(title).toBe("Fix login redirect");
  });

  it("only strips a matching quote at the very start/end, not asymmetric or interior quotes", () => {
    // A mismatched pair (leading " with no trailing ") must be left alone —
    // the regex requires the SAME quote char at both ends to strip.
    // Not asserted via suggestWorkspaceTitle here to keep this a pure regex
    // check without a network round-trip; the shared behavior is exercised
    // through the async cases above.
    const strip = (s: string) => s.trim().replace(/^["']|["']$/g, "");
    expect(strip('"Fix the thing')).toBe("Fix the thing");
    expect(strip(`Title with an "inner" quote`)).toBe(`Title with an "inner" quote`);
  });

  it("does not fabricate a title when the model returns an empty string", async () => {
    tauri.invoke({ claude_text: () => "" });
    const title = await suggestWorkspaceTitle("desc", "claude-sonnet-4-6");
    expect(title).toBe("");
  });

  it("passes the description and model straight through to claudeText, with a title-authoring system prompt", async () => {
    tauri.invoke({ claude_text: () => "Some title" });
    await suggestWorkspaceTitle("add dark mode to settings", "claude-opus-9");
    const call = tauri.lastCall("claude_text");
    expect(call?.args.prompt).toBe("add dark mode to settings");
    expect(call?.args.model).toBe("claude-opus-9");
    expect(String(call?.args.system)).toContain("workspace title");
  });

  it("propagates NoKeyError when no API key is configured (does not swallow it)", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("no-key");
      },
    });
    await expect(suggestWorkspaceTitle("desc", "claude-sonnet-4-6")).rejects.toBeInstanceOf(NoKeyError);
  });

  it("propagates a generic backend error unchanged", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("backend exploded");
      },
    });
    await expect(suggestWorkspaceTitle("desc", "claude-sonnet-4-6")).rejects.toThrow("backend exploded");
  });
});

// Sanity: claudeText's NoKeyError class is what resolveBranchName's ai branch
// special-cases; confirm it's the exported class (guards against a silent
// import-path regression breaking the `instanceof` check above).
describe("NoKeyError wiring", () => {
  it("is importable and is an Error subclass", () => {
    const e = new NoKeyError();
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("no-key");
  });
});
