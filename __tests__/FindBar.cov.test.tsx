// Coverage suite for src/components/FindBar.tsx — the find-in-output bar:
// counter states (empty query, no matches, has matches), keyboard shortcuts
// (Enter/Shift-Enter, ArrowUp/Down, Escape), stepper click handlers (incl.
// the disabled no-op guard), close button, mousedown containment, and the
// mount-time focus/select effect.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { FindBar } from "../src/components/FindBar";
import { useStore } from "../src/state/store";

afterEach(cleanup);

beforeEach(() => {
  useStore.setState({ find: { open: true, query: "", current: 0 } }, false);
});

describe("FindBar counter + steppers", () => {
  it("shows an empty counter and disabled steppers when there is no query and no matches", () => {
    const { getByPlaceholderText, getByTitle } = render(<FindBar total={0} index={0} />);
    const input = getByPlaceholderText("Find in output") as HTMLInputElement;
    expect(input.value).toBe("");
    const counter = input.parentElement!.querySelector("span:nth-of-type(2)");
    expect(counter?.textContent).toBe("");
    const prev = getByTitle("previous match (⇧↵)");
    const next = getByTitle("next match (↵)");
    expect(prev.style.opacity).toBe("0.32");
    expect(next.style.opacity).toBe("0.32");
  });

  it("shows '0/0' when there is a query but no matches", () => {
    useStore.setState({ find: { open: true, query: "zzz", current: 0 } }, false);
    const { container } = render(<FindBar total={0} index={0} />);
    expect(container.textContent).toContain("0/0");
  });

  it("shows 'index+1/total' when there are matches, and enables the steppers", () => {
    const { container, getByTitle } = render(<FindBar total={5} index={2} />);
    expect(container.textContent).toContain("3/5");
    expect(getByTitle("previous match (⇧↵)").style.opacity).toBe("1");
    expect(getByTitle("next match (↵)").style.opacity).toBe("1");
  });

  it("focuses and selects the input on mount", () => {
    const { getByPlaceholderText } = render(<FindBar total={0} index={0} />);
    const input = getByPlaceholderText("Find in output") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });
});

describe("FindBar input + store wiring", () => {
  it("typing updates the store query and resets current to 0", () => {
    useStore.setState({ find: { open: true, query: "", current: 2 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={5} index={2} />);
    fireEvent.change(getByPlaceholderText("Find in output"), { target: { value: "abc" } });
    expect(useStore.getState().find).toEqual({ open: true, query: "abc", current: 0 });
  });
});

describe("FindBar keyboard shortcuts", () => {
  it("Enter steps forward (dir=1)", () => {
    useStore.setState({ find: { open: true, query: "x", current: 0 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={3} index={0} />);
    fireEvent.keyDown(getByPlaceholderText("Find in output"), { key: "Enter" });
    expect(useStore.getState().find.current).toBe(1);
  });

  it("Shift-Enter steps backward (dir=-1)", () => {
    useStore.setState({ find: { open: true, query: "x", current: 1 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={3} index={1} />);
    fireEvent.keyDown(getByPlaceholderText("Find in output"), { key: "Enter", shiftKey: true });
    expect(useStore.getState().find.current).toBe(0);
  });

  it("ArrowDown steps forward and wraps around", () => {
    useStore.setState({ find: { open: true, query: "x", current: 2 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={3} index={2} />);
    fireEvent.keyDown(getByPlaceholderText("Find in output"), { key: "ArrowDown" });
    expect(useStore.getState().find.current).toBe(0); // (2+1)%3
  });

  it("ArrowUp steps backward and wraps around", () => {
    useStore.setState({ find: { open: true, query: "x", current: 0 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={3} index={0} />);
    fireEvent.keyDown(getByPlaceholderText("Find in output"), { key: "ArrowUp" });
    expect(useStore.getState().find.current).toBe(2); // (0-1+3)%3
  });

  it("Escape closes the find bar and resets the query/current", () => {
    useStore.setState({ find: { open: true, query: "abc", current: 2 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={3} index={2} />);
    fireEvent.keyDown(getByPlaceholderText("Find in output"), { key: "Escape" });
    expect(useStore.getState().find).toEqual({ open: false, query: "", current: 0 });
  });

  it("an unrelated key does nothing", () => {
    useStore.setState({ find: { open: true, query: "x", current: 1 } }, false);
    const { getByPlaceholderText } = render(<FindBar total={3} index={1} />);
    fireEvent.keyDown(getByPlaceholderText("Find in output"), { key: "a" });
    expect(useStore.getState().find.current).toBe(1);
  });
});

describe("FindBar stepper + close click handlers", () => {
  it("clicking the enabled 'next' stepper steps forward", () => {
    useStore.setState({ find: { open: true, query: "x", current: 0 } }, false);
    const { getByTitle } = render(<FindBar total={3} index={0} />);
    fireEvent.click(getByTitle("next match (↵)"));
    expect(useStore.getState().find.current).toBe(1);
  });

  it("clicking the enabled 'previous' stepper steps backward", () => {
    useStore.setState({ find: { open: true, query: "x", current: 1 } }, false);
    const { getByTitle } = render(<FindBar total={3} index={1} />);
    fireEvent.click(getByTitle("previous match (⇧↵)"));
    expect(useStore.getState().find.current).toBe(0);
  });

  it("clicking a disabled stepper is a no-op (does not call stepFind at all)", () => {
    // current=2 with total=0: if stepFind ran, the total<=0 branch would force
    // current back to 0. It staying at 2 proves the disabled guard short-circuited.
    useStore.setState({ find: { open: true, query: "x", current: 2 } }, false);
    const { getByTitle } = render(<FindBar total={0} index={0} />);
    fireEvent.click(getByTitle("next match (↵)"));
    fireEvent.click(getByTitle("previous match (⇧↵)"));
    expect(useStore.getState().find.current).toBe(2);
  });

  it("clicking the close button closes the find bar", () => {
    useStore.setState({ find: { open: true, query: "abc", current: 1 } }, false);
    const { getByTitle } = render(<FindBar total={3} index={1} />);
    fireEvent.click(getByTitle("close (esc)"));
    expect(useStore.getState().find).toEqual({ open: false, query: "", current: 0 });
  });
});

describe("FindBar mousedown containment", () => {
  it("stops propagation so a mousedown on the bar doesn't reach ancestors (e.g. drag/select handlers)", () => {
    let parentSaw = false;
    const { container } = render(
      <div onMouseDown={() => (parentSaw = true)}>
        <FindBar total={0} index={0} />
      </div>,
    );
    const bar = container.firstElementChild!.firstElementChild as HTMLElement;
    fireEvent.mouseDown(bar);
    expect(parentSaw).toBe(false);
  });
});
