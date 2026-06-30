# Tasks — workspace-run-servers

Phases 1–6 (front-side v1) are built. Phase 7.2 gates passed; 7.3 manual smoke is **reopened** because the
runtime evidence (detached servers — see `design.md` Context + D7/D8) refuted the original block-derived
liveness and pane-only kill. Phases 8–10 add the reliability work: capture the real server process group,
probe it for liveness, and kill it on Stop/⌘Q. Sequenced so each phase compiles/typechecks on its own.

**Reviser before coding:** D3 (state) and D4 (Stop) in `design.md` are rewritten; D7 (capture) and D8
(liveness probe + poll) are new. The "zero Rust" framing in phases 1–6 no longer holds.

## 1. Identify the servers (`src/lib/ports.ts`)

- [x] 1.1 Add `portScripts(scripts: PortScript[]): PortScript[]` returning the scripts that have ≥1 task whose
      `cmd` matches `/\$\(\((\d+)\s*\+\s*AURORA_PORT_OFFSET\)\)/` (same family as `parseDerivedPorts`). Pure,
      no store/Tauri imports. A script that binds two ports appears **once** (it is one server).
- [x] 1.2 Keep `parseDerivedPorts` (per-port chips) unchanged — `portScripts` is the per-server view; both
      derive from the same `PortScript[]` input.

## 2. Store: track the dedicated server tab (`src/state/store.ts`)

- [x] 2.1 Add `serverTabId: number | null` to the `Workspace` interface. Default to `null` in `newWorkspace`
      and `rehydrate`. Do **not** add it to `PersistedWs` / `savePersisted` (runtime-only; restored
      workspaces come back with servers down).
- [x] 2.2 Add action `prepareServerTab(wsId: string, n: number): void`. It SHALL: (a) if `serverTabId` is set
      and that tab still exists, remove it first (state only — PTY kills happen in the orchestrator before
      this call); (b) append a fresh `Group` to that workspace built at `ws.dir` / `ws.repoId` with
      `min(4, max(1, n))` panes (reuse `newGroup` + the multi-pane pattern from `newWorkspace`, `split: "h"`);
      (c) set the workspace `active` to the new tab and record its group id in `serverTabId`. Operates on the
      given `wsId` (not necessarily the active workspace).
- [x] 2.3 Add action `dropServerTab(wsId: string): void` that removes the group whose id === `serverTabId`
      from that workspace, fixes the `active` index (clamp like `closeTab`), and clears `serverTabId`. Guard:
      never drop the workspace's last remaining tab.
- [x] 2.4 Confirm `patchPane`/`patchActiveWs` reactivity: a block change inside a server pane already produces
      a new workspace ref (via `patchPane`), so a `WorkspaceContextBar` subscribed to `activeWorkspace`
      re-renders when `running` flips. (No code — verification note.)

## 3. Run one server per pane (`src/lib/scripts.ts`)

- [x] 3.1 Add `runServerScript(paneId: number, name: string, opts: { lookupRoot: string; execBase: string }):
      void` that runs a script's tasks **chained with `&&`** in the single given pane via the existing
      `runWhenReady` + `taskCmd(execBase, …)` logic — i.e. the non-split branch of `runScript`, with the
      script's own `split` flag **ignored** (the server is the pane). Reuse the private helpers; do not
      duplicate the chain logic.

## 4. Orchestrator (`src/lib/servers.ts`, new)

- [x] 4.1 `serversUp(ws: Workspace): boolean` — pure selector: `ws.serverTabId != null` AND a tab with that id
      exists AND at least one of that tab's panes has a last block with `running === true`. No store reads
      (takes the workspace), so it is unit-testable.
- [x] 4.2 `runServers(wsId: string): void` — resolve the workspace + its repo scripts
      (`userScripts[ws.repoId]`); compute `servers = portScripts(scripts)`. If empty, no-op. If a server tab
      is already live, no-op (focus it). Otherwise: if a stale server tab exists, kill its panes' PTYs
      (`pty.kill`) then `dropServerTab`; call `prepareServerTab(wsId, servers.length)`; read back the new
      server tab's panes from fresh state; for each `i < min(4, servers.length)` call
      `runServerScript(panes[i].id, servers[i].name, { lookupRoot: ws.repoId!, execBase: ws.dir })`. Mirror
      `create.ts`'s `lookupRoot`/`execBase` indirection (scripts defined on the main checkout, run in the
      worktree).
- [x] 4.3 `stopServers(wsId: string): void` — resolve the server tab; collect its panes' non-null `ptyId`s;
      `await Promise.all(ptyIds.map(pty.kill))` (the same primitive `teardown.ts` uses); then
      `dropServerTab(wsId)`. No-op when `serverTabId` is null. Do **not** touch the worktree or call
      `removeWorkspace`.
- [x] 4.4 Guard the >4 case: if `servers.length > 4`, start the first 4 and surface the remainder (e.g. a
      `notify`), never throw. (Documented cap; honest partial start.)

## 5. The Run/Stop control (`src/components/WorkspaceRail.tsx`)

