<!-- New capability: workspace-teardown. All requirements are ADDED (no prior baseline). -->

## ADDED Requirements

### Requirement: Closing a pane kills its shell's whole process group
When a pane's terminal is torn down, Aurora SHALL terminate not only the pane's shell but the entire
process group the shell leads — so a dev server (or any child) the shell started is stopped, never
orphaned. Aurora SHALL signal the group gracefully first (SIGHUP, so an interactive shell hangs up
and forwards the hangup to its jobs) and SHALL escalate to SIGKILL after a short grace period for any
process that ignored the graceful signal. Aurora SHALL also signal the terminal's current
**foreground** process group (the active job), in case the shell placed that job in its own group.
Aurora SHALL never signal process group id `0`, `1`, or its own group.

#### Scenario: A foreground dev server is stopped when its pane closes
- **WHEN** a pane is running a dev server in the foreground and the pane (or its tab/workspace) is closed
- **THEN** the dev server process and its children SHALL be sent SIGHUP and, if still alive after the grace period, SIGKILL — so the process and its listening port are released

#### Scenario: The shell is given a chance to hang up its jobs
- **WHEN** a pane's process group is torn down
- **THEN** the shell SHALL receive SIGHUP (not an immediate SIGKILL), so it can forward the hangup to its jobs, before any SIGKILL escalation

#### Scenario: Teardown never signals init or Aurora itself
- **WHEN** the captured process group id is missing, `0`, `1`, or equal to Aurora's own process group
- **THEN** Aurora SHALL NOT send a group signal for that id, falling back to killing only the shell process when no valid group id was captured

### Requirement: Deleting a workspace tears it down in order
Aurora SHALL provide a workspace **delete** operation that runs a fixed, dependency-correct sequence:
(1) kill the process group of **every** pane in the workspace (across all its tabs), (2) for a
worktree-backed workspace, remove its git worktree directory (forced, since a process may still hold
the cwd), (3) optionally delete its branch when explicitly requested, then (4) drop the workspace from
the store and re-point the active workspace to a remaining one. If removing the worktree fails, Aurora
SHALL surface the error and SHALL NOT drop the workspace from the store (so no directory is orphaned
without a way to retry).

#### Scenario: Worktree-backed workspace is fully removed
- **WHEN** the user deletes a worktree-backed workspace whose panes are running processes
- **THEN** Aurora SHALL kill those process groups, then remove the worktree directory, then remove the workspace card and activate a neighbouring workspace

#### Scenario: Worktree removal failure keeps the card
- **WHEN** deleting a workspace and `git worktree remove` fails
- **THEN** Aurora SHALL report the failure and SHALL keep the workspace in the rail rather than dropping it

#### Scenario: Manual lane needs no worktree removal
- **WHEN** the user deletes a manual lane (no owning repo) or a workspace whose directory is the repo's main checkout
- **THEN** Aurora SHALL kill its process groups and drop it from the store **without** invoking worktree removal

### Requirement: Destructive guards on delete
Aurora SHALL protect the user from destructive deletes. It SHALL never delete the **last** remaining
workspace (the app must always have at least one). It SHALL never remove the repository's **main
checkout** as if it were a worktree. Before deleting a worktree-backed workspace, Aurora SHALL check
the worktree's git state and, when there are **uncommitted** changes or **unpushed** commits, warn the
user with that specific state and require an explicit confirmation; a cancel SHALL abort with no
change.

#### Scenario: Last workspace cannot be deleted
- **WHEN** only one workspace remains
- **THEN** the delete affordance SHALL be unavailable and the delete operation SHALL refuse, leaving the workspace intact

#### Scenario: Main checkout is protected
- **WHEN** the workspace's directory is the repository's primary checkout
- **THEN** Aurora SHALL NOT offer worktree removal for it and SHALL NOT delete the checkout directory

#### Scenario: Dirty or unpushed work is confirmed
- **WHEN** the user triggers delete on a worktree with uncommitted changes or commits not pushed to its upstream
- **THEN** Aurora SHALL present a confirmation naming the uncommitted/unpushed state, and SHALL proceed only on explicit confirmation

#### Scenario: Cancelling the confirmation changes nothing
- **WHEN** the user cancels the destructive confirmation
- **THEN** no process SHALL be killed, no worktree removed, and the workspace SHALL remain

### Requirement: Optional branch deletion
Aurora SHALL support optionally deleting the workspace's git branch as part of teardown, but only when
the user explicitly opts in. Branch deletion SHALL be off by default and SHALL run only **after** the
worktree is removed (git refuses to delete a branch still checked out in a worktree).

#### Scenario: Branch deleted only on opt-in, after the worktree
- **WHEN** the user deletes a workspace and explicitly chooses to also delete its branch
- **THEN** Aurora SHALL remove the worktree first and then delete the branch; when the user does not opt in, the branch SHALL be left intact

### Requirement: Quitting the app stops all workspace processes
When Aurora exits, it SHALL tear down the process groups of **all** live PTY sessions so no dev server
or other child process is leaked after the app closes. The quit-time teardown SHALL be bounded in time
(a single short graceful interval then a hard kill) so quitting stays responsive.

#### Scenario: Running servers are stopped on quit
- **WHEN** the user quits Aurora while one or more workspaces have running dev servers
- **THEN** Aurora SHALL signal every PTY session's process group (graceful then hard) before the process exits, so no server keeps running and no port stays bound

### Requirement: Rail delete affordance
The workspace rail SHALL expose a delete control on each workspace card (for example revealed on
hover), which does not trigger a workspace switch. Activating it SHALL run the destructive-confirm
flow and, on confirmation, the delete operation. The control SHALL be hidden or disabled when the
workspace cannot be deleted (the last workspace, or the main checkout).

#### Scenario: Delete from the card without switching
- **WHEN** the user activates the delete control on a workspace card
- **THEN** the workspace SHALL NOT become active merely from that click, and the destructive-confirm flow SHALL run

#### Scenario: No delete control where delete is forbidden
- **WHEN** a card represents the last workspace or the repository's main checkout
- **THEN** that card SHALL NOT present an enabled delete control
