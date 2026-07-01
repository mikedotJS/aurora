/**
 * Tests for src/components/WorkspacesIntro.tsx — the one-time "Introducing
 * Workspaces" onboarding dialog (workspaces-intro-dialog OpenSpec change).
 *
 * Deliberately asserts BEHAVIOR/STRUCTURE (role/aria, the "Got it" affordance,
 * focus, dismiss wiring), not the exact copy — the title and value-prop text
 * are a designer-owned surface (INTRO_TITLE / INTRO_VALUE_PROPS) that can
 * change without these tests flaking. The "Got it" label and the dialog's
 * role/aria contract are frozen by the spec and are safe to assert on.
 *
 * Modeled on SettingsModal.cov.test.tsx (render via @testing-library/react
 * against the real store; test/setup.ts preload supplies happy-dom + Tauri
 * mocks).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { useStore, DEFAULT_SETTINGS } from "../src/state/store";
import { WorkspacesIntro } from "../src/components/WorkspacesIntro";

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, introSeen: false },
  });
});
afterEach(cleanup);

describe("WorkspacesIntro — dialog structure + a11y", () => {
  it("renders a modal dialog labelled by its own title element", () => {
    render(<WorkspacesIntro />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl).not.toBeNull();
    // Structure, not copy: the labelling element actually has text in it.
    expect(titleEl!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it("renders exactly one primary action, labeled 'Got it' (frozen label)", () => {
    render(<WorkspacesIntro />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe("Got it");
  });
});

describe("WorkspacesIntro — focus on mount", () => {
  it("moves keyboard focus to the 'Got it' button when the dialog mounts", () => {
    render(<WorkspacesIntro />);
    const gotIt = screen.getByRole("button", { name: "Got it" });
    expect(document.activeElement).toBe(gotIt);
  });
});

describe("WorkspacesIntro — focus trap", () => {
  it("traps Tab: keydown on the dialog panel is prevented so focus can never reach anything behind the modal (e.g. the xterm textarea) — the 'Got it' button is the dialog's only focusable element", () => {
    render(<WorkspacesIntro />);
    const dialog = screen.getByRole("dialog");
    const gotIt = screen.getByRole("button", { name: "Got it" });
    expect(document.activeElement).toBe(gotIt);

    const notCancelled = fireEvent.keyDown(dialog, { key: "Tab" });
    expect(notCancelled).toBe(false); // dispatchEvent() returns false once preventDefault() ran
    expect(document.activeElement).toBe(gotIt); // focus stays put
  });

  it("traps Shift+Tab the same way", () => {
    render(<WorkspacesIntro />);
    const dialog = screen.getByRole("dialog");
    const gotIt = screen.getByRole("button", { name: "Got it" });

    const notCancelled = fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(notCancelled).toBe(false);
    expect(document.activeElement).toBe(gotIt);
  });

  it("does not intercept non-Tab keys — the trap is scoped to Tab only", () => {
    render(<WorkspacesIntro />);
    const dialog = screen.getByRole("dialog");
    const notCancelled = fireEvent.keyDown(dialog, { key: "a" });
    expect(notCancelled).toBe(true);
  });
});

describe("WorkspacesIntro — dismissal", () => {
  it("clicking 'Got it' calls dismissIntro: settings.introSeen flips to true", () => {
    render(<WorkspacesIntro />);
    expect(useStore.getState().settings.introSeen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(useStore.getState().settings.introSeen).toBe(true);
  });

  it("clicking 'Got it' persists introSeen:true to aurora.settings in localStorage", () => {
    render(<WorkspacesIntro />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    const raw = localStorage.getItem("aurora.settings");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.introSeen).toBe(true);
  });

  it("clicking the backdrop is a no-op: it has no dismiss handler, so introSeen stays false", () => {
    const { container } = render(<WorkspacesIntro />);
    // Outer wrapper (absolute inset-0, zIndex 100) → first child is the
    // backdrop div, rendered before the dialog panel and carrying no onClick
    // (D3: backdrop must not be dismissible).
    const backdrop = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop.getAttribute("role")).not.toBe("dialog");

    fireEvent.click(backdrop);

    expect(useStore.getState().settings.introSeen).toBe(false);
    // The dialog is still there — nothing tore it down.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