- [x] 5.1 In `WorkspaceContextBar`, compute `servers = portScripts(scripts)` and `up = serversUp(ws)`. Render
      the control **only when `servers.length > 0`**, next to the port chips (inside the `hasOffset` block,
      after the chips). Wire onClick to `up ? stopServers(ws.id) : runServers(ws.id)`.
- [x] 5.2 Toggle presentation: Run state shows a "play" affordance + label (e.g. ▶ Run); up state shows a
      "stop" affordance + label (e.g. ■ Stop). Keep it a placeholder style here and hand the final visuals
      (glyphs, color, hover, placement relative to chips) to the **designer** (`/frontend-design`) — match the
      existing chip/`PortIcon` treatment.
- [x] 5.3 Accessibility: `type="button"`, `aria-label` reflecting the action ("Run servers" / "Stop servers")
      and `title` with the server count.

## 6. Tests (`__tests__/runServers.test.ts`, `bun:test`)

- [x] 6.1 `portScripts`: a script with `$((3000 + AURORA_PORT_OFFSET))` is a server; one binding two ports is
      **one** entry; a script with no offset port is excluded; empty input → empty.
- [x] 6.2 `serversUp`: false when `serverTabId` null; false when the tab id no longer exists; false when all
      server panes' last blocks are `running:false`; true when at least one is `running:true`. Build minimal
      `Workspace`/`Group`/`PaneState`/`Block` fixtures.
- [x] 6.3 Mapping/cap: with `k` port-scripts, `runServers` requests `min(4, k)` server panes; with `k>4` it
      starts 4 and does not throw. (Drive via the store + mocked `pty`, in the style of
      `__tests__/teardown.test.ts` / `portIsolation.test.ts`.)
- [x] 6.4 Stop: `stopServers` calls `pty.kill` for each server pane's `ptyId` and then `dropServerTab`, and
      leaves the workspace + its other tabs intact (assert no `worktreeRemove`/`removeWorkspace`).
- [x] 6.5 Idempotence: `runServers` while a live server tab exists does not open a second tab; `runServers`
      after the server blocks are marked done clears the stale tab and opens a fresh one.

## 7. Validation

- [x] 7.1 Walk each spec scenario against the implementation: control visibility gated on `portScripts`;
      one-pane-per-server split; toggle reflects `serversUp`; crash returns to Run; Stop kills + keeps the
      workspace; Stop no-op when down; Run idempotent/self-heal; per-workspace isolation on switch; ⌘Q reaps
      (servers run in panes); only saved scripts run; no secret touched.
- [x] 7.2 `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run build` clean.
- [ ] 7.3 Manual smoke in the real app (`tester` via `/run`): a repo with two port-scripts → Run opens a
      two-pane split with both servers up and the toggle on Stop; kill one server in its pane → toggle returns
      to Run after both stop; Stop → servers gone, workspace + working tab intact; switch workspace mid-run →
      the other workspace's servers keep running; ⌘Q → no orphaned `node`/`vite` processes.

## 8. Rust: capture, probe, and kill the real server process group (`src-tauri/src/pty.rs`, `lib.rs`)

- [x] 8.1 Add a per-session capture field to `PtySession`: `server: ServerCapture` where
      `enum ServerCapture { Idle, Pending, Failed, Found(i32) }`, default `Idle`. Add a helper
      `ServerCapture::found(&self) -> Option<i32>` (Some only for `Found`). Set `server: ServerCapture::Idle`
      at every `pty_spawn` insert.
- [x] 8.2 Add `#[tauri::command] pty_capture_server_pgid(app: AppHandle, manager: State<PtyManager>, id: String)
      -> Result<(), String>`. Under the lock: if the session exists, set `server = Pending` and read its
      `shell_pgid`. Spawn a sampler thread that, every ~40 ms for up to ~8 s, re-locks the manager, looks up
      the session by `id` (stop if gone), reads `master.process_group_leader()`, and if it is `Some(p)` with
      `p > 1` and `Some(p) != shell_pgid`, sets `server = Found(p)` and stops; on timeout sets `server =
      Failed`. Brief lock hold per sample (read fg, drop lock, sleep) to avoid contending with `pty_write`.
      Returns immediately (fire-and-forget).
- [x] 8.3 Add `#[tauri::command] pty_server_status(manager: State<PtyManager>, id: String) -> Result<String,
      String>` returning: no session → `"dead"`; `Pending` → `"capturing"`; `Found(p)` → `killpg(p, 0)` via
      `libc` then inspect `std::io::Error::last_os_error().raw_os_error()`: success or `EPERM` → `"alive"`,
      `ESRCH` → `"dead"`; `Failed`/`Idle` → `"uncaptured"`. `killpg(p, 0)` sends no signal — existence check
      only.
- [x] 8.4 Generalize `group_teardown` to take the full set of pgids
      (`fn group_teardown(pgids: &[Option<i32>])`, keeping the `p > 1` && `p != getpgrp()` guards and the
      2 s SIGHUP→SIGKILL grace). Update `pty_kill` to call it with
      `&[session.shell_pgid, fg, session.server.found()]` — so killing a server pane also signals its captured
      group.
