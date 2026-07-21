## Why

Aurora's ⌘R / setup-and-run subsystem is structurally unreliable and the port isolation "isn't
really working" (user's words). The redesign is modeled on **Conductor** (conductor.build): a
committed, typed repo config; first-class managed dev servers with real PIDs; and an absolute
per-workspace port contract — plus (beyond Conductor) real port-probing and collision detection.

The current design has **six structural faults**, each verified in the code:

1. **"Up/down" is a lie.** Liveness is inferred from PTY foreground-pgid sampling + OSC-133, never
   from a bound port (`serversUp` `src/lib/servers.ts:49-67`, `ensurePtyPoll`
   `src/lib/running.ts:116-147`). The badge reflects a heuristic, not a listening socket.
2. **Stop orphans servers.** `pty_kill` tears down `[shell_pgid, fg, server.found()]`
   (`src-tauri/src/pty.rs:337-349`, `group_teardown:310-328`); the tier-4 tty scan that could find
   survivors (`pty.rs:597-608`) is display-only and is NOT on the kill path → servers keep holding
   ports after Stop.
3. **Single-pgid capture is defeated by forking servers.** The ~8 s sampler freezes on one
   "last non-shell" pgid (`pty_capture_server_pgid` `pty.rs:455-562`, `sampler_step:375-399`);
   `nx --no-tui` / multi-process servers re-parent and escape it.
4. **No process handle.** Servers are commands *typed into a shared shell PTY*
   (`send()` → `pty.write(ptyId, cmd+"\n")` `src/lib/scripts.ts:80-83`, `runServerScript:229-266`).
   No PID, no exit code, no restart primitive.
5. **Port isolation is cooperative and unenforced.** The only primitive is `AURORA_PORT_OFFSET`;
   isolation depends on each repo script doing arithmetic `$((3000+AURORA_PORT_OFFSET))`
   (regex `src/lib/ports.ts:44-47`). A hardcoded `-p 3000` silently collides and isn't even
   recognized as a server.
6. **Allocation is a band-aid.** `allocOffset` (`src/lib/create.ts:21-36`) is a single in-memory
   same-repo store scan with a serialization guard (`createChains` `create.ts:203-222`); offsets are
   never reserved against the OS and never reclaimed.

On top of that there are **two parallel data models** for the same concept — `Script`/`RepoScripts`
(`src/state/store.ts:84-97`, no `kind` field, localStorage `userScripts`) and `Preset`
(`src/lib/repoConfig.ts:15-36`, localStorage `aurora.repoconfig`) — neither committed to the repo,
neither team-shareable.

## What changes

A ground-up rework across three capabilities. It is additive-then-cutover: the new managed path
lands behind the existing entry points (⌘R, Run/Stop toggle) and the legacy `AURORA_PORT_OFFSET`
keeps being exported for back-compat during migration.

### 1. Committed, typed repo config (`dev-server-config`)
- New committed file **`aurora.json`** at the repo root (JSON — parsed with native `JSON.parse`;
  **not TOML**, which would need a parser dependency that the `bun add` → esbuild-signature
  constraint forbids). Read/written through the existing `sys::read_text_file` /
  `sys::write_text_file` commands (`src-tauri/src/lib.rs:44-45`, wrapped in `src/lib/sys.ts`).
- Explicit typed model with a real `kind`: `scripts.setup` (runs once after workspace create),
  `scripts.run.<id>` (named run scripts, each `command` / `args` / `cwd` / `default` / `icon` /
  `hide`), `scripts.archive` (runs before teardown), `scripts.run_mode` =
  `"concurrent" | "nonconcurrent"`. Mirrors Conductor's `.conductor/settings.toml` field names.
- **Migration** of the two legacy localStorage models (`userScripts` scripts + `onEnter`, and
  `Preset.runOnOpen` / `env` / `envFiles` / `portOffset`) into `aurora.json`, offered on repo open
  when a committed config is absent but legacy data exists. `onEnter` → `scripts.setup`;
  port-scripts → `scripts.run.<id>`.

### 2. First-class managed servers + lifecycle (`dev-server-lifecycle`)
- New Rust process manager: each run script is spawned as **its own tracked child** (real PID, own
  pgid via `setsid`, own PTY for output) — NOT typed into a shared shell. New commands (net-new,
  alongside the existing `pty_*` handlers in `src-tauri/src/lib.rs:35-42`): `server_spawn`
  (returns a handle with pid/pgid), `server_status` (running / exited + exit code, from `waitpid`,
  not a heuristic), `server_stop` (SIGHUP → verify port freed → SIGKILL survivors of *that exact
  pgid*), `server_probe` (see capability 3).
- Lifecycle state machine: `create → setup(once) → run(named) → probe → stop → archive(once)`.
  `setup` replaces the ad-hoc install-inference + `onEnter` hook (`create.ts:44-52,309`,
  `maybeFireHook` `scripts.ts:280-293`); `archive` is net-new (no teardown hook exists today).
