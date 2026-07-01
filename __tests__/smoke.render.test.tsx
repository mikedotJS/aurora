// Smoke test: proves the component-render path works end-to-end under the shared
// preload (happy-dom + Tauri/xterm mocks + real Zustand store). If this renders,
// P1b can render any component.
import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { StatusBar } from "../src/components/StatusBar";
import { TitleBar } from "../src/components/TitleBar";

describe("component render smoke", () => {
  it("renders StatusBar into the DOM without throwing", () => {
    const { container } = render(<StatusBar />);
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("renders TitleBar (uses getCurrentWindow + store branch)", () => {
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain("aurora");
  });
});