- [x] 8.5 Extend `PtyManager::kill_all`: in the per-session loop, add `s.server.found()` to the set of pgids
      collected for SIGHUP/SIGKILL — so ⌘Q reaps captured detached groups (the orphan fix). No new wiring in
      `lib.rs`'s run-loop (it already calls `kill_all` on `ExitRequested`/`Exit`).
- [x] 8.6 Register `pty::pty_capture_server_pgid` and `pty::pty_server_status` in `lib.rs`
      `generate_handler!`. Confirm `cargo build` clean.

## 9. Front: liveness wiring + poll loop (`term/pty.ts`, `lib/scripts.ts`, `lib/servers.ts`, `state/store.ts`)

- [x] 9.1 `term/pty.ts`: add `captureServerPgid(id: string): Promise<void>` → `invoke("pty_capture_server_pgid",
      { id })`, and `serverStatus(id: string): Promise<ServerStatus>` →
      `invoke<ServerStatus>("pty_server_status", { id })` where
      `type ServerStatus = "capturing" | "alive" | "dead" | "uncaptured"`.
- [x] 9.2 `state/store.ts`: add a runtime-only `serverStatus: Record<string, ServerStatus>` (keyed by ptyId),
      defaulted `{}`, **not** in `PersistedWs`/`savePersisted`; add `setServerStatus(ptyId, s)` and
      `clearServerStatus(ptyIds: string[])`. In `dropServerTab`, clear `serverStatus` for the removed tab's
      pane ptyIds.
- [x] 9.3 `lib/scripts.ts`: thread an optional `onLaunched?: (ptyId: string) => void` through `runServerScript`
      and `runWhenReady`, invoked right after `send(pane, cmd)` with `pane.ptyId`. Do not change existing
      callers (default undefined).
- [x] 9.4 `lib/servers.ts`: in `runServers`, pass `onLaunched: (ptyId) => { pty.captureServerPgid(ptyId);
      ensureServerPoll(); }` to each `runServerScript`, and call `ensureServerPoll()` after launch.
- [x] 9.5 `lib/servers.ts`: change `serversUp(ws)` → `serversUp(ws, status?: Record<string, ServerStatus>)`
      per D3 (status optional → existing tests unchanged; when present, `alive`/`capturing` → up, `dead` → not
      up, `uncaptured`/absent → fall back to the pane's last block `running`). Update the `WorkspaceContextBar`
      call site to pass `useStore(s => s.serverStatus)`.
- [x] 9.6 `lib/servers.ts`: add `ensureServerPoll()` — a single module-level `setInterval(~1500 ms)` that runs
      only while some workspace has a `serverTabId`; each tick probes every server pane's `ptyId` via
      `pty.serverStatus` and writes `setServerStatus`. Stops (clearInterval) when no server tab remains. Guard
      against overlapping ticks.
- [x] 9.7 `lib/servers.ts`: update the stale-tab detection in `runServers` and the post-Stop cleanup to use the
      new liveness (`serversUp(ws, status)`) instead of the raw block flag. `stopServers` clears
      `serverStatus` for the dropped panes.

## 10. Tests for the reliability work (`__tests__/runServers.test.ts`, `bun:test`)

- [x] 10.1 `serversUp(ws, status)` matrix: `alive` → up; `capturing` → up (no flash); `dead` → down;
      `uncaptured` → falls back to block `running`; status `undefined` for a ptyId → falls back to block
      `running` (back-compat with the existing 6.2 fixtures).
- [x] 10.2 Capture trigger: `runServers` calls `pty.captureServerPgid(ptyId)` once per launched server pane
      (mock the pty leaf; assert one call per pane with its ptyId).
- [x] 10.3 Poll loop: `ensureServerPoll` starts on Run, calls `pty.serverStatus` for each server pane and
      writes `setServerStatus`; flips `serversUp` to false once all panes read `"dead"`; clears the interval
      when no server tab remains. Tested via globalThis.setInterval interception (fake-timer approach).
- [x] 10.4 `stopServers` clears `serverStatus` for the dropped panes and (via the unchanged `pty.kill` path)
      still requests a kill per server pane.
- [x] 10.5 Rust: `killpg`/`tcgetpgrp` capture cannot be meaningfully unit-tested without real child processes;
      validate the capture+probe+kill path in the smoke (7.4). Keep `cargo build` clean as the compile gate.

## 11. Reliability validation

- [x] 11.1 `bun test`, `bun run lint`, `bunx tsc --noEmit`, `cargo build`, and `bun run build` clean.
      Results: 138 pass / 0 fail · lint clean · tsc clean · cargo build 0 errors · vite build ok.
- [ ] 11.2 Manual smoke — **the proven detached case** (`tester` via `/run`): a repo whose port-script uses a
      detaching launcher (nx/turbo) that returns the prompt. Run → toggle shows **Stop** and stays on Stop even
      after the prompt returns; confirm via `lsof`/`ps` the server pgid is alive and the port is bound; Stop →
      the server pgid is gone and the port is freed (no orphan); Run again → fresh start; crash the server
      externally → toggle returns to **Run** within ~1.5 s; ⌘Q while running → `ps` shows no orphaned server
      process and the port is free. Record actual pids/pgids/ports observed.
