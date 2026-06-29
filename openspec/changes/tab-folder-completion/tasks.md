## 1. Backend: hidden-folder support in readdir

- [x] 1.1 Add an optional `include_hidden: bool` (default `false`) param to `list_dir` in `src-tauri/src/sys.rs`; when true, do not skip dot-prefixed entries. Keep dirs-first sort and existing behavior when the flag is absent/false.
- [x] 1.2 `cargo build` clean; confirm existing `dirNames` caller still compiles (the new arg is optional/defaulted).

## 2. Frontend plumbing: listDir wrapper + token parsing

- [x] 2.1 Update `listDir` in `src/lib/sys.ts` to accept an optional `includeHidden` flag and pass it through to the `list_dir` invoke; keep the `.catch(() => [])` fallback and `DirEntry[]` return type.
- [x] 2.2 In `src/lib/commands.ts` add `splitPathToken(input, caretPos)` → `{ tokenStart, base, leaf }`: locate the whitespace-delimited token at the caret, split on its last `/` into base + leaf (no `/` → base `"."`, leaf = token), and flag whether the token is a path argument (not first word, or contains `/`, `~`, or a leading `.`/`..`).
- [x] 2.3 In `src/lib/commands.ts` add `folderCandidates(entries, leaf)` (filter `is_dir` entries whose name starts with `leaf`, honoring case) and `commonPrefix(names)` for the longest shared prefix.

## 3. State: completion list on the pane

- [x] 3.1 Add `completion: { items: DirEntry[]; index: number; tokenStart: number; base: string } | null` to `PaneState` in `src/state/store.ts` (initialize `null` in pane factory ~229).
- [x] 3.2 Add actions `openCompletion`, `moveCompletion(delta)` (wrap index), `acceptCompletion` (insert highlighted name + `/` at `tokenStart`, replacing the leaf), and `closeCompletion`.
- [x] 3.3 Clear `completion` in `setInput`, `histNav`, `setSuggestion`, and `setPendingFix` alongside the existing ghost/suggestion resets.

## 4. Keymap: Tab folder-completion + list navigation

- [x] 4.1 Rewrite the normal-mode Tab handler in `src/lib/keymap.ts` (307-316) to the precedence in design D4: pendingFix → completion-list-open accept → path-token folder completion → ghost accept → no-op.
- [x] 4.2 Implement the folder-completion step: compute `splitPathToken`; if path arg, call `listDir(base, leaf.startsWith("."))`, capture `(paneId, input, caretPos)`, and on resolve (with freshness guard) apply: 0 matches → no-op (fall through); 1 → inline-complete name + `/`; >1 → complete `commonPrefix` then `openCompletion`.
- [x] 4.3 Add list-open key routing: ↑/↓ → `moveCompletion`, Tab/↵ → `acceptCompletion` (must NOT submit the command), Esc → `closeCompletion`; any text/Backspace edit closes (or refilters) the list. Resolve the base directory against the pane `cwd`.

## 5. UI: completion list popover

- [x] 5.1 In `src/components/Pane.tsx`, render the completion popover anchored under the prompt when `pane.completion` is set, reusing SuggestionCard styling (~431-521) and `tokens.css`; show each folder name with a trailing `/`, highlight the active row, and a footer hint (`⇥/↵ select · esc dismiss`).
- [x] 5.2 Cap the rendered list length and indicate truncation when there are more matches than shown.

## 6. Validation

- [ ] 6.1 Manually verify each spec scenario: no-ghost listing, unique inline complete, ambiguous list, common-prefix complete, no-match no-op, nested `src/com`, hidden excluded by default, `.gi`→`.git/`, list nav/accept/dismiss without submitting, pendingFix wins, non-path ghost still accepts on Tab, `→` still accepts ghost.
- [x] 6.2 `bun run lint`, `bun run build`, and `cargo build` all clean.
