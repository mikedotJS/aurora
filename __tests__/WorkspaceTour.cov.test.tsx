/**
 * Tests for src/components/WorkspaceTour.tsx — the coach-marks tutorial shown
 * once, right after "Introducing Workspaces" is dismissed (introSeen: true &&
 * tutorialSeen: false, gated in App.tsx).
 *
 * DECOR MODEL: the tour renders its own self-contained, opaque stage
 * (TourStage.tsx) instead of pointing at the real app's rail/StatusBar — so
 * all four coach-marks (rail / new-workspace / run-servers / mr) are ALWAYS
 * present, regardless of the real app's state (no repos, Home active, no
 * servers, no branch). There is no more "conditional target" or "present
 * step" machinery: navigation is a strict `tourStep` walk from 0 to
 * STEPS.length - 1.
 *
 * The component resolves each step's target via
 * `stageRef.current.querySelector('[data-tour="…"]')`, SCOPED to its own
 * stage — never `document` — so it can never collide with a same-id node the
 * real (mounted-underneath) rail/StatusBar might also carry.
 *
 * IMPORTANT CAVEAT (see project memory "Aurora UI visual verification"): this
 * suite runs under happy-dom, which has NO real layout engine — a live
 * `getBoundingClientRect()` on an unmocked element returns all zeros here.
 * These tests stub the rect of specific `data-tour` nodes (keyed by their
 * `data-tour` id, applied via a patched `getBoundingClientRect`) and then
 * assert the component's OWN placement math (clamping, flip-above, spotlight
 * inset) against that stub. That proves the placement ALGORITHM and the
 * wiring (linear nav, scoped lookup, persistence, focus trap) are correct —
 * it does NOT prove the coach-marks visually line up against the real
 * WKWebView-rendered UI. That last mile needs the real app (`/run`) or the
 * wdio e2e harness (`e2e/`).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen, waitFor, act } from "@testing-library/react";
import { useStore, DEFAULT_SETTINGS } from "../src/state/store";
import { WorkspaceTour } from "../src/components/WorkspaceTour";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakeRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function toDOMRect(r: FakeRect): DOMRect {
  return {
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    bottom: r.top + r.height,
    right: r.left + r.width,
    x: r.left,
    y: r.top,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

const rectMap = new Map<string, FakeRect>();

/** Stub the rect the component will read for the stage's `data-tour="id"` node. */
function setRect(id: string, r: FakeRect) {
  rectMap.set(id, r);
}

let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

/** Read the "pos/total" step counter out of the rendered bubble, or null if no bubble. */
function currentStepCounter(): string | null {
  const el = document.querySelector(".aurora-tour-step-counter");
  return el ? el.textContent : null;
}

/** The label on the primary action button ("Next" | "Done"), or null. */
function primaryLabel(): string | null {
  const btn = document.querySelector(".aurora-tour-btn--primary");
  return btn ? btn.textContent : null;
}

/** Flushes any pending microtasks/timers inside an `act()` scope. The
 *  component measures its target SYNCHRONOUSLY in a useLayoutEffect (no
 *  requestAnimationFrame — a WKWebView can pause rAF indefinitely, which used
 *  to leave the overlay blank), so the rect is already resolved by the time
 *  render()/fireEvent() return; this just lets any pending state settle. */
async function flushRaf() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Wait until the bubble shows the given "pos/total" counter. */
async function waitForCounter(text: string) {
  await flushRaf();
  await waitFor(() => {
    expect(currentStepCounter()).toBe(text);
  });
}

beforeEach(() => {
  localStorage.clear();
  rectMap.clear();
  // The stage's `data-tour` nodes are static markup rendered by the
  // component itself (TourStage.tsx), not external elements a test mounts —
  // so stub each target's rect by its `data-tour` id via a patched
  // `getBoundingClientRect`, the same way the real WKWebView would report a
  // real one. An element with its own INSTANCE override (see the scoping
  // test below) takes precedence over this prototype patch, as normal JS
  // property lookup dictates.
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.getAttribute("data-tour");
    const r = id ? rectMap.get(id) : undefined;
    return r ? toDOMRect(r) : originalGetBoundingClientRect.call(this);
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, introSeen: true, tutorialSeen: false },
    tourStep: 0,
  });
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

// ── Rendering against the stage's own DOM targets ───────────────────────────

