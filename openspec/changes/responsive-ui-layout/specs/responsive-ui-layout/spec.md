## ADDED Requirements

### Requirement: No surface clips its content at any window width
Every Aurora chrome surface (rail, title bar, status bar, workspace context bar, tab strip, pane grid) SHALL
contain its content without uncontrolled clipping at any window width from the enforced minimum to wide. Where a
single-line element cannot fit, the system SHALL degrade it through an explicit policy — **truncate with an
ellipsis**, **wrap**, or **scroll** — and SHALL NOT let content be silently cut off by an ancestor's
`overflow: hidden`. This requirement holds at all widths, including wide windows.

#### Scenario: Port chips overflow is contained at a wide window
- **WHEN** the window is wide (e.g. 1600px) and the workspace declares enough derived ports that the port-chip
  row is wider than the available space in the context bar
- **THEN** the port-chip row SHALL scroll horizontally within its own region (thin themed scrollbar) and the
  Run/Stop toggle SHALL remain fully visible, with no chip clipped at the window's right edge

#### Scenario: A long branch name is truncated, not clipped
- **WHEN** the active workspace's branch name is longer than the space available for it in the title bar
- **THEN** the branch label SHALL show an ellipsis and expose the full value via its `title` tooltip, and the
  right-hand status cluster SHALL remain in place

#### Scenario: Narrow floor stays usable
- **WHEN** the window is resized to its enforced minimum width
- **THEN** all interactive controls (tab `+`/`⊟`, Run/Stop toggle, traffic lights, settings gear) SHALL remain
  reachable and no surface SHALL overlap another

### Requirement: The workspace rail width is fluid and bounded
The rail SHALL use a fluid, bounded width rather than a single fixed pixel width, so it gives space back to the
terminal area on narrow windows while staying wide enough to read its cards on wide windows. Card titles,
branch lines, and repo-group headers SHALL truncate with an ellipsis rather than wrap or clip.

#### Scenario: Rail narrows on a small window
- **WHEN** the window is narrow
- **THEN** the rail SHALL render at a width no greater than its upper bound and no smaller than its lower bound,
  and its card text SHALL ellipsis-truncate rather than wrap or spill

#### Scenario: Rail card status row does not collide
- **WHEN** a workspace card shows a status line together with diff counts, a Jira chip, and/or a port chip
- **THEN** the status text SHALL truncate as needed so the chips remain readable within the card, with no chip
  clipped by the card's edge

### Requirement: The rail auto-collapses when the window crosses into the narrow range
When the window crosses from at-or-above the narrow breakpoint to below it, the system SHALL collapse the rail
once, so the terminal area is not strangled. The system SHALL NOT continuously force the rail collapsed: if the
user manually re-opens the rail while the window is narrow, it SHALL stay open. Crossing back to wide SHALL NOT
auto-open the rail. This behavior SHALL NOT alter the boot-time rail visibility driven by a repo's
show-rail-on-launch default.

#### Scenario: Shrinking past the breakpoint collapses the rail
- **WHEN** the window is wider than the narrow breakpoint with the rail shown, and is then resized to below the
  breakpoint
- **THEN** the rail SHALL collapse, leaving the workspace switcher available in the title bar

#### Scenario: Manual re-open while narrow is respected
- **WHEN** the rail has auto-collapsed at a narrow width and the user re-opens it manually
- **THEN** the rail SHALL remain open and SHALL NOT be auto-collapsed again until the window has returned to wide
  and crossed back into narrow

#### Scenario: Returning to wide does not force the rail open
- **WHEN** the rail is collapsed and the window is widened past the breakpoint
- **THEN** the system SHALL leave the rail collapsed (the user opens it when they want it)

### Requirement: The title bar degrades gracefully on narrow windows
The title bar's three regions (window controls, center title, status cluster) SHALL each be allowed to shrink so
that no region forces another off-screen. The center branch label SHALL truncate with an ellipsis and a `title`
tooltip rather than widen the center region at the expense of the side regions.

