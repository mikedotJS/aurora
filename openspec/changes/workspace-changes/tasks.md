## 1. Backend diff/staging (`src-tauri/src/git.rs`)

- [x] 1.1 `git_changed_files(dir, base) -> Vec<ChangedFile{path,old_path?,status,staged,added,removed}>` from `status --porcelain=v1 -z` + `diff --numstat` (worktree, cached, and `<base>...HEAD`).
- [x] 1.2 `git_diff_file(dir, base, path, mode)` → unified patch text for mode `worktree`|`staged`|`base`.
- [x] 1.3 `git_stage(dir,path)`, `git_unstage(dir,path)`, `git_stage_all(dir)`, `git_discard(dir,path,status)` (restore/checkout; delete untracked).
- [x] 1.4 (Open MR) add `glab_mr_create(dir, branch)` in `glab.rs` (or reuse list + open URL). Register all in `lib.rs`; `cargo build` clean.

## 2. Frontend bridges + parsing

- [x] 2.1 `lib/sys.ts`/`lib/git.ts`: wrappers `gitChangedFiles`, `gitDiffFile`, `gitStage`/`gitUnstage`/`gitStageAll`/`gitDiscard` with types + `.catch` fallbacks.
- [x] 2.2 `lib/diff.ts`: parse unified diff → `DiffFile{hunks:[{header,oldStart,newStart,lines:[{kind,oldNo,newNo,text}]}]}`; add `pairForSplit(hunk)` → rows `{left,right}` aligning `-`/`+` runs with null padding.

## 3. State

- [x] 3.1 Add `view: "terminal" | "changes"` to `PaneState` (default `terminal`) + `setPaneView(paneId, view)`.
- [x] 3.2 Add `openChanges(wsId?)`: optionally switch workspace, then set active pane `view = "changes"`.

## 4. UI

- [x] 4.1 `components/Diff.tsx`: `UnifiedDiff` (line-number gutters, +/− tinting, hunk bands) and `SplitDiff` (two columns from paired rows, synced scroll, per-side numbers); tokens-based colors.
- [x] 4.2 `components/ChangesView.tsx`: files list (Staged/Changes sections, status letter, path/dir, ±counts), diff pane with file header (Unified|Split toggle, Stage/Discard), footer summary + Stage all + ⇋ Open MR.
- [x] 4.3 `Pane`/`PaneGrid`: render `<ChangesView>` when `pane.view === "changes"`, else the terminal; add the `Terminal | Changes` toggle to the tab strip / pane header.
- [x] 4.4 Make rail card ±counts (workspaces-core) and the status-bar counter clickable → `openChanges`.
- [x] 4.5 Discard confirmation prompt before destructive revert.

## 5. Keymap

- [x] 5.1 `lib/keymap.ts`: ⌥⌘D toggles active pane view; ⌘G opens Changes on the active pane.

## 6. Validation

- [ ] 6.1 Manually verify: pane toggle terminal↔changes (session intact); split shows term+diff together; staged/unstaged grouping + ±counts + summary; select file shows diff; unified coloring; split alignment + synced scroll; stage/unstage/stage-all refresh; discard confirms; Open MR existing vs create + graceful degrade; all three entry points (rail counts switch+open, toggle, status bar/⌘G).
- [x] 6.2 `bun run lint`, `bun run build`, `cargo build` clean.
