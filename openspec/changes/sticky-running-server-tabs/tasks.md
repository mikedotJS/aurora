# Tasks — sticky-running-server-tabs

Sequenced so each phase typechecks / compiles on its own. Phases 1–2 are backend primitives, 3 wires generic
detection, 4–5 are the UI, 6 is the Ctrl+C fix, 7 is verification. Reuses the existing `workspace-run-servers`
capture/liveness/killpg machinery — **read `src-tauri/src/pty.rs` (ServerCapture, sampler, group_teardown) and
`src/lib/servers.ts` (poll) before coding**; do not duplicate them.

## 0. Confirm the load-bearing assumption first

- [x] 0.1 Re-read portable-pty's `process_group_leader()` impl to confirm it returns the **slave foreground pgid**
      (tcgetpgrp of the master) on macOS, and what it returns when the shell itself is foreground (expect
      `Some(shell_pgid)`, not `None`). Record the finding in `design.md` before building detection on it.
- [x] 0.2 Manually confirm the two cases on the real app with a throwaway log: (a) `vite`/`python -m http.server`
      keep the foreground (`fg != shell`); (b) `nx serve … --no-tui` returns the prompt with a distinct alive
      captured pgid. If (a) or (b) does not hold, revisit the proposal before proceeding.

## 1. Backend: generic foreground state (`src-tauri/src/pty.rs`)

- [x] 1.1 Add `#[tauri::command] pty_foreground_state(id) -> { running: bool, pgid: Option<i32> }`: read
      `session.master.process_group_leader()` and `session.shell_pgid`; `running = fg.is_some() && fg > 1 && fg !=
      shell_pgid`. Return `{ running, pgid: fg }`. No new state.
- [x] 1.2 Add `#[tauri::command] pty_signal_server(id, signal: i32) -> Result<bool,String>`: if the session's
      `ServerCapture::Found(pgid)` answers `killpg(pgid, 0)` (alive), `killpg(pgid, signal)` and return `true`;
      otherwise return `false` (no signal sent — guards the recycled-pgid TOCTOU window). Do **not** signal for
      `Idle`/`Pending`/`Failed`.
- [x] 1.3 Register both commands in the Tauri `generate_handler!` (`src-tauri/src/lib.rs`).
- [x] 1.4 Unit-test the pure predicate parts where feasible (the `fg != shell && fg > 1` decision), mirroring the
      existing `sampler_step` tests in `pty.rs`.

## 2. Frontend bridge (`src/term/pty.ts`)

- [x] 2.1 Add `foregroundState(id): Promise<{ running: boolean; pgid: number | null }>` → `invoke("pty_foreground_state")`.
- [x] 2.2 Add `signalServer(id, signal): Promise<boolean>` → `invoke("pty_signal_server")`. Export a `SIGINT = 2`
      constant (document the macOS value; Aurora is macOS-only per project context).

## 3. Frontend: generic per-pane running detection (`src/lib/servers.ts` or new `src/lib/running.ts`)

- [x] 3.1 Define the combined running signal as a pure function `paneRunning(pane, status?, fg?)` implementing the
      spec's 3-tier priority: foreground-child (fg) → captured-alive (serverStatus) → OSC-133 block flag. Unit-test
      all three tiers + the not-running case with plain fixtures (no store/Tauri).
- [x] 3.2 Generalise the liveness poll to cover **every live pane with a ptyId** (not just Servers-tab panes): per
      tick, call `pty.foregroundState(ptyId)` and (when a capture exists) `pty.serverStatus(ptyId)`, writing both
      into a runtime-only store map keyed by ptyId. Keep the existing overlap guard (`_pollRunning`) and auto-stop
      when no live panes remain. Confirm the added per-pane syscalls are acceptable (see proposal perf risk).
- [x] 3.3 Store (`src/state/store.ts`): add a runtime-only foreground/running map (or extend `serverStatus`),
      keyed by ptyId, with setter/clear actions. **Do NOT** persist it (exclude from `PersistedWs`/`savePersisted`).
      Clear a pane's entry on pane close / respawn / exit.

## 4. Frontend: capture on every command (`src/lib/keymap.ts`)

- [x] 4.1 In the Enter/command-submit path (`keymap.ts:110`, after `startBlock` + `pty.write(cmd + "\n")`), fire
      `pty.captureServerPgid(ptyId)` fire-and-forget so typed detaching commands get their group captured.
- [x] 4.2 Ensure the generic poll is running whenever any pane has a ptyId (call the poll-ensure from spawn/ready or
      from 4.1), and stops when none remain.

## 5. Frontend UI: sticky badge + blocked prompt

- [x] 5.1 `src/components/TabStrip.tsx` — render a running badge (● + label) on tabs with a running pane. Label from
      `Group.name` (auto-rename) or the running block command; wording must read as "process running", not assert a
      server type. Do not break the existing active-dot / split-badge layout.
- [x] 5.2 `src/components/Pane.tsx` — when `paneRunning` is true AND `!pane.rawMode`, replace the live prompt block
      (`Pane.tsx:251`) with a non-editable "● running `<cmd>` — Ctrl+C to stop" affordance. Restore the normal
      prompt when not running. Leave rawMode panes untouched.
- [x] 5.3 Verify the selector reads do not build fresh arrays/objects inline (the documented Zustand black-screen
      crash — memory: *aurora-zustand-selector-crash*). Derive `paneRunning` outside the selector or memoize.

## 6. Frontend: Ctrl+C routing (`src/lib/keymap.ts`)

