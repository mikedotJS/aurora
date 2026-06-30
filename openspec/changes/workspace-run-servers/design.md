# Design — workspace-run-servers

## Context

What the code actually does today (read, not assumed):

- **Port chips.** `WorkspaceContextBar` (`src/components/WorkspaceRail.tsx`) reads the workspace offset via
  `readOffset(ws.env)` and derives concrete ports via `parseDerivedPorts(scripts, offset)`
  (`src/lib/ports.ts`), where `scripts = userScripts[repoId].scripts`. `parseDerivedPorts` dedupes by port
  and returns `{label: script.name, port}[]` — so a script binding two ports yields **two** chips with the
  same label. The bar renders a chip per derived port. This is the bar the button goes into.
- **Scripts.** A repo's scripts live in `userScripts[repoRoot]` as `{name, desc, split, tasks:[{dir,cmd}]}`
  (`src/state/store.ts`). They are user-authored — typed or AI-proposed then explicitly **adopted**
  (`appendScripts`); nothing runs them implicitly.
- **Running a script.** `runScript(paneId, name, {lookupRoot, execBase, prelude})` (`src/lib/scripts.ts`):
  resolves the script from `scriptsForRoot(lookupRoot)`, and either (a) for `split && tasks>1`, calls
  `store.splitPane("h")` to fan the active tab into one pane per task (capped at 4) and runs each, or (b)
  chains the tasks with `&&` and runs them in the given pane once its shell is ready (`runWhenReady`, which
  waits for `pane.ready && pane.ptyId`, self-healing a lost spawn). `send()` does
  `startBlock(pane.id, cmd)` then `pty.write(ptyId, cmd + "\n")`. A real split-pane mechanism already exists.
- **Create-flow on-open.** `runCreate` (`src/lib/create.ts`) already runs one on-open script into the new
  workspace's first pane. Run generalizes this path to *all* port-scripts.
- **PTY + kill (the part the runtime evidence exposed).** Each pane owns one PTY (`pty_spawn`, registered in
  `PtyManager.sessions`, keyed by an opaque `pty-N` id). The session stores `shell_pgid` (the shell's pgid,
  captured at spawn). `pty_kill` (`src-tauri/src/pty.rs`) reads the **current foreground pgid** of the master
  (`master.process_group_leader()` = tcgetpgrp) and calls `group_teardown(shell_pgid, fg)` → SIGHUP then
  SIGKILL after 2 s. `PtyManager::kill_all` (⌘Q, wired in `lib.rs` on `ExitRequested`/`Exit`) drains every
  session and signals each session's `shell_pgid` + current `fg`.
- **Block lifecycle (the old liveness signal).** `Terminal.tsx` parses OSC 133: `133;D;<code>` →
  `store.endBlock` flips the pane's last block to `running:false`.

### Runtime evidence that broke the first design (D3/D4 as originally written)

Measured on the real app with a split script `api + welcomer`:

- `welcomer` → `next-server` pid 71510, binds `:4210`, **pgid 71411**.
- `api` → node pid 71511, binds `:3000`, **pgid 71477**.
- nx **boots each server then returns the prompt to the shell**. The server keeps running, **detached in its
  own process group** (71411 / 71477), which is **not** any pane shell's pgid (pane shells are ~71252/71253)
  and **not** the current foreground once the prompt is back (that is the shell again).

Three proven failures of the original "zero-Rust, block-derived" design:

1. **`serversUp` lies.** It was derived from the last block's `running` flag, which flips to `false` the
   moment the prompt returns (OSC-133 `D`). The toggle shows **Run** while the server is up.
2. **Stop misses the server.** `pty_kill` → `group_teardown(shell_pgid, current_fg)` signals the shell group
   and the *current* foreground (= the shell). It **never** signals 71411/71477. Orphan; port stuck.
3. **⌘Q misses it too.** `kill_all` collects only `shell_pgid` + current `fg` per session — never the detached
   server group. Orphan survives quit.

