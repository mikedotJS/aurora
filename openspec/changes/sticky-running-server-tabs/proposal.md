## Why

When a user runs a long-running command in a pane (a dev server: `vite`, `next dev`, `npm run dev`, `nx serve`,
`python -m http.server`, …), Aurora's blocks-mode UI can make it look **killed when it is not**:

- Aurora suppresses the shell prompt (`PROMPT=''`, see `src/components/Terminal.tsx:41`) and segments output into
  DOM "blocks" via OSC-133 markers. The live prompt (`src/components/Pane.tsx:251`) is rendered **whenever the
  pane is in blocks-mode**, regardless of whether a command is still running. So even while a foreground server
  is streaming logs, the user sees an input caret underneath and can type — those keystrokes go to the PTY, where
  the **foreground server** (not the shell) reads them. The user *thinks* they are back at a shell; they are not.
- Worse, for tools that **detach their server into their own process group** and hand the prompt back — the known,
  documented `nx serve … --no-tui` behaviour (memory: *nx-no-tui-detach*; investigated at length under
  `workspace-run-servers`) — the OSC-133 `D` marker fires (`precmd`), Aurora ends the block
  (`src/components/Terminal.tsx:175`), and the pane genuinely returns to a prompt **while the server keeps running
  in a separate pgid**. The tab gives no signal that a server is still up.
- Ctrl+C is unreliable as a "stop the server" gesture. In blocks-mode, Ctrl+C writes a raw `\x03` to the PTY
  (`src/lib/keymap.ts:346`). That byte reaches the **PTY foreground process group** via the tty. For a foreground
  server that works. For a **detached** server the PTY foreground is the shell (back at its prompt), so `\x03`
  hits the shell and **never reaches the detached server** — the user presses Ctrl+C, the server survives.

The user's ask: make a running dev server **stick to its tab** (a clear "● running" marker + blocked input so the
pane can't masquerade as an idle shell), and make **Ctrl+C actually kill it**.

## What the codebase already gives us (verified)

This is not greenfield. `workspace-run-servers` already built, in Rust, exactly the primitives this feature needs
— but wired **only** to the explicit "Run servers" button + port-declaring scripts, in a dedicated "Servers" tab:

- `master.process_group_leader()` (`src-tauri/src/pty.rs:314,447`) — portable-pty's wrapper over **`tcgetpgrp`
  on the PTY master fd**. This is *the* tty API for reading a pane's **foreground process group**. Already used by
  `pty_kill`/`kill_all`. It is the generic, command-agnostic signal decision #1 asks for: `fg_pgid != shell_pgid`
  ⇒ a foreground child is running.
- `pty_capture_server_pgid` (`src-tauri/src/pty.rs:387`) — a bounded sampler thread that watches the foreground
  pgid and **captures the pgid of a job that then detaches** (returns the prompt), via the pure `sampler_step`
  logic (`src-tauri/src/pty.rs:341`). This is how a detached `nx --no-tui` server's real pgid is recovered.
- `pty_server_status` (`src-tauri/src/pty.rs:493`) — liveness probe via `killpg(pgid, 0)` → `alive|dead|capturing|
  uncaptured`.
- `group_teardown` / `pty_kill` / `kill_all` (`src-tauri/src/pty.rs:285,311,67`) — already SIGHUP→SIGKILL the
  **captured** server pgid, proven to reap the detached `nx --no-tui` server on Stop and on ⌘Q (memory note).

So the reliable kill-path for a detached process group **already exists and works**. What is missing is (a) making
detection **generic and per-pane** (not just the Servers tab), (b) the **sticky tab badge + input block** UI, and
(c) routing **Ctrl+C** on a detached-but-captured server to a `killpg(pgid, SIGINT)` instead of a dead-end `\x03`.

## What Changes

