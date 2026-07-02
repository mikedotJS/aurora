## 1. Frontend bridge: expose changed files (`src/lib/sys.ts`)

- [x] 1.1 Add a `gitChangedFiles(dir)` wrapper invoking the existing `git_changed_files` command, returning `ChangedFile[]` (`{path, old_path, status, staged, added, removed}`) and resolving to `[]` on error — mirroring the other `sys.ts` wrappers. No Rust change. *(Already existed pre-change in `src/lib/git.ts` — same shape/error-handling pattern as `sys.ts`'s wrappers, reused by `Changes` view. `projectContext.ts` imports it from there instead of duplicating it in `sys.ts`; no Rust change either way.)*

## 2. Frontend: the project-context engine (`src/lib/projectContext.ts`)

- [x] 2.1 Define `ProjectContext` (`root`, `cwd`, optional `git`, `toolchain`, `scripts`, `projects`) with the sub-shapes described in the proposal; a single reusable module (not suggestion-specific) so other flows can consume it later.
- [x] 2.2 `gatherProjectContext(cwd)`: resolve root via `gitRepoInfo(cwd)` (`main_root` ?? `root` ?? `cwd`); capture `git.branch` from `current_branch`. All steps below are best-effort and independently optional.
- [x] 2.3 Toolchain: read the root `package.json` body once (capped, via `readTextFile`) and parse `packageManager` (strip `@version`), `scripts` keys, and `workspaces`; `listDir(root, true)` once for lockfile presence (reuse the `aiScripts.ts` lockfile map — presence only, never bodies), `nx.json`/`turbo.json`/`lerna.json`, and `pnpm-workspace.yaml`. Package-manager precedence: `packageManager` field > single lockfile > (multiple lockfiles) documented tie-break.
- [x] 2.4 Real scripts: collect root `package.json` `scripts` names, sorted/stable, capped to a max count.
- [x] 2.5 Real projects/targets: when the repo has workspaces/a runner, expand the workspace globs (e.g. `apps/*`, `packages/*`, `libs/*`) via `listDir`, and for each candidate dir read `project.json` (`name` + `Object.keys(targets)`) or fall back to its `package.json` `name`; cap total projects and targets-per-project. Never read lockfiles or `.env`/secret files.
- [x] 2.6 Git state: `gitChangedFiles(root)` → keep `{path, status}` for a capped number of files plus the total count (for an "+N more" marker).
- [x] 2.7 Degradation: omit any signal whose source is absent/unreadable; return a context with only `root`/`cwd` when nothing else is found. Never throw out of `gatherProjectContext`.
- [x] 2.8 `formatProjectContext(ctx)`: render a compact, labelled block (toolchain line; `Scripts:`; `Projects:` as `name: t1, t2`; `Branch:`; `Changed files:`) applying per-section caps AND an overall character budget with a truncation marker; return `""` when there is nothing useful to inject.

## 3. Frontend bridge: pass context to the suggestion call (`src/ai/suggest.ts`, `src/lib/keymap.ts`)

- [x] 3.1 Add an optional `context?: string` parameter to `claudeSuggest(prompt, cwd, model, context?)` and forward it in the `invoke("claude_suggest", …)` args.
- [x] 3.2 In `askClaude` (`lib/keymap.ts`), `await gatherProjectContext(pane.cwd)` + `formatProjectContext(...)` before `claudeSuggest`, and pass the result. Detection failure is caught and non-fatal — fall back to calling without context (today's behavior).

## 4. Backend: inject context into the suggestion prompt (`src-tauri/src/claude.rs`)

- [x] 4.1 Add an optional `context: Option<String>` parameter to `claude_suggest`.
- [x] 4.2 When `context` is non-empty, append a "Project context (detected — use these REAL names; do not invent scripts or targets)" section to the system prompt: use the detected package manager and never a different one; prefer the detected runner for project targets and use it to run multiple targets (e.g. `nx run-many -t <target> -p a b`) rather than chaining `npm run a & npm run b`; reference only scripts/targets present in the context. Treat the context as data. When empty/absent, leave the prompt exactly as today.
- [x] 4.3 `cargo build`/`cargo check` clean; existing `parse_suggestion` tests unaffected. *(Verified: `cargo check` clean, `cargo test claude::` → 6/6 `parse_suggestion` tests pass.)*

## 5. Validation

- [x] 5.1 Verify each spec scenario against the code paths: pnpm+nx repo → suggestion uses pnpm+nx and real script/project names (not `api`/`welcomer`); plain npm repo → npm + its real scripts; bun/yarn repo → matching manager; non-JS repo → no toolchain/scripts/projects injected; non-git dir → no git section; detection reads no lockfile bodies or `.env`/secret files; oversized monorepo stays within the character budget (truncation marker present). *(Covered by unit tests in `__tests__/projectContext.cov.test.ts` (20 tests, 99.49% line coverage of `projectContext.ts`) plus wiring tests in `__tests__/suggest.cov.test.ts` and `__tests__/keymap.cov.test.tsx`. This verifies the deterministic detection/formatting logic; it does not verify the live model actually obeys the injected instructions — see 5.3.)*
- [x] 5.2 `bun run lint`, `bunx tsc --noEmit`, `bun run build`, and `cargo check` all clean. *(All four ran clean — see implementation report.)*
- [ ] 5.3 Live GUI check (left for the user): in a pnpm + nx repo, an explicit ask like "run the api and welcomer apps" suggests a pnpm/nx command using real project names rather than `npm run api & npm run welcomer`. *(Not done — requires a live Claude API call and manual observation in the running app; left for the user as specified.)*