The fix (decided: "do it properly, Rust OK"): **capture the server's real process group at launch, probe
that group for liveness, and add it to the kill set.** `master.process_group_leader()` already gives the
foreground pgid; we sample it just after launch to capture the job's group (D7), register it on the session
**in Rust** so `kill_all` can reap it (D7), probe it with `killpg(pgid, 0)` on a light front poll (D8), and
fold it into `group_teardown`/`kill_all` (revised D4/D6). D3 (state) and D4 (Stop) are rewritten below.

## Goals / Non-Goals

**Goals**
- One affordance to start **all** port-declaring servers and stop them, next to the port chips, visible only
  when there is at least one such script.
- The toggle reflects the **real** runtime state — a server's actual process group being alive — and
  self-corrects when a server crashes, **including** servers that detach into their own group (nx, turbo).
- Stop and ⌘Q **reliably** kill the servers (the captured group), leaving **no orphan and no stuck port**,
  without removing the worktree/workspace.
- Reuse the existing pane/split/PTY machinery; add the **minimum** new Rust (one capture command, one status
  command, and small edits to the two existing kill paths).

**Non-Goals**
- Auto-running on open through this control; merging it with the create-flow on-open script (follow-up).
- A general Rust process registry beyond a single captured pgid per session.
- Covering servers that truly **daemonize** into a brand-new session/pgid unrelated to the launch job (see
  Risks — out of scope; nx/turbo do **not** do this, per the measurement).
- Supporting more than the existing 4-pane cap of servers in one workspace.
- Fixing the `--port`-ignoring server's wrong port chip (a port-derivation concern; noted, deferred).

## Decisions

### D1 · The unit is the *server pane*, honoring the `split` flag — parity with `runScript`
*(unchanged — implemented)*

A **port-script** = a saved repo script with ≥1 task whose `cmd` matches
`/\$\(\((\d+)\s*\+\s*AURORA_PORT_OFFSET\)\)/` (the same regex `parseDerivedPorts` uses). `portScripts(scripts)`
in `src/lib/ports.ts` returns that subset. `serverUnits(scripts)` expands them honoring `split`:
- **split script with ≥2 non-empty tasks** → **one unit per task** (concurrent panes, **no `&&`**).
- **non-split, or split with exactly 1 non-empty task** → **one unit**, tasks chained `&&`.

`ServerUnit = { name; taskIndex: number | null }`. Chips stay per *port*. Visibility: button iff
`portScripts.length > 0` ⟺ `derivedPorts.length > 0`.

### D2 · Server → pane mapping: a dedicated "Servers" tab (one pane per server unit)
*(unchanged — implemented)*

Run opens a **dedicated tab** in the active workspace, split into `N = min(4, serverUnits.length)` panes, one
per unit. Split units run only their `taskIndex`; non-split units chain `&&`. All run at `lookupRoot:
ws.repoId` / `execBase: ws.dir`. A dedicated background-renderable tab keeps servers off the user's working
tab so Stop never kills the user's shell. Capped at 4 panes; >4 surfaces a `notify` and starts the first 4.

### D3 · Source of truth for Run/Stop state: the **captured process group's liveness**, with the block flag as fallback *(REVISED — supersedes the block-derived version)*

`serverTabId: number | null` on `Workspace` stays exactly as built — runtime-only, set by `prepareServerTab`,
cleared by `dropServerTab`, **not** persisted (a restored workspace comes back with servers down).

What changed: **"servers up" is no longer read off the OSC-133 `running` flag** (proven to lie for detached
servers — see Context). It is derived from the **real liveness of each server pane's captured process group**,
maintained by a light front poll (D8) into a runtime store map `serverStatus: Record<ptyId, ServerStatus>`
where `ServerStatus = "capturing" | "alive" | "dead" | "uncaptured"`.

`serversUp(ws, status?)` (still a **pure** selector; `status` optional for back-compat with existing tests):
```
if ws.serverTabId == null → false
let tab = ws.tabs.find(g => g.id === ws.serverTabId); if !tab → false
return tab.panes.some(pane => {
  const s = status?.[pane.ptyId ?? ""];
  switch (s) {
    case "alive":     return true;          // captured group answers killpg(pgid,0)
    case "capturing": return true;          // launched, pgid not resolved yet — booting, hold "up"
    case "dead":      return false;         // captured group is ESRCH
    case "uncaptured":                       // capture gave up (no distinct job) — fall back…
    default:          return pane.blocks.at(-1)?.running === true;  // …to the legacy OSC-133 flag
  }
})
```

