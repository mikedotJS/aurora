# PROGRESS — setup script appears "cut" immediately on workspace create

## Goal
A workspace's Setup Script (`aurora.json` `scripts.setup`, e.g. `pnpm install`) must run to
completion in the workspace terminal with its output visible — not appear to finish instantly
with an empty block while the process keeps running invisibly.

## In scope
- The unpaired OSC `133;D` emitted by `ZSH_INIT`'s own `precmd`, which prematurely ends the
  Setup Script's block.

## Out of scope
- The `managed-server-lifecycle` change's open tasks (1.1, 1.3, 3.6, 4.2, 5.3, 5.4).
- Non-zsh shells emitting no OSC 133 markers at all (pre-existing, separate).
- The `initTimer` 1200 ms readiness fallback (investigated, not the trigger — see evidence).

## Done when
- A real zsh, driven with Aurora's `ZSH_INIT`, emits **no `133;D` before its first `133;C`**.
- Real `133;D` markers still fire, with correct exit codes, for ordinary commands, empty lines,
  and syntax errors (all three legitimately produce a `D` with no preceding `C`).
- `bun run test` + `typecheck` + `lint` green.

## Root cause (proven, see evidence log)
`ZSH_INIT` installs `precmd`/`preexec` hooks *in the middle of the line it is itself running*.
`preexec` therefore never fires for that line, but `precmd` does — so the very first thing zsh
emits after init is a **`133;D` with no matching `133;C`**.

`Terminal.tsx`'s `parseNormal` ends the current block on any `133;D` (`133;C` is explicitly
ignored). If `runWhenReady`'s 60 ms poll happens to call `startBlock("pnpm install")` inside the
~8 ms window between `AuroraReady` and that stray `D`, the block is closed immediately. From then
on `store.appendOutput` drops every byte (`if (!last.running) return {}`), so pnpm's entire output
is discarded and the pane shows a finished, empty command with the prompt back — while pnpm is
still really running.

## Slices
| # | Slice | Status | Commit |
|---|-------|--------|--------|
| 1 | `ZSH_INIT` must not emit an unpaired `133;D` for its own init line | done, uncommitted | — |
| 2 | Managed servers must run under `$SHELL -ic`, not `sh -lc` | done, uncommitted | — |
| 3 | `aurora.json` gains `envFiles`, materialized into each new worktree | done, uncommitted | — |
| 4 | `write_text_file` must refuse a leaf-symlink escape (vuln from slice 3) | done, uncommitted | — |
| 6 | file-watch aurora.json → re-read on disk edit, no relaunch | done, uncommitted | — |

### Slice 6 evidence
- New `src-tauri/src/config_watch.rs` (notify 6): `ConfigWatcher::new(Fn(String) sink)` watches a
  repo-root DIR non-recursively, filters to `aurora.json`, reports the ORIGINAL root string.
  `watch_aurora_config` command + `ConfigWatcherState` in `lib.rs`; sink emits `aurora:config-changed`.
- Rust tests (real fs, channel sink): fires on write, fires on remove, IGNORES an unrelated file,
  watch is idempotent. Red-first observed: disabling the filename filter → "ignores unrelated" FAILS.
  `cargo test --lib` → 140 pass / 0 fail (+4).
- New `src/lib/configWatch.ts`: `requestConfigWatch` (deduped invoke), `startConfigWatch` (per-root
  250ms debounce), `reloadAuroraConfig` (invalidate + re-read). Wired: `ensureAuroraConfigLoaded`
  registers the watch on every load; `App.tsx` starts the listener once. Circular import
  configWatch↔auroraConfigStore is safe (no call at module-eval; tsc + suite green).
- JS tests red-first observed: break dedup → "watch exactly once" FAILS; remove debounce →
  "coalesce burst into one reload" FAILS. Gate → 1853 pass / 0 fail.
- Self-write loop checked: editor Save writes the file → watcher fires → reload re-READS (never
  writes) → no loop; reload re-requests watch but it's deduped.
- Backlog: no unwatch on repo-remove (harmless stale watch). Nested `<sub>/aurora.json` edits are
  safely ignored (parent not in the roots map).

### Slice 4 — leaf-symlink workspace escape (found by the ship verifier)
`sys.rs` `write_text_file` canonicalized the target's PARENT and checked containment, but
`std::fs::write` follows a symlink at the FINAL path component. Slice 3 made `envFiles` a committed,
attacker-controlled input, so a hostile cloned repo could ship a tracked symlink `leaklink ->
../../secret` plus `aurora.json envFiles:[{path:"leaklink",…}]` and overwrite an arbitrary file
outside the worktree on workspace create.

