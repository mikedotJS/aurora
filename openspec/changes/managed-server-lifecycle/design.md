# Design — managed-server-lifecycle

## Context

Rework Aurora's setup/run scripts, dev-server lifecycle, and port isolation from the ground up,
modeled on Conductor. Four confirmed decisions (managed servers, committed typed config, absolute
`AURORA_PORT`, probe + collision) are inputs, not open questions. This doc records the load-bearing
architecture decisions and — critically — how ">90% integration coverage" is defined across a
JS frontend and a Rust process backend that are exercised by two different test runners.

## Decision 1 — Config format: `aurora.json` (JSON), not TOML

Conductor uses `.conductor/settings.toml`. Aurora **cannot** add a TOML parser: `bun add` breaks
esbuild's code signature → build SIGKILLs (137) (memory: `esbuild-codesign-after-bun-add`). JSON
parses with native `JSON.parse`, zero deps. File lives at repo root as `aurora.json` (committed,
team-shareable), read/written through the existing `sys::read_text_file` / `sys::write_text_file`
Tauri commands (`src-tauri/src/lib.rs:44-45`, wrapped in `src/lib/sys.ts`). No new Rust command
needed for config IO.

Schema (v1):

```jsonc
{
  "version": 1,
  "scripts": {
    "setup": "bun install",                 // string | string[]; runs ONCE after workspace create
    "run": {
      "web": {
        "command": "bun",
        "args": ["run", "dev", "-p", "$AURORA_PORT"],
        "cwd": ".",                          // relative to workspace root; default "."
        "default": true,                     // ⌘R / bare Run-button click target
        "icon": "🌐",                        // optional, shown in the Run menu
        "hide": false                        // optional, hide from the Run menu
      },
      "api": { "command": "bun", "args": ["run", "api", "-p", "$AURORA_PORT"] }
    },
    "archive": "bun run clean",              // string | string[]; runs ONCE before teardown
    "run_mode": "concurrent"                 // "concurrent" | "nonconcurrent"
  }
}
```

- `run.<id>` mirrors Conductor's `scripts.run.<id>` (command/args/options.cwd/default/icon/hide).
  Aurora omits Conductor's `available_in` (workspace-vs-root distinction Aurora doesn't model) in v1
  — **assumption to confirm** with the user; leaving it out is the smaller design.
- Env-var substitution (`$AURORA_PORT`, `$AURORA_WORKSPACE_PATH`, …) is expanded by the spawner, not
  by a shell arithmetic idiom.

## Decision 2 — Data model with a real `kind`

Today two parallel models (`Script`/`RepoScripts` `store.ts:84-97`, `Preset`
`repoConfig.ts:15-36`) describe the same thing and neither has a `kind`. Unify to one typed model
that the store holds and `aurora.json` serializes:

```ts
type ScriptKind = "setup" | "run" | "archive";
interface ManagedScript {
  kind: ScriptKind;
  id: string;            // stable key; "setup"/"archive" are singletons, "run" ids are named
  command: string;
  args: string[];
  cwd: string;           // relative to workspace root
  // run-only:
  default?: boolean;
  icon?: string;
  hide?: boolean;
}
```

`kind` is the field whose absence is fault-adjacent today: a "port script" is inferred by regex
(`ports.ts:44-47`) instead of being declared a run server. With `kind: "run"` the classification is
explicit and probing/badging attach to it directly.

## Decision 3 — Absolute port contract + exact-migration base

- `AURORA_PORT` = first port of a 10-wide range reserved for the workspace.
- Allocation base constant `AURORA_PORT_BASE = 3000` (documented; single source of truth). Range for
  offset `k` is `[3000+k, 3009+k]` with `k ∈ {0,10,20,…}`.
- `AURORA_PORT = AURORA_PORT_BASE + AURORA_PORT_OFFSET`. Because the legacy idiom is
  `$((3000+AURORA_PORT_OFFSET))`, an unmigrated script resolves to *exactly* `AURORA_PORT`. So we
  keep exporting `AURORA_PORT_OFFSET` and migration is numerically lossless.
- Conductor-parity env also injected: `AURORA_WORKSPACE_NAME`, `AURORA_WORKSPACE_PATH`,
  `AURORA_ROOT_PATH`, `AURORA_DEFAULT_BRANCH`, `AURORA_IS_LOCAL`.
- **Allocation / reservation / reclamation:** the allocator scans live workspaces across *all repos*
  (today `allocOffset` `create.ts:24-25` scans same-repo only → cross-repo collisions possible),
  picks the lowest free range, records the reservation on the workspace, and releases it on
  archive/teardown. Reservation is against Aurora's own bookkeeping; the OS-truth check is the probe
  (Decision 5), which catches a range Aurora thinks is free but something external is holding.

## Decision 4 — First-class managed process (fixes faults 2,3,4)

New Rust module (proposed `src-tauri/src/server.rs`, registered next to `pty_*` in `lib.rs:35-42`):

- `server_spawn(id, command, args, cwd, env) -> { pid, pgid, ptyId }` — spawns the run command as
  its **own** child in its **own** session (`setsid`, as `pty_spawn` already does `pty.rs:57,188-190`)
  with its own PTY for output rendering. The command is the child's argv (`sh -lc "<command>"`),
  **not** text written into an interactive shell. So Aurora owns pid+pgid directly.