- **Generic per-pane "running" signal (backend).** Add `pty_foreground_state(id) -> { running, pgid }` (or reuse
  `process_group_leader()` via a thin command) that reports whether the pane's PTY foreground pgid differs from the
  shell pgid. The front polls this per visible/live pane on a light interval (align with the existing ~1.5 s server
  poll in `src/lib/servers.ts:69`). Combined signal, in priority order, for "this pane is running a process":
  1. current foreground pgid `!= shell_pgid` (foreground server — vite/next/python) → **running**;
  2. else a **captured** detached pgid that is still `alive` (nx-style detached server) → **running**;
  3. else the OSC-133 block `running` flag (existing fallback).
- **Start a capture for every command, not just Run-button servers.** Wire `pty.captureServerPgid(ptyId)` into the
  block lifecycle — fire it when a command block starts (the Enter path, `src/lib/keymap.ts:110`) so a typed
  `nx serve --no-tui` gets its detached pgid captured the same way the Run button does. (Fire-and-forget; resolves
  to `uncaptured` for ordinary commands that never detach, which is the correct no-op.)
- **Sticky tab badge (frontend).** `TabStrip` (`src/components/TabStrip.tsx`) shows a "● running" badge + the
  running command label on any tab with a running pane. The label reuses the existing auto-rename source
  (`src/lib/tabNaming.ts`, `Group.name`) or the running block's command.
- **Block the prompt while running (frontend).** In blocks-mode, when a pane is "running" (per the combined signal)
  and **not** in rawMode, replace the live command prompt (`src/components/Pane.tsx:251`) with a non-editable
  "● running `<cmd>` — Ctrl+C to stop" affordance, so the pane cannot masquerade as an idle shell. rawMode
  programs (vim/top/inline prompts) are unaffected — they already own the pane.
- **Ctrl+C really kills (frontend + backend).** In a running pane, route Ctrl+C by state:
  - foreground child (pgid == PTY foreground): keep writing `\x03` to the PTY (already correct — SIGINT reaches it);
  - detached-but-captured child (PTY foreground is the shell, captured pgid alive): call a new
    `pty_signal_server(id, SIGINT)` that does `killpg(captured_pgid, SIGINT)` — the same mechanism Stop/⌘Q already
    use to reap it, so it is proven to reach the process.

## Risks, unknowns & honest limitations

These are **not** hand-waved — several bear directly on whether decision #3 ("Ctrl+C tue vraiment") is fully
achievable:

- **A truly *un-captured* detached server cannot be reached by Ctrl+C.** The kill-path requires the sampler to have
  captured the detached pgid. If capture resolved to `uncaptured` (no distinct foreground job was ever observed —
  e.g. a server that daemonizes into a brand-new session/pgid before the sampler sees it, or that forks so fast the
  ~40 ms sampler misses the window), there is **no pgid to signal** and Ctrl+C has nothing to target. This is a real
  gap. The UI must degrade honestly (offer nothing false); `kill_all` on ⌘Q still won't reach a truly daemonized
  server either — that was never in scope and remains out of scope here.
- **`killpg(pgid, SIGINT)` vs graceful vs escalation.** SIGINT to the captured group *reaches* the process (proven:
  Stop/⌘Q already SIGHUP→SIGKILL the same group). **Open question:** does the server treat SIGINT as a clean stop,
  or does Ctrl+C need an escalation (SIGINT → wait → SIGTERM/SIGKILL)? Escalation changes Ctrl+C semantics (a second
  press = harder kill?). Proposed: single SIGINT first; decide escalation during implementation from observed nx/
  next-server behaviour. **Do not assume one press guarantees death.**
- **pgid reuse / stale capture.** Between capture and a Ctrl+C, the captured pgid could theoretically be recycled by
  the OS after the server died. `killpg` on a recycled pgid could signal an unrelated group. Mitigation: only signal
  when `pty_server_status` reports `alive` immediately before signalling; still a narrow TOCTOU window — call it out.
- **Generalising the sampler to every command has a cost.** The sampler was fire-once per launched server. Firing a
  capture per typed command adds one bounded (~8 s) sampler thread per command and a per-pane foreground poll. Needs
  a perf check (thread churn, lock contention on `PtyManager.sessions`) — the existing poll already guards overlap
  (`_pollRunning`, `src/lib/servers.ts:59`); reuse that discipline.
