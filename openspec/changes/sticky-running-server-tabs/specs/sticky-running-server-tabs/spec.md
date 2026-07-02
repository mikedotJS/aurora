## ADDED Requirements

### Requirement: A pane is detected as "running" from its PTY foreground process group, generically
The system SHALL determine whether a pane is running a child process by reading the pane's PTY **foreground
process group** (via the tty `tcgetpgrp` on the PTY master, already exposed as `process_group_leader()`) and
comparing it to the pane's shell process group. This detection SHALL be **command-agnostic**: it SHALL apply to any
long-running foreground command (e.g. `vite`, `next dev`, `npm run dev`, `nx serve`, `python -m http.server`), not
only to scripts declared with a port offset and not only to the dedicated Servers tab. The combined running signal
for a pane SHALL be evaluated in this priority order:
1. the current PTY foreground process group differs from the shell's process group (a foreground child) → running;
2. otherwise, a previously **captured** detached process group that is still alive (probed via `killpg(pgid, 0)`)
   → running;
3. otherwise, the pane's OSC-133 command-block `running` flag → running.

A pane whose foreground process group equals its shell group, with no live captured group and no running block,
SHALL be considered **not running**.

#### Scenario: A foreground dev server marks the pane running
- **WHEN** a pane runs a server that holds the foreground (e.g. `vite`, whose process group is the PTY foreground)
- **THEN** the pane SHALL be detected as running because the foreground process group differs from the shell group,
  without depending on the OSC-133 block flag

#### Scenario: A detached server marks the pane running
- **WHEN** a pane runs a tool that boots a server, returns the shell prompt, and leaves the server alive in its own
  process group (e.g. `nx serve … --no-tui`), and that group was captured
- **THEN** the pane SHALL be detected as running for as long as the captured group answers `killpg(pgid, 0)`, even
  though the PTY foreground has returned to the shell and the command block is no longer marked running

#### Scenario: An idle shell is not running
- **WHEN** a pane sits at its shell prompt with no child job (foreground group equals the shell group) and no live
  captured group
- **THEN** the pane SHALL be detected as not running

#### Scenario: Detection is not limited to configured scripts
- **WHEN** the user types an arbitrary long-running command that is not a saved port-declaring script
- **THEN** the system SHALL still detect the pane as running from its foreground process group

### Requirement: A capture is started for every command so detached servers can be tracked and reached
The system SHALL start the bounded process-group capture (the existing `pty_capture_server_pgid` sampler) when a
command block starts in a pane, not only when the dedicated "Run servers" control is used. The capture SHALL be
fire-and-forget and SHALL resolve to "uncaptured" for ordinary commands that never produce a distinct foreground
job, without blocking the pane. When a command does detach a server into its own process group, the capture SHALL
record that group on the PTY session so it can later be probed for liveness and signalled.

#### Scenario: A typed detaching command gets its group captured
- **WHEN** the user types a command that boots a server and then returns the prompt (the server detaches into its
  own process group)
- **THEN** the system SHALL have captured that process group so the pane's running state and Ctrl+C both target it

#### Scenario: An ordinary command resolves to uncaptured without blocking
- **WHEN** the user runs a short command that never forks a distinct foreground job (e.g. `ls`)
- **THEN** the capture SHALL resolve to "uncaptured" and SHALL NOT block the pane or change its behaviour

### Requirement: A running pane's tab shows a persistent running badge
The system SHALL render, on the tab strip, a running badge (e.g. a "●" marker) together with a label naming the
running command on any tab that has at least one running pane (per the combined running signal). The badge SHALL
remain visible for as long as the pane is running — including while a detached server is alive and the shell prompt
has returned — and SHALL clear on its own once no pane in the tab is running. The label SHALL reuse the existing
tab-naming source (the auto-set `Group.name`) or the running command text, and SHALL describe a running process
truthfully rather than asserting a specific server type.

#### Scenario: A running pane badges its tab
- **WHEN** a pane in a tab is detected as running
- **THEN** that tab SHALL show a running badge and a label for what is running

#### Scenario: A detached server keeps the badge after the prompt returns
- **WHEN** a detached server is alive in its captured process group and the pane's prompt has returned
- **THEN** the tab SHALL keep showing the running badge until the captured group is no longer alive

