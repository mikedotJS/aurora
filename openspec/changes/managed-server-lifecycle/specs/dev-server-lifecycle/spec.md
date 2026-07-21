## ADDED Requirements

### Requirement: Run scripts are first-class managed processes
The system SHALL spawn each run script as its own tracked child process with a real PID and its own
process group (via `setsid`), NOT as a command typed into a shared interactive shell PTY. Each
managed server SHALL expose its PID and process-group id to the lifecycle controller, and SHALL have
its own output stream (PTY) for rendering. The system SHALL NOT rely on foreground-pgid sampling or
OSC-133 block flags to know a managed server's identity.

#### Scenario: A run script is spawned as its own child
- **WHEN** the user starts a `kind: "run"` script
- **THEN** the system SHALL spawn it as a dedicated child process in its own process group and record that process's PID/pgid

#### Scenario: A forking/multi-process server stays owned
- **WHEN** a managed run script forks or re-parents child processes (e.g. an nx daemon started with `--no-tui`)
- **THEN** those children SHALL remain in the managed server's process group and be tracked as part of the same managed server

### Requirement: Real process status, not heuristics
The system SHALL determine a managed server's running/exited state from the OS process (e.g. a
non-blocking wait yielding an exit code), not from a PTY foreground-pgid heuristic. When a managed
server exits, the system SHALL record its exit code.

#### Scenario: Exit is observed with a code
- **WHEN** a managed run script's process exits
- **THEN** the system SHALL report the server as exited and SHALL capture the process exit code

### Requirement: Stop kills the exact process group and verifies teardown
When stopping a managed server, the system SHALL signal that server's own process group
(SIGHUP first), wait a short grace period, then verify the process has exited AND its bound port is
freed; any survivor SHALL be escalated to SIGKILL targeting that same process group. The system
SHALL NOT use a broad process-name kill (e.g. `pkill -f`) at any point.

#### Scenario: A well-behaved server stops on SIGHUP
- **WHEN** Stop is invoked on a managed server that exits on SIGHUP within the grace period
- **THEN** the system SHALL consider it stopped and SHALL confirm its port is no longer bound

#### Scenario: A survivor is force-killed
- **WHEN** a managed server is still alive or still holding its port after the SIGHUP grace period
- **THEN** the system SHALL SIGKILL that server's process group and re-verify the port is freed

#### Scenario: No broad kill is used
- **WHEN** any Stop or teardown path runs
- **THEN** the system SHALL only signal specific tracked pids/pgids and SHALL NOT issue a name-pattern kill that could hit the user's other processes

### Requirement: Setup / run / archive lifecycle
The system SHALL run `scripts.setup` exactly once after a workspace is created and before its run
scripts start; run scripts SHALL NOT start until setup has completed successfully. The system SHALL
run `scripts.archive` exactly once before a workspace is archived/torn down. Run scripts SHALL be
started according to `run_mode`: `concurrent` starts all selected servers, `nonconcurrent` keeps at
most one running at a time.

#### Scenario: Run waits for setup
- **WHEN** a workspace with a `scripts.setup` is created and the user starts a run script
- **THEN** the run script SHALL NOT start until setup has exited successfully

#### Scenario: Archive runs before teardown
- **WHEN** a workspace with a `scripts.archive` is torn down
- **THEN** the system SHALL run archive before removing the worktree, and teardown SHALL still proceed if archive fails, surfacing the failure

#### Scenario: nonconcurrent run_mode keeps one server
- **WHEN** `run_mode` is `nonconcurrent` and a run script is already running, and the user starts another run script
- **THEN** the system SHALL stop the running one before starting the new one

### Requirement: Run entry points drive the managed lifecycle
The existing Run/Stop toggle and the ⌘R keyboard handler SHALL drive the managed lifecycle. When
more than one non-hidden run script exists, the Run action SHALL present a menu of run scripts;
otherwise it SHALL start the default (or only) run script. ⌘R SHALL continue to `preventDefault()`
the WKWebView reload.

#### Scenario: Single run script runs directly
- **WHEN** exactly one non-hidden run script exists and the user triggers Run (button or ⌘R)
- **THEN** the system SHALL start that run script without showing a menu

#### Scenario: Multiple run scripts show a menu
- **WHEN** more than one non-hidden run script exists and the user triggers Run
- **THEN** the system SHALL present a Run menu of the available run scripts, with the default marked
