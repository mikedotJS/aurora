## Why

`workspace-port-isolation` made the dev servers' ports **visible** — the context bar above the tab strip
renders a chip per derived port (e.g. `welcomer :3010 · welcomer :4210`). But there is still **no way to
start or stop those servers from that bar**. The user has to remember which scripts are the servers, open a
pane, and run each one by hand; and there is no single affordance that tells them whether the servers are up.

The product source of truth (`docs/workspaces-ux.mmd`) already calls for this:

- `run["Démarre le(s) serveur(s) de dev"]` under **2 · Aurora prépare** and the ready state
  `ready(["Workspace prêt — serveurs up · ports affichés"])`.
- `multi["Plusieurs serveurs ? chacun son port, affiché"]` under **3 · Travailler**.
- `crash["Visible · redémarrable d'un clic"]` as the multi-server crash recovery.
- Principle **4 · État rendu visible** (`pr4`): *port alloué · branche · serveurs up*.

This change materializes the missing control: a single **Run / Stop toggle** sitting next to the port chips,
that boots every port-declaring script (one server = one pane, split when there are several) and stops them
again — without tearing down the workspace.

## Update — Run/Stop reliability (runtime-proven; supersedes the "zero-Rust derived state" plan)

The first cut assumed a server's liveness could be read entirely off the OSC-133 command-block lifecycle
(the `running` flag) and that killing the server pane's process group (shell + current foreground) would stop
the server. **Measured on the real app, both assumptions are false for tools that detach their server** (nx,
turbo, …):

- A split script `api + welcomer` boots `next-server` (pid 71510, binds `:4210`, **pgid 71411**) and a node
  api (pid 71511, binds `:3000`, **pgid 71477**). nx starts each server then **returns the prompt to the
  shell** — the server stays alive in its **own process group** (71411 / 71477), which belongs to **no**
  Aurora pane shell (pane shells have pgids like 71252/71253).
- Consequence 1 — **`serversUp` lies**: the server's block flips to `running:false` when the prompt returns
  (OSC-133 `D`), so the toggle shows **Run** while the server is still up.
- Consequence 2 — **Stop misses the server**: `pty_kill` → `group_teardown(shell_pgid, current_fg)` kills the
  shell group and the *current* foreground (= the shell, once the prompt is back) — **never** 71411/71477.
  Orphaned server, stuck port.
- Consequence 3 — **⌘Q (`kill_all`) misses it too** → orphan survives quit (the exact leak that motivated the
  workspaces chantier).

**Direction (decided by the user — "do it properly, Rust OK"): capture the server's real process group at
launch, probe that group for liveness, and kill that group.** `master.process_group_leader()` (tcgetpgrp of
the PTY master) already exists and is already used by `pty_kill`/`kill_all`; we sample it just after launch to
capture the launch job's foreground pgid (which contains the detached server), register it **in Rust** (so
`kill_all` can reap it on ⌘Q — that path never consults the webview), probe it with `killpg(pgid, 0)`, and add
it to the teardown kill set. See `design.md` D7/D8 and the revised D3/D4.

Bonus observed (deferred, **not** fixed here): the `api` server ignores `--port` and binds `:3000` instead of
`:3010`, so its **port chip is wrong**. That is a script/port-derivation issue (`parseDerivedPorts` trusts the
script text), orthogonal to Run/Stop reliability — noted, not addressed by this change.

## What Changes

- **A Run / Stop toggle in `WorkspaceContextBar`**, rendered **only when the active workspace has at least one
  port-declaring script** (the same scripts that produce the port chips). It is a true toggle: it shows
  **Run** when the servers are down and **Stop** when they are up, reflecting the real runtime state.
- **Run** starts every *port-script* — a saved repo script with ≥1 task whose command contains
  `$((<base> + AURORA_PORT_OFFSET))`. **One port-script = one "server" = one pane.** With several servers the
  panes are split (one per server); with one server, a single pane. Each server runs its script's tasks in
  the workspace's worktree dir, exactly as the create-flow on-open run does (`runScript` with
  `lookupRoot`/`execBase`). The chips stay **per port** — a script binding two ports is still one server in
  one pane, shown as two chips. This is intentional.
- **Stop** terminates those servers (kills their process groups) using the **same primitive workspace
  teardown already uses** (`pty.kill` → `pty_kill` → `group_teardown`, SIGHUP→SIGKILL) — but **without**
  removing the worktree or the workspace.
