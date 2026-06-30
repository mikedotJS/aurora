## Why

Per-repo scripts (install / dev / build / test / lint …) are defined by hand in the Scripts editor —
the user has to translate what they already know about a repo's stack (its `package.json`, `Cargo.toml`,
`Makefile`, compose file, …) into Aurora's name + commands + working-dir form, once per repo. Aurora
already has a BYO Anthropic key wired through Rust; we can let Claude read the repo's manifests and
propose a fitting set of scripts the user reviews, edits, and accepts — turning minutes of setup into a
glance.

## What Changes

- **"Generate with AI" in the Scripts editor**: a new action in `ScriptsSetupModal`, enabled when an
  Anthropic key is present and the repo root (`main_root`) is resolved; degrades to the key-entry flow
  when no key is set and is hidden/disabled when not in a repo.
- **Repo-signal gathering (webview)**: collect a shallow listing of the repo root plus the contents of
  recognized manifest/config files when present (`package.json`, `pnpm/yarn/bun` lock *presence*,
  `Cargo.toml`, `Makefile`, `justfile`, `pyproject.toml`/`requirements.txt`, `go.mod`,
  `docker-compose.yml`, `.nvmrc`, `README.md`), each size-capped, lockfile bodies and `.env`/secret
  files excluded.
- **One-shot Claude call (Rust, BYOK)**: extend `claude_text` with an optional `max_tokens` so the
  existing keychain-backed call path can return a small script set (the 300-token default is too small);
  the frontend sends only the assembled signals — never the key.
- **Structured output + validation**: Claude returns ONLY a JSON array of scripts in Aurora's schema
  (`{name, desc, split, tasks:[{dir,cmd}]}`); the frontend strips fences, validates the shape, clamps
  script/task counts, and drops anything malformed.
- **Review before adopt — nothing runs**: proposed scripts are shown in a review step where the user can
  edit and pick which to keep; accepted scripts are appended to the repo's scripts (deduping names),
  persisted per-repo (keyed by `main_root`). Generated commands are **never auto-executed** — they only
  run later through the existing explicit `run` flow.
- **Prompt-injection guard**: manifest/README contents are treated as untrusted **data**, not
  instructions; the system prompt fixes the task and output contract and tells the model to ignore any
  instructions embedded in the repo files.

## Capabilities

### New Capabilities
- `ai-script-generation`: from the Scripts editor, ask Claude (BYO key, via Rust) to read the current
  repo's manifests and propose a set of per-repo scripts in Aurora's schema; the user reviews/edits and
  accepts them into the repo's scripts, with nothing executed automatically and graceful degradation
  when no key / not in a repo.

### Modified Capabilities
<!-- Builds on the `scripts-hooks` capability (defined in the `add-aurora-terminal` change), reusing its
     per-repo script schema, store, and editor. That capability is not yet a baseline spec under
     openspec/specs/, so the new behavior is captured as the new capability above rather than as a delta. -->

## Impact

- **Frontend (`src/`)**: `components/ScriptsSetupModal.tsx` (the "Generate with AI" action + the review
  step); new `lib/aiScripts.ts` (gather repo signals, build the prompt, call Claude, parse + validate
  into `Script[]`, merge into the repo's scripts via the existing `lib/scripts.ts` mutators); reuses
  `ai/suggest.ts`'s `claudeText` wrapper / `NoKeyError`. Per-repo persistence already lands scripts under
  `main_root`.
- **Backend (`src-tauri/`)**: `claude.rs` — add an optional `max_tokens` parameter to `claude_text`
  (default unchanged); no new secret surface (key stays in the keychain, request issued from Rust).
- **Reuses**: the Anthropic BYOK path (`claude.rs` + keychain), the per-repo scripts store/editor
  (`scripts-hooks`), and the repo-root resolution (`main_root`) used to key scripts.
- **Depends on**: `scripts-hooks` (per-repo scripts), the Anthropic key being configured for generation
  (degrades otherwise).
- **Out of scope**: running generated scripts automatically; non-Anthropic providers; multi-repo /
  monorepo per-package generation (single repo root this pass).