Rationale:
- **Correct for the detached case** (nx/turbo): `killpg(pgid,0)` on 71411/71477 is the truth; the block flag
  is irrelevant.
- **Correct for the foreground case** (vite/next stay foreground): the captured pgid is the job group and
  `killpg(0)` agrees with the block flag — same answer, now uniform.
- **No flash on boot**: from launch until the pgid resolves, status is `"capturing"` → the pane counts as up,
  so the toggle does **not** flicker Run→Stop→Run while the server boots.
- **Crash → Run on its own**: when the group exits, the next poll reads `"dead"`; if it was the last live
  pane, `serversUp` → false → toggle returns to **Run** (the crashed pane stays visible — crash UX).
- **Capture-failure is not fatal**: a pane whose capture gave up (`"uncaptured"`) falls back to the old
  `running` flag — strictly no worse than today for that pane.

- *Rejected — keep the block flag as source of truth:* proven to lie for detached servers (the whole bug).
- *Rejected — a Rust event when the pgid dies:* needs a per-server watcher thread + event plumbing for a
  signal a 1.5 s `killpg(0)` poll already gives; ≤4 cheap syscalls / 1.5 s is negligible (D8 cost note).

### D4 · Stop: kill the **captured server group** too, reuse the teardown primitive, keep the workspace *(REVISED)*

`stopServers(wsId)` is structurally unchanged on the front: read the server tab's panes' `ptyId`s →
`Promise.all(ptyIds.map(pty.kill))` → `dropServerTab(wsId)`; worktree and workspace untouched; no-op when
`serverTabId` is null. It additionally clears `serverStatus` for those ptyIds and lets the poll stop when no
server tab remains (D8).

The fix is **in `pty_kill` (Rust)**: it now signals **three** groups, not two — `shell_pgid`, the current
`fg`, **and the captured `server_pgid`** for that session. So killing a server pane's PTY now reaches the
detached server group (71411/71477), not just the shell. `group_teardown` is generalized to take the set of
pgids (it already dedupes and guards `p > 1` && `p != getpgrp()`).

- *Rejected — Ctrl-C (`\x03`):* only SIGINTs the foreground job (already returned to the shell for a detached
  server); cannot reach a detached group.
- *Why not a separate "kill this pgid" front command:* Stop already kills **by ptyId**; making `pty_kill`
  itself also signal the registered `server_pgid` keeps Stop's call site unchanged and reuses the existing
  grace-kill timing.

### D5 · Idempotence & self-heal *(unchanged in shape; "stale" now means not-`serversUp` under the new liveness)*
- The toggle prevents a double start while up.
- `runServers` first drops any stale server tab (killing straggler PTYs via `pty.kill`, which now also kills
  any still-registered server group) and then creates a fresh one — so post-crash Run cleanly restarts.
- `stopServers` with no tracked tab is a no-op.

### D6 · Edge cases (codified in the spec) *(REVISED for the pgid model)*
- **No port-script** → no button.
- **Detached server (nx/turbo)** → captured at launch (D7); `serversUp` reads `killpg(pgid,0)`; Stop/⌘Q kill
  the captured group. **This is the proven case the original design failed.**
- **Server still booting** → status `"capturing"` → toggle shows **Stop** without flashing.
- **A server crashes** → its group goes `ESRCH` → next poll `"dead"`; if last live, toggle → **Run**; crashed
  pane stays visible.
- **Capture fails** (a script that never forks a distinct foreground job) → status `"uncaptured"` → fall back
  to the OSC-133 `running` flag for that pane (no regression vs. today).
- **Stop while nothing runs** → no-op.
- **Workspace switch while running** → the server tab + PTYs stay in the background; the bar reflects only the
  active workspace's `serverTabId` + its panes' `serverStatus`.
