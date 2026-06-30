## ADDED Requirements

### Requirement: Run/Stop control appears only when the workspace has a port-declaring script
The system SHALL render a Run/Stop control in the workspace context bar (next to the port chips) **if and
only if** the active workspace's repo has at least one *port-script* — a saved script with ≥1 task whose
command contains `$((<base> + AURORA_PORT_OFFSET))`. When there is no such script, no control SHALL be shown.
The control SHALL NOT change which port chips are displayed (chips remain one per derived port).

#### Scenario: A workspace with a port-script shows the control
- **WHEN** the active workspace's repo has at least one script whose command binds `$((<base> + AURORA_PORT_OFFSET))`
- **THEN** the context bar SHALL show the Run/Stop control next to the port chips

#### Scenario: A workspace with no port-script shows no control
- **WHEN** the active workspace's repo has no script that declares an offset port
- **THEN** the context bar SHALL NOT show the Run/Stop control

#### Scenario: A two-port server is one server but two chips
- **WHEN** a single script binds two offset ports (e.g. `:3010` and `:4210`)
- **THEN** the context bar SHALL still show two port chips, and the control SHALL treat that script as a single server

### Requirement: Run starts one pane per server, honoring the split flag
When the user activates Run, the system SHALL start every port-script as an isolated server, with the number
of panes determined by the script's `split` flag — parity with the existing runScript behavior:
- A port-script with `split: true` and ≥2 non-empty tasks SHALL open **one pane per task** (tasks run
  concurrently; the system SHALL NOT chain them with `&&`, as the first task is a long-running server that
  would block subsequent tasks).
- A port-script without `split`, or with `split: true` but only 1 non-empty task, SHALL run in **one pane**
  with tasks chained `&&`.

Each server SHALL run its script's tasks in the workspace's worktree directory (resolving the script from the
workspace's repo), inside a real Aurora pane backed by a PTY. The number of server panes MAY be capped at the
existing per-tab pane limit (4); when more server units exist than the cap, the system SHALL start up to the
cap and SHALL NOT fail silently.

#### Scenario: A split port-script with two tasks opens two panes (concurrent)
- **WHEN** the workspace has one port-script with `split: true` and two tasks (e.g. `nx serve api` + `welcomer dev`), and the user activates Run
- **THEN** the system SHALL open two panes, each running only its own task — the second task SHALL start independently, not blocked by the first

#### Scenario: Two non-split servers open as a split of two panes
- **WHEN** the workspace has two non-split port-scripts and the user activates Run
- **THEN** the system SHALL open two panes (a split), each running one server in the workspace's worktree directory

#### Scenario: A two-port non-split server is one server but two chips
- **WHEN** a single non-split script binds two offset ports across two tasks
- **THEN** the system SHALL run both tasks chained with `&&` in one pane, and the context bar SHALL show two port chips (one per port)

#### Scenario: One server opens a single pane
- **WHEN** the workspace has exactly one port-script (non-split, or split with 1 task) and the user activates Run
- **THEN** the system SHALL run that server in a single pane

#### Scenario: Servers run inside panes so app quit reaps them
- **WHEN** servers are running and the application is quit (⌘Q)
- **THEN** the app-quit teardown SHALL terminate the running server processes — **including a server that
  detached into its own process group** — by signalling each session's captured server process group in
  addition to the shell and current-foreground groups, leaving no orphaned process and no stuck port

### Requirement: Run captures each server's real process group at launch
When Run launches a server unit into its pane, the system SHALL capture that server's real process group by
sampling the pane's PTY foreground process group after the command is dispatched, until it differs from the
pane's shell process group (with a bounded timeout), and SHALL record the captured group on the PTY session in
the backend so it can be probed for liveness and killed later — including by application-quit teardown, which
does not consult the webview. The system SHALL NOT capture the shell's own process group as the server group.
When no distinct foreground job is observed within the timeout, the capture SHALL resolve to "uncaptured"
rather than blocking.

#### Scenario: A chained build-then-serve script captures the job's group
- **WHEN** a non-split server script chains tasks (e.g. `build && serve`) in one pane
- **THEN** the system SHALL capture the single shell job's process group (which contains the final long-running
  server), so that group can be probed and killed

#### Scenario: The shell's own group is never mistaken for the server
- **WHEN** the foreground process group still equals the pane's shell process group (the job has not yet taken
  the foreground)
- **THEN** the system SHALL NOT record that as the server group, and SHALL keep sampling until a distinct group
  appears or the timeout elapses

#### Scenario: A command that forks no job resolves to uncaptured
- **WHEN** the launched command never produces a foreground process group distinct from the shell within the
  capture window
- **THEN** the capture SHALL resolve to "uncaptured" (no server group recorded) and the system SHALL fall back
  to the command-block flag for that pane's liveness

