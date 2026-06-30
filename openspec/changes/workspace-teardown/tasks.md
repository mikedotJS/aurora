<!-- BUILD teardown. Order: Rust process-group core first (the real fix), then the Rust safety/branch
     commands, then the TS orchestrator + store rename, then the rail affordance, then verification.
     Implementer: keep `cargo check` and `bun run build` green after each numbered section.
     Line numbers are anchors at authoring time (pre-edit); confirm before editing. -->

## 1. Rust — capture the shell's process group

- [x] 1.1 `src-tauri/Cargo.toml`: add `libc = "0.2"` to `[dependencies]` (already transitive via
  `portable-pty`; `Cargo.lock` has `libc 0.2.186`). Run `cargo check` to confirm it resolves.
- [x] 1.2 `src-tauri/src/pty.rs`: add `shell_pgid: Option<i32>` to `struct PtySession` (`:19-23`).
- [x] 1.3 `src-tauri/src/pty.rs`: in `pty_spawn`, capture the pid **before** `child` is moved into the
  waiter thread — after `let mut child = pair.slave.spawn_command(cmd)?` (`:100`) add
  `let shell_pgid = child.process_id().map(|p| p as i32);` (the `Child::process_id` trait method;
  == pgid because portable-pty `setsid()`s the child). Set it on the `PtySession` built at `:142-149`.

## 2. Rust — the process-group teardown helper

- [x] 2.1 `src-tauri/src/pty.rs`: add a free helper
  `fn group_teardown(shell_pgid: Option<i32>, fg_pgid: Option<i32>)`:
  - collect the distinct, valid pgids: each `Some(p)` where `p > 1` and `p != unsafe { libc::getpgrp() }`;
  - `unsafe { libc::killpg(p, libc::SIGHUP); }` for each (graceful: shell hangs up + forwards HUP to
    its jobs; direct HUP to the foreground job group);
  - spawn a detached `std::thread` that `std::thread::sleep(Duration::from_millis(2000))` then
    `unsafe { libc::killpg(p, libc::SIGKILL); }` for each (hard cleanup of stragglers).
- [x] 2.2 `src-tauri/src/pty.rs`: rewrite `pty_kill` (`:194-200`) to, on `remove(&id)`:
  read `let fg = session.master.process_group_leader();` (foreground pgid via `tcgetpgrp`, the
  `MasterPty` trait method) **before** signalling; call `group_teardown(session.shell_pgid, fg)`;
  fall back to `session.killer.kill()` only when `session.shell_pgid.is_none()`; then let `session`
  drop (closes the master). Do **not** call `killer.kill()` in the graceful path.
- [x] 2.3 Verify: `cargo check` is green; a manual run — start `sleep 600 &` (or a real `vite` dev
  server) in a pane, close the pane, confirm via `ps` the child is gone within the grace window
  (was: orphaned).

## 3. Rust — kill everything on app quit

- [x] 3.1 `src-tauri/src/pty.rs`: add `impl PtyManager { pub fn kill_all(&self) { … } }` that
  `std::mem::take`s the sessions map, then **once**: SIGHUPs every `(shell_pgid, fg)` group,
  `std::thread::sleep(Duration::from_millis(300))`, SIGKILLs every group. Read each session's `fg`
  via `master.process_group_leader()` before signalling. Keep it bounded (single sleep, not per
  session) so quit stays fast.
- [x] 3.2 `src-tauri/src/lib.rs`: change `.run(tauri::generate_context!())` (`:67`) to
  `let app = tauri::Builder…build(tauri::generate_context!()).expect(…);` then
  `app.run(|handle, event| { if let tauri::RunEvent::ExitRequested { .. } = event {
  handle.state::<pty::PtyManager>().kill_all(); } });`. Confirm at impl that `ExitRequested` is the
  right variant and that we do **not** call `api.prevent_exit()`.
- [x] 3.3 Verify: `cargo check` green; quitting the app (⌘Q) leaves no `node`/dev-server child of the
  former app process (`ps` before/after).

## 4. Rust — git safety + optional branch delete commands

- [x] 4.1 `src-tauri/src/git.rs`: add
  `#[tauri::command] pub fn git_worktree_safety(dir: String) -> Result<Safety, String>` returning
  `struct Safety { dirty: bool, ahead: u32, has_upstream: bool }` (derive `Serialize`):
  - `dirty` = `git status --porcelain` (in `dir`) yields a non-empty result;
  - `git rev-list --count @{upstream}..HEAD` → on success `has_upstream=true`, `ahead=` parsed count;
    on error (no upstream) `has_upstream=false`, `ahead=0`. Reuse the existing `git(dir, &[…])` helper.
- [x] 4.2 `src-tauri/src/git.rs` (optional): add
  `#[tauri::command] pub fn git_branch_delete(root: String, branch: String, force: bool) -> Result<(), String>`
  → `git(&root, &["branch", if force {"-D"} else {"-d"}, &branch]).map(|_| ())`.
