# design.md — sticky-running-server-tabs

## Phase 0 — confirming `process_group_leader()` before building on it

**Claim to verify (proposal):** portable-pty's `process_group_leader()` is `tcgetpgrp` of the PTY master
fd, and on macOS returns `Some(shell_pgid)` — not `None`/`-1` — when the shell itself is the foreground
process group (i.e. the pane is sitting at an idle prompt).

**0.1 — source-level confirmation.** Extracted `portable-pty-0.8.1.crate` (the exact version pinned in
`src-tauri/Cargo.toml`) into a scratch dir and read `src/unix.rs`:

```rust
fn process_group_leader(&self) -> Option<libc::pid_t> {
    match unsafe { libc::tcgetpgrp(self.fd.0.as_raw_fd()) } {
        pid if pid > 0 => Some(pid),
        _ => None,
    }
}
```

`unix.rs` has no `#[cfg(target_os = ...)]` branches — this single impl is used on macOS, Linux and the
BSDs alike. It further confirmed `spawn_command` calls `setsid()` then `ioctl(fd, TIOCSCTTY, 0)` before
exec — establishing the child (the shell) as the session leader **and** the tty's foreground process
group (POSIX: `TIOCSCTTY` on a fd with no controlling terminal makes the calling process's pgrp the
foreground pgrp of that tty). So immediately after spawn, and whenever the shell is back at its prompt,
`tcgetpgrp(master_fd)` is expected to return `Some(shell_pgid)`, never `None`.

**0.2 — empirical confirmation on this machine.** Source reading alone wasn't treated as sufficient — a
throwaway Rust example (`src-tauri/examples/fg_probe.rs`, written, run once via
`cargo run --example fg_probe`, then deleted — not part of the build) spawned a real `/bin/zsh` PTY via
`portable-pty` directly (no Tauri/webview involved — this predates and does not require phase 7's
WKWebView verification) and printed `process_group_leader()` at three points:

```
shell_pgid           = Some(95709)
(a) fg at idle prompt = Some(95709)   (expect Some(shell_pgid), not None)
(b) fg during `sleep 5` (foreground) = Some(95808)   (expect Some(pgid) != shell_pgid)
(c) fg right after `sleep 5 & disown` = Some(95709)   (expect Some(shell_pgid) again — prompt returned)
```

All three match the hypothesis exactly:
- idle shell → `Some(shell_pgid)`, confirming the "not None" claim decision #1 depends on.
- a foreground child (`sleep 5`) → a distinct, larger pgid, confirming tier 1 of the combined signal
  (`fg != shell_pgid` ⇒ foreground child running).
- backgrounding + disowning → foreground returns to `shell_pgid`, confirming that a detached job is
  correctly *invisible* to the foreground-pgid check alone — which is exactly why tier 2 (the captured-pgid
  liveness probe) is needed for the `nx --no-tui`-style detach case; tier 1 by itself cannot and should not
  catch it.

**Verdict: proceed.** Both the source and the live probe agree with the proposal's hypothesis; nothing here
blocks building `pty_foreground_state` / the combined running signal on `process_group_leader()`.

## Ctrl+C escalation policy (task 6.3)

**Decision: a single SIGINT, no automatic escalation to SIGTERM/SIGKILL on a repeat press.**

Rationale:
- `killpg(pgid, SIGINT)` is proven to *reach* a captured detached group — Stop/⌘Q already signal the same
  group (via `group_teardown`) and are known to reap it. The open question was never reachability, it was
  "does the target treat SIGINT as a clean stop" — and that's a property of the target process, not
  something Aurora should second-guess by auto-escalating.
- Escalating automatically would change what a second Ctrl+C press *means* (first press = ask nicely,
  second = force-kill) without the user asking for a harder kill — that's a surprising, non-standard
  keybinding semantic for a shell. A real terminal's Ctrl+C is "send SIGINT again"; Aurora keeps that
  invariant. If SIGINT alone doesn't stop a given server, the user still has the existing, explicit "Stop"
  control (`stopServers` / the Servers tab) which already does the proven SIGHUP→SIGKILL sequence.
- Keeps the mental model simple and matches the "reuse, don't invent" instruction: one code path
  (`pty_signal_server`, a single `killpg(pgid, signal)`), no new timers/state for a grace-period escalation.

