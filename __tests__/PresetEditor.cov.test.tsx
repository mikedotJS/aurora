import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import { PresetEditor } from "../src/components/PresetEditor";
import { getRepoConfig } from "../src/lib/repoConfig";
import type { Preset } from "../src/lib/repoConfig";

const ROOT = "/repo/aurora";

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "p1",
    name: "feature",
    issueTypes: ["Bug", "Story"],
    paneLayout: "2-split",
    runOnOpen: "dev",
    env: { API_KEY: "xyz", TOKEN: "abc" },
    baseOverride: "develop",
    portOffset: 15,
    jiraSync: true,
    ...overrides,
  };
}

function seed(preset: Preset) {
  useStore.setState({ repoConfigs: { [ROOT]: { ...getRepoConfig(ROOT), presets: [preset] } } });
}

beforeEach(() => {
  tauri.reset();
  tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "develop"] }) });
  useStore.setState({
    repoConfigs: {},
    userScripts: { [ROOT]: { scripts: [{ name: "dev", desc: "", split: false, tasks: [] }, { name: "build", desc: "", split: false, tasks: [] }], onEnter: null } },
  });
});
afterEach(cleanup);

describe("rendering", () => {
  it("shows the preset name in the header and pre-fills every field from the prop", async () => {
    const preset = makePreset();
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    expect(screen.getByText("Edit preset")).toBeTruthy();
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByDisplayValue("feature")).toBeTruthy();
    expect(screen.getByDisplayValue("Bug, Story")).toBeTruthy();
    expect(screen.getByDisplayValue("API_KEY")).toBeTruthy();
    expect(screen.getByDisplayValue("xyz")).toBeTruthy();
    expect(screen.getByDisplayValue("TOKEN")).toBeTruthy();
    expect(screen.getByDisplayValue("abc")).toBeTruthy();
    // non-auto port offset shows the numeric input, not the "auto" state
    expect(screen.getByDisplayValue("15")).toBeTruthy();
    // base override select resolves once gitBranches() settles
    await waitFor(() => expect((screen.getByDisplayValue("develop") as HTMLSelectElement).tagName).toBe("SELECT"));
  });

  it("renders an empty env-vars list and the 'auto' port state for a fresh preset", () => {
    const preset = makePreset({ env: {}, portOffset: "auto", issueTypes: [] });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    expect(screen.getByDisplayValue("")).toBeTruthy(); // issue types input, empty
    expect(screen.getByText("auto")).toBeTruthy();
    expect(screen.queryByDisplayValue("15")).toBeNull();
  });
});

describe("name + issue types", () => {
  it("updates the name field on input", () => {
    const preset = makePreset();
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const input = screen.getByDisplayValue("feature") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed-preset" } });
    expect(screen.getByDisplayValue("renamed-preset")).toBeTruthy();
    // header sample also reflects the draft name
    expect(screen.getByText("renamed-preset")).toBeTruthy();
  });

  it("splits, trims, and drops empty entries when editing issue types", () => {
    const preset = makePreset();
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const input = screen.getByDisplayValue("Bug, Story") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bug,  , Task ," } });
    expect(screen.getByDisplayValue("Bug, Task")).toBeTruthy();
  });
});

describe("pane layout", () => {
  it("switches the pane layout via the pill selector", async () => {
    const preset = makePreset({ paneLayout: "1" });
    seed(preset);
    const onClose = () => {};
    render(<PresetEditor root={ROOT} preset={preset} onClose={onClose} />);
    fireEvent.click(screen.getByText("2×2"));
    fireEvent.click(screen.getByText("Save preset"));
    expect(getRepoConfig(ROOT).presets[0].paneLayout).toBe("2x2");
  });
});

describe("on-open script + base override selects", () => {
  it("changes the on-open script via its select", () => {
    const preset = makePreset({ runOnOpen: "dev" });
    const { container } = render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const selects = container.querySelectorAll("select");
    const scriptSelect = selects[0] as HTMLSelectElement;
    expect(scriptSelect.value).toBe("dev");
    fireEvent.change(scriptSelect, { target: { value: "build" } });
    expect(scriptSelect.value).toBe("build");
    fireEvent.change(scriptSelect, { target: { value: "" } });
    expect(scriptSelect.value).toBe("");
  });

  it("changes the base override via its select, including back to 'inherit default'", async () => {
    const preset = makePreset({ baseOverride: null });
    const { container } = render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll("select")[1].querySelectorAll("option").length).toBeGreaterThan(1));
    const baseSelect = container.querySelectorAll("select")[1] as HTMLSelectElement;
    expect(baseSelect.value).toBe("");
    fireEvent.change(baseSelect, { target: { value: "develop" } });
    expect(baseSelect.value).toBe("develop");
    fireEvent.change(baseSelect, { target: { value: "" } });
    expect(baseSelect.value).toBe("");
  });
});