#### Scenario: Side regions keep their place under a long center title
- **WHEN** the center title or branch is long
- **THEN** the window-control cluster and the status cluster SHALL remain at their respective edges, and the
  center content SHALL truncate rather than push them

### Requirement: The status bar prioritizes content when space is scarce
The status bar SHALL keep its left, contextual group (cwd, branch, MRs, changes, scripts, alerts, tab counter)
readable when space is limited, truncating the path first, and SHALL hide or condense its right keyboard-hint
group below the narrow breakpoint. The two groups SHALL never overlap.

#### Scenario: Keyboard hints hide when narrow
- **WHEN** the window is below the narrow breakpoint
- **THEN** the right-hand keyboard-hint group SHALL be hidden or reduced, and the left contextual group SHALL
  remain readable with the path truncating first

#### Scenario: Groups never overlap
- **WHEN** the left group's content is wide enough to meet the right group at any width
- **THEN** the left group SHALL truncate so the two groups remain visually separated rather than overlapping

### Requirement: The workspace context bar keeps its controls reachable
The workspace context bar SHALL remain a single-line bar whose Run/Stop toggle is always visible. The unbounded
port-chip region SHALL scroll horizontally within its own area when it cannot fit, using the existing thin
themed scrollbar, while the leading meta (branch, issue, preset) MAY truncate. The bar SHALL NOT grow taller or
clip its toggle to accommodate the ports.

#### Scenario: Many ports scroll without hiding the toggle
- **WHEN** the workspace's derived ports exceed the available width in the context bar
- **THEN** the port-chip region SHALL become horizontally scrollable and the Run/Stop toggle SHALL stay visible
  and clickable at the end of the bar

#### Scenario: The bar stays one line
- **WHEN** the context bar's content exceeds the available width
- **THEN** the bar SHALL remain a single row (it SHALL NOT wrap to a taller bar that pushes the tab strip down)

### Requirement: The tab strip scrolls and keeps its action buttons reachable
The tab strip SHALL keep its new-tab (`+`) and split (`⊟`) buttons reachable regardless of how many tabs are
open, by making the tab list horizontally scrollable and pinning the action buttons. When a tab is selected, the
system SHALL scroll it into view so the active tab is never left off-screen.

#### Scenario: Many tabs keep the action buttons visible
- **WHEN** more tabs are open than fit the available width
- **THEN** the tab list SHALL scroll horizontally and the `+` and `⊟` buttons SHALL remain visible at the end of
  the strip

#### Scenario: Selecting a tab scrolls it into view
- **WHEN** the user selects a tab (by click or keyboard) that is outside the visible scroll area
- **THEN** the selected tab SHALL be scrolled into view

### Requirement: The pane grid never forces panes to overflow
The pane grid SHALL keep every pane within the terminal area at all widths, with no pane forcing horizontal
overflow. As a usability refinement (lower priority), when the terminal area is narrow the grid MAY lay a 2–3
pane split out as a vertical stack instead of a side-by-side row.

#### Scenario: Split panes shrink instead of overflowing
- **WHEN** a split of two or more panes is shown in a narrow terminal area
- **THEN** each pane SHALL shrink to share the available width with no pane overflowing, and the embedded xterm
  SHALL resize to its pane

### Requirement: No new runtime dependency and the visual language is preserved
The responsive behavior SHALL be implemented with native CSS (`clamp()`, `min`/`max`, flex, grid, `@media`) and
the native `matchMedia` API only — no new UI framework, utility-CSS, or layout library. The dark theme, green
accents, monospace type, and the existing design tokens SHALL be unchanged; any new scroll region SHALL use the
existing thin themed scrollbar style.

#### Scenario: Build introduces no new layout dependency
- **WHEN** the change is built
- **THEN** no new UI/layout runtime dependency SHALL appear in the dependency manifest, and the existing design
  tokens SHALL be unchanged

#### Scenario: New scroll regions match the existing scrollbar style
- **WHEN** a newly added horizontally scrollable region (tab strip, port chips) shows its scrollbar
- **THEN** it SHALL use the existing thin themed scrollbar style rather than the platform default
