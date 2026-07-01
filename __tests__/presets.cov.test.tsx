// Coverage tests for src/lib/presets.ts.
import { describe, it, expect, beforeEach } from "bun:test";
import { useStore } from "../src/state/store";
import {
  listPresets,
  getPreset,
  addPreset,
  updatePreset,
  deletePreset,
  presetForIssueType,
  presetCreateFields,
} from "../src/lib/presets";
import { getRepoConfig } from "../src/lib/repoConfig";
import type { Preset } from "../src/lib/repoConfig";

const ROOT = "/repo/aurora";

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "p-fixed",
    name: "feature",
    issueTypes: ["Bug"],
    paneLayout: "2-split",
    runOnOpen: "dev",
    env: { FOO: "bar" },
    baseOverride: "develop",
    portOffset: 10,
    jiraSync: true,
    ...overrides,
  };
}

function seed(preset: Preset) {
  useStore.setState({ repoConfigs: { [ROOT]: { ...getRepoConfig(ROOT), presets: [preset] } } });
}

beforeEach(() => {
  useStore.setState({ repoConfigs: {} });
});

describe("listPresets / getPreset", () => {
  it("returns [] for a repo with no saved config, and for a null root", () => {
    expect(listPresets(ROOT)).toEqual([]);
    expect(listPresets(null)).toEqual([]);
  });

  it("lists presets from a saved config and finds by id or by name", () => {
    const preset = makePreset();
    seed(preset);
    expect(listPresets(ROOT)).toEqual([preset]);
    expect(getPreset(ROOT, preset.id)).toEqual(preset);
    expect(getPreset(ROOT, preset.name)).toEqual(preset);
    expect(getPreset(ROOT, "does-not-exist")).toBeUndefined();
  });
});

describe("addPreset", () => {
  it("creates a fresh preset with the documented defaults and persists it", () => {
    const p = addPreset(ROOT);
    expect(p.name).toBe("new-preset");
    expect(p.issueTypes).toEqual([]);
    expect(p.paneLayout).toBe("1");
    expect(p.runOnOpen).toBeNull();
    expect(p.env).toEqual({});
    expect(p.baseOverride).toBeNull();
    expect(p.portOffset).toBe("auto");
    expect(p.jiraSync).toBe(false);
    expect(p.id).toMatch(/^p\d+-/);
    expect(listPresets(ROOT)).toContainEqual(p);
  });

  it("generates a distinct id on every call, appending each preset", () => {
    const a = addPreset(ROOT);
    const b = addPreset(ROOT);
    expect(a.id).not.toBe(b.id);
    expect(listPresets(ROOT).map((p) => p.id)).toEqual([a.id, b.id]);
  });
});

describe("updatePreset", () => {
  it("patches an existing preset in place, and the id argument always wins", () => {
    const preset = makePreset({ id: "p1", name: "old" });
    seed(preset);
    updatePreset(ROOT, "p1", { name: "renamed", id: "p1" });
    const found = getPreset(ROOT, "p1");
    expect(found?.name).toBe("renamed");
    expect(found?.id).toBe("p1");
    // Unpatched fields survive the merge.
    expect(found?.env).toEqual({ FOO: "bar" });
  });

  it("is a no-op when the id doesn't match any preset", () => {
    const preset = makePreset({ id: "p1" });
    seed(preset);
    updatePreset(ROOT, "missing-id", { name: "x" });
    expect(listPresets(ROOT)).toEqual([preset]);
  });
});

describe("deletePreset", () => {
  it("removes a preset by id", () => {
    const preset = makePreset({ id: "p1" });
    seed(preset);
    deletePreset(ROOT, "p1");
    expect(listPresets(ROOT)).toEqual([]);
  });

  it("is a no-op when the id doesn't match any preset", () => {
    const preset = makePreset({ id: "p1" });
    seed(preset);
    deletePreset(ROOT, "missing-id");
    expect(listPresets(ROOT)).toEqual([preset]);
  });
});

describe("presetForIssueType", () => {
  it("returns undefined for a null, undefined, or empty issue type", () => {
    seed(makePreset({ issueTypes: ["Bug"] }));
    expect(presetForIssueType(ROOT, null)).toBeUndefined();
    expect(presetForIssueType(ROOT, undefined)).toBeUndefined();
    expect(presetForIssueType(ROOT, "")).toBeUndefined();
  });

  it("matches case-insensitively against a preset's issueTypes", () => {
    const preset = makePreset({ issueTypes: ["Bug", "Hotfix"] });
    seed(preset);
    expect(presetForIssueType(ROOT, "bug")).toEqual(preset);
    expect(presetForIssueType(ROOT, "BUG")).toEqual(preset);
    expect(presetForIssueType(ROOT, "HotFix")).toEqual(preset);
  });

  it("returns undefined when no preset claims the issue type", () => {
    seed(makePreset({ issueTypes: ["Bug"] }));
    expect(presetForIssueType(ROOT, "Story")).toBeUndefined();
  });
});

describe("presetCreateFields", () => {
  it("maps a '1' layout preset to a single pane and passes through its other fields", () => {
    const preset = makePreset({ paneLayout: "1", portOffset: "auto", runOnOpen: "start" });
    expect(presetCreateFields(preset)).toEqual({
      paneCount: 1,
      split: undefined,
      scriptName: "start",
      baseOverride: preset.baseOverride,
      env: preset.env,
      portOffset: "auto",
      jiraSync: preset.jiraSync,
    });
  });

  it("maps a '2-split' layout to 2 panes with an h split", () => {
    const fields = presetCreateFields(makePreset({ paneLayout: "2-split" }));
    expect(fields.paneCount).toBe(2);
    expect(fields.split).toBe("h");
  });

  it("maps a '2x2' layout to 4 panes with an h split", () => {
    const fields = presetCreateFields(makePreset({ paneLayout: "2x2" }));
    expect(fields.paneCount).toBe(4);
    expect(fields.split).toBe("h");
  });

  it("passes a null runOnOpen through as a null scriptName", () => {
    const fields = presetCreateFields(makePreset({ runOnOpen: null }));
    expect(fields.scriptName).toBeNull();
  });
});
