// Coach-marks tutorial: a spotlight + bubble overlay that walks the key
// Workspaces affordances after the "Introducing Workspaces" dialog is
// dismissed (see WorkspacesIntro.tsx). Distinct from that one-time dialog —
// this one points at real-LOOKING DOM targets (`data-tour="<id>"`) rather
// than a static illustration.
//
// DECOR, NOT THE REAL APP: the tour renders its own opaque, self-contained
// stage (TourStage.tsx) — a faux rail, workspace card, and status bar — under
// its spotlight, instead of pointing at the app's actual rail/StatusBar.
// That's deliberate: the four coach-marks must appear EVERY time, in full,
// regardless of the real app's state (no repos added, the Home terminal
// active with no branch, no servers configured). A decor sidesteps all of
// that — its four `data-tour` nodes are always there. The stage carries no
// store subscription, no onClick, no backend call; it's purely illustrative,
// `aria-hidden`, and never touches persisted state. Teardown is simply
// unmounting (App.tsx gates this component on `introSeen && !tutorialSeen`).
//
// Step navigation (`tourStep`) lives in state/store.ts, shared with the
// keyboard layer (lib/keymap.ts) so Esc/←/→ and the on-screen buttons drive
// the exact same state without coupling to each other. `finishTutorial()`
// persists `tutorialSeen = true`, mirroring `dismissIntro()`.
//
// WKWebView (Tauri v2) means layout must be resolved in JS: each step's
// target is found via `stageRef.current.querySelector('[data-tour="…"]')` —
// SCOPED to this component's own stage, never `document`, so it can never
// match a same-id node the real (mounted-underneath) rail/StatusBar might
// also carry — measured with `getBoundingClientRect` in a SYNCHRONOUS
// useLayoutEffect (never via requestAnimationFrame — a WKWebView pauses rAF
// while its window is occluded/unfocused, which would leave `rect` null and
// the overlay blank forever), and re-measured on resize/scroll.
//
// All four steps are always present now (the decor guarantees it), so the
// walk is strictly linear: tourStep 0..STEPS.length-1, counter `pos+1/total`,
// the last step's primary action reads "Done".

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { TourStage } from "./TourStage";

interface TourStep {
  id: string;
  text: string;
}

// DESIGNER: wording lives here — keep it sober, in WorkspacesIntro's product voice.
const STEPS: TourStep[] = [
  { id: "rail", text: "These are your workspaces — an isolated worktree per branch. Click a row to switch between them." },
  { id: "new-workspace", text: "Spin up a workspace for any branch — no stashing." },
  { id: "run-servers", text: "Run the workspace's dev servers, each on isolated ports." },
  { id: "mr", text: "Jira and the merge request, right next to the code." },
];

