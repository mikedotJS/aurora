## 1. State — find session

- [x] 1.1 Add `find: { open: boolean; query: string; current: number }` to the store in `src/state/store.ts` (default `{ open: false, query: "", current: 0 }`).
- [x] 1.2 Add actions `openFind()`, `closeFind()`, `setFindQuery(q)`, and `stepFind(dir, total)`; add them to the `StoreState` interface. `setFindQuery` resets `current` to 0; `closeFind` resets query + current. (stepFind takes `total` so wrap-around is computed without storing the match list.)

## 2. Matching + highlight rendering

- [x] 2.1 Add a helper that, given a line's `Seg[]` and the query, returns the line's match ranges (case-insensitive `indexOf` over the joined text) — new `src/lib/find.ts` (`findRangesInLine`, plus `blockLines`/`collectMatches`/`highlightLine` shared with BlockView).
- [x] 2.2 In `BlockView` (`src/components/Pane.tsx`), when a query is active, re-segment each line against its match ranges (walk a running char offset; split segments at match boundaries) and render matched slices with the segment's own style plus a highlight background.
- [x] 2.3 Compute the flat match list (block id, line, offset) for the active pane via `useMemo` from `find.query` + blocks; clamp `find.current` into range; expose which match is "current" so `BlockView` can style it distinctly.
- [x] 2.4 Give the current match a marker (ref) and `scrollIntoView({ block: "nearest" })` it in an effect when `find.current`/`find.query` changes (only while the bar is open).

## 3. Find bar UI (frontend-design skill)

- [x] 3.1 Use the **`frontend-design` skill** to design and build a `FindBar` component anchored top-right of the active pane: search input, `current/total` counter, prev/next buttons, close — using Aurora oklch tokens, Geist, and the existing overlay/card vocabulary (no Tailwind).
- [x] 3.2 Wire the bar to the store: input → `setFindQuery`; prev/next buttons → `stepFind(-1/1)`; close → `closeFind`. Handle Enter (next), Shift-Enter (prev), ↑/↓, and Esc (close) on the input.
- [x] 3.3 Render `<FindBar />` in the active pane (in `Pane.tsx`) only when `find.open` and the pane is active and not in raw mode; auto-focus the input on open.

## 4. Keymap

- [x] 4.1 In `handleKeyDown` (`src/lib/keymap.ts`), add ⌘F (`k === "f" || "F"` with `e.metaKey`): `e.preventDefault()` and `openFind()`. Place it before the generic `e.metaKey` fallthrough. (Plus an Esc-closes-find guard for when focus has left the find input.)

## 5. Verify

- [x] 5.1 `bun run lint`, `bun run typecheck`, and `bun run build` clean.
- [ ] 5.2 Manual check in the running app: ⌘F opens the bar (input focused, native find suppressed); typing highlights matches with colors preserved; counter shows `n/total`; Enter/Shift-Enter and ↑/↓ navigate with wrap-around and scroll the current match into view; query change resets to first; Esc closes and clears highlights.