Fix: after the parent check, `symlink_metadata(target)` (does not follow the link) and reject if the
leaf is a symlink. A missing target (normal fresh-worktree case) and a plain existing file pass.

Evidence:
- Red-first, observed: `write_text_file_rejects_a_leaf_symlink_escape` panicked "a leaf-symlink
  escape must be refused" against the old code (the outside file WAS overwritten); passes after.
- Two sibling tests guard the happy path and the already-blocked directory-symlink escape.
- `cargo test --lib` → **136 pass / 0 fail** (was 133; +3 this slice).

### Verifier notes carried forward (not defects I introduced)
- `auroraConfig.test.ts:14` uses `mock.module("../src/lib/sys")`, which bun applies process-globally
  and never restores. So `bun test <fileA> <fileB>` across those two files reports failures — but the
  project's real runner (`bun test/cov.ts`) runs every file in its OWN process for exactly this
  reason (its header comment says so). The gate is honest; only a manual multi-file `bun test` trips
  it. Correct way to run: `bun test/cov.ts`, or one file at a time. Left as-is (pre-existing pattern;
  re-architecting bun global mocks is out of scope for this task).

### Slice 3 — gitignored env files never reach a worktree
`git worktree add` only carries tracked files, so `apps/*/.env.local` (gitignored) is missing from
every workspace. For ClubMed that left `NEXT_PUBLIC_API_BASEURL` undefined → welcomer POSTed to
`http://localhost:4210/auth/undefined/graphql` (a relative URL against its own origin — it was
never pointing at 3000).

`materializeEnvFiles` already existed and its module doc even names this exact gap, but its only
input was `preset.envFiles`, which lives in `localStorage["aurora.repoconfig"]` and only applies
when a preset is selected at create.

[ASSUMED] Added `envFiles` to the committed `aurora.json` schema rather than requiring a
localStorage preset — it's team-shareable, needs no UI, and is where this repo's config already
lives. Preset `envFiles` still work and win on a path collision.

Evidence:
- Red-first, observed (both guards, by reverting the implementation, not by inspection):
  - drop the aurora.json source → "materializes aurora.json envFiles …" FAILS.
  - drop the path dedupe → "a preset envFile wins … written once" FAILS `Expected length: 1,
    Received length: 2` (two concurrent writes to one path would race for the final bytes).
- 4 new schema tests in `auroraConfig.test.ts` failed before `normalizeEnvFiles` existed.
- `bash .claude/gate.sh` → typecheck ✓, lint ✓, **1847 pass / 0 fail across 82 files**.
- nx really does load the file: wrote `apps/api/.env.local` = `PORT=3010` into the worktree, ran
  `pnpm nx serve api` with **no** PORT in the environment → `✅ api bound 3010 from .env.local
  alone`. So the run command no longer needs `PORT=$AURORA_PORT`.
- ClubMed's new `aurora.json` parsed with Aurora's own parser: `ok: true, error: null`, and
  `renderEnvContent` at offset 10 → `PORT=3010` / `NEXT_PUBLIC_API_BASEURL=http://localhost:3010/api`.

Not verified at runtime: welcomer actually reading its new `.env.local`. It rests on Next's native
`.env.local` loading, which is what the main checkout already depends on today.

Deferred: no UI for editing `envFiles` (`ScriptsSetupModal` still only edits scripts). Hand-edit
`aurora.json` for now.

### Slice 2 — managed servers ran on the wrong Node
`server.rs:106` spawned every `aurora.json` run/setup/archive script with `sh -lc`. That reads
/etc/profile + ~/.profile and never ~/.zshrc, where `fnm` is initialized (`~/.zshrc:113`). So a
managed server ran on `/usr/local/bin/node` v20.14.0 instead of the fnm-selected v22.14.0 — and
v20.14 predates `require(esm)`, which is why `nx serve api` died with `ERR_REQUIRE_ESM` on
`@react-pdf/renderer` while the same command in a normal pane worked.

Pre-change, Run/Stop was `pty_write` into the pane's own `$SHELL`, so it inherited the right env.
The `sh -lc` regression came in with `managed-server-lifecycle`; the module doc even claimed it was
"same as `pty_spawn`", but `pty_spawn` runs `$SHELL` with no args (interactive → sources `.zshrc`).

Evidence:
- `sh -lc 'node -v'` → `v20.14.0` (`/usr/local/bin/node`); `$SHELL -ic 'node -v'` → `v22.14.0` (fnm).
- `/usr/local/bin/node -e "require('@react-pdf/renderer/lib/react-pdf.js')"` → `ERR_REQUIRE_ESM`;
  same require under v22.14.0 → OK. Causal link, not correlation.
