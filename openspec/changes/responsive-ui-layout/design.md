# Design — responsive-ui-layout

## Context (audited, file:line)

Window floor: `src-tauri/tauri.conf.json` → `width 1080, height 720, minWidth 720, minHeight 460, resizable true`.
So the real narrow floor is **720px**, not 600px; the prompt's "~600px" is below the enforced minimum (see D9).

Root split — `App.tsx:213-219`: `<div style={{ flex:1, minHeight:0, display:"flex" }}>` then
`{!railCollapsed && <WorkspaceRail/>}` and a main column `flex:1, minWidth:0` (good — column can shrink). No
width detection anywhere. `railCollapsed` (store `599` default `false`, `737` setter, `738` toggle) is **not
persisted** (absent from `PersistedWs`/`savePersisted` in `lib/workspace.ts`; grep confirms it lives only in
`App.tsx`, `store.ts`, `TitleBar.tsx`). Boot logic `App.tsx:121-123` sets it `true` only when a repo's
`showRailOnLaunch === false`.

Per-surface defects:
- **Rail** `WorkspaceRail.tsx:424` `flex:"0 0 256px"` — hard fixed, never shrinks. Card title/branch/RepoHeader
  already ellipsis (`170-181`, `183-195`, `352`), but the **status row** `196-247` is a `flex; gap:8` of
  status-text + diff + jira chip + port chip with **no `min-width:0`, no ellipsis** on the text span (`197`),
  and the card has `overflow:hidden` (`132`) → long content is clipped, chips collide.
- **Title bar** `TitleBar.tsx:21-30` grid `1fr auto 1fr`; branch span `74` has no `max-width`/ellipsis. Grid
  items default `min-width:auto`, so a long branch widens the `auto` track and squeezes the `1fr` tracks,
  pushing the right cluster toward the clipped edge → "branch tronqué".
- **Status bar** `StatusBar.tsx:29-43` `flex; justify-content:space-between`, **no wrap, no overflow, no
  `min-width:0`**. Left group `44` (cwd, branch chip, MRs, "N changed", scripts, alerts, tab counter) and right
  group `122` (4 keyboard hints, ~280px) collide on narrow windows.
- **Workspace context bar** `WorkspaceRail.tsx:641-777` `flex; gap:12`, **no wrap/overflow**. Port-chips
  container `692-722` is `inline-flex; white-space:nowrap`, one segment per derived port → unbounded width →
  clipped at the window's right edge regardless of window size. This is the screenshot's `:…` bug. Root cause
  confirmed: an unbounded `nowrap` row in a non-scrolling, non-truncating bar.
- **Tab strip** `TabStrip.tsx:30-42` `flex; gap:3`, **no `overflow-x`, no shrink**; tabs ~180-200px each; the
  `+` (`187`) and `⊟` (`205`) buttons trail the flex → overflow pushes them off-screen / unreachable.
- **Pane grid** `PaneGrid.tsx:18-30` uses `grid-template-columns: repeat(cols, minmax(0,1fr))` and `Pane`
  `138-154` is `flex:1 1 0; min-width:0; overflow:hidden` — **already shrink-safe; no break**, only a usability
  issue when 3 panes sit side-by-side in a narrow terminal column. `gridShape` `7-12`: n≤3 ⇒ single row.
- **xterm** `Terminal.tsx:293-301`: `ResizeObserver` → `fit.fit()` + `pty.resize(cols,rows)`. Resize is already
  wired; the responsive work must not turn it into a storm (D8).

**Key honest finding:** roughly half the visible defects (port-chip clip at 1600px, branch truncation at wide
width, card status collision) are **content-overflow bugs independent of window width** — they need
truncation/scroll policy, *not* breakpoints. The other half (rail strangle, tab overflow, status-bar collision)
are width-dependent. The design treats these as two separate tiers so we don't reach for breakpoints where a
`min-width:0` suffices.

## Decisions

### D1 — Three mechanism tiers (least powerful tool that works)
1. **Unconditional CSS primitives** (no width detection): `min-width:0`, `text-overflow:ellipsis`+`title`,
   `overflow-x:auto` scroll regions (reusing `.ascroll`), `clamp()` rail width. Fixes the content-overflow class
   at **all** widths, including 1600px. This is the bulk of the change.
2. **CSS `@media` in `global.css`** (threshold, visual-only): hide/condense the status-bar keyboard-hint group.
   `global.css` already hosts component classes (`.aurora-ws-runtoggle`, `.aurora-term`, `.aurora-ws-card`), so
   this is in-grain and needs no JS.
3. **`matchMedia` JS hook** (threshold, state/logic CSS cannot express): rail auto-collapse; optional pane-split
   axis. `window.matchMedia('(max-width: 840px)')` fires **only on threshold crossings** → no per-pixel churn.

Alternatives rejected: (a) a Zustand `winWidth` field updated on every resize pixel — rejected, re-render churn;
(b) moving the entire inline-styled app to CSS classes so viewport media queries can target it — rejected,
large refactor against the "smallest change" rule and the team's inline/module-CSS convention; (c) a CSS
container-queries refactor — same objection, deferred as a possible future foundation, not needed now.

### D2 — Single breakpoint
One named narrow threshold, `--bp-narrow: 840px` (documented in `tokens.css`, used by the `@media` block and the
`matchMedia` hook). 840 ≈ clamped-rail max (~280) + a usable terminal column (~560). Avoid breakpoint
proliferation: one threshold + good overflow primitives covers narrow→wide. A second ultra-narrow threshold is
**not** introduced unless smoke testing at 720px proves it necessary (tracked in tasks, default: not added).