export function WorkspaceTour() {
  const tourStep = useStore((s) => s.tourStep);
  const tutorialSeen = useStore((s) => s.settings.tutorialSeen);
  const tourNext = useStore((s) => s.tourNext);
  const tourPrev = useStore((s) => s.tourPrev);
  const finishTutorial = useStore((s) => s.finishTutorial);

  const [rect, setRect] = useState<DOMRect | null>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  // Scopes every `data-tour` lookup below to THIS stage, never `document` —
  // required so the tour can never accidentally match the real rail's or
  // StatusBar's own `data-tour` nodes mounted underneath it.
  const stageRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    if (tourStep >= STEPS.length) return;
    const el = stageRef.current?.querySelector<HTMLElement>(`[data-tour="${STEPS[tourStep].id}"]`);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [tourStep]);

  // Measured SYNCHRONOUSLY in useLayoutEffect (runs after DOM mutations,
  // before paint) rather than via requestAnimationFrame: a Tauri v2 WKWebView
  // pauses its rAF/display-link while the window is occluded or unfocused
  // (proven in the e2e harness — a scheduled rAF never fired), which would
  // leave `rect` null and the tour rendering nothing, permanently.
  // useLayoutEffect has no such dependency, so the rect resolves on the same
  // commit and the bubble paints at the correct spot on its first frame.
  //
  // Also the boundary safety net for the one remaining edge case now that
  // every step is always present: the keyboard layer (keymap.ts) calls the
  // raw `store.tourNext()` unconditionally on ArrowRight/Space, including
  // from the LAST step, which would otherwise push `tourStep` to
  // `STEPS.length` — finish explicitly here instead of leaving the tour
  // rendering null forever with the keyboard-modal guard (keymap.ts) still
  // swallowing every key.
  useLayoutEffect(() => {
    if (tutorialSeen) return; // finished: stay inert (App unmounts us anyway)
    if (tourStep >= STEPS.length) {
      finishTutorial();
      return;
    }
    const el = stageRef.current?.querySelector<HTMLElement>(`[data-tour="${STEPS[tourStep].id}"]`);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [tourStep, tutorialSeen, finishTutorial]);

  // Recalculate on resize/scroll from anywhere.
  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  useEffect(() => {
    nextBtnRef.current?.focus();
  }, [tourStep, rect]);

  // Focus-trap: park focus on the primary action, mirroring WorkspacesIntro's
  // `trapTab` so Tab can never hand focus to the xterm textarea behind the
  // overlay. Keyboard nav itself (Esc/←/→) is handled centrally in keymap.ts.
  function trapTab(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    nextBtnRef.current?.focus();
  }

  if (tutorialSeen || tourStep >= STEPS.length) return null;

  const total = STEPS.length;
  const isLast = tourStep === total - 1;
  const step = STEPS[tourStep];

  // Placement: try each side around the target in a preference order, and use
  // the first that has room to sit WITHOUT covering it. This matters for
  // edge-hugging, near-full-height targets like the rail — "below"/"above"
  // never have room there (its top and bottom both sit near the viewport's
  // own edges), so a below/above-only algorithm forces the bubble back
  // on top of the target it's supposed to point at. Falls back to whichever
  // side has the most available space if none fit cleanly (viewport smaller
  // than the bubble — not expected in the app, but the on-screen clamp below
  // is the real safety net either way).
  const BUBBLE_W = 300;
  const BUBBLE_H_EST = 150;
  const MARGIN = 14;
  const ARROW_MARGIN = 20;
  type Side = "below" | "above" | "left" | "right";
  let top = 0;
  let left = 0;
  let side: Side = "below";
  let arrowStyle: React.CSSProperties = { left: BUBBLE_W / 2 };
  if (rect) {
    const spaces: Record<Side, number> = {
      right: window.innerWidth - rect.right,
      left: rect.left,
      below: window.innerHeight - rect.bottom,
      above: rect.top,
    };
    // A target left-of-center prefers opening into the (presumably emptier)
    // right side first, and vice versa — the rail and the "+"/Run targets
    // inside it are all left-of-center in this tour, so this naturally sends
    // them rightward, into the empty code area, whenever there's room.
    const leftBiased = rect.left + rect.width / 2 < window.innerWidth / 2;
    const order: Side[] = leftBiased ? ["right", "left", "below", "above"] : ["left", "right", "below", "above"];
    const fits = (s: Side) => spaces[s] >= (s === "left" || s === "right" ? BUBBLE_W : BUBBLE_H_EST) + MARGIN * 2;
    side = order.find(fits) ?? order.reduce((best, s) => (spaces[s] > spaces[best] ? s : best));

    if (side === "right") {
      left = rect.right + MARGIN;
      top = rect.top + rect.height / 2 - BUBBLE_H_EST / 2;
    } else if (side === "left") {
      left = rect.left - BUBBLE_W - MARGIN;
      top = rect.top + rect.height / 2 - BUBBLE_H_EST / 2;
    } else if (side === "above") {
      top = rect.top - BUBBLE_H_EST - MARGIN;
      left = rect.left;
    } else {
      top = rect.bottom + MARGIN;
      left = rect.left;
    }
    left = Math.min(Math.max(left, MARGIN), window.innerWidth - BUBBLE_W - MARGIN);
    top = Math.min(Math.max(top, MARGIN), window.innerHeight - BUBBLE_H_EST - MARGIN);

    // DESIGNER: the becquet's position along the shared edge is derived, not
    // stored — the target's center on that axis, relative to the bubble's
    // (already-clamped) position on the same axis, kept off the rounded
    // corners. Below/above vary it horizontally (`left`); left/right vary it
    // vertically (`top`) instead — see the matching --left/--right becquet
    // variants in global.css.
    if (side === "left" || side === "right") {
      const arrowTop = Math.min(Math.max(rect.top + rect.height / 2 - top, ARROW_MARGIN), BUBBLE_H_EST - ARROW_MARGIN);
      arrowStyle = { top: arrowTop };
    } else {
      const arrowLeft = Math.min(Math.max(rect.left + rect.width / 2 - left, ARROW_MARGIN), BUBBLE_W - ARROW_MARGIN);
      arrowStyle = { left: arrowLeft };
    }
  }

  return (
    <div
      className="aurora-tour-root"
      role="dialog"
      aria-modal="true"
      aria-label={step.text}
      onKeyDown={trapTab}
    >
      {/* The decor: opaque, sits BELOW the overlay/spotlight (first child, no
          z-index — paints first), ABOVE the real app underneath. Its
          `data-tour` nodes are what the spotlight/bubble below actually
          measure and point at. */}
      <TourStage ref={stageRef} />
      {/* Safety net: don't paint the click-catcher/spotlight/bubble until the
          stage has actually been measured (mirrors the old `!rect` guard) —
          but the stage itself must stay mounted above so it CAN be measured;
          gating the whole dialog on `rect` would deadlock. */}
      {rect && (
        <>
          <div className="aurora-tour-overlay" />
          <div
            className="aurora-tour-spotlight"
            style={{
              top: rect.top - 6,
              left: rect.left - 6,
              width: rect.width + 12,
              height: rect.height + 12,
            }}
          />
          <div
            // MOTION: keyed by step so React remounts this node (not the
            // spotlight, which stays a single node on purpose — see
            // .aurora-tour-spotlight's transition in global.css) on every step
            // change, replaying its popIn entrance each time.
            key={tourStep}
            className={`aurora-tour-bubble${side !== "below" ? ` aurora-tour-bubble--${side}` : ""}`}
            style={{ top, left, width: BUBBLE_W }}
          >
            <div className="aurora-tour-arrow" style={arrowStyle} aria-hidden="true" />
            <div className="aurora-tour-step-counter">
              {tourStep + 1}/{total}
            </div>
            <div className="aurora-tour-text">{step.text}</div>
            <div className="aurora-tour-actions">
              <button type="button" className="aurora-tour-btn aurora-tour-btn--ghost" onClick={finishTutorial}>
                Skip
              </button>
              <div className="aurora-tour-nav">
                {tourStep > 0 && (
                  <button type="button" className="aurora-tour-btn" onClick={tourPrev}>
                    Back
                  </button>
                )}
                <button
                  ref={nextBtnRef}
                  type="button"
                  className="aurora-tour-btn aurora-tour-btn--primary"
                  onClick={isLast ? finishTutorial : tourNext}
                >
                  {isLast ? "Done" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