describe("WorkspaceTour — targets its own stage's DOM node for the active step", () => {
  it("step 1 spotlights the 'rail' target with a 6px inset/outset around its real rect", async () => {
    setRect("rail", { top: 100, left: 50, width: 200, height: 600 });
    render(<WorkspaceTour />);

    await waitForCounter("1/4");

    const spotlight = document.querySelector(".aurora-tour-spotlight") as HTMLElement;
    expect(spotlight).not.toBeNull();
    expect(spotlight.style.top).toBe("94px"); // 100 - 6
    expect(spotlight.style.left).toBe("44px"); // 50 - 6
    expect(spotlight.style.width).toBe("212px"); // 200 + 12
    expect(spotlight.style.height).toBe("612px"); // 600 + 12
  });

  it("re-measures against the target's CURRENT rect after a window resize", async () => {
    setRect("rail", { top: 100, left: 50, width: 200, height: 600 });
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    // Simulate the rail's real rect changing (e.g. window resize).
    setRect("rail", { top: 10, left: 10, width: 150, height: 400 });
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      const spotlight = document.querySelector(".aurora-tour-spotlight") as HTMLElement;
      expect(spotlight.style.top).toBe("4px"); // 10 - 6
    });
  });

  // A tall, edge-hugging target like the rail has ~no room above or below it
  // (its own top and bottom sit near the viewport's edges) — the old
  // below/flip-above-only algorithm forced the bubble back on top of it
  // (Michael's visual regression report: "c'est par-dessus et ça cache").
  // The bubble must instead open sideways, into the empty space next to it.
  it("places the bubble to the RIGHT of a tall, left-hugging target (the rail) instead of covering it", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    setRect("rail", { top: 40, left: 0, width: 240, height: 760 });
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    const bubble = document.querySelector(".aurora-tour-bubble") as HTMLElement;
    expect(bubble.className).toContain("aurora-tour-bubble--right");
    // Entirely clear of the target's right edge (240px) — never overlapping it.
    expect(parseFloat(bubble.style.left)).toBeGreaterThanOrEqual(240);
    expect(bubble.style.left).toBe("254px"); // rect.right(240) + MARGIN(14)
    expect(bubble.style.top).toBe("345px"); // rect.top(40) + height/2(380) - BUBBLE_H_EST/2(75)

    // Becquet points left (back at the rail): its fixed edge (`left: -7px`)
    // comes from the `.aurora-tour-bubble--right .aurora-tour-arrow` CSS rule
    // (not asserted here — global.css isn't loaded in this test environment,
    // only inline styles are). Its VARYING position — vertical now, derived
    // from the target's center — is what the component sets inline.
    const arrow = document.querySelector(".aurora-tour-arrow") as HTMLElement;
    expect(arrow.style.left).toBe(""); // not driven by JS on this side — CSS owns it
    expect(arrow.style.top).toBe("75px"); // rect.top(40) + height/2(380) - bubble.top(345)
  });

  // When the target instead hugs the RIGHT side with room to its left (e.g. a
  // narrower window), the bubble opens left instead — same rule, opposite side.
  it("falls back to the LEFT of a target hugging the right edge, when there's no room on the right", async () => {
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    setRect("rail", { top: 350, left: 450, width: 40, height: 20 });
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    const bubble = document.querySelector(".aurora-tour-bubble") as HTMLElement;
    expect(bubble.className).toContain("aurora-tour-bubble--left");
    // Entirely clear of the target's left edge (450px) — never overlapping it.
    expect(parseFloat(bubble.style.left) + 300).toBeLessThanOrEqual(450);
    expect(bubble.style.left).toBe("136px"); // rect.left(450) - BUBBLE_W(300) - MARGIN(14)
    // Vertical clamp still applies: the ideal centered top (285px) overflows
    // this 400px-tall viewport, so it's capped to stay fully on-screen.
    expect(bubble.style.top).toBe("236px"); // clamped: 400 - BUBBLE_H_EST(150) - MARGIN(14)
  });

  // A wide target near the bottom (like the status bar) has no room to either
  // side either — falls back to above, still never covering the target.
  it("falls back to ABOVE a wide target with no room on either side or below", async () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    setRect("rail", { top: 550, left: 20, width: 360, height: 20 });
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    const bubble = document.querySelector(".aurora-tour-bubble") as HTMLElement;
    expect(bubble.className).toContain("aurora-tour-bubble--above");
    expect(parseFloat(bubble.style.top) + 150).toBeLessThanOrEqual(550); // clear of the target's top edge
  });

  // MOTION (fixed): the stale-position flash the motion-designer flagged is
  // gone. `measure()` runs SYNCHRONOUSLY in a useLayoutEffect on the step
  // change (not one rAF later), and React flushes layout effects — and the
  // setRect they trigger — before the browser paints. So the freshly-remounted
  // bubble (new key={tourStep}) is already positioned against the NEW target
  // on its very first painted frame; the previous step's rect is never shown.
  it("MOTION FIXED: on step change the bubble is measured synchronously, so it paints at the NEW target's rect immediately (no one-frame flash at the old position)", async () => {
    setRect("rail", { top: 100, left: 50, width: 200, height: 600 });
    setRect("new-workspace", { top: 500, left: 300, width: 40, height: 20 });
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    const bubbleBefore = document.querySelector(".aurora-tour-bubble") as HTMLElement;
    const topBefore = bubbleBefore.style.top; // derived from the rail's rect (top: 100)

    // fireEvent is wrapped in act(), which flushes the useLayoutEffect (and the
    // resulting setRect re-render) synchronously — exactly what the browser does
    // before its next paint.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(currentStepCounter()).toBe("2/4");
    const bubbleAfterClick = document.querySelector(".aurora-tour-bubble") as HTMLElement;
    expect(bubbleAfterClick).not.toBe(bubbleBefore); // confirms it's the remounted node, not a stale query
    // Already at new-workspace's position (top: 500 → bottom+margin), NOT the
    // rail's stale one — the flash is gone.
    expect(bubbleAfterClick.style.top).not.toBe(topBefore);
  });

  // Regression guard for the scoping requirement: if the component ever fell
  // back to an unscoped `document.querySelector`, it would match a same-id
  // `data-tour="rail"` node belonging to the REAL (mounted-elsewhere)
  // WorkspaceRail before it ever reached its own stage's node — since that
  // decoy sits earlier in document order than react-testing-library's own
  // render container.
  it("scopes target lookup to its own stage — never matches a same-id data-tour node mounted elsewhere in the document", async () => {
    const decoy = document.createElement("div");
    decoy.setAttribute("data-tour", "rail");
    // An own-property override shadows the prototype patch above for this
    // specific element only, so the decoy reports its own (wildly different)
    // rect regardless of what's stubbed for "rail" generically.
    decoy.getBoundingClientRect = () => toDOMRect({ top: 9000, left: 9000, width: 1, height: 1 });
    document.body.appendChild(decoy);
    try {
      setRect("rail", { top: 100, left: 50, width: 200, height: 600 });
      render(<WorkspaceTour />);
      await waitForCounter("1/4");

      const spotlight = document.querySelector(".aurora-tour-spotlight") as HTMLElement;
      // The stage's own rail (94px), never the decoy's (8994px).
      expect(spotlight.style.top).toBe("94px");
    } finally {
      decoy.remove();
    }
  });
});