- **State is the real process group, not a block flag.** Run **captures the server's process group** at
  launch (a bounded Rust sampler reads the PTY's foreground pgid until it differs from the shell) and stores
  it on the session in Rust. "Servers up" is then **probed** with `killpg(pgid, 0)` on a light front poll
  (~1.5 s, only while a server tab exists); a crashed or stopped server's group goes `ESRCH` and the toggle
  returns to **Run** on its own. The OSC-133 `running` flag is kept only as a **fallback** for panes whose
  capture did not resolve.
- **Reliable Stop / ⌘Q.** `pty_kill` and `kill_all` now also signal the **captured** server group (in
  addition to the shell + current-foreground groups), so the detached server is killed — no orphan, no stuck
  port.

Non-goals (this change):
- **Minimal new Rust, not zero.** Two new commands (`pty_capture_server_pgid`, `pty_server_status`) plus small
  edits to `pty_kill`/`kill_all` to also signal the captured group. No general process registry beyond a
  single captured pgid per session; servers still run **inside real Aurora panes**.
- No covering of tools that truly **daemonize** their server into a brand-new session/pgid (nx/turbo do not —
  they keep it in the launch job's group; genuine daemonizers are out of scope and were unkillable before).
- No auto-run on workspace open through this control (the create-flow on-open script is untouched). The
  overlap between an on-open dev-server script and this Run control is called out in `design.md` as a known
  interaction + follow-up, not silently merged.
- No rewriting of scripts, no port reassignment at runtime, no change to how ports are derived/displayed
  (that is `workspace-port-isolation`).

## Capabilities

### New Capabilities
- `workspace-run-servers`: from the workspace context bar, start every port-declaring script as an isolated
  per-workspace set of dev servers (one pane per server, split for several), reflect whether those servers
  are up as a Run/Stop toggle, and stop them (kill their process groups) without removing the workspace —
  reusing the existing pane/PTY model, the OSC-133 block lifecycle for liveness, and the teardown kill
  primitive.

### Modified Capabilities
<!-- Builds directly on `workspace-port-isolation` (the port chips + `parseDerivedPorts`/`readOffset` it
     renders in WorkspaceContextBar) and `workspace-teardown` (the `pty.kill` group-teardown primitive).
     Neither has additional behavior changed here — this capability is additive: a new control that composes
     the existing port derivation, pane/split model, and kill primitive. No baseline spec of those lives
     under openspec/specs/, so the behavior is captured as the new capability above. -->

## Impact

- **Rust (`src-tauri/src/`):**
  - `pty.rs` — add a per-session capture field (`PtySession.server: Idle|Pending|Failed|Found(i32)`); add
    `pty_capture_server_pgid(id)` (bounded sampler thread capturing the launch job's foreground pgid) and
    `pty_server_status(id) -> "capturing"|"alive"|"dead"|"uncaptured"` (`killpg(pgid, 0)` probe); generalize
    `group_teardown` to also signal the captured `server_pgid`; extend `kill_all` to reap captured groups.
  - `lib.rs` — register the two new commands in `generate_handler!`. (⌘Q wiring is unchanged — `kill_all`
    already runs on `ExitRequested`/`Exit`; it now also reaps the captured groups.)
- **Frontend (`src/`):**
  - `term/pty.ts` — add `captureServerPgid(id)` and `serverStatus(id)` bridges to the new commands.
  - `lib/ports.ts` — add `portScripts(scripts)`: the subset of scripts that declare ≥1 offset port (the
    "servers"). Pure, unit-testable, alongside `parseDerivedPorts`.
  - `lib/servers.ts` *(new)* — orchestrator: `runServers(wsId)`, `stopServers(wsId)`, the pure
    `serversUp(ws, status?)` selector (now consults the `serverStatus` liveness map, OSC-133 fallback), and a
    module-level **poll loop** (`ensureServerPoll`) that probes each server pane's pgid (~1.5 s) while any
    server tab exists. Fires `pty.captureServerPgid` on each server launch. Mirrors the
    `lib/teardown.ts` / `lib/create.ts` orchestrator pattern.
  - `lib/scripts.ts` — `runServerScript(paneId, name, { lookupRoot, execBase, taskIndex? })` gains an
    `onLaunched?(ptyId)` callback fired **at send** (via `runWhenReady`), so the front can kick capture the
    instant the server's command is dispatched. Reuses the existing `runWhenReady` + `taskCmd` logic.
  - `state/store.ts` — runtime-only `serverTabId: number | null` on `Workspace` (already built; **not**
    persisted); `prepareServerTab(wsId, n)` / `dropServerTab(wsId)` (already built); **add** a runtime-only
    `serverStatus: Record<ptyId, ServerStatus>` map + `setServerStatus`/`clearServerStatus` actions (not
    persisted), cleared for a tab's panes on `dropServerTab`. PTY kills stay in the orchestrator.
  - `components/WorkspaceRail.tsx` — `WorkspaceContextBar`: the Run/Stop button (already built) reads
    `serversUp(ws, serverStatus)` so it reflects the probed liveness. Visuals already in place.
- **Reuses (no change):** `pty_spawn` (panes spawn shells), `group_teardown` / `pty_kill` (Stop — now also
  signals the captured group), `PtyManager::kill_all` (⌘Q — now also reaps captured groups), `splitPane`
  + the 4-pane cap, `PaneArea` rendering of background tabs. The OSC-133 `running` flag survives only as the
  capture-failure **fallback** in `serversUp`.
- **Out of scope:** auto-running servers on workspace open via this path; unifying the create-flow on-open
  script with this control (follow-up); >4 servers in a single workspace (capped by the existing 4-pane limit
  — documented in `design.md`); tools that truly daemonize their server into a new session/pgid; fixing the
  wrong port chip for a `--port`-ignoring server.