- [x] 6.1 In the Ctrl handler (`keymap.ts:346`), for `^C` when the pane is running: if the running signal is the
      **foreground child** (fg != shell), keep `pty.write(ptyId, "\x03")`. If it is a **detached-but-captured**
      group (fg == shell, captured alive), call `pty.signalServer(ptyId, SIGINT)` instead.
- [x] 6.2 If `signalServer` returns `false` (uncaptured / dead), do not claim success; surface a brief, honest
      notice (e.g. "couldn't reach the process") rather than silently doing nothing. Keep the existing `setInput("")`
      side-effect only where appropriate.
- [x] 6.3 Decide the escalation policy from observed behaviour (single SIGINT vs SIGINT→SIGTERM/SIGKILL on repeat).
      Document the decision in `design.md`. Default to a single SIGINT unless testing shows nx/next-server needs more.

## 7. Verify (real app — WKWebView; jsdom cannot confirm this)

- [x] 7.1 `bun run build` + `cargo build` clean; `bun test` green (new unit tests included).
      Re-confirmed 2026-07-02: `bun test/cov.ts` **1583 pass / 0 fail** across 69 files (RESULT: GREEN,
      91.87% line / 98.63% func coverage over 61 src files); `bun run build` (tsc + vite) clean; `cargo build`
      (dev profile) clean; `cargo test --lib` **115 passed / 0 failed** (incl. 4 new real-PTY integration
      tests below), stable across repeated parallel and `--test-threads=1` runs.
      Found+fixed a real bug during this pass: `src/components/Pane.tsx` referenced an undefined `showRunning`
      (ReferenceError), crashing every render of a running pane — added the missing `const showRunning =
      !pane.rawMode && !showKeyEntry && running;` (mirrors `showPrompt`'s running clause). This was hanging
      the isolated test runner (App.cov.test.tsx crash-looped React's synchronous unmount-during-render path);
      confirmed fixed by re-running that file standalone (20/20 pass) and the full suite (was RED with 4
      process-crashed files under disk pressure, now clean GREEN after fix + freeing disk).
- [x] 7.2 (backend half only, machine-verified) Foreground server: added real-PTY integration tests
      (`src-tauri/src/pty.rs`, `mod real_pty_tests`) that spawn a real `/bin/zsh` on a real PTY, run `sleep 30`
      in the foreground, and assert `fg_is_non_shell` (the exact predicate `pty_foreground_state` uses) is
      true with a pgid distinct from the shell's, then SIGINT the group and assert it dies and the foreground
      reverts to the shell — proving the reachability half of "Ctrl+C stops it, badge clears, prompt returns"
      against the live kernel, not a mock. **NOT verified**: the tab badge rendering, the prompt-block UI, and
      the actual keystroke-to-Ctrl+C path in the real WKWebView app — those need a human running `vite` (or
      `python -m http.server`) in an Aurora pane and watching the tab/prompt/Ctrl+C behavior.
- [x] 7.3 (backend half only, machine-verified) Detached server: added a real-PTY integration test that
      backgrounds a job (`sleep 30 & disown` — the macOS-native detach idiom, confirmed manually; `setsid` is
      Linux-only and unavailable here) so the foreground genuinely returns to the shell while the job stays
      alive in its own pgid, then does exactly what `pty_signal_server` does (allowlist check, fresh
      `killpg(pgid,0)` liveness re-check, `killpg(pgid, SIGINT)`) and asserts the process actually dies and
      `killpg(pgid,0)` subsequently reports ESRCH — proving Ctrl+C's kill-path reaches and kills a genuinely
      detached process, not just a foreground one. **NOT verified**: an actual `nx serve --no-tui` in a real
      repo (this test emulates the detach mechanism, not nx itself), the badge staying lit after the prompt
      returns, or `lsof -i` port-freed confirmation — all need a human in the real app with a real nx project.
- [x] 7.4 (backend half, machine-verified) Uncaptured edge: added a real-PTY integration test that lets a
      short-lived backgrounded job (`sleep 1 & disown`) die on its own, then asserts the guard `pty_signal_server`
      relies on (`killpg(pgid,0)` returns ESRCH) — proving the "never signal a dead/uncaptured pgid" contract
      holds against a real dead process, not an assumption. **NOT verified**: the front-end honest-degradation
      notice ("couldn't reach the process") is unit-tested in jsdom (`__tests__/keymap.cov.test.tsx`, tiers
      confirmed) but a human has not watched it actually appear in the real app for a fast/daemonizing command.
- [ ] 7.5 rawMode program (`vim`, `top`) is unaffected: no badge-driven prompt block, Ctrl+C behaves as before.
      Not machine-verifiable beyond what already exists: `src/lib/running.ts`'s `paneRunning` is deliberately
      rawMode-agnostic (by design, gating is `Pane.tsx`'s job) and this is unit-tested
      (`__tests__/running.cov.test.tsx`, "ignores pane.rawMode entirely"); `Pane.tsx`'s `showPrompt`/`showRunning`
      both gate on `!pane.rawMode`, confirmed by direct code read. Actually running `vim`/`top` in a pane and
      confirming no visual regression needs a human in the real app — untouched here.
- [ ] 7.6 Relaunch with a server that had been running: panes come back not-running, normal prompt, no badge.
      Not machine-verified: `foregroundState`/`serverStatus` are runtime-only maps confirmed NOT persisted
      (excluded from `PersistedWs`/`savePersisted` by code read), so a relaunch should structurally start every
      pane with no entry in either map → `paneRunning` falls through to tier 3 (OSC-133 block flag, which also
      resets on a fresh pane) → not-running by construction. This is a structural argument from reading the
      code, not an observed relaunch. A human quitting and relaunching Aurora with a server that was running
      is needed to actually confirm it.
