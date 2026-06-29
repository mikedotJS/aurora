## Why

Pressing ⌘A in a pane should select the command you're currently typing — the way ⌘A works in any text field — so you can replace it, clear it, or copy it in one stroke. Today Aurora has no ⌘A handler, so the keystroke falls through to the webview's native Select All, which grabs the whole pane output (scrollback) instead of just the line you're editing.

## What Changes

- Add a **⌘A handler** that selects the active pane's current prompt input (everything you've typed on the line), not the output/scrollback.
- Make the selected input behave **like a real text field**: typing a character replaces the whole selection, Backspace/Delete clears it, ⌘C copies it, and pressing an arrow or continuing to type collapses the selection.
- **Visually highlight** the selected input text so the selection is obvious; hide the blinking caret and ghost-autocomplete while the input is fully selected.
- **Prevent** the webview's native Select All for ⌘A so it can never select the whole output again.
- Leave real inputs (search field, settings) and full-screen programs (xterm raw mode) untouched — their own ⌘A/selection still applies.

## Capabilities

### New Capabilities
- `prompt-select-all`: ⌘A selection of the pane's prompt input — what gets selected, how the selection is rendered, and how typing / delete / copy / navigation act on it.

### Modified Capabilities
<!-- None — additive prompt-editing behavior; no existing capability spec changes. -->

## Impact

- **Frontend**: `src/lib/keymap.ts` (`handleKeyDown` — add a ⌘A branch that selects the input and `preventDefault`s native Select All; make the printable-key, Backspace/Delete, ⌘C, and arrow branches selection-aware). `src/state/store.ts` (per-pane `inputSelected` flag + action; clear it on any input mutation). `src/components/Pane.tsx` (render the input with a selection highlight and suppress caret/ghost while selected).
- **No backend changes**; copy uses `navigator.clipboard.writeText` (mirroring the existing paste path).
- **Out of scope**: selecting scrollback/output text (drag-select + native ⌘C still works); selection while a full-screen program owns the pane (xterm raw mode).
