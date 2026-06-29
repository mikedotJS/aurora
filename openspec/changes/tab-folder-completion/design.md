## Context

The smart prompt is a React-owned input rendered as DOM spans in `src/components/Pane.tsx`
(prompt block ~242-277), driven entirely by a global keydown handler in `src/lib/keymap.ts`
(normal-mode block ~152-329). Completion today is **ghost-only**: `ghostFor()` in
`src/lib/commands.ts` (100-124) computes a single inline suffix from the cwd's entries
(`ctx.dirNames`), subcommand tables, and history; the Tab handler (keymap 307-316) either applies a
`pendingFix`, accepts the `ghost`, or — when neither exists — **does nothing**.

That "does nothing" path is the gap: for an ambiguous or empty path argument the ghost engine
either produces nothing or silently shows only the first match, so Tab can't list/explore folders
the way a real shell does. The pieces to fix it already exist:
- `src-tauri/src/sys.rs` `list_dir(path)` (98-114) does a real readdir of an arbitrary path,
  expands `~`, returns `DirEntry { name, is_dir }`, dirs-first sorted, hidden excluded.
- `src/lib/sys.ts` `listDir(path): Promise<DirEntry[]>` (14) wraps that command.
- `cwd` is tracked per pane (`PaneState.cwd`) and already feeds `dirNames` via
  `setDirNames` (store ~393-397, refreshed in `App.tsx` 61-75 on cwd change).

## Goals / Non-Goals

**Goals:**
- Make Tab perform real filesystem folder completion on the path token under the cursor, even when
  no ghost/Claude suggestion exists.
- Single match → inline complete; multiple → common-prefix complete then a selectable list; none →
  no-op.
- Support cwd, relative, `../`, `~/`, and absolute base directories; reveal hidden folders only
  when the prefix starts with `.`.
- Preserve all existing prompt behavior (pendingFix, non-path ghost accept, → accepts ghost).

**Non-Goals:**
- Completing plain files (the request is folders; `cat`/`code` file completion is a later
  follow-up). Folder-first only.
- Shell-accurate quoting/escaping of spaces and special characters in folder names (basic handling
  only; see Open Questions).
- Replacing or reworking the ghost engine, Claude suggestion, or typo-fix systems.

## Decisions

### D1: Reuse `list_dir` on-demand rather than extend cached `dirNames`
On Tab, resolve the token's base directory and call `listDir(base)` to get fresh `DirEntry[]`
(which carries `is_dir`), then filter to directories whose name matches the leaf prefix.
- *Why:* `dirNames` is a `string[]` scoped to the **cwd only** and drops the `is_dir` flag, so it
  can neither serve nested paths (`src/com`) nor reliably distinguish folders from files. A direct
  readdir of the resolved base is one cheap local call and keeps a single code path.
- *Alternatives:* (a) Reuse cached `dirNames` for the cwd case only — rejected: two code paths and
  no nested-path support. (b) Add a dedicated `complete_dir` Rust command — rejected: `list_dir`
  already returns exactly what's needed.

### D2: Async fetch with a freshness guard
The keydown handler is synchronous, but `listDir` is async. The Tab handler will fire the fetch and
apply the result via store actions when it resolves, capturing the `(paneId, input, caretPos)` at
request time and discarding the result if the pane's input/caret changed before it returned.
- *Why:* avoids stale completions racing user typing; readdir latency is small but non-zero.
- *Alternative:* synchronously use cached `dirNames` for the no-separator case to feel instant, and
  async only for nested paths. Deferred — keep it uniform for v1; revisit if latency is noticeable.

### D3: Token parsing lives in `commands.ts`
Add a pure helper (e.g. `splitPathToken(input, caretPos)` → `{ base, leaf, tokenStart }` and a
`folderMatches(entries, leaf)` / longest-common-prefix helper). Base resolution: no separator →
base = `.` (cwd); otherwise split on the last `/`, expand a leading `~`, and treat a leading `/` as
absolute. The Rust side resolves `~` and relative paths against the pane cwd passed in.
- *Why:* keeps logic unit-testable and out of the keymap/store; mirrors where `ghostFor` already
  lives.

### D4: Precedence in the Tab handler
Rewrite keymap 307-316 to this order: (1) `pendingFix` → apply; (2) completion list open → accept
highlighted; (3) token is a path argument → run folder completion (which itself decides inline /
list / no-op, and on no-op falls through); (4) `ghost` present → accept ghost; (5) else no-op.
"Path argument" = not the first word (a space precedes the token) **or** the token contains `/`,
`~`, or a leading `.`/`..`. `→` (ArrowRight, keymap 317-323) is unchanged and still accepts ghost.
- *Why:* folders win Tab for path tokens (so an ambiguous prefix lists instead of silently taking
  the first ghost), while command-word/subcommand ghosts (`git stat`→`status`) and pendingFix keep
  their current behavior.

### D5: Completion list state on the pane
Add `PaneState.completion: { items: DirEntry[]; index: number; tokenStart: number; base: string } | null`
with actions `openCompletion`, `moveCompletion(delta)`, `acceptCompletion`, `closeCompletion`.
Clear it wherever the prompt context changes — `setInput`, `histNav`, `setSuggestion`,
`setPendingFix` — alongside the existing ghost/suggestion resets. When the list is open, keymap
routes ↑/↓/Tab/↵/Esc to it (and any text/Backspace edit closes or refilters it).
- *Why:* matches the existing per-pane state pattern (`ghost`, `suggestion`, `pendingFix`) and the
  store's centralized reset points.

### D6: List UI reuses the SuggestionCard visual language
Render the list as a small popover anchored under the prompt in `Pane.tsx`, styled with existing
`tokens.css` values and the SuggestionCard layout (`Pane.tsx` ~431-521): folder names with a
trailing `/`, the active row highlighted, footer hint `⇥/↵ select · esc dismiss`.

### D7: Hidden-folder support is an opt-in readdir flag
Add an optional `include_hidden: bool` parameter to `list_dir` (default false) and the `listDir`
wrapper; the completion path requests hidden entries only when the leaf prefix starts with `.`.
- *Why:* the spec requires `.gi` → `.git/` while keeping `.git` out of a bare `cd ` listing.
- *Alternative:* always return hidden and filter in TS — rejected: would change behavior for the
  existing `dirNames`/ghost consumer of `list_dir`.

## Risks / Trade-offs

- **Stale async result applied after input changed** → freshness guard in D2 (compare captured
  input/caret to current before applying; drop on mismatch).
- **Changing Tab precedence regresses ghost-accept** → D4 only diverts Tab for *path* tokens; a
  non-path token (command word / subcommand) still accepts the ghost; `→` always accepts the ghost.
  Covered by the spec's "Non-path ghost still accepts on Tab" scenario.
- **Very large directories** → readdir returns everything; mitigate by capping the rendered list
  (e.g. first N) and noting truncation, since matches are prefix-filtered anyway.
- **Folder names with spaces/special chars** → inline insertion may produce an unquoted path;
  acceptable for v1 (see Open Questions), and most `cd` targets are space-free.
- **Adding `include_hidden` touches a shared command** → keep it a defaulted optional arg so the
  existing `dirNames` caller is unchanged.

## Open Questions

- Should files (not just folders) be completable for `cat`/`code`/`open`? Deferred to a follow-up;
  v1 is folder-first per the request.
- Do we quote/escape spaces in inserted folder names now, or defer until file completion lands?
- Should a second Tab after a single inline completion immediately list the new directory's
  children (chained drill-down), or require a keystroke first?