// ── All four steps are always present — the decor guarantees it ────────────

describe("WorkspaceTour — all 4 coach-marks are always present, regardless of real app state", () => {
  it("shows all 4 coach-marks with an empty store (no repos, no workspaces) and walks 1/4 through Done", async () => {
    useStore.setState({ workspaces: [], repos: [], activeWs: null });
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    // The stage's own decor renders all four targets unconditionally.
    const ids = Array.from(document.querySelectorAll("[data-tour]")).map((el) => el.getAttribute("data-tour"));
    expect(ids).toEqual(["rail", "new-workspace", "run-servers", "mr"]);

    expect(primaryLabel()).toBe("Next");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("2/4");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("3/4");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("4/4");
    expect(primaryLabel()).toBe("Done");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(useStore.getState().settings.tutorialSeen).toBe(true));
  });

  it("the decor has no interactive handlers — clicking its fake targets does nothing", async () => {
    render(<WorkspaceTour />);
    await waitForCounter("1/4");
    const stepBefore = useStore.getState().tourStep;

    fireEvent.click(document.querySelector('[data-tour="run-servers"]')!);
    fireEvent.click(document.querySelector('[data-tour="mr"]')!);
    fireEvent.click(document.querySelector('[data-tour="new-workspace"]')!);

    expect(useStore.getState().tourStep).toBe(stepBefore);
    expect(useStore.getState().settings.tutorialSeen).toBe(false);
  });
});

// ── Navigation: buttons + keyboard boundary ─────────────────────────────────

