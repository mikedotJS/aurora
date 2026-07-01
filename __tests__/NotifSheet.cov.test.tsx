// Coverage suite for src/components/NotifSheet.tsx — the notification-history
// bottom sheet: empty state, populated log with/without a repo badge and
// with/without a url, the timeAgo() bucket boundaries (just now / Ns / Nm /
// Nh), the mute toggle (both label states), clear, and close (overlay + ×).

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import * as opener from "@tauri-apps/plugin-opener";
import { NotifSheet } from "../src/components/NotifSheet";
import { useStore, type Notif } from "../src/state/store";

afterEach(cleanup);

function mkNotif(overrides: Partial<Notif> = {}): Notif {
  return {
    id: 1,
    color: "oklch(0.83 0.115 184)",
    icon: "⇋",
    headline: "New MR !12",
    sub: "Add feature",
    repo: "aurora",
    url: "https://gitlab.example.com/mr/12",
    ts: Date.now(),
    ...overrides,
  };
}

let openUrlSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  useStore.setState({ notifLog: [], muted: false, panel: "notif" }, false);
  // spyOn on an already-spied module property returns the SAME spy with
  // accumulated history in this bun:test version — spy once, clear per test.
  openUrlSpy = spyOn(opener, "openUrl");
  openUrlSpy.mockClear();
});

describe("NotifSheet empty state", () => {
  it("shows the empty-log placeholder when there are no notifications", () => {
    const { getByText } = render(<NotifSheet />);
    expect(getByText("no notifications yet")).toBeTruthy();
    expect(getByText("merge-request events will appear here")).toBeTruthy();
  });
});

describe("NotifSheet populated log", () => {
  it("renders headline, sub, repo badge, and icon color for each entry", () => {
    useStore.setState(
      { notifLog: [mkNotif({ id: 1 }), mkNotif({ id: 2, headline: "MR !13 updated", sub: "Fix bug", repo: "other" })] },
      false,
    );
    const { getByText, queryByText } = render(<NotifSheet />);
    expect(getByText("New MR !12")).toBeTruthy();
    expect(getByText("Add feature")).toBeTruthy();
    expect(getByText("aurora")).toBeTruthy();
    expect(getByText("MR !13 updated")).toBeTruthy();
    expect(getByText("other")).toBeTruthy();
    expect(queryByText("no notifications yet")).toBeNull();
  });

  it("omits the repo badge when repo is falsy", () => {
    useStore.setState({ notifLog: [mkNotif({ repo: "" })] }, false);
    const { queryByText } = render(<NotifSheet />);
    expect(queryByText("aurora")).toBeNull();
  });

  it("clicking an entry with a url opens it, and is cursor:pointer", () => {
    useStore.setState({ notifLog: [mkNotif({ url: "https://example.com/mr/12" })] }, false);
    const { getByText } = render(<NotifSheet />);
    const row = getByText("New MR !12").closest('[style*="cursor"]') as HTMLElement;
    expect(row.style.cursor).toBe("pointer");
    fireEvent.click(row);
    expect(openUrlSpy).toHaveBeenCalledWith("https://example.com/mr/12");
  });

  it("clicking an entry without a url is inert (cursor:default, no openUrl call)", () => {
    useStore.setState({ notifLog: [mkNotif({ url: undefined })] }, false);
    const { getByText } = render(<NotifSheet />);
    const row = getByText("New MR !12").closest('[style*="cursor"]') as HTMLElement;
    expect(row.style.cursor).toBe("default");
    fireEvent.click(row);
    expect(openUrlSpy).not.toHaveBeenCalled();
  });
});

describe("NotifSheet timeAgo formatting", () => {
  it("shows 'just now' for very recent entries (<8s)", () => {
    useStore.setState({ notifLog: [mkNotif({ ts: Date.now() - 1000 })] }, false);
    const { getByText } = render(<NotifSheet />);
    expect(getByText("just now")).toBeTruthy();
  });

  it("shows 'Ns ago' between 8s and 60s", () => {
    useStore.setState({ notifLog: [mkNotif({ ts: Date.now() - 30_000 })] }, false);
    const { getByText } = render(<NotifSheet />);
    expect(getByText(/^\d+s ago$/)).toBeTruthy();
  });

  it("shows 'Nm ago' between 1m and 60m", () => {
    useStore.setState({ notifLog: [mkNotif({ ts: Date.now() - 5 * 60_000 })] }, false);
    const { getByText } = render(<NotifSheet />);
    expect(getByText("5m ago")).toBeTruthy();
  });

  it("shows 'Nh ago' for an hour or more", () => {
    useStore.setState({ notifLog: [mkNotif({ ts: Date.now() - 3 * 60 * 60_000 })] }, false);
    const { getByText } = render(<NotifSheet />);
    expect(getByText("3h ago")).toBeTruthy();
  });

  it("clamps a future timestamp to 0s -> 'just now' (Math.max(0, ...) branch)", () => {
    useStore.setState({ notifLog: [mkNotif({ ts: Date.now() + 60_000 })] }, false);
    const { getByText } = render(<NotifSheet />);
    expect(getByText("just now")).toBeTruthy();
  });
});

describe("NotifSheet mute toggle", () => {
  it("shows 'alerts on' when unmuted and toggles to muted on click", () => {
    useStore.setState({ muted: false }, false);
    const { getByText, queryByText } = render(<NotifSheet />);
    expect(getByText("alerts on")).toBeTruthy();
    expect(queryByText("muted")).toBeNull();
    fireEvent.click(getByText("alerts on"));
    expect(useStore.getState().muted).toBe(true);
  });

  it("shows 'muted' when muted and toggles back to unmuted on click", () => {
    useStore.setState({ muted: true }, false);
    const { getByText } = render(<NotifSheet />);
    expect(getByText("muted")).toBeTruthy();
    fireEvent.click(getByText("muted"));
    expect(useStore.getState().muted).toBe(false);
  });

  it("muting also clears the live toast stack (per the store's toggleMute)", () => {
    useStore.setState({ muted: false, notifs: [mkNotif()] }, false);
    const { getByText } = render(<NotifSheet />);
    fireEvent.click(getByText("alerts on"));
    expect(useStore.getState().notifs).toEqual([]);
  });
});

describe("NotifSheet clear + close", () => {
  it("'clear' empties the notif log", () => {
    useStore.setState({ notifLog: [mkNotif({ id: 1 }), mkNotif({ id: 2 })], unseen: 4 }, false);
    const { getByText } = render(<NotifSheet />);
    fireEvent.click(getByText("clear"));
    expect(useStore.getState().notifLog).toEqual([]);
    expect(useStore.getState().unseen).toBe(0);
  });

  it("clicking the × closes the panel", () => {
    const { getByText } = render(<NotifSheet />);
    fireEvent.click(getByText("×"));
    expect(useStore.getState().panel).toBeNull();
  });

  it("clicking the dimmed overlay closes the panel", () => {
    const { container } = render(<NotifSheet />);
    // NotifSheet renders a fragment: [dimmed overlay, sheet] as direct children.
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);
    expect(useStore.getState().panel).toBeNull();
  });
});
