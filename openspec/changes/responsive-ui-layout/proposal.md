## Why

Aurora's chrome is built almost entirely from **fixed pixel sizes and non-overflowing flex rows**, with
**zero width-awareness** anywhere in the app. The rail is a hard `flex: 0 0 256px` (`WorkspaceRail.tsx:424`),
the title-bar branch, the status-bar item rows, the workspace context bar, and the tab strip are all single-line
flex containers with **no truncation, no wrapping, no scroll, and no `min-width: 0`**. Two distinct failure
classes result:

1. **Content-overflow at any width** (visible even in the user's 1600px screenshot): the port chips clip at the
   right edge (`odyssey:welcomer :3010 · odyssey:welcomer :…`), the header branch name is cut off, workspace
   card status rows collide.
2. **Width-strangle when narrow**: at the enforced window floor (`minWidth: 720`, `tauri.conf.json`) the fixed
   256px rail eats ~35% of the width; the tab strip overflows and its new-tab/split buttons become unreachable;
   the status bar's two groups collide.

`railCollapsed` is the **only** width-adaptation lever and it is fully manual (the `‹` chevron / ⌘B). Nothing in
the app reacts to window size. This change makes every surface degrade gracefully from the narrow floor to wide
windows, with no uncontrolled truncation or overflow.

## What Changes

- **Always-on overflow discipline (no breakpoints, fixes the 1600px bugs):** apply native CSS primitives —
  `min-width: 0` on flex children that must shrink, `text-overflow: ellipsis` + `title` tooltip for single-line
  labels (header branch, status cwd, card status line), and **scrollable regions** (`overflow-x: auto` + the
  existing `.ascroll` thin scrollbar) for the unbounded rows: the **tab strip** (keeps `+`/`⊟` reachable) and
  the **port-chips region** of the workspace context bar (keeps the Run/Stop toggle pinned).
- **Fluid rail width:** replace `flex: 0 0 256px` with a clamped fluid width (`clamp()`), so the rail gives back
  space on narrow windows; card text already ellipsises, so content stays clean.
- **One narrow breakpoint, two mechanisms:** a single named threshold (~840px). Visual-only degradations
  (hide/condense the status bar's keyboard-hint group) are done with **CSS `@media` in `global.css`** targeting
  added classNames (the file already hosts component classes like `.aurora-ws-runtoggle`, `.aurora-term`).
  State/logic degradations that CSS cannot express (rail **auto-collapse** when the window crosses into narrow)
  use a small native **`matchMedia` hook** — no new dependency.
- **Tab strip** becomes horizontally scrollable with the active tab scrolled into view on selection; trailing
  `+`/`⊟` buttons pinned and always visible.
- **(Lower priority, optional) Pane reflow:** when the terminal area is narrow, a 2–3 pane split MAY stack
  vertically instead of side-by-side (the grid already uses `minmax(0, 1fr)`, so this is a usability refinement,
  not a break fix).
- **Window floor review:** validate every surface down to `minWidth`; optionally lower `minWidth` (720 → ~640)
  once overflow is handled — as a discrete, reviewable step.

Non-goals:
- **Not a performance/snappiness change.** No input-latency or re-render-count work. (xterm already resizes via
  its `FitAddon` + `ResizeObserver` in `Terminal.tsx:293`; we only ensure the responsive work does not provoke
  resize storms — see `design.md`.)
- **No new UI framework, no Tailwind, no CSS-in-JS library, no layout dependency.** Native `clamp()`/`min-max`/
  flex/grid/`@media`/`matchMedia` only.
- **No redesign** of the visual language: dark theme, green accents, monospace, and the existing `tokens.css`
  values are preserved; this is layout adaptation, not restyle.
- **No persistence change** for `railCollapsed` (it stays runtime-only, as today).

## Capabilities

### New Capabilities
- `responsive-ui-layout`: every Aurora surface (root rail↔terminal split, workspace rail, title bar, status bar,
  workspace context bar, tab strip, pane grid) adapts to window width — fluid where it should be fluid, truncates
  or scrolls instead of clipping, and degrades chrome density at a single narrow breakpoint — with no new
  dependency and no change to the visual language.

### Modified Capabilities
<!-- None. No baseline spec for these surfaces exists under openspec/specs/ (only merge-request-search lives
     there). The rail/terminal/bars chrome was introduced by add-aurora-terminal + the workspaces changes, whose
     specs are not promoted to openspec/specs/. This change's responsive behavior is therefore captured as a new
     additive capability rather than a delta to a non-existent baseline. -->

## Impact

- **CSS (`src/styles/global.css`):** add component classes + one `@media (max-width: …)` block for the narrow
  threshold (status-bar hint group hide/condense; any density tweaks). Reuse `.ascroll` for new scroll regions.
  `tokens.css` may gain a breakpoint custom property (`--bp-narrow`) for documentation; palette values stay as-is.
- **New hook (`src/lib/`):** a tiny `useMediaQuery`/`useNarrow` hook over `window.matchMedia` (threshold-only,
  no per-pixel churn) for the state/logic degradations.
- **`src/App.tsx`:** the root split (`flex` row at line 213) gains the width signal; drives rail auto-collapse.
- **`src/components/WorkspaceRail.tsx`:** rail container width → `clamp()`; the `WorkspaceCard` status row and
  `RepoHeader` get `min-width: 0`/ellipsis discipline; `WorkspaceContextBar` port-chips region becomes a pinned
  scrollable sub-row with the Run/Stop toggle outside it.
- **`src/components/TitleBar.tsx`:** grid cells get `min-width: 0`; branch span ellipsis + `title`.
- **`src/components/StatusBar.tsx`:** left group `min-width: 0` + shrink/ellipsis; right hint group becomes a
  classed element that the `@media` block hides/condenses when narrow.
- **`src/components/TabStrip.tsx`:** tab list wrapped in a scrollable region; trailing buttons pinned; active tab
  `scrollIntoView` on select.
- **`src/components/PaneGrid.tsx`:** (optional) split-axis selection consults the width signal for the n≤3 case.
- **`src-tauri/tauri.conf.json`:** (optional) lower `minWidth` after overflow handling is verified.
- **Reuses (no change):** `Terminal.tsx` xterm `FitAddon`/`ResizeObserver` (must stay correct), the Zustand
  `railCollapsed` state machine and `showRailOnLaunch` boot logic, `PaneGrid`'s existing `minmax(0, 1fr)` grid.