describe("WorkspaceTour — Next / Back navigation", () => {
  it("'Back' is absent on the first step, appears from the second step on", async () => {
    render(<WorkspaceTour />);
    await waitForCounter("1/4");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("2/4");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("the primary button reads 'Done' only on the last step (4/4)", async () => {
    useStore.setState({ tourStep: 3 });
    render(<WorkspaceTour />);
    await waitForCounter("4/4");
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  // The keyboard layer (lib/keymap.ts) calls the raw `store.tourNext()`
  // unconditionally on ArrowRight/Space, including from the last step — this
  // pushes `tourStep` to STEPS.length. The component's activation effect must
  // finish the tour explicitly there rather than getting stuck rendering
  // null forever (the keyboard-modal guard in keymap.ts would otherwise keep
  // swallowing every key with no visible way out except Esc).
  it("keyboard ArrowRight (store.tourNext) from the LAST step finishes the tour instead of stalling past the end", async () => {
    useStore.setState({ tourStep: 3 });
    render(<WorkspaceTour />);
    await waitForCounter("4/4");

    act(() => useStore.getState().tourNext());

    await waitFor(() => expect(useStore.getState().settings.tutorialSeen).toBe(true));
  });
});

// ── Closing persists tutorialSeen ───────────────────────────────────────────

describe("WorkspaceTour — closing persists tutorialSeen", () => {
  it("'Skip' closes the tour immediately and persists tutorialSeen:true to aurora.settings", async () => {
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(useStore.getState().settings.tutorialSeen).toBe(true);
    const raw = localStorage.getItem("aurora.settings");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).tutorialSeen).toBe(true);
  });

  it("reaching 'Done' on the last step also persists tutorialSeen:true and resets tourStep", async () => {
    useStore.setState({ tourStep: 3 });
    render(<WorkspaceTour />);
    await waitForCounter("4/4");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(useStore.getState().settings.tutorialSeen).toBe(true);
    });
    expect(useStore.getState().tourStep).toBe(0);
    const raw = localStorage.getItem("aurora.settings");
    expect(JSON.parse(raw!).tutorialSeen).toBe(true);
  });

  it("once tutorialSeen is true, rendering the component again produces nothing (no stale overlay)", () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, introSeen: true, tutorialSeen: true } });
    const { container } = render(<WorkspaceTour />);
    expect(container.firstChild).toBeNull();
  });

  it("a tourStep past the last step (e.g. left over from a prior finish) also renders nothing", () => {
    useStore.setState({ tourStep: 4 });
    const { container } = render(<WorkspaceTour />);
    // Renders inert (null) on this synchronous first pass; the layout effect
    // then calls finishTutorial(), which is covered by the dedicated
    // boundary test above.
    expect(container.firstChild).toBeNull();
  });
});

// ── The tour never touches persisted state beyond tutorialSeen ─────────────

describe("WorkspaceTour — leaves everything but tutorialSeen untouched", () => {
  it("aurora.scripts / aurora.repoconfig and the rest of the store are byte-identical before and after a full tutorial cycle", async () => {
    localStorage.setItem("aurora.scripts", JSON.stringify({ foo: "bar" }));
    localStorage.setItem("aurora.repoconfig", JSON.stringify({ baz: 1 }));
    const settingsBefore = { ...DEFAULT_SETTINGS, introSeen: true, tutorialSeen: false };
    localStorage.setItem("aurora.settings", JSON.stringify(settingsBefore));
    useStore.setState({ settings: settingsBefore, tourStep: 0, railCollapsed: true });

    const scriptsBefore = localStorage.getItem("aurora.scripts");
    const repoConfigBefore = localStorage.getItem("aurora.repoconfig");
    const railCollapsedBefore = useStore.getState().railCollapsed;
    const workspacesBefore = useStore.getState().workspaces;
    const reposBefore = useStore.getState().repos;

    render(<WorkspaceTour />);
    await waitForCounter("1/4");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("2/4");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("3/4");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitForCounter("4/4");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(useStore.getState().settings.tutorialSeen).toBe(true));

    // No worktree/backend-adjacent persistence, no rail toggling, no
    // workspace/repo mutation — the decor never touches any of it.
    expect(localStorage.getItem("aurora.scripts")).toBe(scriptsBefore);
    expect(localStorage.getItem("aurora.repoconfig")).toBe(repoConfigBefore);
    expect(useStore.getState().railCollapsed).toBe(railCollapsedBefore);
    expect(useStore.getState().workspaces).toBe(workspacesBefore); // same reference: never touched
    expect(useStore.getState().repos).toBe(reposBefore);

    // aurora.settings changes ONLY by tutorialSeen flipping true.
    const settingsAfterRaw = localStorage.getItem("aurora.settings");
    expect(settingsAfterRaw).not.toBeNull();
    const settingsAfter = JSON.parse(settingsAfterRaw!) as Record<string, unknown>;
    expect({ ...settingsAfter, tutorialSeen: undefined }).toEqual({ ...settingsBefore, tutorialSeen: undefined });
    expect(settingsAfter.tutorialSeen).toBe(true);
  });
});

// ── Focus trap ───────────────────────────────────────────────────────────────

describe("WorkspaceTour — focus", () => {
  it("focuses the primary action button once a step is showing", async () => {
    render(<WorkspaceTour />);
    await waitForCounter("1/4");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
  });

  it("traps Tab on the dialog root so focus can never reach the xterm behind the overlay", async () => {
    render(<WorkspaceTour />);
    await waitForCounter("1/4");

    const dialog = screen.getByRole("dialog");
    const primary = screen.getByRole("button", { name: "Next" });
    expect(document.activeElement).toBe(primary);

    const notCancelled = fireEvent.keyDown(dialog, { key: "Tab" });
    expect(notCancelled).toBe(false); // preventDefault() ran
    expect(document.activeElement).toBe(primary);
  });
});