#### Scenario: The badge clears when nothing is running
- **WHEN** the last running pane in a tab stops (its captured group dies and no foreground child remains)
- **THEN** the tab's running badge SHALL clear without user action

### Requirement: The command prompt is blocked while a pane is running
The system SHALL NOT present the normal editable command prompt while a pane is running (per the combined running
signal) and is in blocks-mode (not the full-screen/rawMode xterm overlay). It SHALL instead present a
non-misleading running affordance that makes clear a process is still running and how to interrupt it (Ctrl+C), so
the pane cannot appear to be an idle shell that has returned to a prompt. When the pane stops running, the normal
command prompt SHALL be restored. Panes already handed to the rawMode xterm overlay (full-screen or inline-prompt
programs) SHALL be unaffected by this requirement.

#### Scenario: A running foreground server hides the misleading prompt
- **WHEN** a foreground server is running in a blocks-mode pane
- **THEN** the pane SHALL show the running affordance instead of an editable command prompt

#### Scenario: A detached server still blocks the prompt
- **WHEN** a detached server is alive (its captured group answers the liveness probe) and the pane's shell prompt
  has returned
- **THEN** the pane SHALL still show the running affordance rather than an editable prompt, until the captured group
  is dead

#### Scenario: The prompt returns when the process ends
- **WHEN** the running process ends and the pane is no longer detected as running
- **THEN** the normal editable command prompt SHALL be restored

#### Scenario: rawMode programs are not affected
- **WHEN** a pane is in the rawMode xterm overlay (e.g. `vim`, `top`, an inline arrow-key prompt)
- **THEN** this requirement SHALL NOT alter that pane's input handling

### Requirement: Ctrl+C interrupts the running process, including a detached server
When the user presses Ctrl+C in a running pane, the system SHALL deliver an interrupt to the actually-running
process rather than only to whatever currently holds the PTY foreground:
- when the running process **is** the PTY foreground group, the system SHALL send the interrupt through the PTY
  (writing `\x03`), which the tty routes to that foreground group;
- when the running process is a **detached** group that was captured and is still alive (the PTY foreground having
  returned to the shell), the system SHALL signal that captured process group directly with `killpg(pgid, SIGINT)`,
  guarded by a liveness check immediately before signalling.

When the running process is a detached server whose group was **not** captured ("uncaptured"), the system SHALL NOT
falsely claim to have stopped it; it MAY report that it cannot reach the process. The system SHALL NOT signal a
process group that is not confirmed alive at signalling time (guarding against a recycled pgid).

#### Scenario: Ctrl+C stops a foreground server
- **WHEN** a foreground server is running (it is the PTY foreground group) and the user presses Ctrl+C
- **THEN** the system SHALL write `\x03` to the PTY, delivering SIGINT to that group and stopping the server

#### Scenario: Ctrl+C stops a detached, captured server
- **WHEN** a detached server is alive in its captured process group (the shell holds the PTY foreground) and the
  user presses Ctrl+C
- **THEN** the system SHALL send `killpg(captured_pgid, SIGINT)` to that group — the same group Stop/⌘Q already reap
  — reaching the server that a raw `\x03` would have missed

#### Scenario: An uncaptured detached server is not falsely reported as stopped
- **WHEN** a detached server is running but its process group was never captured, and the user presses Ctrl+C
- **THEN** the system SHALL NOT signal an unknown group and SHALL NOT falsely report the process as stopped

#### Scenario: A dead/recycled group is not signalled
- **WHEN** Ctrl+C would target a captured group that no longer answers the liveness probe
- **THEN** the system SHALL NOT send a signal to that (possibly recycled) process group

### Requirement: Running state is runtime-only and not persisted
The pane running state, captured process groups, and running badges SHALL be runtime-only and SHALL NOT be
persisted. After an application relaunch, panes SHALL come back not running (their PTYs and captured groups do not
survive a relaunch), with normal command prompts, until a new command is run.

#### Scenario: Running state does not survive relaunch
- **WHEN** the application is relaunched while a server had been running
- **THEN** the restored panes SHALL show the normal prompt and no running badge until a command is run again