describe("environment variables", () => {
  it("renames a key while preserving its value and row order", () => {
    const preset = makePreset({ env: { API_KEY: "xyz", TOKEN: "abc" } });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const keyInputs = screen.getAllByPlaceholderText("NAME");
    fireEvent.change(keyInputs[0], { target: { value: "API_KEY2" } });
    expect(screen.getByDisplayValue("API_KEY2")).toBeTruthy();
    expect(screen.getByDisplayValue("xyz")).toBeTruthy(); // value preserved
    expect(screen.getByDisplayValue("TOKEN")).toBeTruthy(); // other row untouched
  });

  it("edits a value in place", () => {
    const preset = makePreset({ env: { API_KEY: "xyz" } });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const valueInput = screen.getByDisplayValue("xyz") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "new-value" } });
    expect(screen.getByDisplayValue("new-value")).toBeTruthy();
    expect(screen.getByDisplayValue("API_KEY")).toBeTruthy();
  });

  it("deletes a row via the × button", () => {
    const preset = makePreset({ env: { API_KEY: "xyz", TOKEN: "abc" } });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    expect(screen.getAllByPlaceholderText("NAME")).toHaveLength(2);
    fireEvent.click(screen.getAllByText("×")[0]);
    expect(screen.getAllByPlaceholderText("NAME")).toHaveLength(1);
    expect(screen.getByDisplayValue("TOKEN")).toBeTruthy();
    expect(screen.queryByDisplayValue("API_KEY")).toBeNull();
  });

  it("adds a new empty variable row via '+ add variable'", () => {
    const preset = makePreset({ env: { API_KEY: "xyz" } });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    expect(screen.getAllByPlaceholderText("NAME")).toHaveLength(1);
    fireEvent.click(screen.getByText("+ add variable"));
    expect(screen.getAllByPlaceholderText("NAME")).toHaveLength(2);
  });
});

describe("port offset", () => {
  it("toggles from 'auto' to a numeric offset and back", () => {
    const preset = makePreset({ portOffset: "auto" });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    expect(screen.queryByDisplayValue("10")).toBeNull();
    fireEvent.click(screen.getByText("auto"));
    expect(screen.getByDisplayValue("10")).toBeTruthy();
    fireEvent.click(screen.getByText("auto"));
    expect(screen.queryByDisplayValue("10")).toBeNull();
  });

  it("parses the numeric input, clamping negative/empty values to 0", () => {
    const preset = makePreset({ portOffset: 15 });
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const numInput = screen.getByDisplayValue("15") as HTMLInputElement;
    fireEvent.change(numInput, { target: { value: "40" } });
    expect(screen.getByDisplayValue("40")).toBeTruthy();
    fireEvent.change(numInput, { target: { value: "" } });
    expect(screen.getByDisplayValue("0")).toBeTruthy();
    fireEvent.change(numInput, { target: { value: "-5" } });
    expect(screen.getByDisplayValue("0")).toBeTruthy();
  });
});

describe("jira sync toggle", () => {
  it("flips draft.jiraSync when the toggle is clicked", () => {
    const preset = makePreset({ jiraSync: false });
    seed(preset);
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    const label = screen.getByText("Two-way Jira sync");
    const toggle = label.parentElement!.nextElementSibling as HTMLElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("Save preset"));
    expect(getRepoConfig(ROOT).presets[0].jiraSync).toBe(true);
  });
});

describe("delete flow", () => {
  it("asks for confirmation, and 'keep' backs out without deleting", () => {
    const preset = makePreset();
    seed(preset);
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Delete preset"));
    expect(screen.getByText("Delete this preset?")).toBeTruthy();
    fireEvent.click(screen.getByText("keep"));
    expect(screen.queryByText("Delete this preset?")).toBeNull();
    expect(screen.getByText("Delete preset")).toBeTruthy();
    expect(getRepoConfig(ROOT).presets).toHaveLength(1);
  });

  it("deletes the preset and closes on confirmed delete", () => {
    const preset = makePreset();
    seed(preset);
    let closed = false;
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => (closed = true)} />);
    fireEvent.click(screen.getByText("Delete preset"));
    fireEvent.click(screen.getByText("Delete"));
    expect(getRepoConfig(ROOT).presets).toHaveLength(0);
    expect(closed).toBe(true);
  });
});

describe("save + cancel", () => {
  it("persists the full edited draft on Save and calls onClose", () => {
    const preset = makePreset({ id: "p9", name: "old-name" });
    seed(preset);
    let closed = false;
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => (closed = true)} />);
    fireEvent.change(screen.getByDisplayValue("old-name"), { target: { value: "new-name" } });
    fireEvent.click(screen.getByText("Save preset"));
    const saved = getRepoConfig(ROOT).presets.find((p) => p.id === "p9");
    expect(saved?.name).toBe("new-name");
    expect(closed).toBe(true);
  });

  it("discards changes and calls onClose on Cancel", () => {
    const preset = makePreset({ id: "p9", name: "old-name" });
    seed(preset);
    let closed = false;
    render(<PresetEditor root={ROOT} preset={preset} onClose={() => (closed = true)} />);
    fireEvent.change(screen.getByDisplayValue("old-name"), { target: { value: "unsaved-edit" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(getRepoConfig(ROOT).presets.find((p) => p.id === "p9")?.name).toBe("old-name");
    expect(closed).toBe(true);
  });
});