- **⌘Q while running** → `kill_all` now signals each session's `shell_pgid` + `fg` **+ captured
  `server_pgid`** → the detached server groups are reaped → **no orphan** (the fix for the leak that motivated
  the chantier).

### D7 · Capture the server's process group at launch *(NEW)*

**Where the pgid is captured.** Right after `runServerScript` actually *sends* a server unit's command into
its pane (i.e. once `pane.ready && pane.ptyId`, inside the `send()` path), the front fires
`pty.captureServerPgid(ptyId)` (fire-and-forget). `runServerScript`/`runWhenReady` gain an optional
`onLaunched?(ptyId)` callback invoked exactly at send, so capture begins the instant a job is about to take
the foreground — not earlier (when fg is still the shell) and not on a guess.

**How the race is handled (in Rust, where `shell_pgid` lives).** `pty_capture_server_pgid(id)` does **not**
block; it marks the session's capture state `Pending` and spawns a short sampler thread that, every ~40 ms for
up to ~8 s, reads the session's foreground pgid (`master.process_group_leader()`) under the manager lock and:
- if `fg` is `Some(p)`, `p > 1`, and `p != shell_pgid` → records `server_pgid = p` (`Found(p)`), stops;
- if the session disappears (pane closed) → stops;
- on timeout with no distinct job → records `Failed` (front reads this as `"uncaptured"`).

This handles the documented hard points:
- **The race**: just after send, `fg` is still `shell_pgid`; the loop waits until the launch job takes the
  foreground, then captures **its** group. It will not capture the shell by mistake (explicit `!= shell_pgid`
  guard).
- **Detached server that returns the prompt**: the captured group (71411/71477) **persists** after nx exits
  (verified — the group stays alive), so the registered pgid remains valid for probe + kill.
- **Chained `build && serve` (non-split)**: ~~the whole chain is one shell job = one pgid~~ **this was wrong**.
  Under zsh, `cmd1 && cmd2` creates **two sequential foreground process groups** (measured: `sleep 0.6 &&
  sleep 5` → pgid 95757 then 95758, both ≠ shell). The corrected sampler tracks the **last** non-shell
  foreground pgid seen (`last_non_shell`) and freezes only after `SHELL_SETTLE` (3) consecutive
  shell-foreground samples (~120 ms debounce). This debounce survives the brief inter-job shell window
  (typically < 1 ms) without triggering a premature freeze on the build stage's pgid. After `serve`
  starts and then detaches (or after timeout if it stays foreground), `last_non_shell` == serve's pgid
  → correct capture.
- **No job at all** (a command that runs entirely in the shell without forking a job) → `Failed` →
  `"uncaptured"` → block-flag fallback.

**Where the pgid is stored.** On the **Rust** `PtySession`, as a small enum field (`server: ServerCapture =
Idle | Pending | Failed | Found(i32)`), default `Idle`. It **must** be Rust-side: `kill_all` runs from the
Tauri run-loop on ⌘Q **without consulting the webview**, so only a Rust-held pgid can be reaped there. The
front never handles raw pgids — it triggers capture **by ptyId** and probes/kills **by ptyId**. (A mirror
copy in the store is unnecessary and is deliberately avoided.)

- *Rejected — front-driven sampling loop* (`pty_foreground_pgid` getter polled from JS): N round-trips per
  server, exposes `shell_pgid` to the webview to do the comparison, and still needs a second "register for
  ⌘Q" command. Folding sample+compare+register into one Rust call is simpler and keeps `shell_pgid` in Rust.
- *Rejected — capture on the first OSC-133 `133;C`:* couples capture to `Terminal.tsx` output parsing; the
  `onLaunched`-at-send trigger + bounded Rust sampler is decoupled and robust to send-vs-fork timing.

### D8 · Liveness probe + front poll cycle *(NEW)*

**Probe (Rust).** `pty_server_status(id) -> ServerStatus` maps the session's capture state:
- no session → `"dead"`;
- `Pending` → `"capturing"`;
- `Found(p)` → `killpg(p, 0)`: `0`/`EPERM` → `"alive"`, `ESRCH` → `"dead"`;
- `Failed`/`Idle` → `"uncaptured"`.