### Requirement: The control is a toggle reflecting the real server process-group liveness
The control SHALL be a toggle that shows **Run** when the workspace's servers are down and **Stop** when they
are up, derived from the **real liveness of each server's captured process group** — not from a stored intent
and not from the OSC-133 command-block flag (which is unreliable for servers that detach and return the
prompt). A server SHALL be considered up while its captured process group still exists (probed via
`killpg(pgid, 0)`), and down once that group no longer exists. While a just-launched server's group has not
yet been captured, it SHALL be treated as up (booting) so the toggle does not flicker. When the capture did
not resolve for a pane, the system MAY fall back to the OSC-133 command-block flag for that pane. When every
server is down, the control SHALL return to the **Run** state without user action.

#### Scenario: A detached server keeps the toggle on Stop
- **WHEN** a server is started by a tool that boots it and returns the shell prompt (the server now lives in
  its own process group, detached from the pane's shell)
- **THEN** the toggle SHALL remain on **Stop** for as long as that captured process group is alive, even though
  the pane's command block is no longer marked running

#### Scenario: Toggle shows Stop while a server is still booting
- **WHEN** a server has just been launched and its process group has not yet been captured
- **THEN** the control SHALL show Stop without flickering back to Run

#### Scenario: A crashed server returns the toggle to Run
- **WHEN** the only running server's process group exits unexpectedly (crash) and is detected dead by the
  liveness probe
- **THEN** the control SHALL return to the Run state on its own, and the crashed server's pane SHALL remain visible so its output can be read

#### Scenario: Capture failure falls back to the command-block flag
- **WHEN** a server pane's process-group capture did not resolve (no distinct foreground job was observed)
- **THEN** the system SHALL fall back to the OSC-133 command-block running flag for that pane rather than
  reporting the server down outright

#### Scenario: State is not faked across relaunch
- **WHEN** the application is relaunched with previously-running servers
- **THEN** the restored workspace SHALL show the Run state (servers are down) until the user activates Run again

### Requirement: Stop terminates the servers without removing the workspace
When the user activates Stop, the system SHALL terminate the workspace's running server processes by killing
their process groups — **including each server's captured process group** (so a server that detached into its
own group is reached, not only the pane's shell and current-foreground groups) — using the same teardown kill
primitive (SIGHUP then SIGKILL) used by workspace deletion, and SHALL remove the dedicated server panes — but
SHALL NOT remove the worktree and SHALL NOT remove the workspace. Activating Stop when no servers are tracked
SHALL be a no-op.

#### Scenario: Stop kills servers and keeps the workspace
- **WHEN** servers are running and the user activates Stop
- **THEN** the server processes SHALL be killed and the workspace, its worktree, and its working panes SHALL remain

#### Scenario: Stop kills a detached server's process group
- **WHEN** a detached server is running (its process group is no longer the pane's foreground) and the user
  activates Stop
- **THEN** the system SHALL signal the captured server process group, terminating the server and freeing its
  port — leaving no orphan

#### Scenario: Stop with nothing running does nothing
- **WHEN** no servers are tracked for the workspace and Stop is somehow invoked
- **THEN** the system SHALL do nothing (no error, no state change)

### Requirement: Running again is idempotent and self-healing
Because the control is a toggle, the user SHALL NOT be able to start a second copy of the servers through it
while they are up. When the servers are down (including after a crash) and the user activates Run, the system
SHALL clear any stale server panes (killing any straggler processes) before starting a fresh set, so Run after
a crash cleanly restarts the servers.

#### Scenario: Run after a crash restarts cleanly
- **WHEN** a previous server set has crashed (control back on Run) and the user activates Run
- **THEN** the system SHALL clear the stale server panes and start a fresh set of servers

#### Scenario: The toggle prevents a double start
- **WHEN** the servers are up
- **THEN** the control SHALL show Stop, so activating it stops rather than starts a second set

### Requirement: Servers are isolated per workspace
Each workspace's servers SHALL be tracked and controlled independently. Switching to another workspace SHALL
leave a workspace's servers running in the background, and the context bar's Run/Stop control SHALL reflect
only the **active** workspace's own servers.

#### Scenario: Switching workspaces leaves servers running
- **WHEN** workspace A's servers are running and the user switches to workspace B
- **THEN** workspace A's servers SHALL keep running, and the control SHALL reflect workspace B's own server state

### Requirement: Run executes only user-authored scripts and reaches no secrets
Run SHALL execute only scripts already saved in the repo's scripts (authored by the user, or AI-proposed and
explicitly adopted through the scripts flow). It SHALL NOT execute remote or manifest text that the user has
not seen and accepted, and it SHALL NOT read or transmit any secret (no provider/API key) — it operates purely
on the pane/PTY model and the saved script command strings.

#### Scenario: Only saved scripts run
- **WHEN** the user activates Run
- **THEN** only the workspace repo's saved port-scripts SHALL be executed, and no unseen remote content SHALL be run

#### Scenario: No secret is touched
- **WHEN** Run or Stop is activated
- **THEN** no provider/API key SHALL be read by the webview or sent anywhere as part of this control
