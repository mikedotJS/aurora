## 1. State — input selection flag

- [x] 1.1 Add `inputSelected: boolean` to `PaneState` in `src/state/store.ts` (default `false` in `newPane`).
- [x] 1.2 Add a `selectAllInput(paneId: number)` action that sets `inputSelected: true` only when `pane.input` is non-empty; add it to the `StoreState` interface.
- [x] 1.3 In `setInput`, include `inputSelected: false` in the patch so any text change collapses the selection.

## 2. Keymap — ⌘A and selection-aware editing

- [x] 2.1 In `handleKeyDown` (`src/lib/keymap.ts`), in the `e.metaKey` block add a branch for `k === "a" || k === "A"`: always `e.preventDefault()`; call `s.selectAllInput(pane.id)` unless `s.keyEntry`.
- [x] 2.2 Add ⌘C in the `e.metaKey` block: when `pane.inputSelected && pane.input`, `e.preventDefault()` and `navigator.clipboard.writeText(pane.input)` (keep selection); otherwise let it fall through to native copy.
- [x] 2.3 In the prompt editing branches, when `pane.inputSelected`: printable key (`k.length === 1 && !e.altKey`) → `setInput(pane.id, k)` (replace); Backspace or `Delete` → `setInput(pane.id, "")`.
- [x] 2.4 When `pane.inputSelected`, an arrow key (`ArrowLeft/Right/Up/Down`) collapses the selection (clear the flag) and returns without navigating on that press.

## 3. Render — selection highlight in the prompt

- [x] 3.1 In `src/components/Pane.tsx`, when `pane.inputSelected` render the input text span with a selection highlight (`background: color-mix(in oklab, var(--ac) 32%, transparent)`).
- [x] 3.2 While selected, do not render the blinking caret or the ghost-autocomplete span.

## 4. Verify

- [x] 4.1 `bun run lint`, `bun run typecheck`, and `bun run build` clean.
- [x] 4.2 Manual check in the running app: type a command, ⌘A highlights it (caret/ghost hidden, output not selected); typing replaces it; Backspace/Delete clears it; ⌘C copies it; an arrow collapses the selection; ⌘A with empty input selects nothing and the output is never selected.