`killpg(pgid, 0)` sends no signal — it only asks the kernel whether the group exists. It reads nothing
sensitive.

**Poll (front).** A single module-level `setInterval(~1.5 s)` in `servers.ts` (`ensureServerPoll()`), started
by `runServers` (and on capture), runs **only while at least one workspace has a `serverTabId`**. Each tick:
for every server pane (any workspace's server tab) with a `ptyId`, call `pty.serverStatus(ptyId)` and write
the result into the store map `serverStatus[ptyId]` (which makes the context bar re-render). When no server
tab remains anywhere, the interval clears itself. `stopServers`/`dropServerTab` clear the map entries for the
removed panes.

- **Cost**: ≤4 panes per workspace × however many workspaces have a live server tab (typically 1), one
  `killpg(0)` syscall each, every 1.5 s. Negligible; the loop does not run at all when no servers exist.
- *Poll vs Rust event* — chose poll: it also expresses the `"capturing"` transient for free and needs no
  watcher-thread/event plumbing. Latency of up to ~1.5 s to flip the toggle on crash is acceptable for this
  affordance.

## Risks / Known interactions

- **Capture timing (honest unknown).** Capture relies on the launch job taking the PTY foreground for at least
  one ~40 ms sample within the ~8 s window. For nx/turbo/vite/next this window is comfortably long (the
  launcher runs for ≥ a second). A pathological launcher whose foreground window is shorter than one sample,
  or that never takes the foreground, yields `"uncaptured"` → block-flag fallback (no orphan-kill for that
  pane via the new path, same as today). The sample cadence/window are the tuning knobs; defaults are a
  starting point to confirm in the smoke test.
- **Probe false negative/positive.** `killpg(pgid,0)` is precise for "does this group exist". The only fuzz is
  **pgid reuse**: after the server's group dies, the OS could (rarely) reuse that pgid for an unrelated
  process, making a dead server read `"alive"`. macOS pid/pgid reuse is sequential and slow; within a session
  it is very unlikely, and the consequence is a momentarily stuck toggle, not a data risk. Documented, not
  mitigated in v1.
- **True daemonizers — out of scope.** A tool that `setsid()`s its server into a brand-new session/pgid
  unrelated to the launch job (e.g. `pm2`, `--daemon`, `docker run -d`) escapes both the captured pgid and
  `kill_all`. The measurement shows nx/turbo keep the server **in the launch job's group**, so they are
  covered; genuine daemonizers are not, and were not killable before either. Flagged, deferred.
- **On-open script overlap.** Unchanged from before: if an on-open dev-server script is also a port-script,
  Run would start it twice (`EADDRINUSE`). Still a follow-up; this change does not auto-run on open.
- **>4 servers.** Capped by the 4-pane limit (D2). Surfaced, deferred.
- **Wrong port chip for a `--port`-ignoring server.** Observed (`api` binds `:3000`, chip says `:3010`).
  Orthogonal to Run/Stop; a `parseDerivedPorts` trust issue. Noted, deferred.

## Security

- **No secrets in the webview, no provider calls.** Capture, probe, and kill operate on pgids and signals
  only. `killpg(pgid, 0)` reads no process memory and transmits nothing. No Anthropic/AI key is read or sent.
  Confirmed: this change introduces no new provider call path and touches no key.
- **Executes only user-authored scripts.** Run starts exactly the scripts already saved in
  `userScripts[repoId]` (typed by the user, or AI-proposed and explicitly adopted). No remote/manifest text is
  executed.
- **Signal scope is guarded.** Both `group_teardown` and `kill_all` keep the existing guards: never signal
  `pgid <= 1` and never signal Aurora's own process group (`getpgrp()`). The captured `server_pgid` is run
  through the same guards.

## Migration

`serverTabId` and the runtime `serverStatus` map are additive and runtime-only (not in `PersistedWs`), so
there is no persisted-data migration. The Rust `PtySession.server` field defaults to `Idle` for every existing
spawn path.
