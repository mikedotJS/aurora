## MODIFIED Requirements

### Requirement: Command palette switches and creates workspaces
Aurora SHALL provide a command palette, opened with ⌘K (and from the rail and switcher create
affordances), that both switches to an existing workspace and creates a new one. As the user types, the
palette SHALL filter existing workspaces (by issue key, title, or branch) for switching, and SHALL always
offer a "create new workspace" region listing the available sources. ↑/↓ SHALL move the selection, ↵ SHALL
activate it (switch to a matched workspace, or create from a source against the **pinned target repo**
using the source's resolved defaults), ⇥ SHALL open the scope form for the selected source, and Esc SHALL
close the palette. Typing SHALL NOT change the pinned target repo.

#### Scenario: Filter to switch
- **WHEN** the user opens the palette and types text matching an existing workspace's title
- **THEN** that workspace SHALL be listed and pressing ↵ on it SHALL switch to it without creating anything

#### Scenario: Create with defaults applies the full preset and runs the on-open script
- **WHEN** the user selects a create source and presses ↵
- **THEN** Aurora SHALL create the workspace in the pinned target repo using the source's resolved defaults — applying the preset's pane layout, `env`, and port offset, and running the preset's on-open script — without first showing the scope form

#### Scenario: Edit scope before creating
- **WHEN** the user selects a create source and presses ⇥
- **THEN** the scope form SHALL open prefilled for that source against the pinned target repo, and no workspace SHALL be created until the user confirms

#### Scenario: Target survives the first keystroke
- **WHEN** the palette is opened with an explicit target repo (the rail's repo "+" or empty-card "+") and the user types one or more characters
- **THEN** the pinned target repo SHALL remain that repo, and a subsequent ↵ create SHALL land in it rather than falling back to the active or first repo

## ADDED Requirements

### Requirement: Pinned, visible, changeable create target
The command palette SHALL display the target repo — the repo a new workspace would be created in — as a
persistent chip, for every entry point (rail repo "+", empty-card "+", switcher "+", ⌘K). The chip SHALL
show the **resolved** target: an explicitly-pinned repo when one was supplied, otherwise the active
workspace's repo. When more than one repo exists, the chip SHALL let the user change the target, and the
chosen repo SHALL become the pinned target without resetting the typed query or selection. When more than
one repo exists and there is no active workspace to default to, the palette SHALL require an explicit repo
choice and SHALL NOT create until one is made. When no repo exists at all, the palette SHALL show its
"open a git repository" state.

#### Scenario: Resolved target is always shown
- **WHEN** the palette is open with at least one repo
- **THEN** a target chip SHALL display the repo that a create would use (the pinned repo, else the active workspace's repo)

#### Scenario: Changing the target preserves the query
- **WHEN** the user has typed a branch name and then picks a different repo in the target chip
- **THEN** the pinned target SHALL become the picked repo and the typed query and selection SHALL be unchanged

#### Scenario: No usable context forces an explicit choice
- **WHEN** more than one repo exists, no workspace is active, and the user opens the palette
- **THEN** the chip SHALL show an unselected "choose repo" state and create SHALL be blocked until the user picks a repo

### Requirement: One creation path — quick and scope-form are equivalent
There SHALL be a single way a workspace's creation spec is assembled, so the quick (↵) path and the scope
form produce the **same** workspace setup for the same inputs. For identical source, branch, base, and
preset, both paths SHALL resolve the same base branch, the same preset pane layout / `env` / port offset,
and the same on-open script. The quick path SHALL NOT silently drop the on-open script, the preset `env`,
or the port offset.

#### Scenario: Quick create runs the on-open script
- **WHEN** the user creates a workspace via ↵ from the palette for a preset that defines an on-open script
- **THEN** that on-open script SHALL run once the workspace's panes are ready, exactly as it would if created from the scope form

#### Scenario: Quick and form yield the same setup
- **WHEN** a workspace is created from source `branch` with the same branch, base, and preset via ↵ versus via the scope form
- **THEN** both workspaces SHALL receive the same preset pane layout, the same `env` (including the exported port offset), and the same on-open script

### Requirement: A one-keystroke create shows its defaults first
For any source that creates on ↵ without opening the scope form, the palette SHALL show, before the
keystroke, the defaults that create will use: the base branch, the preset, and the on-open script (or an
explicit "none"). These SHALL be the same values the creation spec resolves.

#### Scenario: Defaults visible before pressing Enter
- **WHEN** an instant-create source (e.g. "new branch" or "clone") is listed in the palette
- **THEN** its row SHALL show the resolved base branch, preset, and on-open script (or "on-open: none") that ↵ would apply
