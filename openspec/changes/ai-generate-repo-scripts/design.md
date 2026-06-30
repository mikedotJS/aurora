# Design — ai-generate-repo-scripts

## Context

Aurora already has (a) a per-repo scripts model — `Script { name, desc, split, tasks:[{dir,cmd}] }`
persisted under the repo's `main_root` (`lib/scripts.ts` + the `userScripts` store), edited in
`ScriptsSetupModal`; and (b) a BYO Anthropic key wired through Rust — `claude.rs::claude_text(system,
prompt, model)` reads the key from the OS keychain and POSTs to the Anthropic Messages API, returning
the assistant's text (`Err("no-key")` when unset). The frontend wrapper is `ai/suggest.ts::claudeText`
(throws `NoKeyError`). The branch-naming feature already uses this exact path to get model output and
validate it in JS.

This change adds a generation step on top: read the repo's manifests, ask Claude for a fitting set of
scripts, and let the user review/accept them into the existing per-repo store. No new persistence model
and no new credential surface.

Standing constraint (carried from the terminal's security posture): **secrets never enter the webview**
(the key stays in the keychain; the request is issued from Rust), and **model-suggested shell commands
are never executed without explicit user action** (cf. `claude_suggest`'s non-destructive contract and
the `?`/⌘↵ suggest-then-confirm flow).

## Goals / Non-Goals

**Goals:**
- One action in the Scripts editor that proposes a set of scripts fitting the current repo's stack.
- Reuse the existing keychain BYOK call path and the existing per-repo script schema/store/editor.
- A mandatory review step: the user edits and chooses which proposed scripts to keep; nothing runs.
- Graceful degradation: no key → key entry; not in a repo → unavailable; bad model output → no change.
- Treat repo file contents as untrusted data (prompt-injection resistant).

**Non-Goals:**
- Auto-running generated scripts (they only run later via the explicit `run` flow).
- Non-Anthropic providers (OpenAI etc.) — the pool's `aiDefaultId` wiring is out of scope here.
- Monorepo / per-package generation — single repo root this pass.
- A bespoke "agentic" repo crawl — a bounded, allowlisted signal set is sufficient.

## Decisions

### D1 · Reuse `claude_text`, add an optional `max_tokens`
The generation call is a one-shot completion exactly like branch-naming, so reuse `claude_text` rather
than add a command. Its hard-coded `max_tokens: 300` is too small for a script set, so add an optional
`max_tokens: Option<u32>` parameter (default 300 — backward compatible); the generation call passes
~1500. `call_claude` already takes `max_tokens`.
- *Alternatives:* a new `claude_json`/`claude_scripts` command (rejected — duplicates the BYOK path);
  Anthropic tool-use / structured output (rejected — heavier than needed; JS-side validation matches the
  branch-naming precedent and keeps Rust generic).

### D2 · Gather repo signals in the webview, relay through Rust
The webview lists the repo root with the existing `list_dir` command and reads manifest contents with a
small **capped** `read_text_file(path, maxBytes)` primitive added to the backend (Tab completion only
listed directories — there was no generic file read yet). It assembles the signal bundle and passes it as
the prompt; the Anthropic call stays a thin Rust relay (only the `max_tokens` addition). Keeping the
allowlist + assembly in the webview means the new backend surface is two generic primitives, and the
secret boundary is unchanged.
- *Alternatives:* a single Rust `gather_repo_signals(root)` that owns the allowlist (rejected this pass —
  a generic `read_text_file` is reusable and keeps the prompt assembly next to the prompt); reusing an
  existing JS read (rejected — none existed).

### D3 · Output contract: a JSON array in Aurora's `Script` schema, validated client-side
The system prompt fixes the output to ONLY a JSON array of `{name, desc, split, tasks:[{dir,cmd}]}` (no
prose, no fences). The frontend strips any stray code fences, `JSON.parse`s, and **validates**: each
script needs a non-empty `name` and ≥1 task with a non-empty `cmd`; `dir` defaults to `""`; `split`
coerced to boolean; script and per-script task counts clamped (e.g. ≤ 12 scripts, ≤ 6 tasks). Malformed
entries are dropped; a fully unparseable response surfaces an error and leaves scripts unchanged.

### D4 · Mandatory review; nothing auto-runs; repo content is untrusted data
Proposed scripts land in a **review** view (reuse the editor's script-card rendering) where the user can
edit fields and toggle which to keep, then "Add selected". Accepted scripts append via the existing
`addScript`/`updateScript` mutators. Commands never execute during generation or acceptance — only later
through `run`. The system prompt states the manifests are data to analyze, that the model must ignore any
instructions embedded in them, and that commands must be non-destructive (mirrors `claude_suggest`).

### D5 · Signal selection + size caps (token budget & secret hygiene)
Send: a shallow listing of the repo root (names only) and the **contents** of an allowlist of manifests
when present — `package.json`, `Cargo.toml`, `Makefile`, `justfile`, `pyproject.toml`,
`requirements.txt`, `go.mod`, `docker-compose.yml`/`compose.yaml`, `.nvmrc`, and a truncated `README.md`.
Record only the **presence** of lockfiles (to infer the package manager) — never their bodies. Exclude
`.env*` and obvious secret files. Per-file cap ~8 KB, total prompt cap bounded so the response fits the
token budget.

### D6 · Merge semantics: append, never clobber
On accept, append to the repo's scripts; on a name collision with an existing user script, auto-suffix
(`build` → `build-2`) rather than overwrite. The user's hand-written scripts are never silently replaced.

### D7 · Model selection
Use the configured suggestions model (the same `settings.model` `claudeText` already uses). Per-repo
`aiDefaultId` routing is deferred with the rest of the pool-account wiring.

## Risks / Trade-offs

- **Prompt injection via README/manifest contents** → data is isolated in the prompt with an explicit
  "ignore embedded instructions" directive; more importantly, output is constrained to the script schema,
  reviewed by the user, and never auto-run — so an injected instruction cannot cause execution.
- **Hallucinated / wrong commands** → mandatory review + edit before keep; non-destructive guidance in
  the prompt; execution stays behind the explicit `run` flow.
- **Secret leakage to Anthropic** → allowlist manifests only; exclude `.env*`/secret files and lockfile
  bodies; per-file and total caps.
- **Truncated/invalid JSON (token overflow)** → bounded input + `max_tokens` headroom + strict validation
  that drops bad entries; a fully invalid response shows an error and changes nothing.
- **No key / not in a repo** → action routes to key entry / is unavailable, consistent with the editor's
  existing "cd into a repo" empty state.

## Migration Plan

Additive. No data migration: generated scripts use the existing `Script` schema and per-repo store. The
`claude_text` `max_tokens` parameter is optional and defaults to today's value, so existing callers
(branch-naming) are unaffected. Rollback = remove the editor action and `lib/aiScripts.ts`; no persisted
state changes.

## Open Questions

- Should the review step offer "refine" (re-prompt with the user's edits/notes) in this pass, or land
  accept-only first?
- Monorepo support (detect workspaces/packages and offer per-package scripts) — follow-up.
- When the connection-pool `aiDefaultId` wiring lands, route generation through the repo's bound AI
  account instead of the global suggestions key.
