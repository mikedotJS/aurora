// One-time "Introducing Workspaces" dialog. Shown exactly once (see
// `Settings.introSeen` in state/store.ts) after boot completes, over the app
// content — the empty state or a restored workspace. Reuses SettingsModal's
// overlay/backdrop/panel chrome, but sits above every other overlay
// (zIndex 100) and its backdrop is NOT a dismissal target: the one-time
// message must not be burned by a stray click. The only exits are the "Got
// it" action and Esc (handled centrally in lib/keymap.ts), both of which
// persist `introSeen` via `dismissIntro()`.

import { useEffect, useRef } from "react";
import { useStore } from "../state/store";

// DESIGNER: edit copy/visuals here — do not change the dismiss wiring below.
// The announcement: an eyebrow + title, a one-line thesis rendered as a shell
// comment over a "worktree graph" hero (a miniature of the real rail — one repo
// fanning into isolated, per-branch workspaces on their own ports), then 2–3
// value props. Copy is free to rewrite; the styling lives in global.css under
// `.aurora-intro-*`. The port readouts (:3001/:3002/:3003) carry the
// "isolated ports" pillar visually, so it isn't repeated as a fourth prop.
const INTRO_EYEBROW = "New in Aurora";
const INTRO_TITLE = "Introducing Workspaces";
const INTRO_THESIS = "every branch gets its own live worktree";

type LaneTone = "live" | "review" | "idle";
// Illustrative sample lanes for the hero graph — decorative (aria-hidden), not
// wired to real state. Kept short so branches don't truncate at 440px.
const INTRO_LANES: { key: string; branch: string; port: string; tone: LaneTone }[] = [
  { key: "AUR-142", branch: "fix/checkout-total", port: "3001", tone: "live" },
  { key: "AUR-138", branch: "feat/search-facets", port: "3002", tone: "review" },
  { key: "chore", branch: "chore/bump-deps", port: "3003", tone: "idle" },
];

const INTRO_VALUE_PROPS: { glyph: string; title: string; desc: string }[] = [
  {
    glyph: "⎇",
    title: "A worktree per branch",
    desc: "Each workspace opens in its own git worktree — switch tickets without stashing a thing.",
  },
  {
    glyph: "▸",
    title: "Dev servers, run in place",
    desc: "Start and stop a workspace's servers from Aurora, each on isolated ports so nothing collides.",
  },
  {
    glyph: "◐",
    title: "Jira & GitLab in view",
    desc: "Issue status and merge-request state sit right beside the workspace doing the work.",
  },
];

// Tone → status-dot treatment, echoing the rail's StatusDot vocabulary.
const LANE_TONE: Record<LaneTone, { color: string; glyph: string; live?: boolean }> = {
  live: { color: "var(--ac)", glyph: "●", live: true },
  review: { color: "var(--jira)", glyph: "●" },
  idle: { color: "var(--faint)", glyph: "○" },
};
// END DESIGNER — dismiss wiring below is frozen.

export function WorkspacesIntro() {
  const dismissIntro = useStore((s) => s.dismissIntro);
  const gotItRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    gotItRef.current?.focus();
  }, []);

  // Focus-trap: the dialog has exactly one focusable element (the "Got it"
  // button), so Tab/Shift+Tab must never be allowed to leave it — otherwise,
  // on first launch inside a repo, focus escapes to the xterm textarea
  // mounted behind the intro and keystrokes start going to the terminal.
  // Keeping focus pinned on the button is sufficient (there's nowhere else
  // to trap it to); re-focus defensively in case focus already moved.
  function trapTab(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    gotItRef.current?.focus();
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 30,
      }}
    >
      {/* Backdrop is intentionally NOT a dismissal target — no onClick. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "color-mix(in oklab, black 55%, transparent)",
          animation: "fadeIn .16s ease",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspaces-intro-title"
        onKeyDown={trapTab}
        style={{
          position: "relative",
          width: "min(440px, 100%)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--win)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "0 34px 90px -26px rgba(0,0,0,.82)",
          animation: "popIn .2s cubic-bezier(.2,.7,.2,1)",
          overflow: "hidden",
        }}
      >
        {/* Signature: a worktree graph — the product illustrating itself. One
            repo fans into isolated, per-branch lanes on their own ports. Purely
            decorative, so the whole subtree is hidden from assistive tech. */}
        <div className="aurora-intro-hero" aria-hidden>
          <div className="aurora-intro-comment"># {INTRO_THESIS}</div>
          <div className="aurora-intro-graph">
            <div className="aurora-intro-root">
              <span className="aurora-intro-mark">⇋</span>
              <span className="aurora-intro-repo">aurora</span>
              <span className="aurora-intro-count">{INTRO_LANES.length} workspaces</span>
            </div>
            {INTRO_LANES.map((lane, i) => {
              const last = i === INTRO_LANES.length - 1;
              const tone = LANE_TONE[lane.tone];
              return (
                <div
                  key={lane.key}
                  className="aurora-intro-lane"
                  style={{ animationDelay: `${0.12 + i * 0.07}s` }}
                >
                  <span className="aurora-intro-branchch">{last ? "└─" : "├─"}</span>
                  <span
                    className={`aurora-intro-dot${tone.live ? " aurora-intro-dot--live" : ""}`}
                    style={{ color: tone.color }}
                  >
                    {tone.glyph}
                  </span>
                  <span className="aurora-intro-key">{lane.key}</span>
                  <span className="aurora-intro-branch">⎇ {lane.branch}</span>
                  <span
                    className="aurora-intro-port"
                    style={{ color: tone.live ? "var(--ac)" : "var(--acd)" }}
                  >
                    :{lane.port}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Scrollable content — keeps "Got it" reachable on short windows. */}
        <div className="aurora-intro-body ascroll">
          <div className="aurora-intro-eyebrow">{INTRO_EYEBROW}</div>
          <h2 id="workspaces-intro-title" className="aurora-intro-title">
            {INTRO_TITLE}
          </h2>
          <div className="aurora-intro-props">
            {INTRO_VALUE_PROPS.map((vp) => (
              <div key={vp.title} className="aurora-intro-prop">
                <span className="aurora-intro-prop-glyph" aria-hidden>
                  {vp.glyph}
                </span>
                <div>
                  <div className="aurora-intro-prop-title">{vp.title}</div>
                  <div className="aurora-intro-prop-desc">{vp.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="aurora-intro-footer">
          <button
            ref={gotItRef}
            type="button"
            onClick={dismissIntro}
            className="aurora-empty-primary aurora-intro-cta"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
