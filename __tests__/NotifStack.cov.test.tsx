// Coverage suite for src/components/NotifStack.tsx — the toast stack: the
// null early-return when empty, rendering multiple toasts (with/without a
// repo badge), clicking a toast opens its URL (or does nothing without one),
// and the dismiss (×) button removes just that toast without opening its URL.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import * as opener from "@tauri-apps/plugin-opener";
import { NotifStack } from "../src/components/NotifStack";
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
  useStore.setState({ notifs: [] }, false);
  // spyOn on an already-spied module property returns the SAME spy with
  // accumulated call history in this bun:test version, so spy once and
  // clear per-test rather than re-spying (which would leak call counts).
  openUrlSpy = spyOn(opener, "openUrl");
  openUrlSpy.mockClear();
});

describe("NotifStack empty state", () => {
  it("renders nothing when there are no notifications", () => {
    const { container } = render(<NotifStack />);
    expect(container.innerHTML).toBe("");
  });
});

describe("NotifStack populated", () => {
  it("renders each notif's headline, sub, and repo badge", () => {
    useStore.setState({ notifs: [mkNotif({ id: 1 }), mkNotif({ id: 2, headline: "MR !13 updated", repo: "other" })] }, false);
    const { getByText } = render(<NotifStack />);
    expect(getByText("New MR !12")).toBeTruthy();
    expect(getByText("MR !13 updated")).toBeTruthy();
    expect(getByText("aurora")).toBeTruthy();
    expect(getByText("other")).toBeTruthy();
  });

  it("omits the repo badge when repo is falsy", () => {
    useStore.setState({ notifs: [mkNotif({ repo: "" })] }, false);
    const { queryByText } = render(<NotifStack />);
    expect(queryByText("aurora")).toBeNull();
  });

  it("clicking a toast with a url opens it", () => {
    useStore.setState({ notifs: [mkNotif({ url: "https://example.com/mr/12" })] }, false);
    const { getByText } = render(<NotifStack />);
    fireEvent.click(getByText("New MR !12"));
    expect(openUrlSpy).toHaveBeenCalledWith("https://example.com/mr/12");
  });

  it("clicking a toast without a url does not open anything", () => {
    useStore.setState({ notifs: [mkNotif({ url: undefined })] }, false);
    const { getByText } = render(<NotifStack />);
    fireEvent.click(getByText("New MR !12"));
    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it("clicking the dismiss (×) button removes only that notif and does not open its url", () => {
    useStore.setState({ notifs: [mkNotif({ id: 1 }), mkNotif({ id: 2, headline: "second" })] }, false);
    const { getAllByText } = render(<NotifStack />);
    const closeButtons = getAllByText("×");
    fireEvent.click(closeButtons[0]);
    expect(useStore.getState().notifs.map((n) => n.id)).toEqual([2]);
    expect(openUrlSpy).not.toHaveBeenCalled();
  });
});