- `server_status(handle) -> Running | Exited(code)` from a non-blocking `waitpid`, not from
  foreground-pgid sampling or OSC-133. Removes `pty_capture_server_pgid` sampler
  (`pty.rs:455-562`) from the run path.
- `server_stop(handle)` — SIGHUP the pgid, wait ~200 ms (Conductor's cadence), re-probe the port; if
  still bound or process still alive, SIGKILL *that exact pgid*. Never a broad `pkill`. Reuses the
  `group_teardown` guards (`> 1`, `!= getpgrp()`, `pty.rs:311-317`).

This directly retires faults 2 (Stop targets the real pgid, then verifies), 3 (own session → forked
children stay in the pgid; no single-"last non-shell" heuristic), 4 (real PID + exit code + a
restart = respawn primitive).

## Decision 5 — Probe + collision (macOS `lsof`)

- After spawn, poll for the process group's LISTEN sockets. Primary: `lsof -nP -iTCP -sTCP:LISTEN`
  filtered to the pgid's pids. **Caveat to confirm at implementation:** `lsof -g <pgid>` filtering
  is not reliable in all cases; the robust form is enumerate pids with `ps -g <pgid> -o pid=` then
  `lsof -nP -p <pids> -iTCP -sTCP:LISTEN`. Existing tty-scan machinery (`pty.rs:597-608`) is a
  precedent that shelling out to system tools on macOS is acceptable here.
- **Up** = ≥1 LISTEN port owned by the pgid. The badge is now truth, not heuristic (fixes fault 1).
- **Collision** = a bound port outside `[AURORA_PORT, AURORA_PORT+9]`, OR a port already recorded as
  owned by another live workspace's managed server. Surface loudly: red badge + `notify`.
- Probe cadence: reuse the existing ~1.5 s poll shape (`ensurePtyPoll` `running.ts:116-147`) but
  query `server_probe`/`server_status` instead of `foregroundState`+`serverStatus`.

## Decision 6 — Lifecycle state machine

`create → setup(once) → run(named, per run_mode) → probe → stop → archive(once) → reclaim port`.

- `setup` supersedes install-inference (`create.ts:44-52`) + `runOnOpen` (`create.ts:309`) +
  `onEnter`/`maybeFireHook` (`scripts.ts:280-293`). It runs once after worktree create; the
  `depsReadyGate` race guard (`scripts.ts:99-110`) folds into "run waits for setup to exit 0".
- `archive` is net-new (no teardown hook exists). Runs before `workspace-teardown` removes the
  worktree; on failure, teardown still proceeds (cleanup is best-effort) but surfaces the error.
- `run_mode: nonconcurrent` runs a single run server at a time (starting another stops the prior);
  `concurrent` runs all selected.

## Test strategy — what ">90% integration coverage" means here (honest seam)

The subsystem straddles two runners: JS (`bun run test` = `bun test/cov.ts`, happy-dom, NO Rust) and
Rust (`cargo test`, real processes). A single blended coverage number would be dishonest. Define it
as **two named targets, reported separately**:

1. **JS subsystem, >90% via `bun test/cov.ts` — integration-level.** "Integration" here = exercising
   the real orchestrator + store + config + port-allocator modules *together* through the public
   entry points (`runServers`/`stopServers`, create flow, ⌘R handler, migration), with only the
   Tauri `invoke` boundary (`server_spawn`/`server_stop`/`server_status`/`server_probe`, `sys` file
   IO) faked by an in-memory process-manager double. This double models spawn→listen→exit so the
   full lifecycle state machine, port allocation/reservation/reclamation across multiple workspaces
   and repos, collision surfacing, and localStorage→`aurora.json` migration are all driven end-to-end
   on the JS side. Coverage measured by the repo's own `bun test/cov.ts` runner on the new subsystem
   modules (`servers.ts`, `scripts.ts` run path, `ports.ts`, `create.ts` alloc, `repoConfig.ts`
   migration, the new config module). Evidence = pasted runner output with the per-file %.
2. **Rust process/probe layer via `cargo test` — real-process integration.** Spawn a real
   short-lived listener (e.g. `python3 -m http.server $PORT` or `nc -l`), assert `server_probe`
   reports the bound port, `server_stop` frees it (re-probe shows it gone), and a deliberately
   surviving child is SIGKILLed. These prove the parts the JS double *fakes*. They run under
   `cargo test`, are NOT counted in the `bun` number, and their evidence = pasted `cargo test` green.

The seam is explicit: the JS double is only trustworthy because the Rust tests independently prove
the real spawn/probe/stop behaves as the double claims. Neither alone is sufficient; the plan
requires both. e2e (WebdriverIO, `e2e/`) is slow and occluded (memory: `wkwebview-raf-paused…`,
`aurora-e2e-wdio-harness`) → at most one Run-menu smoke, not the coverage vehicle.

## Open questions (carry into implementation, do not guess)

- `run.<id>.available_in` (Conductor's workspace-vs-root field): omitted in v1 — confirm with user.
- `AURORA_PORT_BASE` default 3000 vs a higher base to dodge common system ports — confirm.
- Exact `lsof` invocation for reliable pgid→port mapping (see Decision 5 caveat) — confirm on real
  macOS with a forking server (`nx --no-tui`) before declaring the probe done.
- Whether managed servers keep a visible pane (output) or move to a headless log surface — assumed
  "own PTY, still shown in a pane" to preserve current UX; confirm.