- The JS orchestrator (`src/lib/servers.ts`, `src/lib/scripts.ts` run path) is rewritten to drive
  the managed commands instead of `pty.write`-into-shell. The 4-pane cap (`servers.ts:114-128`) and
  single-pgid capture (`servers.ts:147`) are removed.

### 3. Absolute port contract + probe + collision (`dev-server-ports`)
- Inject **`AURORA_PORT`** = the first port of a **10-port range** reserved for the workspace
  (mirrors `CONDUCTOR_PORT`). Scripts do `-p $AURORA_PORT`, no arithmetic. Also inject the Conductor
  parity set: `AURORA_WORKSPACE_NAME`, `AURORA_WORKSPACE_PATH`, `AURORA_ROOT_PATH`,
  `AURORA_DEFAULT_BRANCH`, `AURORA_IS_LOCAL`.
- **Back-compat:** keep exporting `AURORA_PORT_OFFSET`. Allocation base is a documented constant
  `AURORA_PORT_BASE` (default **3000**) so that `AURORA_PORT = AURORA_PORT_BASE + AURORA_PORT_OFFSET`
  and the legacy idiom `$((3000+AURORA_PORT_OFFSET))` resolves to exactly `AURORA_PORT` — the
  migration is numerically exact, old scripts keep working unchanged.
- **Allocation / reservation / reclamation:** allocate the lowest free 10-port range across *all
  live workspaces of all repos* (not same-repo only), reserve it, and reclaim it on
  archive/teardown. Replaces `allocOffset` (`create.ts:21-36`).
- **Probe (net-new — user said "optimize it all", no deferral):** after a run script starts, probe
  the actually-listening port(s) of its process group via `lsof` on macOS. The up/down badge
  reflects a real bound port; the bound port number is surfaced.
- **Collision detection:** a bound port outside the workspace's allocated range, or a port already
  owned by another workspace's managed server, is surfaced loudly (red badge + notify). Stop must
  verify the port is freed and escalate to SIGKILL for survivors.

### UI touchpoints
- Run/Stop toggle (`src/components/WorkspaceRail.tsx:839-862`) becomes a **Run menu** when more than
  one non-hidden run script exists (Conductor's Run-button menu); the default script runs on the
  bare click. ⌘R (`src/lib/keymap.ts:439-456`) opens the menu (multi) or runs the default (single),
  keeping `preventDefault()`.
- Per-server badge shows real state (up/down/collision) + the probed port number.
- Script-editing surfaces (`ScriptsSetupModal`, `ScriptsSheet`, `PresetEditor`, `WorkspaceSettings`)
  edit the typed `setup/run[]/archive` model and write `aurora.json`.
- The AI generator (`src/lib/aiScripts.ts:58-72`) emits `-p $AURORA_PORT` instead of the arithmetic
  offset form.

## Impact

- **Affected specs (new capabilities):** `dev-server-config`, `dev-server-lifecycle`,
  `dev-server-ports`. Supersedes the intent of the in-flight `workspace-port-isolation`,
  `workspace-run-servers`, and the scripts half of `workspace-config`.
- **Affected code (rework, not greenfield):**
  - Rust: `src-tauri/src/pty.rs` (new server-manager module or sibling `server.rs`), `lib.rs`
    handler registration.
  - JS lifecycle: `src/lib/servers.ts`, `src/lib/scripts.ts`, `src/lib/create.ts`,
    `src/lib/running.ts`, `src/lib/ports.ts`, `src/lib/repoConfig.ts` (+ migration),
    `src/lib/aiScripts.ts`, `src/lib/envFiles.ts`, `src/state/store.ts` (typed model + `kind`).
  - UI: `WorkspaceRail.tsx`, `keymap.ts`, `ScriptsSetupModal`, `ScriptsSheet`, `PresetEditor`,
    `WorkspaceSettings`.
- **Tests:** rewrite/extend `__tests__/{ports.cov,portIsolation,servers.cov,runServers,running.cov,
  create.cov,buildCreateSpec,envFiles,scripts.cov,pty.cov,presets.cov,repoConfig.migrate,
  repoConfig.cov,PresetEditor.cov,ScriptsSetupModal.cov,ScriptsSheet.cov,keymap-shortcuts.cov,
  WorkspaceRail.cov,teardown}`; new `cargo test` in the Rust server module. **>90% integration
  coverage target on the new JS subsystem** (see `design.md` for the JS/Rust seam and how coverage
  is measured — it is NOT a single blended number).

## Non-goals / constraints held

- **No new dependency** (`bun add` breaks esbuild's signature → SIGKILL 137) → JSON config, no TOML.
- **No broad `pkill -f`** anywhere (would kill the user's live `tauri dev`); kills target specific
  tracked pids/pgids only.
- macOS-only, Tauri v2 WKWebView; all UI text in English.
- Not re-litigating the four confirmed decisions (managed servers, committed typed config, absolute
  `AURORA_PORT`, probe+collision) — they are the design inputs.