- [x] 4.3 `src-tauri/src/lib.rs`: register `git::git_worktree_safety` (and `git::git_branch_delete`)
  in `generate_handler!` (`:18-66`). `cargo check` green.

## 5. TS — store rename + worktree bridge

- [x] 5.1 `src/state/store.ts`: rename `archiveWorkspace` → `removeWorkspace` — interface (`:277`) and
  impl (`:681-691`). Body unchanged (guard `length <= 1`, filter out, re-point `activeWs`,
  `savePersisted`). `grep -rn "archiveWorkspace" src` returns nothing afterward.
- [x] 5.2 `src/lib/worktree.ts`: make `worktreeRemove` surface failure — return
  `Promise<{ ok: true } | { ok: false; error: string }>` (or add `worktreeRemoveStrict`). Update the
  sole existing caller `src/lib/create.ts:237` (rollback) to ignore the result as before.
- [x] 5.3 `src/lib/worktree.ts`: add `worktreeSafety(dir): Promise<{ dirty: boolean; ahead: number;
  hasUpstream: boolean }>` invoking `git_worktree_safety`, and (optional) `gitBranchDelete(root,
  branch, force): Promise<void>` invoking `git_branch_delete`.

## 6. TS — the deleteWorkspace orchestrator

- [x] 6.1 `src/lib/teardown.ts` (**new**): `export async function deleteWorkspace(id: string, opts?:
  { deleteBranch?: boolean }): Promise<{ ok: true } | { ok: false; error: string }>`:
  1. snapshot `w` from `useStore.getState()`; absent → `{ ok: false, error }`.
  2. guards: `workspaces.length <= 1` → `{ ok: false, error: "keep at least one workspace" }`;
     `worktreeBacked = w.repoId != null && w.dir !== w.repoId`.
  3. collect non-null `ptyId` across `w.tabs[].panes[]`; `await Promise.all(ids.map((p) =>
     pty.kill(p)))`.
  4. if `worktreeBacked`: `const r = await worktreeRemove(w.repoId!, w.dir, true);` on `!r.ok` →
     return the error **without** dropping the store entry (no orphan).
  5. if `opts.deleteBranch && w.branch && worktreeBacked`: `await gitBranchDelete(w.repoId!,
     w.branch, true)` (best-effort; log on failure).
  6. `useStore.getState().removeWorkspace(id)`; return `{ ok: true }`.
- [x] 6.2 Verify: `bun run build` (tsc strict) green; unit-reason through the manual-lane path
  (`repoId == null`) — no `worktreeRemove`, PTYs killed, entry dropped.

## 7. TS — the rail delete affordance

- [x] 7.1 `src/components/WorkspaceRail.tsx` (`WorkspaceCard`, `:28-136`): add a hover-revealed trash
  control top-right (`position:absolute`), `onClick` with `e.stopPropagation()`. Reveal on card
  hover (local `useState` or CSS), and **hide** it when `useStore.getState().workspaces.filter(w=>…)
  .length <= 1` (last) or when the card is the main checkout (`ws.dir === ws.repoId`).
- [x] 7.2 `src/components/WorkspaceRail.tsx`: the trash handler:
  - if `worktreeBacked`: `const s = await worktreeSafety(ws.dir);` build a `window.confirm` message —
    base `Delete workspace "${ws.title}" (${ws.branch})? Its worktree and running servers will be
    removed.` plus, when `s.dirty`, `\n\n⚠ uncommitted changes will be lost` and, when `s.ahead > 0`,
    `\n⚠ ${s.ahead} unpushed commit(s) will be lost`;
  - manual lane / main checkout: a lighter confirm ("Close workspace …? Running servers will be
    stopped.");
  - on confirm → `await deleteWorkspace(ws.id)`; on `{ ok: false }` → `useStore.getState().notify(…)`
    (or inline error). (Optional) a second confirm / checkbox to pass `{ deleteBranch: true }`.
- [x] 7.3 Verify: `bun run build` green; ESLint clean (`bunx eslint .`).

## 8. Verification

- [x] 8.1 `cd src-tauri && cargo check` is green (libc + new commands + exit handler compile).
- [x] 8.2 `bun run build` (Vite + tsc strict) green; `bunx eslint .` clean.
- [ ] 8.3 Process-group kill, foreground job: in a worktree workspace run a real dev server
  (`bun run dev` / `nx serve`), note its PID + a child PID via `ps`, delete the workspace, confirm
  **both** are gone within the grace window and the listening port is freed (`lsof -i`).
- [ ] 8.4 Worktree removed: after delete, `git worktree list` in the repo no longer lists the dir and
  `.aurora-worktrees/<repo>/<leaf>` is gone.
- [ ] 8.5 Guards: the trash control is absent on the **last** workspace and on the **main checkout**;
  deleting a **dirty** worktree shows the uncommitted/unpushed warning and aborts on cancel.
- [ ] 8.6 App quit: with a dev server running in a workspace, ⌘Q Aurora and confirm via `ps`/`lsof`
  the server process is gone and the port freed (was: leaked).
- [x] 8.7 `openspec validate workspace-teardown --strict` passes.
