## Context

A pane's output is React-owned DOM: `Pane.tsx`'s `BlockView` turns each block's captured output into lines via `ansiToLines` (`Seg[][]`, each `Seg = { text, style }`), rendered as `<div>` lines of styled `<span>`s inside the `.ascroll` scroll container (`scrollRef`). The prompt and cards live in the same scroll flow. Keyboard input is captured by the window-level `handleKeyDown` in `keymap.ts`, which returns early when the focused element is an `INPUT`/`SELECT`/`TEXTAREA` (so the find bar's own field keeps its keys) and when a panel/modal is open. ⌘F is currently unhandled.

Because the output is our own DOM (not xterm in normal mode), we can highlight matches by re-rendering segments — no native find needed. The only subtlety is preserving ANSI colors while overlaying highlight on matched substrings that may cross segment boundaries.

## Goals / Non-Goals

**Goals:**
- ⌘F opens a polished, on-brand find bar over the active pane; Esc closes and clears.
- Live, case-insensitive matching over the active pane's blocks; highlight all matches, emphasize the current one, scroll it into view.
- Next/previous (Enter / Shift-Enter, ↑/↓) with wrap-around and a `current/total` counter.
- ANSI colors preserved under highlights; consuming ⌘F so the webview default never interferes.

**Non-Goals:**
- Regex, whole-word, or replace; multi-pane/tab search; find inside xterm raw mode.
- A persistent search index — matching is recomputed from rendered text (output is bounded by what's on screen/in scrollback state).

## Decisions

### 1. Find state is global, scoped to the active pane
Add `find: { open: boolean; query: string; current: number }` to the store (single instance, applies to the active pane) with actions `openFind` / `closeFind` / `setFindQuery` / `stepFind(dir)`. One find session at a time matches the single-active-pane model and keeps state simple; switching panes or closing resets it. **Alternative considered:** per-pane find state on `PaneState` — rejected as overkill for a transient overlay; nothing needs to persist per pane.

### 2. Matching + the match list are derived in the component, not stored
The find bar / pane computes matches with `useMemo` from `query` + the active pane's blocks: walk each block's `ansiToLines`, and for each line record matches (block id, line index, start/end offsets) via case-insensitive `indexOf` scanning. `find.current` indexes this flat list and is clamped when the list changes; `stepFind` moves it with wrap-around. Storing only `current` (not the list) avoids stale match data in the store.

### 3. Highlight by re-segmenting lines against match ranges (preserve ANSI)
When a query is active, `BlockView` renders each line by intersecting the line's match ranges with its `Seg`s: for each segment, split its text at any overlapping match boundaries and render matched slices with the segment's own `style` plus a highlight background (current match gets a stronger "active" style). Tracking a running character offset across segments makes this correct even when a match spans differently-styled segments. **Alternative considered:** `window.find()` / native selection — rejected (non-standard, flaky in WKWebView, no control over styling or counting).

### 4. Scroll the current match into view via a ref/id
The current match's element gets a marker (e.g. `data-find-current` or a ref) and is `scrollIntoView({ block: "nearest" })`'d in an effect whenever `find.current` or the query changes, so navigation reveals off-screen matches. This composes with the existing auto-scroll-to-bottom effect (find scroll only runs while the bar is open).

### 5. Keyboard wiring
`handleKeyDown` gains ⌘F → `e.preventDefault()` + `openFind()` (focus the field). Esc/Enter/Shift-Enter/↑/↓ are handled on the find bar's input (the window handler already ignores `INPUT` targets), calling `stepFind`/`closeFind`. ⌘F is added before the generic `e.metaKey` fallthrough.

### 6. Build the UI with the `frontend-design` skill
The find bar is a small but visible piece of chrome; implement it via the `frontend-design` skill so it reads as intentional — anchored top-right of the active pane, using Aurora's oklch tokens, Geist Mono/Sans, and the existing overlay/card vocabulary (cf. `MrSheet`, `SuggestionCard`), with a clear active-match accent and a compact counter. Keep it within the project's plain/module-CSS-in-JS convention (no Tailwind).

## Risks / Trade-offs

- **[Highlighting across many large blocks re-renders on each keystroke]** → Matching is O(text) and memoized; only the active pane's blocks are scanned, and rendering only re-segments lines that contain matches. Debounce only if profiling shows jank.
- **[A match spanning a style boundary loses one side's color]** → The offset-walk re-segmentation applies the original per-segment style to each slice, so colors are preserved across the boundary.
- **[Find bar overlaps output it's searching]** → Anchor it top-right with a small footprint; scroll-into-view uses `block: "nearest"` so the current match isn't hidden behind the bar (add top padding/scroll margin if needed).
- **[⌘F leaking while a full-screen program runs]** → In raw mode the xterm textarea is focused, so `handleKeyDown` returns early; the find bar is not offered there.