- Not the worktree, not `node_modules`: the exact failing command (`pnpm nx run api:build
  --skip-nx-cache`, 40 parallel tasks) succeeds in that same worktree from a normal shell.
- `$SHELL -ic` preserves exit codes (`(exit 7)` → 7) and still expands `$((3000 +
  AURORA_PORT_OFFSET))` → 3010.
- Red-first, observed: new test `spawn_sources_the_interactive_shell_rc_so_version_managers_
  initialize` (uses `$ZDOTDIR`, never touches the real rc) FAILS against `sh -lc`, passes after.
- `cargo test --lib` → 133 pass / 0 fail. `bash .claude/gate.sh` → 1840 pass / 0 fail.

Not committed: the working tree already carries the whole in-flight `managed-server-lifecycle`
change (~20 files, incl. `Terminal.tsx`). Committing would entangle this fix with that WIP, so the
commit is left to the user.

## Evidence log
- **Real zsh + user's real `~/.zshrc`** (`scratchpad/pty_probe2.py marker`), current `ZSH_INIT`:
  `269.4ms AuroraReady → 277.6ms 133;D (unpaired) → 280.0ms 133;C → 688.7ms 133;D`.
  The stray `D` lands 8.2 ms after the pane is marked ready.
- **Refuted**: the 1200 ms `initTimer` fallback. `zsh -i -c exit` = 0.20–0.21 s, `zsh -l -i` =
  0.24–0.32 s, and `pty.rs` spawns a non-login shell — the timer never fires first.
- **Refuted**: stale `managedServers` aliasing a fresh shell pane. `managedServers` is
  runtime-only (`store.ts:797`) and `paneSeq` resets on boot (`store.ts:806`).
- **Refuted (and would regress)**: gating `endBlock` on having seen a `133;C`.
  `scratchpad/probe_fix2.py` shows an empty line and a syntax error each emit a `D` with **no**
  preceding `C` — such blocks would hang "running" forever.
- **Fix verified against real zsh** (`scratchpad/probe_fix2.py`):
  - before: `READY -> D(0) -> C -> D(0) -> C -> D(7) -> D(7) -> D(7) -> C -> D(0)` (6 × `D`)
  - after:  `READY -> C -> D(0) -> C -> D(7) -> D(7) -> D(7) -> C -> D(0)` (5 × `D`)
  Exactly the leading unpaired `D` disappears; `D(7)` (exit code) and the empty-line /
  syntax-error `D`s all survive.
- Red-first, observed: with the guard stripped from `zshInit.ts`, `__tests__/zshInit.shell.test.ts`
  fails — `never emits a command-end before the first command-start` → `Expected: "C", Received:
  "D:0"`. Guard restored → 4 pass / 0 fail.
- Gate: `bash .claude/gate.sh` → typecheck ✓, lint ✓, **1840 pass / 0 fail across 82 files**,
  lines 88.17%, funcs 96.45%. `RESULT: GREEN`.

## Known limits of the evidence
The stray `D` lands ~8 ms after the pane is marked ready, and `runWhenReady` polls on a 60 ms grid
— so pre-fix this corrupts a create only when a poll tick falls inside that window, not on every
create. It was reproduced at the shell level, not driven through the real Tauri app. The fix
removes the stray marker entirely, so the race cannot occur regardless of timing.

### Slice 5 — api needs its gitignored secret env, not just PORT (ClubMed config only)
Login threw tedious's `The "config.server" property is required and must be of type string.` —
`db.ts:31` passes `host: process.env.DB_CONFIG_HOST` to Sequelize→tedious (`config.server`), and
`DB_CONFIG_HOST` was undefined. Cause: `apps/api/.env.local` holds 14 secret vars (DB + SMTP +
cookie) and is gitignored, so it never reaches a worktree; my PORT-only `envFiles` file didn't
supply them. welcomer's file has no secrets, so `envFiles` fully covers it.

[USER-DECISION] Chose "copy in setup" over an Aurora-level auto-copy feature or manual. `aurora.json`
setup now `cp "$AURORA_ROOT_PATH/apps/api/.env.local" apps/api/.env.local 2>/dev/null` then appends
`PORT=$AURORA_PORT`, then `pnpm install`; api dropped from `envFiles` (setup owns that file), welcomer
kept. Secrets stay on-machine and out of git (gitignored path in a gitignored worktree); values never
read. Source-missing degrades gracefully (`>>` creates a PORT-only file, same as before).

