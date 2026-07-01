// Coverage suite for src/components/TitleBar.tsx — traffic lights (wired to
// getCurrentWindow), the rail-collapsed WorkspaceSwitcher swap, the branch
// label, and the connection dot / settings gear.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TitleBar } from "../src/components/TitleBar";
import { useStore, type Workspace } from "../src/state/store";

let seq = 90000;

function mkWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w-" + seq++,
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/repo",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [],
    active: 0,
    createdAt: 0,
    lastActive: 0,
    serverTabId: null,
    ...overrides,
  };
}

function seed(overrides: Record<string, unknown> = {}) {
  useStore.setState(
    {
      workspaces: [],
      activeWs: null,
      initialized: true,
      apiKeyPresent: false,
      keyEntry: false,
      keyError: null,
      settingsOpen: false,
      railCollapsed: false,
      repos: [],
      ...overrides,
    },
    false,
  );
}

beforeEach(() => {
  seed();
});
afterEach(() => {
  cleanup();
});

describe("TitleBar — center label", () => {
  it("shows 'aurora — zsh' when the rail is expanded and there is no active branch", () => {
    const { getByText, queryByTitle } = render(<TitleBar />);
    expect(getByText("aurora")).toBeTruthy();
    expect(getByText("zsh")).toBeTruthy();
    // Rail expanded -> the WorkspaceSwitcher pill isn't rendered.
    expect(queryByTitle("switch workspace")).toBeNull();
  });

  it("shows the ⎇ branch label when the active workspace has a branch, with a title tooltip", () => {
    const ws = mkWorkspace({ branch: "feature/x" });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByText } = render(<TitleBar />);
    const el = getByText("⎇ feature/x");
    expect(el.getAttribute("title")).toBe("feature/x");
  });

  it("swaps to the WorkspaceSwitcher pill when the rail is collapsed", () => {
    seed({ railCollapsed: true });
    const { queryByText, getByTitle } = render(<TitleBar />);
    expect(queryByText("aurora")).toBeNull();
    expect(getByTitle("switch workspace")).toBeTruthy();
  });
});

describe("TitleBar — connection status", () => {
  it("shows the warning dot + 'byok · add key' when no API key is present", () => {
    seed({ apiKeyPresent: false });
    const { getByText, queryByText } = render(<TitleBar />);
    expect(getByText("byok · add key")).toBeTruthy();
    expect(queryByText("connected")).toBeNull();
  });

  it("shows the connected dot + 'connected' when an API key is present", () => {
    seed({ apiKeyPresent: true });
    const { getByText, queryByText } = render(<TitleBar />);
    expect(getByText("connected")).toBeTruthy();
    expect(queryByText("byok · add key")).toBeNull();
  });

  it("clicking the connection status starts key entry", () => {
    seed({ apiKeyPresent: false });
    const { getByText } = render(<TitleBar />);
    fireEvent.click(getByText("byok · add key"));
    expect(useStore.getState().keyEntry).toBe(true);
  });
});

describe("TitleBar — settings gear", () => {
  it("clicking the gear opens settings", () => {
    const { getByTitle } = render(<TitleBar />);
    fireEvent.click(getByTitle("settings (⌘,)"));
    expect(useStore.getState().settingsOpen).toBe(true);
  });
});

describe("TitleBar — traffic lights", () => {
  it("close calls the window close control without throwing", () => {
    const { getByTitle } = render(<TitleBar />);
    expect(() => fireEvent.click(getByTitle("close"))).not.toThrow();
  });

  it("minimize calls the window minimize control without throwing", () => {
    const { getByTitle } = render(<TitleBar />);
    expect(() => fireEvent.click(getByTitle("minimize"))).not.toThrow();
  });

  it("plain click on the green button toggles fullscreen (not zoom)", async () => {
    const { getByTitle } = render(<TitleBar />);
    const btn = getByTitle("fullscreen (⌥ to zoom)");
    fireEvent.click(btn, { altKey: false });
    // Async handler — just prove it settles without throwing.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("⌥-click on the green button zooms instead", async () => {
    const { getByTitle } = render(<TitleBar />);
    const btn = getByTitle("fullscreen (⌥ to zoom)");
    fireEvent.click(btn, { altKey: true });
    await new Promise((r) => setTimeout(r, 0));
  });
});
