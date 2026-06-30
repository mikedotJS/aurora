# Design — workspace-changes

## D1 · Changes as a pane view mode

The cleanest fit with the existing pane model: each pane gains `view: "terminal" | "changes"`
(default `"terminal"`). When `"changes"`, the pane renders `<ChangesView>` instead of the
scrollback/prompt; the PTY keeps running underneath (toggling back shows live output). Toggle in the
tab strip ("Terminal | Changes") and via ⌥⌘D acts on the **active pane**. ⌘G and the rail-count /
status-bar entry points set the active pane to `"changes"` (creating no new pane). This keeps the
Changes view per-pane so a 2-split can show terminal + diff side by side.

State: add `view` to `PaneState` and a `setPaneView(paneId, view)` action. The diff is always computed
for the **workspace** (its `dir` + `baseBranch`), not per-pane.

## D2 · Backend diff (`src-tauri/src/git.rs`)

All run in the workspace `dir`, PATH-augmented.

- `git_changed_files(dir, base) -> Vec<ChangedFile{ path, old_path?, status, staged, added, removed }>`
  - `git status --porcelain=v1 -z` → staged vs unstaged + status letter (A/M/D/R/??); rename → `old_path`.
  - `git diff --numstat <base>...HEAD` and `git diff --numstat` / `--cached --numstat` for ±counts.
  - Merge into one list flagged `staged`. Binary files report `added/removed = null`.
- `git_diff_file(dir, base, path, mode) -> String` — unified patch text:
  - `mode = "worktree"` → `git diff -- <path>` (unstaged), `"staged"` → `git diff --cached -- <path>`,
    `"base"` → `git diff <base>...HEAD -- <path>` (the full workspace diff, for review).
  - Returns the raw unified diff; the frontend parses it (D3).
- `git_stage(dir, path)` = `git add -- <path>`; `git_unstage(dir, path)` = `git restore --staged -- <path>`;
  `git_stage_all(dir)` = `git add -A`.
- `git_discard(dir, path, status)` — for modified/deleted: `git restore -- <path>` (and
  `restore --staged` if also staged); for untracked: delete the file. Destructive → the UI confirms first.

## D3 · Diff parsing (`src/lib/diff.ts`)

Parse unified diff text into a structure the renderers consume:
```ts
interface DiffFile { path: string; hunks: Hunk[] }
interface Hunk { header: string; oldStart: number; newStart: number; lines: DiffLine[] }
interface DiffLine { kind: " " | "+" | "-"; oldNo: number | null; newNo: number | null; text: string }
```
Parser walks `@@ -a,b +c,d @@` headers, tracking old/new line numbers; ` `=context (both numbers),
`-`=removed (old only), `+`=added (new only). For **split** view we pair lines: walk the hunk and emit
rows `{ left: DiffLine|null, right: DiffLine|null }` — a run of `-` lines aligns against the following
run of `+` lines (zip by index; pad the shorter side with `null`), context lines occupy both sides.

## D4 · Rendering (`components/Diff.tsx`, `ChangesView.tsx`)

- `ChangesView` layout: left **files list** (Staged section, Changes section; each row: status letter
  in a status color, filename, dim directory, ±counts), right **diff pane** with a file header
  (status + path + ±, `Unified | Split` toggle, `Stage`/`Discard`), and a footer summary
  (`N files · +A −B`) with `Stage all` + `⇋ Open MR`.
- `Unified`: single column; per row a left gutter with old+new line numbers (tabular-nums) and the
  text, background tinted by kind (`--err` wash for `-`, `--ac`/green wash for `+`). Hunk headers in a
  faint band.
- `Split`: two columns from the paired rows; left tinted red for removed, right tinted green for added,
  blank padding cells where one side is absent; line numbers per side. Scroll is synchronized by
  sharing one scroll container (the two columns live in one grid) so they can't desync.
- Colors reuse tokens: removed `--err`, added a green derived from `--ac`/`--acd` (the mockup uses the
  accent family for additions), context `--fg`/`--dim`, gutters `--faint`.

## D5 · Entry points

- **Rail card counts** (`workspaces-core` rendered them inert): clicking the ±counts calls
  `openChanges(wsId)` = switch to that workspace + `setPaneView(activePane, "changes")`.
- **View toggle**: a `Terminal | Changes` control in the tab strip toggles the active pane's `view`.
- **Status bar counter** (`workspaces-core` rendered it inert): click → `setPaneView(active, "changes")`;
  ⌘G in `keymap` does the same.

## D6 · Open MR

"Open MR" reuses the existing GitLab path: if an MR for the branch exists (from `glab_mr_list`), open
its `web_url`; otherwise run `glab mr create` for the branch (a thin new `glab_mr_create(dir, branch)`
wrapper, or open the create URL). Updates the workspace's `mr` field. This is a handoff, not a reimpl
of MR management.

## D7 · Refresh & out of scope
- Diff refreshes when the Changes view mounts, after a stage/discard/stage-all, and on a lightweight
  interval or on focus (no file-watcher in this change). The status-bar/rail counts already refresh via
  `workspaces-core`'s `git_status_summary`.
- Not here: inline comments, hunk-level (partial) staging, conflict resolution UI, syntax highlighting
  of diff bodies. These can be follow-ups.