Evidence:
- Updated `aurora.json` parses with Aurora's own parser: `ok: true, error: null`.
- Ran the setup file-prep against the LIVE worktree (`feat-welcomer-gody-9999-2309120`): file went
  from `[PORT]` only → `[COOKIE, DB_CONFIG_*, INTERVENTION_URL, NEXT_PUBLIC_IS_DEBUG, PORT, SMTP_*]`,
  `DB_CONFIG_HOST` present + non-empty, exactly one `PORT=3010` line. This un-breaks the current
  workspace without a recreate — user must restart the api (Stop→Run / ⌘R).
- No Aurora source changed this slice (ClubMed `aurora.json` + a one-time live-file fix only).

### Slice 5b — why the fix didn't take: aurora.json is cached in memory
"Still the same error" after slice 5: new worktrees kept getting a PORT-only `apps/api/.env.local`.
Root cause is NOT the config — it's that `ensureAuroraConfigLoaded` (`auroraConfigStore.ts:51-52`)
caches `aurora.json` in the store's `auroraConfigs` map and returns the cached copy forever:
`const cached = ...auroraConfigs[root]; if (cached) return cached;`. The running Aurora read
`aurora.json` once; every create since used that stale copy, so my on-disk edits (cp in setup, api
dropped from envFiles) were never seen. `auroraConfigs` is runtime-only (no `partialize`/`persist`;
`savePersisted` only stores workspaces + activeWs), so a RELAUNCH clears it and re-reads disk.

Also observed: the user is recreating the workspace repeatedly (test-93192 → 2309120 → daozkd), so
each live-file fix gets torn down with its worktree. The durable fix is the relaunch.

Unblock applied: same cp fix on the current live worktree (`feat-welcomer-gody-9999-daozkd`) →
`DB_CONFIG_HOST` non-empty, single `PORT=3010`, welcomer URL `:3010`. User restarts ONLY the api
(Stop→Run), does NOT recreate (recreate re-runs the stale cached setup) until Aurora is relaunched.

Backlog (Aurora): `aurora.json` edits on disk require a relaunch to take effect — there's no
file-watch / re-read. A watcher (or re-read on repo focus) would remove this footgun.

### Slice 6 — file-watch aurora.json (kills the "edits need a relaunch" footgun)
Goal: when a repo's `aurora.json` changes on disk, Aurora re-reads it without a relaunch, so a new
workspace's setup/run/envFiles reflect the edit.

Design: a Rust `notify` watcher (no JS dep — avoids the `bun add`/esbuild-codesign issue) watches each
loaded repo root's DIRECTORY (watching the file misses editor rename-replace), filters to
`aurora.json`, and emits a Tauri event `aurora:config-changed {root}`. Frontend debounces per root,
then `invalidateAuroraConfig(root)` + `ensureAuroraConfigLoaded(root)` → repopulates the store cache
→ dependent UI (run menu, scripts) re-derives. `ensureAuroraConfigLoaded` registers the watch after a
successful load (idempotent, deduped both sides).

Done when:
- Rust: writing `<root>/aurora.json` fires the change callback with `root`; an unrelated file in the
  same dir does NOT. (real-fs test, injectable sink like server.rs's `app: Option<AppHandle>`)
- JS: an `aurora:config-changed` for a cached root invalidates + reloads it; debounced/deduped.
- Gate green (JS + cargo), red-first on the new tests.
[ASSUMED] no unwatch on repo-remove (harmless stale watch; YAGNI) — logged as backlog.

## Next action
Done — file-watch shipped (slice 6). Both halves red-first tested, JS 1853/0, cargo 140/0, release
build compiles, wiring cross-checked, config_watch.rs clippy-clean. UNVERIFIED seam: the live
FSEvents→emit→listen→reload round-trip in the running GUI (can't drive a headless Tauri app; both
sides unit-proven, uses the same Tauri-event pattern as pty:data/server:data). Requires an Aurora
REBUILD to take effect (Rust change). Commit alongside the rest.

---
Earlier slices — 4 shipped, all gates green (JS 1847/0, Rust 136/0), ship verifier's one real finding (leaf
symlink) fixed and re-proven. Review + commit alongside the `managed-server-lifecycle` work.
Remaining `managed-server-lifecycle` tasks (1.1, 1.3, 3.6, 4.2, 5.3, 5.4) untouched and out of scope.
Deferred: no UI to edit `aurora.json envFiles` (hand-edit for now); Aurora needs relaunching to pick
up the Rust changes (slices 2 + 4) before the ClubMed config behaves as verified.
