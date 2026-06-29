## Why

There's no way to find text in a pane's scrollback — on a long session you're stuck scrolling and eyeballing. ⌘F is the universal "find in this view" gesture and today does nothing in Aurora (no handler; the webview has no native find UI). Adding find-in-output makes long output navigable.

## What Changes

- Add a **⌘F find bar** for the active pane: a small overlay with a search field, a match counter (e.g. `3/12`), previous/next controls, and close.
- **Search the active pane's command-block output** as you type (case-insensitive), **highlight every match** in place, emphasize the **current** match, and **scroll it into view**.
- **Navigate** matches with Enter / Shift-Enter (and ↑/↓), wrapping around; **Esc** closes the find bar and clears highlights.
- Consume ⌘F so the webview's default does not interfere; leave other inputs (prompt, search fields) and full-screen programs (xterm raw mode) untouched.
- **Build the find-bar UI with the `frontend-design` skill** so it's polished and on-brand (Aurora oklch tokens, Geist, existing card/overlay vocabulary) rather than generic.

## Capabilities

### New Capabilities
- `output-search`: find-in-output for a pane — opening/closing the find bar, live case-insensitive matching across the scrollback, match highlighting (all + current), match-count display, and next/previous navigation with scroll-into-view.

### Modified Capabilities
<!-- None — additive; no existing capability spec changes. -->

## Impact

- **Frontend**: new find-bar component in `src/components/` (designed via the `frontend-design` skill). `src/components/Pane.tsx` / `BlockView` (highlight matched substrings while preserving ANSI styling; mark + scroll the current match). `src/state/store.ts` (find state: open flag, query, current-match index — scoped to the active pane). `src/lib/keymap.ts` (⌘F opens the find bar and `preventDefault`s; Esc/Enter/Shift-Enter handled by the bar).
- **No backend changes**; matching runs over the already-rendered block text in the webview.
- **Out of scope**: regex/whole-word/replace, searching across panes/tabs at once, and find inside a full-screen (xterm) program.
