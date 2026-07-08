// The WorkspaceTour's decor: a self-contained, opaque mock of the rail, an
// active workspace card, and the status bar. It exists so all four coach-marks
// (rail / new-workspace / run-servers / mr) ALWAYS have a real DOM target to
// spotlight, regardless of the app's actual state — no repos, the Home
// terminal active, no servers configured, no branch resolved yet. See
// WorkspaceTour.tsx: its measurement effect queries `data-tour="…"` nodes
// SCOPED to this stage (via the forwarded ref), never `document`, so it can
// never collide with the real rail/StatusBar mounted underneath.
//
// Static markup only: reuses the real `.aurora-ws-runtoggle` CSS class for
// visual fidelity on the Run pill; everything else mirrors WorkspaceRail's /
// StatusBar's inline styling (there are no other shared classes to reuse —
// those components style inline too). NO onClick, NO store subscription, NO
// backend call anywhere in this tree — it is illustrative, not functional.
// `aria-hidden` on the root: the tour's own dialog (role="dialog" in
// WorkspaceTour.tsx) carries the accessible narration, not this decor.
//
// Demo content is a fixed repo/branches/MR, in the same tone as
// WorkspacesIntro's own illustrative hero (see INTRO_LANES there) — not
// randomized, not store-derived.

import { forwardRef } from "react";

const DEMO_REPO = "aurora";
const DEMO_WORKSPACES = [
  { branch: "fix/checkout-total", port: "3001", active: false },
  { branch: "feat/search-facets", port: "3002", active: true },
] as const;
const ACTIVE_WS = DEMO_WORKSPACES.find((w) => w.active)!;

export const TourStage = forwardRef<HTMLDivElement>(function TourStage(_props, ref) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--win)",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        {/* Fake rail — mirrors WorkspaceRail.tsx's outer container + repo
            header + workspace cards. */}
        <div
          data-tour="rail"
          style={{
            flex: "0 0 clamp(208px, 22vw, 280px)",
            display: "flex",
            flexDirection: "column",
            background: "var(--page)",
            borderRight: "1px solid var(--line)",
            minHeight: 0,
          }}
        >
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 10px 11px 14px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--sans)",
                fontSize: 11,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "var(--dim)",
              }}
            >
              Workspaces
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "11px 12px 5px 13px",
              fontFamily: "var(--sans)",
              fontSize: 10.5,
              letterSpacing: ".04em",
              color: "var(--faint)",
            }}
          >
            <span style={{ color: "var(--dim)", fontSize: 9 }}>▾</span>
            <span style={{ color: "var(--acd)" }}>⇋</span>
            <span style={{ color: "var(--fg)" }}>{DEMO_REPO}</span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
              <span style={{ color: "var(--faint)", marginRight: 2 }}>{DEMO_WORKSPACES.length}</span>
              {/* Rendered in an always-on "hot" state, not the real button's
                  resting var(--dim)/no-fill idle look: this is the coach-mark's
                  target, so it must read as lit/actionable the instant the
                  spotlight hole reveals it, not as a ghost glyph. Tint/border
                  borrowed verbatim from the real button's own :hover state
                  (WorkspaceRail.tsx railIconBtn), not invented. */}
              <span
                data-tour="new-workspace"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 20,
                  height: 20,
                  borderRadius: 5,
                  color: "var(--ac)",
                  background: "color-mix(in oklab, var(--ac) 16%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--ac) 42%, var(--line))",
                  fontSize: 13,
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                +
              </span>
            </span>
          </div>

          <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
            {DEMO_WORKSPACES.map((w) => (
              <div
                key={w.branch}
                style={{
                  padding: "8px 14px",
                  borderBottom: "1px solid var(--line)",
                  background: w.active ? "color-mix(in oklab, var(--ac) 6%, transparent)" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg)" }}>
                  <span
                    style={{
                      flex: "0 0 auto",
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: w.active ? "var(--ac)" : "var(--faint)",
                      boxShadow: w.active ? "0 0 7px var(--ac)" : "none",
                    }}
                  />
                  <span style={{ color: "var(--acd)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ⎇ {w.branch}
                  </span>
                </div>
                {w.active && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 9px",
                        borderRadius: 6,
                        fontFamily: "var(--mono)",
                        fontSize: 11.5,
                        color: "var(--ac)",
                        background: "color-mix(in oklab, var(--ac) 9%, transparent)",
                        border: "1px solid color-mix(in oklab, var(--acd) 30%, var(--line))",
                      }}
                    >
                      <span style={{ color: "var(--acd)" }}>:</span>
                      {w.port}
                    </span>
                    {/* .aurora-ws-runtoggle's own resting/idle state is
                        var(--dim) on a transparent fill — correct for the real,
                        interactive button (quiet until hovered) but a second
                        instance of the same "ghost glyph" problem the + had
                        when it's sitting inert inside a spotlight hole with
                        nothing to hover it. Forced here into its own :hover
                        look (values copied verbatim from global.css) since
                        this decor is never actually hovered. */}
                    <button
                      type="button"
                      tabIndex={-1}
                      data-tour="run-servers"
                      className="aurora-ws-runtoggle"
                      style={{
                        flex: "0 0 auto",
                        color: "var(--ac)",
                        background: "color-mix(in oklab, var(--ac) 10%, transparent)",
                        borderColor: "color-mix(in oklab, var(--ac) 40%, var(--line))",
                      }}
                    >
                      <span className="aurora-ws-runtoggle__icon" aria-hidden style={{ color: "var(--ac)" }}>
                        ▸
                      </span>
                      Run
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Fake code area — decorative fill, no content needed. */}
        <div style={{ flex: "1 1 auto", background: "var(--win)" }} />
      </div>

      {/* Fake status bar — mirrors StatusBar.tsx's cwd / branch / MR entry. */}
      <div
        style={{
          flex: "0 0 30px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 16px",
          background: "var(--bar)",
          borderTop: "1px solid var(--line)",
          fontFamily: "var(--sans)",
          fontSize: 11,
          color: "var(--faint)",
        }}
      >
        <span style={{ color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ~/dev/{DEMO_REPO}
        </span>
        <span style={{ color: "var(--acd)" }}>⎇ {ACTIVE_WS.branch}</span>
        {/* "1 MR" text has no dedicated color in the real StatusBar either (it
            inherits the bar's own var(--faint)) — correct for ambient chrome,
            too quiet for a coach-mark target sitting in an unscrimmed hole.
            Bumped to var(--fg) here only, same reasoning as the + and Run pill. */}
        <span data-tour="mr" style={{ display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", color: "var(--fg)" }}>
          <span style={{ color: "var(--acd)" }}>⇋</span>
          1 MR
        </span>
      </div>
    </div>
  );
});
