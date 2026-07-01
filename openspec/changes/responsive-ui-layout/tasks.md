# Tasks — responsive-ui-layout

Ordered so each phase compiles/typechecks on its own. Phases 1–6 are the **always-on overflow fixes** (no width
detection — these alone fix the wide-window screenshot bugs). Phase 7 adds the single breakpoint mechanism.
Phase 8 wires the width-dependent degradations. Phase 9 is optional. Phase 10 verifies.

Designer note: the surgical CSS/inline edits below preserve the existing visual language; if any surface needs a
genuine layout rethink (not just overflow plumbing), hand that surface to the **designer** with the
`/frontend-design` skill before coding it.

## 1. Title bar overflow (`src/components/TitleBar.tsx`)

- [x] 1.1 Add `minWidth: 0` to each of the three grid cells (window-controls `31`, center `56`, status `79`) so
      the `1fr` tracks can shrink below content size.
- [x] 1.2 Make the branch span (`74`) `overflow:hidden; textOverflow:ellipsis; whiteSpace:nowrap; minWidth:0`
      and add `title={branch ?? undefined}` so the full branch shows on hover. Verify: a 60-char branch shows an
      ellipsis and does NOT push the right-hand "connected"/gear cluster off its edge.

## 2. Status bar overflow + hint group (`src/components/StatusBar.tsx`, `src/styles/global.css`)

- [x] 2.1 Add `minWidth: 0` to the left group (`44`) and `flex: "0 1 auto"`; give the cwd span (`45`)
      `overflow:hidden; textOverflow:ellipsis; whiteSpace:nowrap; minWidth:0` so the path truncates first.
- [x] 2.2 Add `className="aurora-statusbar-hints"` to the right keyboard-hint group (`122`) and `flex:"0 0 auto"`.
- [x] 2.3 In `global.css` add `.aurora-statusbar-hints { display: flex }` plus an `@media (max-width: 840px)`
      rule that hides it (`display: none`). (Keep this `@media` block as the single home for narrow-only CSS.)
      Note: `display` ownership moved to CSS class (not inline) so the @media rule can override it — inline
      styles have higher specificity than class selectors and cannot be targeted by media queries.
- [ ] 2.4 Verify at ~720px: the two groups do not overlap; the hint group is gone; cwd ellipsises.

## 3. Workspace context bar — scrollable ports + pinned toggle (`src/components/WorkspaceRail.tsx`)

- [x] 3.1 In `WorkspaceContextBar` (`641`) give the outer bar `minWidth: 0` and ensure it stays one line (no
      `flexWrap`). Made the preset text span have `flex:"0 1 auto"; minWidth:0` with ellipsis so it is the
      first leading meta item to truncate.
- [x] 3.2 Wrap the port-chips region (`692-722`, the `aurora-ws-ports` pill) — and the bare-offset fallback
      (`724-744`) — so the scrolling element is `flex:"1 1 auto"; minWidth:0; overflowX:auto` with
      `className="ascroll"`; keep the inner `whiteSpace:nowrap`. Only this region scrolls — not the whole bar.
- [x] 3.3 Ensure the Run/Stop toggle (`750-773`) sits OUTSIDE the scroll region with `flex:"0 0 auto"` so it is
      always visible.
- [ ] 3.4 Verify at 1600px with ≥4 derived ports: ports scroll inside their pill; toggle always visible; bar
      height unchanged; no `:…` clip at the window edge.

## 4. Workspace rail — fluid width + card status row (`src/components/WorkspaceRail.tsx`)

- [x] 4.1 Replace the rail container width `flex:"0 0 256px"` (`424`) with `flex:"0 0 clamp(208px, 22vw, 280px)"`.
      Confirm cards still read at 208px (title/branch already ellipsis at `170-195`).
- [x] 4.2 In `WorkspaceCard` status row (`196`), add `minWidth:0` to the row and give the status-text span (`197`)
      `overflow:hidden; textOverflow:ellipsis; whiteSpace:nowrap; minWidth:0` so it truncates before the diff/
      jira/port chips, instead of colliding/clipping. Keep the chips `flex:"0 0 auto"`.
- [ ] 4.3 Verify: a workspace with a long status line + diff + jira + port chip at the clamped-min rail width
      shows truncated status text and all chips intact within the card.

