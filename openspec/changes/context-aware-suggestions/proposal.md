## Why

The explicit "✦ CLAUDE · SUGGESTS" card turns a natural-language ask into a shell command via
`claude_suggest` (Rust). Today its system prompt is given **only** the current working directory
(`src-tauri/src/claude.rs` — the `claude_suggest` command builds the system string with just `{cwd}`).
The model knows nothing about how the repo is built or what commands actually exist, so it guesses:
in a pnpm + nx monorepo the card suggested `npm run api & npm run welcomer` — wrong package manager,
ignoring the monorepo runner, **and inventing script names** (`api`, `welcomer`) that may not exist.

Rather than a narrow package-manager patch, we want the suggestion to be genuinely context-aware. The
webview already has deterministic bridges for everything we need — `gitRepoInfo`, `listDir`,
`readTextFile` (`src/lib/sys.ts`), the lockfile→package-manager map in `src/lib/aiScripts.ts`, and the
`git_changed_files` Rust command (`src-tauri/src/git.rs`). We introduce one **reusable project-context
engine** that assembles a bounded set of signals and injects them into the suggestion prompt, so the
model uses the repo's *real* toolchain, *real* script/target names, and current git state.

## What Changes

- **New reusable context engine (`src/lib/projectContext.ts`)**: `gatherProjectContext(cwd)` resolves
  the repo root (`gitRepoInfo` → `main_root`, falling back to `cwd`) and assembles a typed
  `ProjectContext` from the filesystem + git bridges, and `formatProjectContext(ctx)` renders it into a
  compact, token-budgeted "Project context" block (or `""` when there is nothing useful). Signals:
  - **Toolchain** — package manager from the `packageManager` field of the root `package.json` (corepack,
    authoritative) else lockfile presence (`pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `bun.lockb`→bun,
    `package-lock.json`→npm); monorepo runner from `nx.json`/`turbo.json`/`lerna.json` presence;
    workspaces from a `workspaces` field or `pnpm-workspace.yaml`.
  - **Real scripts** — the *names* of the root `package.json` `scripts` (so the model uses real scripts,
    not invented ones), capped.
  - **Real projects/targets** — for a workspace repo, enumerate workspace packages (from the workspaces
    globs, e.g. `apps/*`, `packages/*`) and read each `project.json` (project `name` + declared `targets`
    keys) or fall back to the package's `package.json` `name`; capped in count and per-project.
  - **Git state** — current branch (from `gitRepoInfo`) and the changed-file list (via a new `sys.ts`
    wrapper over the existing `git_changed_files` command): capped file paths with their status, plus a
    total count.
- **Injection into the suggestion prompt**: `claudeSuggest` (`src/ai/suggest.ts`) and the Rust
  `claude_suggest` gain an optional `context` string. When present, Rust appends a structured
  "Project context (detected — use these REAL names; do not invent scripts or targets)" section to the
  system prompt, instructing the model to use the detected package manager (never a different one),
  prefer the detected runner for project targets (e.g. `nx run-many` rather than chaining
  `npm run a & npm run b`), and only reference scripts/targets that appear in the context. When absent,
  the prompt is unchanged from today.
- **`askClaude` wiring** (`src/lib/keymap.ts`): gather + format the context for the pane's `cwd` before
  calling `claudeSuggest`; detection failure is non-fatal (falls back to today's context-free call).
- **Token discipline**: every signal is individually capped and the assembled block has an overall
  character budget with truncation markers, so a large monorepo cannot blow up the prompt.
- **Untrusted-data framing preserved**: injected content is the deterministic detection result plus
  git-derived names — never arbitrary file bodies (no README/Makefile/CI parsing, no terminal
  scrollback). Script/target names come from JSON keys we parse, not free text.

## Capabilities

### New Capabilities
- `context-aware-suggestions`: the explicit Claude command-suggestion path builds a reusable, bounded
  project-context bundle (toolchain, real script + project/target names, git branch + changed files) via
  deterministic filesystem/git detection and injects it into the suggestion prompt, so suggested
  commands match the repo's real package manager, runner, and available commands — degrading cleanly
  (each signal optional; non-JS and non-git repos supported) and staying within a token budget.

### Modified Capabilities
<!-- Builds on the existing "Explicit natural-language to Claude command suggestion" requirement from the
     `smart-prompt` capability (defined in the `add-aurora-terminal` change). That capability is not a
     baseline spec under openspec/specs/, so the expanded behavior is captured as the new capability
     above rather than as a MODIFIED delta — mirroring how `ai-generate-repo-scripts` handled
     `scripts-hooks`. -->

## Impact

- **Frontend (`src/`)**:
  - new `lib/projectContext.ts` — the context engine (`ProjectContext` type, `gatherProjectContext`,
    `formatProjectContext`), reusing `lib/sys.ts` and the lockfile map/pattern from `lib/aiScripts.ts`;
  - `lib/sys.ts` — add a `gitChangedFiles(dir)` wrapper over the existing `git_changed_files` command
    (no Rust change; the command already exists);
  - `ai/suggest.ts` — `claudeSuggest` gains an optional `context` argument forwarded to `claude_suggest`;
  - `lib/keymap.ts` — `askClaude` gathers/formats the context and passes it (graceful fallback on error).
  - No suggestion-card UI change.
- **Backend (`src-tauri/`)**: `claude.rs` — `claude_suggest` gains an optional `context: Option<String>`
  parameter and appends the "Project context" section to its system prompt when non-empty. No new secret
  surface, no new network behavior, no new filesystem/git commands (existing ones are reused).
- **Reuses**: `lib/sys.ts` (`gitRepoInfo`, `listDir`, `readTextFile`), the lockfile→PM detection already
  in `lib/aiScripts.ts`, the `git_changed_files`/`git_repo_info` Rust commands, and the BYOK
  `claude_suggest` path.
- **Considered and rejected**: (a) detecting inside Rust `claude_suggest` — rejected to avoid a second
  detection implementation diverging from the TS one in `aiScripts.ts`, and because detection is a cheap
  filesystem/git step whose IPC cost is negligible next to the Anthropic network call; (b) running `nx`
  to enumerate projects/targets authoritatively — rejected as slow and side-effectful; we read
  `project.json` files deterministically instead (accepting that plugin-*inferred* targets not written to
  `project.json` may be missed).
- **Out of scope**: terminal scrollback / command output (privacy + tokens); parsing README/Makefile/CI
  files as prompt input; per-package "which project am I in" target resolution beyond enumerating
  projects; changing the suggestion card UI or the run flow; non-Anthropic providers.
