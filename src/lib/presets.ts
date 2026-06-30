// Preset CRUD + the "active preset for an issue type" lookup consumed by the
// create scope form. Presets live in the per-repo config (lib/repoConfig.ts);
// these helpers read/write that config and stamp a preset onto a workspace.

import { getRepoConfig, updateRepoConfig, layoutToPanes, type Preset } from "./repoConfig";

/** Presets for a repo (always non-empty: built-ins back the default config). */
export function listPresets(root: string | null): Preset[] {
  return getRepoConfig(root).presets;
}

export function getPreset(root: string | null, idOrName: string): Preset | undefined {
  return listPresets(root).find((p) => p.id === idOrName || p.name === idOrName);
}

let newSeq = 1;
function freshPreset(): Preset {
  return {
    id: `p${newSeq++}-${Math.random().toString(36).slice(2, 7)}`,
    name: "new-preset",
    issueTypes: [],
    paneLayout: "1",
    runOnOpen: null,
    env: {},
    baseOverride: null,
    portOffset: "auto",
    jiraSync: false,
  };
}

export function addPreset(root: string): Preset {
  const preset = freshPreset();
  updateRepoConfig(root, (c) => {
    c.presets.push(preset);
  });
  return preset;
}

export function updatePreset(root: string, id: string, patch: Partial<Preset>): void {
  updateRepoConfig(root, (c) => {
    const i = c.presets.findIndex((p) => p.id === id);
    if (i !== -1) c.presets[i] = { ...c.presets[i], ...patch, id };
  });
}

export function deletePreset(root: string, id: string): void {
  updateRepoConfig(root, (c) => {
    c.presets = c.presets.filter((p) => p.id !== id);
  });
}

/**
 * The preset that auto-selects for a Jira issue type (case-insensitive), or
 * undefined. Used by the scope form to pre-select when a workspace is created
 * from an issue.
 */
export function presetForIssueType(root: string | null, issueType: string | null | undefined): Preset | undefined {
  if (!issueType) return undefined;
  const t = issueType.toLowerCase();
  return listPresets(root).find((p) => p.issueTypes.some((x) => x.toLowerCase() === t));
}

/** The fields a preset stamps onto a new workspace (pane layout, script, base, env). */
export function presetCreateFields(preset: Preset) {
  const { paneCount, split } = layoutToPanes(preset.paneLayout);
  return {
    paneCount,
    split,
    scriptName: preset.runOnOpen,
    baseOverride: preset.baseOverride,
    env: preset.env,
    portOffset: preset.portOffset,
    jiraSync: preset.jiraSync,
  };
}