## 5. Tab strip — horizontal scroll + pinned buttons (`src/components/TabStrip.tsx`)

- [x] 5.1 Wrap the mapped tabs (`43-185`) in a scroll container `flex:"1 1 auto"; minWidth:0; overflowX:auto;
      overflowY:hidden` with `className="ascroll"`; move the `+` (`187`) and `⊟` (`205`) buttons into a trailing
      `flex:"0 0 auto"` group outside that container. Keep `gap:3` inside.
- [x] 5.2 Give each tab `flex:"0 0 auto"` so tabs keep their size and the row scrolls (rather than squashing).
- [x] 5.3 On `selectTab` (the tab `onClick`, `49`), scroll the selected tab into view via `tabRefs` array +
      `scrollIntoView({ inline:"nearest", block:"nearest" })` in a `useEffect` keyed on `active`.
- [ ] 5.4 Verify: open ~8 tabs at 900px — the strip scrolls, `+`/`⊟` stay visible, selecting a hidden tab scrolls
      it into view.

## 6. Scrollbar polish (`src/styles/global.css`)

- [x] 6.1 Confirmed: the existing `.ascroll::-webkit-scrollbar { height: 9px }` in `tokens.css` covers the new
      horizontal scroll regions (TabStrip, ports pill). No new scrollbar CSS needed — `.ascroll` reused as-is.

## 7. Width signal — single breakpoint (`src/styles/tokens.css`, `src/lib/`)

- [x] 7.1 Added `--bp-narrow: 840px` to `tokens.css` `:root` with a comment explaining it is documentary (CSS
      custom properties cannot be used in @media conditions; 840px appears literally in @media rules and the hook).
- [x] 7.2 Created `src/lib/useMediaQuery.ts` with:
      - `BP_NARROW_PX = 840` constant
      - `useMediaQuery(query): boolean` — subscribes to `matchMedia`, updates on `change` only (no per-pixel churn)
      - `useNarrow(): boolean` — convenience wrapper for `(max-width: 840px)`

## 8. Rail auto-collapse on crossing into narrow (`src/App.tsx`)

- [x] 8.1 In `App.tsx`, subscribe to `window.matchMedia("(max-width: 840px)")` `change` event. On a transition
      into narrow (`e.matches = true`), if the user override flag is not set, call `setRailCollapsed(true)` once.
- [x] 8.2 Session override: a `userOpenedWhileNarrow` ref tracks whether the user opened the rail while narrow
      (detected via a separate `useEffect` on `railCollapsed` watching for `true→false` transitions while narrow).
      The override resets when the window returns to wide. Going wide does NOT auto-open.
- [x] 8.3 No conflict with boot `showRailOnLaunch`: the matchMedia `change` event only fires on subsequent
      crossings, not on initial attach. The boot collapse (`App.tsx:121-123`) runs in an async init effect and
      is not affected by the listener.
- [ ] 8.4 Verify the three scenarios: shrink past 840 collapses once; manual re-open stays open; widening leaves
      it as-is.

## 9. (Optional, lower priority) Pane reflow when narrow (`src/components/PaneGrid.tsx`)

- [x] 9.1 N/A (hors périmètre, décidé au checkpoint)
- [x] 9.2 N/A (hors périmètre, décidé au checkpoint)

## 10. Window floor + verification

- [x] 10.1 N/A (décision orchestrateur : on garde minWidth 720 — pas de modification de tauri.conf.json)
- [ ] 10.2 `bun run lint`, `bun run typecheck`, and `bun run build` clean. `cargo build` clean if
      `tauri.conf.json` changed.
      → **Gates run and passed** (typecheck: clean, lint: clean, build: ✓ 993ms, tauri.conf unchanged → no cargo needed)
- [ ] 10.3 Manual smoke (tester / `/verify`) at three widths — ~720px (floor), ~1080px (default), ~1600px (wide):
      no clipping or overlap on any surface; port chips scroll with toggle visible (wide); branch ellipsises
      with tooltip; tab `+`/`⊟` reachable with many tabs and active tab scrolls into view; status hints hide
      under 840; rail clamps and auto-collapses per Phase 8; xterm resizes cleanly (no visible storm/jank) while
      dragging the window edge.
- [ ] 10.4 Confirm the visual language is intact at all three widths: dark theme, green accents, monospace, thin
      themed scrollbars; `tokens.css` palette unchanged.
