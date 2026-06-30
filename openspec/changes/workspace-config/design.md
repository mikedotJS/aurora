# Design — workspace-config

## D1 · Per-repo config store

A repo's configuration is keyed by repo root and persisted under the app-config dir (or
`localStorage["aurora.repoconfig"]` keyed by root, matching `aurora.scripts`):
```ts
interface RepoConfig {
  root: string;
  presets: Preset[];                 // replaces the built-in fix/feature/spike
  defaults: {
    branchNaming: BranchNamingConfig;
    baseBranch: string;              // e.g. "main" | "develop"
    autoPortOffset: boolean;
    isolation: "worktree" | "worktree+env" | "container";
    showRailOnLaunch: boolean;
    jiraSyncDefault: boolean;
  };
  lifecycle: {
    pruneWorktreeOnMerge: boolean;
    closeAction: "archive" | "delete";
    confirmDelete: boolean;
  };
  aiAccounts: AiAccount[];           // claude-work / claude-personal / aider harnesses
}
interface Preset {
  name: string; issueTypes: string[];      // auto-select for these Jira issue types
  agent: AgentKind; autoStart: boolean;
  paneLayout: "1" | "2-split" | "2x2";
  runOnOpen: string | null;                // script name
  env: Record<string,string>;
  baseOverride: string | null;             // null = inherit defaults.baseBranch
  portOffset: "auto" | number;
  jiraSync: boolean;
}
interface AiAccount { id: string; kind: "claude" | "aider"; scope: "work"|"personal"|null; default: boolean; model?: string; keyHint?: string }
```
`workspace-create` reads `RepoConfig.presets` (falling back to the built-ins when none configured) and
`RepoConfig.defaults.branchNaming` when prefilling the scope form. AI-account secrets stay in the
keychain (reuse the BYOK path); config stores only non-secret hints (`keyHint`, `kind`, `default`).

## D2 · Settings panel (`WorkspaceSettings.tsx`)

Sectioned scroll panel (Frame 5), reachable from the gear / `workspaces` command. Sections: Integrations
(Jira project + GitLab URL with connect/manage — connection logic is `jira-integration`), AI accounts
(list + add/remove + set-default), Presets (list → opens `PresetEditor`), New-workspace defaults
(branch-naming source selector that deep-links into the branch-naming editor, base dropdown, port
toggle, isolation segmented, rail toggle), Lifecycle (three controls). All writes go through
`lib/presets.ts` / `lib/repoConfig.ts` and persist immediately.

## D3 · Preset editor (`PresetEditor.tsx`)

Form per Frame 6: name; auto-select issue types (multi-select of the repo's Jira issue types when Jira
connected, else free tags); AI scope; start-agent-on-ticket toggle; pane layout segmented; run-on-open
script dropdown (repo scripts); env-var rows (NAME=value, add/remove); base override (inherit/main/…);
port offset (auto/number); two-way Jira sync. Delete (confirm) / Cancel / Save. Saving updates
`RepoConfig.presets`.

## D4 · Branch-naming engine (`lib/branchNaming.ts`)

```ts
type BranchNamingConfig =
  | { source: "manual"; template: string }                     // tokens in {…}
  | { source: "package-json"; field: string }                  // e.g. "aurora.branchPattern"
  | { source: "validator"; regex: string; groups: Group[] }    // inferred
  | { source: "ai"; instruction: string; chainValidator: boolean };
```
`resolveBranchName(cfg, issue, repoDir): Promise<{ name, preview?, valid, explanation? }>`:
- **manual**: `applyTemplate(template, issue)` — substitute tokens, slugify free text, drop unknown
  tokens, lowercase, spaces→`-`, slug cap 40. Pure + synchronous; drives the live preview.
- **package-json**: read `field` from `<repoDir>/package.json` via backend; treat its value as a manual
  template; re-read on change. Shown read-only ("bound · shared with your team").
- **validator**: backend detects a `validate-branch-name` regex (package.json config / husky hook /
  commitlint). `parseRegexToGroups(regex)` → ordered groups; enum groups (`(feat|fix|chore)`) become
  pickers, free groups become slug fields. Generate by filling groups (from issue type/component +
  slug) and **assert the result matches the regex** before offering it.
- **ai**: send `instruction` + issue context to `claude_suggest`; if `chainValidator`, validate the
  returned name against the detected regex and **retry** (re-prompt with the failure) until it passes
  or a retry cap is hit; show Claude's reasoning + the ✓/✕ validator result.

A single `validate_branch_name(dir, name)` backend command runs the repo's real validator when present
(so the preview's ✓/✕ is authoritative), falling back to the parsed-regex test, then to the local
sanity check from `workspace-create`.

## D5 · Validator detection (`src-tauri/src/repoconfig.rs`)

- `read_package_field(dir, field)` — parse `package.json`, dot-path lookup.
- `detect_branch_validator(dir) -> Option<{ regex, source }>` — look for `validate-branch-name` config
  in `package.json` (`config.validate-branch-name.pattern` or `validate-branch-name` key), husky
  `pre-push`/`commit-msg` invoking it, or a committed `.validate-branch-namerc`. Return the regex.
- `validate_branch_name(dir, name)` — if a validator binary is configured, run it on `name`; else test
  the detected regex; return `{ ok, message? }`.

## D6 · Migration from the foundation
- `workspace-create`'s `lib/branchName.ts` (`buildBranchName`/`validateBranchName`) becomes a thin
  fallback used only when no `RepoConfig.defaults.branchNaming` exists; the scope form switches to
  `resolveBranchName`.
- The built-in `fix`/`feature`/`spike` presets become the **seed** `RepoConfig.presets` on first open
  of a repo's settings, after which they're editable.

## D7 · Out of scope
- The Jira **connection** flow and issue-type fetching → `jira-integration` (this surfaces the toggle
  and reads issue types when available). "Container" isolation is selectable but only worktree(+env) is
  implemented by the foundation; choosing container shows "coming soon".
