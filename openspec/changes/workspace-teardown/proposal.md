<!-- BUILD teardown — movement #3 of 4 in the Workspaces recovery roadmap (docs/workspaces-reprise-roadmap.md).
     CUT (#1) and UNIFY (#2) are applied. This change builds the reversible, first-class teardown:
     a process-GROUP kill (not just the shell) + a wired delete action + destructive guards + a rail
     affordance. Port isolation (#4) is a separate, later change. -->

## Why

Aurora can **create** workspaces but cannot **tear them down**. The result is the worst trap in the
flow (papercut audit verdict, `docs/workspaces-ux-papercuts.md` lines 16, 23, 51-53): worktrees and
**dev servers accumulate** with no in-app way to stop them — the "chauffe".

Two concrete, verified defects feed it:

- **`pty_kill` only kills the shell, not its process group.** The shell is spawned as a session
  leader (`portable-pty` calls `setsid()` in its `pre_exec`, confirmed in
  `portable-pty-0.8.1/src/unix.rs:220`), so its `pid == pgid == sid`. But `pty_kill`
  (`src-tauri/src/pty.rs:194-200`) calls `killer.kill()`, which sends **SIGKILL to the shell pid
  only**. Children the shell spawned (an `nx`/`vite`/`node` dev server, which an interactive zsh with
  job control places in its **own** foreground process group) are never signalled. SIGKILLing the
  shell also denies zsh any chance to HUP its own jobs. The dev server is orphaned and keeps running
  (and keeps the CPU/port busy). `pty_kill` is also only ever invoked on **Terminal unmount**
  (`src/components/Terminal.tsx:310`) — never on a workspace teardown, and there is **no app-quit
  handler at all** (no `RunEvent`/window handler exists in `src-tauri/src/lib.rs`), so quitting Aurora
  leaks every running server.
- **No teardown action is wired.** `archiveWorkspace` (`src/state/store.ts:681-691`) removes a
  workspace from the store array (it does **not** archive — the `archived` flag is never set) but has
  **no caller** (confirmed by grep: only its interface + impl), kills no process, and removes no
  worktree. `worktreeRemove` exists (`src/lib/worktree.ts:30`) but is called **only on create
  rollback** (`src/lib/create.ts:237`). The `.aurora-worktrees/` tree grows without bound.

This change makes teardown a first-class, reversible-by-intent operation: stop the **whole process
group**, remove the **worktree**, drop the workspace, re-point the active one — behind destructive
guards so it can never nuke the main checkout, the last workspace, or unsaved/unpushed work silently.

## What Changes

### Backend (`src-tauri/`) — the core: kill the process **group**

- **Capture the shell's pgid at spawn.** In `pty_spawn` (`pty.rs:100`), read `child.process_id()`
  (the `Child` trait method, `portable-pty-0.8.1/src/lib.rs:137`) **before** the child is moved into
  the waiter thread; store it on `PtySession` as `shell_pgid: Option<i32>` (== pgid, via setsid).
  Keep the existing `master` on the session (already stored) so teardown can also read the **current
  foreground job's** pgid via `master.process_group_leader()` (`lib.rs:107` → `tcgetpgrp`).
- **Tear down the group, gracefully then hard.** New private helper `group_teardown(shell_pgid,
  fg_pgid)`:
  1. `libc::killpg(pgid, SIGHUP)` to the shell group **and** (when different) the foreground-job
     group. SIGHUP because interactive zsh ignores SIGTERM but acts on SIGHUP — and on a HUP exit
     zsh forwards SIGHUP to **all** its jobs, covering background jobs the foreground-pgid signal
     misses.
  2. spawn a detached grace thread: sleep ~2s, then `libc::killpg(pgid, SIGKILL)` to both groups for
     any straggler in the shell's own group.
  - Guard every call with `pgid > 1` and `pgid != getpgrp()` so we never signal init or Aurora's own
    group. Drop the immediate `killer.kill()` from the graceful path (it would pre-empt zsh's HUP
    forwarding); keep `killer` only as the fallback when `shell_pgid` is `None`.
- **Rewire `pty_kill`** to call `group_teardown` (capture `fg_pgid` *before* signalling), then drop
  the session (closing the master, which itself raises a kernel SIGHUP to the foreground group).
- **Kill everything on app quit.** Add `PtyManager::kill_all()` that drains all sessions and, once,
  SIGHUPs every group, sleeps a short bounded interval (~300ms), then SIGKILLs every group. Wire it
  from a Tauri exit handler: build the app, then `app.run(|handle, event| …)` and on
  `RunEvent::ExitRequested` call `handle.state::<PtyManager>().kill_all()` (`lib.rs:67`). Do not
  prevent exit.
- **Add `libc = "0.2"`** to `src-tauri/Cargo.toml` `[dependencies]` (already transitive via
  `portable-pty`; lock has `libc 0.2.186`) for `killpg` / `getpgrp` / `SIGHUP` / `SIGKILL`.
- **New command `git_worktree_safety(dir)`** → `{ dirty, ahead, has_upstream }`: `dirty` from
  `git status --porcelain` (non-empty), `ahead`/`has_upstream` from `git rev-list --count
  @{upstream}..HEAD` (no upstream → `has_upstream=false`, `ahead=0`). Powers the destructive confirm.
- **Optional new command `git_branch_delete(root, branch, force)`** → `git branch -D` run in the main
  root, for the opt-in "also delete the branch" path. Must run **after** the worktree is removed (git
  refuses to delete a branch still checked out in a worktree). Register both in the `lib.rs`
  invoke_handler.

### Frontend (`src/`) — wire the action + the affordance

- **New orchestrator `src/lib/teardown.ts` → `deleteWorkspace(id, opts?)`** (mirrors `runCreate` in
  `create.ts`; the store stays synchronous, the async sequence lives in a lib). Strict order:
  1. Snapshot the workspace; if absent → `{ ok: false }`.
  2. **Guards**: refuse when it is the **only** workspace; treat `repoId == null` (manual lane) or
     `dir === repoId` (the **main checkout**) as *non-worktree-backed* → never call `worktreeRemove`
     for those.
  3. **Kill all PTYs**: collect every non-null `ptyId` across `w.tabs[].panes[]` and
     `await Promise.all(ids.map(pty.kill))` (this fires the Rust group teardown).
  4. **Remove the worktree** (worktree-backed only): `worktreeRemove(repoId, dir, /*force*/ true)`.
     Force because a dev server mid-HUP may still hold the cwd; on macOS the dir unlink still
     succeeds. Surface failure (see decision below).
  5. **Optional branch delete**: when `opts.deleteBranch` and the workspace has a branch →
     `gitBranchDelete(repoId, branch, true)`.
  6. **Drop from store + re-point active**: call the renamed `removeWorkspace(id)` action.
- **Rename `archiveWorkspace` → `removeWorkspace`** in the store (interface + impl). It removes (never
  archived), has no caller today, and the honest name matches what `deleteWorkspace` needs as its
  final step. Behaviour unchanged: filter out, re-point `activeWs` to a neighbour, `savePersisted`.
- **`worktreeRemove` surfaces its result.** Today it swallows errors (`.catch(() => undefined)`). Add
  an error-returning path (or a `worktreeRemoveStrict`) so `deleteWorkspace` can report a failed
  removal instead of silently orphaning a directory.
- **Rail affordance** (`src/components/WorkspaceRail.tsx`, `WorkspaceCard`): a hover-revealed trash
  control (top-right, `stopPropagation` so it does not switch). On click:
  - For worktree-backed cards: `await worktreeSafety(ws.dir)`, then a **`window.confirm`** composing
    the title/branch and a warning when `dirty` (`N uncommitted changes`) or `ahead > 0`
    (`M unpushed commits`). This matches the existing destructive-confirm pattern
    (`window.confirm` in `ChangesView.tsx:110`) — **no Tauri capability change** (`dialog` only has
    `allow-open` today). On confirm → `await deleteWorkspace(ws.id, { deleteBranch })`.
  - Hide the control when it is the **last** workspace or the workspace is not a registered
    secondary worktree (verified via `git worktree list`); closing manual lanes is deferred.

### Key decisions

- **Process **group**, not process. SIGHUP→grace→SIGKILL.** The bug is precisely that the current
  kill targets one pid. Signalling the group (shell pgid) plus the foreground job pgid, starting with
  SIGHUP so zsh forwards the hangup to all its jobs, is what actually reaches the dev server. SIGKILL
  after a grace window guarantees cleanup of anything that ignored HUP.
- **Reuse, don't reinvent.** `master.process_group_leader()` already gives the foreground pgid; the
  shell pid comes free from `child.process_id()`. No process-tree walking, no `/proc` (absent on
  macOS), no `ps` shell-out.
- **Order is load-bearing: kill → remove worktree → drop from store.** Removing the worktree before
  the processes die risks git refusing or fighting open files; dropping the store entry before the FS
  is cleaned orphans the directory with no UI to retry.
- **Confirm-on-dirty over a dead "confirmDelete" knob.** CUT removed the inert `confirmDelete`
  setting. The honest replacement is an *always-on* destructive confirm whose copy escalates with the
  actual git state (uncommitted / unpushed), read live at click time — not a persisted toggle.
- **Never the main checkout or the last workspace.** `git worktree remove` would refuse the primary
  anyway; we also never `rm` it. Keeping ≥1 workspace preserves the existing `length <= 1` invariant
  so the app never has zero panes.
- **Branch deletion is opt-in and off by default.** Deleting a shared/base branch is irreversible and
  rarely wanted at teardown; it is a secondary, explicit choice.

### Non-goals (explicitly NOT in this change)

- **Port isolation** (consuming `AURORA_PORT_OFFSET` / injecting a usable `PORT`, showing the port on
  the card) — that is BUILD movement #4 (`workspace-port-injection`).
- Re-introducing any agent concept (removed in CUT) — none is added.
- A trash/undo bin or soft-archive: "reversible" here means *guarded + confirmed*, not a restore
  queue. Restoring a deleted worktree is out of scope.
- Killing processes that **double-fork / daemonize** and reparent to launchd, or that were explicitly
  `disown`ed off the shell's job table — inherent to Unix process management; documented as a known
  limit, not solved here.
- Windows process-group semantics — Aurora is macOS-only; the unix path is the only target.

## Capabilities

### Added Capabilities
- `workspace-teardown`: a new capability covering process-group teardown of a pane's shell + its
  children, the wired workspace delete (kill → remove worktree → drop), destructive guards
  (last/main-checkout/dirty/unpushed), optional branch deletion, app-quit cleanup, and the rail
  delete affordance.

## Impact

- **Backend (`src-tauri/`)**:
  - `Cargo.toml` — add `libc = "0.2"`.
  - `src/pty.rs` — `PtySession` gains `shell_pgid: Option<i32>`; `pty_spawn` captures
    `child.process_id()`; new `group_teardown` helper + `PtyManager::kill_all()`; `pty_kill` rewired
    to group teardown.
  - `src/lib.rs` — register `git_worktree_safety` (+ optional `git_branch_delete`); switch
    `.run(generate_context!())` to `build(...).run(|handle, event| …)` calling `kill_all()` on
    `ExitRequested`.
  - `src/git.rs` — add `git_worktree_safety` (+ optional `git_branch_delete`), reusing the `git()`
    helper.
- **Frontend (`src/`)**:
  - `lib/teardown.ts` — **new**: `deleteWorkspace` orchestrator.
  - `lib/worktree.ts` — `worktreeRemove` surfaces errors; add `worktreeSafety` + (optional)
    `gitBranchDelete` bridges.
  - `state/store.ts` — rename `archiveWorkspace` → `removeWorkspace` (interface `:277`, impl `:681`).
  - `components/WorkspaceRail.tsx` — trash affordance + confirm in `WorkspaceCard`.
  - `term/pty.ts` — no change (the existing `pty.kill(id)` bridge already maps to the rewired
    `pty_kill`).
- **Persisted data**: none changed. `aurora.workspaces` is rewritten by `savePersisted` after a
  delete (one fewer entry).
- **Capabilities/permissions**: none. `window.confirm` keeps us inside the current `dialog`
  capability (`allow-open` only).
- **Depends on**: CUT (`cut-dead-workspace-surface`) and UNIFY (`unify-workspace-create`) — applied.
- **Hands off to**: BUILD port isolation (`workspace-port-injection`) and the designer for the final
  affordance styling / confirm copy.