If real-world testing (phase 7, manual) shows a specific tool (e.g. some framework's dev-server wrapper)
ignoring a single SIGINT, escalation can be added later as a scoped follow-up — not assumed now.

## Known follow-ups (post-review, 2026-07-01)

A code review of the implemented feature found five issues. #1 (capture clobbered by a resubmit), #2
(unconditional map re-allocation on every poll tick) and #4 (unvalidated `signal` passed to `killpg`) were
fixed directly — see `pty_capture_server_pgid`'s `should_rearm` guard + the `serverStatus[ptyId] !== "alive"`
front-end guard in `runInShell` (keymap.ts), the no-op equality checks in `setServerStatus`/`setForegroundState`
(store.ts), and `is_allowed_server_signal` in `pty_signal_server` (pty.rs). Two remaining findings are
deliberately left as documented follow-ups rather than fixed now:

**#3 — TOCTOU on a recycled pgid.** `pty_signal_server` and `pty_server_status` both re-check
`killpg(pgid, 0) == 0` immediately before acting, closing *most* of the window, but there's an
irreducible gap: the OS is free to recycle a pgid between that liveness check and the very next syscall
(the actual `killpg(pgid, signal)`), and — in the pathological case — reassign it to an unrelated process
that happens to share the pgid. This is bounded (pgid reuse requires the whole process group to have
fully exited and the kernel's pid/pgid space to wrap back around to that exact number in a ~microsecond
window) and has no simple fix: the real fix is tracking the shell's `(pid, start_time)` pair (or a
`pidfd`/kqueue-based handle) instead of a bare `i32` pgid, which is a materially bigger change (new state,
new liveness primitive, portable-pty doesn't expose start_time) than this feature's scope. Not fixed here;
flagged for a future "robust process identity" pass if it's ever observed in practice (it hasn't been).

**#5 — Ctrl+C can route off a poll snapshot that's up to ~1.5 s stale.** `routeCtrlC` (keymap.ts) decides
whether to send a raw `\x03` or a targeted `killpg(pgid, SIGINT)` based on `foregroundState`/`serverStatus`,
which are only refreshed once per poll tick. If the foreground state changes between ticks (e.g. a detached
server exits right as the user hits Ctrl+C, or a new foreground child takes over), the routing decision can
be briefly wrong. Mitigated by: (a) the prompt-blocking behavior (`Pane.tsx`'s `running` gate) already keeps
the input away from the shell while something is running, so most stray Ctrl+C presses land on an actively
displayed "running" pane, not an idle one; (b) `pty_signal_server`'s own fresh liveness re-check (the #3
guard) means a stale-but-now-dead pgid is never actually signalled — worst case is a harmless no-op
"couldn't reach it" notice, never a false "stopped" or a signal to the wrong target. No code change made
here; the same review also asked for an optimistic "block the prompt through the first poll tick after a
submit" fix for the closely-related flicker below, evaluated and deferred for the same reason (see next).

**Flicker: the prompt can reappear for up to ~1.5 s between a server's detach and the next poll tick.**
When a command detaches (e.g. `nx serve --no-tui` backgrounding after ~120 ms), the shell's OSC-133;D marker
fires almost immediately (`Terminal.tsx`), flipping tier 3 (`block.running`) to `false` right away — but
tier 1 (`foregroundState`) and tier 2 (`serverStatus`) only catch up on the next `ensurePtyPoll` tick (up to
1.5 s later, and the Rust-side capture sampler itself needs its own ~120 ms `SHELL_SETTLE` debounce before
tier 2 even has a pgid to report "alive"). In that window `paneRunning()` can briefly return `false`, so the
prompt reappears then disappears again — the exact user-visible bug this feature targets, just narrowed
from "permanently wrong" to "briefly wrong".

Considered and NOT applied: firing an extra one-off `pty.foregroundState`/`pty.serverStatus` probe on a
fixed short delay right after `runInShell` submits a command. Rejected because it doesn't actually close the
gap — the Rust capture sampler's own `SHELL_SETTLE` debounce (120 ms, chosen deliberately in phase 0/1 so a
`build && serve` chain's brief inter-job shell window doesn't freeze the capture on `build`'s pgid instead of
`serve`'s) means `serverStatus` can still legitimately be `"capturing"` rather than `"alive"` at any fixed
delay short enough to be worth adding. A correct fix needs either an event-driven signal from the Rust
sampler (push, not poll — a real behavior change with more surface to test in this pass) or shortening
`SHELL_SETTLE` (which reopens the `build && serve` premature-freeze regression phase 0/1 exists to prevent).
Given the capture itself is never lost now (issue #1's fix), a stray Ctrl+C during the flicker window still
reaches the right target once the next tick lands; the residual harm is purely a cosmetic prompt flash.
Left as a follow-up for a push-based (event `pty:server-captured`) redesign of the poll, out of scope here.
