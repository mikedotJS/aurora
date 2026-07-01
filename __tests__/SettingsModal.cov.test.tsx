import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { useStore, DEFAULT_SETTINGS } from "../src/state/store";
import { SettingsModal } from "../src/components/SettingsModal";
import { ACCENTS } from "../src/lib/theme";

beforeEach(() => {
  tauri.reset();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    apiKeyPresent: false,
    muted: false,
    settingsOpen: true,
    keyEntry: false,
    connections: { jira: [], ai: [] },
    repoConfigs: {},
  });
});
afterEach(cleanup);

describe("no api key present", () => {
  it("shows 'no key set' and the 'add' pill; clicking it closes settings and starts key entry", () => {
    render(<SettingsModal />);
    expect(screen.getByText("no key set")).toBeTruthy();
    expect(screen.getByText("add")).toBeTruthy();
    expect(screen.queryByText("remove")).toBeNull();
    expect(screen.getByText("needs key")).toBeTruthy(); // Ask Claude row

    fireEvent.click(screen.getByText("add"));
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(useStore.getState().keyEntry).toBe(true);
  });
});

describe("api key present", () => {
  it("shows 'stored in macOS Keychain', 'update' + 'remove' pills, and 'ready'", () => {
    useStore.setState({ apiKeyPresent: true });
    render(<SettingsModal />);
    expect(screen.getByText("stored in macOS Keychain")).toBeTruthy();
    // "update" also appears in the Connections sub-panel's AI-account row.
    expect(screen.getAllByText("update").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("remove")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
  });

  it("clicking 'remove' deletes the key via keychain and clears apiKeyPresent", async () => {
    useStore.setState({ apiKeyPresent: true });
    tauri.invoke({ key_delete: () => undefined });
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("remove"));
    // await the async handler's microtasks
    await Promise.resolve();
    await Promise.resolve();
    expect(tauri.lastCall("key_delete")).toBeTruthy();
    expect(useStore.getState().apiKeyPresent).toBe(false);
  });
});

describe("model segmented control", () => {
  it("switches the model via each option", () => {
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("Opus 4.8"));
    expect(useStore.getState().settings.model).toBe("claude-opus-4-8");
    fireEvent.click(screen.getByText("Haiku 4.5"));
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
    fireEvent.click(screen.getByText("Sonnet 4.6"));
    expect(useStore.getState().settings.model).toBe("claude-sonnet-4-6");
  });
});

describe("appearance", () => {
  it("switches accent through every swatch", () => {
    render(<SettingsModal />);
    const keys = Object.keys(ACCENTS);
    // "Accent" label sits in Row's inner label div; its grandparent is the Row,
    // whose last child holds the swatch <span> children.
    const labelDiv = screen.getByText("Accent");
    const row = labelDiv.parentElement!.parentElement!;
    const swatchContainer = row.lastElementChild as HTMLElement;
    const swatches = Array.from(swatchContainer.children) as HTMLElement[];
    expect(swatches.length).toBe(keys.length);
    for (const chip of swatches) {
      fireEvent.click(chip);
    }
    expect(keys).toContain(useStore.getState().settings.accent);
  });

  it("switches text size via the segmented control", () => {
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("Compact"));
    expect(useStore.getState().settings.fontSize).toBe("compact");
    fireEvent.click(screen.getByText("Large"));
    expect(useStore.getState().settings.fontSize).toBe("large");
    fireEvent.click(screen.getByText("Cozy"));
    expect(useStore.getState().settings.fontSize).toBe("cozy");
  });
});

describe("shell + notification toggles", () => {
  it("flips ghost autocomplete", () => {
    render(<SettingsModal />);
    const label = screen.getByText("Ghost autocomplete");
    const toggle = label.parentElement!.parentElement!.querySelector('div[style*="border-radius: 999px"]') as HTMLElement;
    fireEvent.click(toggle);
    expect(useStore.getState().settings.ghost).toBe(!DEFAULT_SETTINGS.ghost);
  });

  it("flips auto-rename tabs", () => {
    render(<SettingsModal />);
    const label = screen.getByText("Auto-rename tabs");
    const toggle = label.parentElement!.parentElement!.querySelector('div[style*="border-radius: 999px"]') as HTMLElement;
    fireEvent.click(toggle);
    expect(useStore.getState().settings.autoRenameTabs).toBe(!DEFAULT_SETTINGS.autoRenameTabs);
  });

  it("flips merge request alerts", () => {
    render(<SettingsModal />);
    const label = screen.getByText("Merge request alerts");
    const toggle = label.parentElement!.parentElement!.querySelector('div[style*="border-radius: 999px"]') as HTMLElement;
    fireEvent.click(toggle);
    expect(useStore.getState().settings.notifyMr).toBe(!DEFAULT_SETTINGS.notifyMr);
  });

  it("flips do-not-disturb (mute), clearing pending notifs", () => {
    useStore.setState({ notifs: [{ id: 1, color: "x", icon: "x", headline: "h", sub: "s", repo: "r", ts: 0 }] });
    render(<SettingsModal />);
    const label = screen.getByText("Do not disturb");
    const toggle = label.parentElement!.parentElement!.querySelector('div[style*="border-radius: 999px"]') as HTMLElement;
    fireEvent.click(toggle);
    expect(useStore.getState().muted).toBe(true);
    expect(useStore.getState().notifs).toEqual([]);
  });
});

describe("closing", () => {
  it("closes via the backdrop click", () => {
    const { container } = render(<SettingsModal />);
    // Outer wrapper's first child is the click-to-dismiss backdrop div.
    const backdrop = container.firstElementChild!.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("closes via the × button", () => {
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("×"));
    expect(useStore.getState().settingsOpen).toBe(false);
  });
});
