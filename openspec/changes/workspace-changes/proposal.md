## Why

A workspace exists to ship a change, and the rail already advertises each workspace's diff (`+128
−34`). Frames 11–13 turn that number into a destination: an in-app **Changes view** that shows the
workspace's diff **against its base branch** — a changed-files list (staged / unstaged, with per-file
±counts and A/M/D/R status), a **unified** diff pane, and a **split** side-by-side pane (base left,
working tree right) — plus staging, discard, and an "Open MR" affordance. It's reachable three ways:
the rail card's diff counts, a Terminal↔Changes view toggle (⌥⌘D), and the status-bar change counter
(⌘G). This keeps review in the terminal where the work happens, instead of bouncing to a browser.

## What Changes

- **Changes view** as a per-pane view mode: each pane can show **Terminal** (today) or **Changes**.
  A view toggle in the tab strip flips the active pane; ⌥⌘D toggles it.
- **Changed-files list**: computed from `git status` + `git diff` against the workspace's base branch;
  grouped into **Staged** and **Changes (unstaged)**; each row shows status letter (A/M/D/R), file
  path, directory, and ±line counts. Selecting a file shows its diff.
- **Unified diff pane**: hunks with `@@` headers, old/new line numbers, and +/− line coloring.
- **Split diff pane**: two synchronized columns — base (`⎇ <base> · base`) on the left, working tree
  (`⎇ <branch> · working tree`) on the right — with padding for added/removed lines and per-side line
  numbers. A per-file toggle switches Unified ↔ Split.
- **Actions**: Stage / Discard per file and Stage all; an "Open MR" button that hands off to the
  existing GitLab MR flow (creates/opens the MR for the workspace's branch).
- **Entry points**: clicking a rail card's ±counts, the tab-strip view toggle (⌥⌘D), and the
  status-bar counter (⌘G) all open Changes for the relevant workspace.

## Capabilities

### New Capabilities
- `workspace-changes`: the in-app Changes view — base-branch diff computation, the staged/unstaged
  changed-files list, unified and split diff rendering, per-file stage/discard + stage-all, the Open
  MR handoff, and the three entry points (rail counts, view toggle, status-bar counter).

### Modified Capabilities
<!-- Extends `workspaces` (rail card counts become a door) and the terminal pane (a Changes view mode).
     Both are introduced by in-progress changes not yet archived to openspec/specs/, so these are new
     requirements here rather than deltas. -->

## Impact

- **Frontend (`src/`)**: new `components/ChangesView.tsx` (files list + diff pane) and
  `components/Diff.tsx` (unified + split renderers); `lib/diff.ts` parses `git diff` unified output
  into files→hunks→lines; pane state gains `view: "terminal" | "changes"`; `PaneGrid`/`Pane` render the
  Changes view when selected; `StatusBar` counter and rail counts become clickable; `keymap` gains
  ⌥⌘D and ⌘G.
- **Backend (`src-tauri/src/git.rs`)**: add `git_changed_files(dir, base)` (status + numstat vs base),
  `git_diff_file(dir, base, path, staged)` (unified patch text), `git_stage(dir, path)` /
  `git_unstage(dir, path)` / `git_discard(dir, path)` (`add` / `restore --staged` / `restore` /
  `checkout`), and `git_stage_all(dir)`.
- **Reuses**: the existing `glab` MR flow for "Open MR" (status-bar MR entry / `MrSheet`); the
  workspace's `baseBranch` from `workspaces-core`.
- **Depends on**: `workspaces-core`. **Complements**: `workspace-create`.
