## Context

Aurora's prompt is not a real `<input>` — `pane.input` is a string in the Zustand store, rendered in `Pane.tsx` as `<span>{pane.input}</span>` followed by a fake blinking caret and faint ghost-autocomplete. All editing flows through the window-level `handleKeyDown` in `keymap.ts`: a printable key appends (`input + k`), Backspace trims the last char (`input.slice(0, -1)`), Escape clears, ↑/↓ navigate history. There is no caret position — the caret is always at the end.

`handleKeyDown` returns early when the focused element is an `INPUT`/`SELECT`/`TEXTAREA`, so real inputs (MR search, settings) and the xterm textarea (raw mode) keep their own ⌘A. For the prompt, focus sits on the non-editable `#aurora-root`, so ⌘A currently hits the webview's native Select All and highlights the whole document/output.

Because the input is append-only state, "select all + edit like a real field" can't lean on the browser's input selection — it needs an explicit selection flag and selection-aware editing branches.

## Goals / Non-Goals

**Goals:**
- ⌘A selects the entire current prompt input of the active pane, and nothing else.
- Selected input behaves like a real field: printable key replaces, Backspace/Delete clears, ⌘C copies, arrow/typing collapses.
- The selection is visually obvious; caret and ghost are hidden while selected.
- ⌘A never triggers native Select All of the output again (always `preventDefault`).

**Non-Goals:**
- A full caret/cursor model (mid-line insertion, partial selection, shift-arrow ranges). The prompt stays append-only; selection is all-or-nothing.
- Selecting scrollback/output text — drag-select + native ⌘C already cover that.
- Changing selection behavior inside real inputs or xterm raw mode.

## Decisions

### 1. Per-pane `inputSelected` boolean in the store
Add `inputSelected: boolean` to `PaneState` (default `false`) and a `selectAllInput(paneId)` action that sets it `true` only when `pane.input` is non-empty. An explicit flag (not a DOM `Selection`) survives React re-renders and is the single source of truth the editing branches read. **Alternative considered:** create a real DOM `Range` over the input span so native ⌘C works — rejected because the span re-renders on every keystroke (the selection would vanish) and it still wouldn't give type-to-replace.

### 2. Clear the flag on every input mutation, centrally
`setInput` already funnels all text changes; add `inputSelected: false` to its patch so any normal typing/paste/ghost-accept/history-nav (all of which call `setInput`) collapses the selection automatically. Only `selectAllInput` sets it `true`. This keeps the invariant "selection is valid only until the text changes" without sprinkling resets across call sites.

### 3. Selection-aware editing branches in `handleKeyDown`
With `pane.inputSelected` true:
- **Printable key** (`k.length === 1`, no Alt) → `setInput(pane.id, k)` (replace), which also clears the flag.
- **Backspace / Delete** → `setInput(pane.id, "")`.
- **⌘C** → `navigator.clipboard.writeText(pane.input)` (mirrors the existing `pasteClipboard` helper); keep the selection.
- **Arrows** → collapse the selection (set flag false) without other side effects; ↑/↓ then no longer jump history on the same press (one press to deselect).
- **Enter** → submit as today (the flag is moot; `setInput("")` on submit clears it).
The ⌘A branch lives in the existing `e.metaKey` block and **always** calls `preventDefault()` — even when the input is empty — so native Select All can never run. Guard `selectAllInput` behind `!s.keyEntry` so ⌘A never highlights the masked API key.

### 4. Render the selection in `Pane.tsx`
When `pane.inputSelected`, wrap the input text in a highlight (`background: color-mix(in oklab, var(--ac) 32%, transparent)`, matching the `::selection` token and xterm's selection color) and do not render the blinking caret or the ghost span. When not selected, render exactly as today.

## Risks / Trade-offs

- **[Native ⌘C copies an empty/stale DOM selection instead of the input]** → We intercept ⌘C only when `inputSelected` and write `pane.input` explicitly; otherwise ⌘C falls through to native copy for drag-selected output.
- **[Arrow press both deselects and navigates, surprising the user]** → On a press while selected, arrows only collapse the selection; history/ghost actions need a second press. Predictable and matches "a selection eats the first arrow."
- **[⌘A leaks into key-entry and selects the secret]** → `selectAllInput` is guarded by `!s.keyEntry`; ⌘A there just `preventDefault`s.
- **[Ghost autocomplete reappears mid-selection and clutters the highlight]** → Ghost and caret are suppressed in the selected render branch, so the highlight is clean.