- **"Running" is deliberately generic — including short/foreground non-servers.** Per decision #1, *any* live
  foreground child counts. So `npm install` (2 min) will show "● running" and block the prompt — which is arguably
  correct, but a `sleep 30` will too. This is intended, not a bug; but the badge/label wording should read as
  "process running", not literally "server", to stay honest. Flagged for the designer.
- **`process_group_leader()` semantics to re-confirm at implementation.** The codebase asserts it is `tcgetpgrp`
  of the master (`pty.rs:314` comment). Portable-pty's actual impl must be re-read to confirm it returns the
  *slave's* foreground pgid on macOS (Aurora's target) and not `-1`/`None` when the shell is foreground. Hypothesis
  to confirm, not an established fact for the generic path.
- **This is a bug the user is describing — why OpenSpec and not the debugger?** The *misleading prompt* is real
  behaviour, but the ask adds new capability (sticky badge, blocked input, generic detection, Ctrl+C routing), so it
  is a **feature** with a bug-fix embedded. The root-cause fix for the detach itself is **not available**: the
  memory note (*nx-no-tui-detach*) established that nx decides to background on its own and **Aurora writes nothing
  extra** — there is nothing on Aurora's side to neutralise. So decision #3 is delivered by *reaching* the detached
  process (capture + signal), **not** by preventing the detach. This distinction is load-bearing and honest.

## Capabilities

### New Capabilities
- `sticky-running-server-tabs`: detect, generically and per-pane, when a pane is running a foreground or detached
  child process; mark its tab as running; block the pane's command prompt while it runs; and make Ctrl+C interrupt
  the running process — including a detached server — by reusing the existing PTY foreground-pgid + capture + killpg
  machinery.

### Modified Capabilities
<!-- Builds on workspace-run-servers (the capture sampler, liveness probe, and killpg teardown) and on the
     add-aurora-terminal blocks/OSC-133 model. It generalises capture/liveness from the Servers-tab flow to every
     pane and adds UI (badge, blocked prompt) + Ctrl+C routing. No baseline spec of those capabilities lives under
     openspec/specs/, so the new behaviour is captured as the new capability above rather than as spec deltas. -->

## Impact

- **Rust (`src-tauri/src/`):**
  - `pty.rs` — add `pty_foreground_state(id) -> { running: bool, pgid: Option<i32> }` (reads
    `process_group_leader()` vs `shell_pgid`); add `pty_signal_server(id, signal: i32)` doing `killpg(captured_pgid,
    signal)` guarded by a fresh `killpg(pgid, 0)` liveness check. Reuse `ServerCapture` / `process_group_leader()`
    as-is. No new registry.
  - `lib.rs` — register the two new commands in the Tauri handler.
- **Frontend (`src/`):**
  - `term/pty.ts` — add `foregroundState(id)` and `signalServer(id, signal)` bridges.
  - `state/store.ts` — a runtime-only per-pane running signal (derive from `serverStatus` + a new foreground map, or
    extend the existing `serverStatus` map keyed by ptyId). **Not persisted.**
  - `lib/servers.ts` (or a sibling `lib/running.ts`) — generalise the poll to cover every live pane's foreground
    state, not just Servers-tab panes; keep the overlap guard.
  - `lib/keymap.ts` — on block start (Enter path, line 110) fire `pty.captureServerPgid`; on Ctrl+C (line 346) route
    to `\x03` (foreground) vs `pty.signalServer(SIGINT)` (detached-but-captured).
  - `components/TabStrip.tsx` — running badge + label.
  - `components/Pane.tsx` — replace the live prompt with the "running" affordance while a pane is running
    (blocks-mode, non-rawMode).
- **Reuses (no change):** `pty_capture_server_pgid`, `pty_server_status`, `group_teardown`/`pty_kill`/`kill_all`,
  the OSC-133 block lifecycle, `tabNaming`/`Group.name`.
- **Out of scope:** servers that truly daemonize into a new session before the sampler sees them (unreachable — same
  limitation as `workspace-run-servers`); preventing the detach itself (not possible, per the memory note); Ctrl+C
  escalation policy beyond a first SIGINT (decided during implementation); persisting running state across relaunch.