### D3 — Rail width + auto-collapse
- **Width:** `flex: 0 0 clamp(208px, 22vw, 280px)` (replacing `0 0 256px`). Fluid, bounded; card text already
  ellipsises so this introduces no new overflow. Pure CSS, always on.
- **Auto-collapse:** when the window **crosses into** narrow (`matchMedia('(max-width:840px)')` flips to true),
  set `railCollapsed = true` **once**. Do **not** continuously force it: a user who manually re-opens the rail
  while narrow keeps it open. Implementation guard: act only on the `change` transition into narrow, and track a
  session flag so a manual open at narrow width suppresses re-collapse until the window goes wide again. Going
  wide does **not** auto-open (avoid surprising the user / fighting `showRailOnLaunch`).
- Interaction with boot: `showRailOnLaunch` already sets collapsed at boot (`App.tsx:121`); the auto-collapse
  listener attaches after init and only reacts to subsequent crossings, so it does not fight the boot default.

Alternative considered — **overlay rail** (absolute, floating over the terminal at narrow width): better use of
space but materially more code (focus trap, outside-click, z-index, animation) and a new interaction model.
Rejected for this change as over-engineering; the clamp + one-shot collapse is the smallest thing that removes
the strangle. Overlay is a noted future option.

Lighter fallback if the one-shot/override logic proves fiddly in review: ship **clamp only** (no auto-collapse)
— it already returns ~48px to the terminal at the floor and keeps the rail usable. The spec marks auto-collapse
as a distinct requirement so it can be dropped without affecting the rest.

### D4 — Title bar
Add `min-width:0` to the three grid cells (so `1fr` tracks can shrink) and make the branch span
`overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0` with `title={branch}` for the full
value on hover. Graceful ellipsis replaces today's squeeze-and-clip. The collapsed-rail `WorkspaceSwitcher`
already bounds itself (`max-width:280` ellipsis, `WorkspaceSwitcher.tsx:35`).

### D5 — Status bar
- Right keyboard-hint group → a classed element (`.aurora-statusbar-hints`); the `@media (max-width:840px)`
  block hides it (or drops to the two highest-value hints). It is the lowest-value content when space is scarce.
- Left group: `min-width:0`, children `flex-shrink` permitted, cwd span gets ellipsis (`min-width:0; overflow;
  text-overflow:ellipsis`). The two top-level groups become `flex:0 1 auto` / `min-width:0` so they never
  overlap. The cwd (already shortened by `shortenCwd`) is the first to truncate.

### D6 — Workspace context bar (the headline bug)
Restructure the bar into three zones: **[leading meta]** (branch/issue/preset — `flex:0 1 auto`, may truncate)
· **[ports region]** (`flex:1 1 auto; min-width:0; overflow-x:auto` with `.ascroll`; keeps its internal
`white-space:nowrap`) · **[Run/Stop toggle]** (`flex:0 0 auto`, pinned, always visible). The unbounded element
(ports) scrolls inside its own pill instead of clipping the bar; the toggle is never pushed off. Bar height
stays single-line.

Alternative — `flex-wrap:wrap` on the whole bar: simplest, but the bar is `flex:0 0 auto`, so wrapping makes it
grow taller and shove the tab strip down with a variable-height meta bar. Rejected for height instability;
scroll-the-unbounded-region is cleaner.

### D7 — Tab strip
Wrap the tab list in a `flex:1 1 auto; min-width:0; overflow-x:auto` region (`.ascroll`); keep the `+`/`⊟`
buttons in a trailing `flex:0 0 auto` group so they are always reachable. On `selectTab`, `scrollIntoView({
inline:"nearest", block:"nearest" })` the active tab so keyboard/⌘-number selection never leaves it off-screen
(no such logic exists today — must be added with the scroll region, or scrolling hides the active tab).

### D8 — xterm resize safety (non-goal guard)
The pane container's `ResizeObserver` (`Terminal.tsx:293`) calls `fit()`+`pty.resize()` on every size change.
Rail collapse is a **discrete conditional render** (`App.tsx:214`) → one resize event, fine. Therefore: **do not
CSS-transition any dimension that changes a pane container's size** (rail width, split). If a width transition is
ever wanted, debounce the fit. The clamp reacts only to window resize, which already streams RO events handled
today. No code change to `Terminal.tsx`; this is a constraint on how the rest is built.

### D9 — Window floor
Keep `minHeight`. Validate all surfaces at `minWidth:720`. Optionally lower `minWidth` to ~640 **after** the
overflow/scroll work lands and is smoke-tested, as its own reviewable task — not bundled blindly. The prompt's
600px target is reachable only if 640 proves clean.

### D10 — Pane reflow (optional, lower priority)
`PaneGrid` already prevents breakage via `minmax(0,1fr)`. As a usability refinement, for the n≤3 case
`gridShape` MAY choose a vertical stack (rows) instead of a horizontal row when the terminal area is narrow
(width signal from the hook). Clearly marked optional so it can be cut without affecting the break fixes.

## Risks / sensitive zones
- **Rail auto-collapse vs manual toggle** (D3) — the one genuinely stateful piece; the override/suppression flag
  must be correct or the rail flickers or fights the user. Mitigation: one-shot on transition + session
  override flag; fallback to clamp-only.
- **xterm resize storms** (D8) — avoid transitioning pane-affecting dimensions.
- **Tab `scrollIntoView`** (D7) — forgetting it makes the active tab disappear once the strip scrolls.
- **`railCollapsed` not persisted** — auto-collapse is session-only by design; do not add persistence here.
- **Scrollbar aesthetics** — every new scroll region MUST use `.ascroll` (thin, themed); never default chunky
  scrollbars. Preserve dark/green/monospace language and `tokens.css`.
