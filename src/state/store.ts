// Central UI state machine: groups (tabs) → panes (sessions). Mirrors the
// structure of the Aurora mockup but each pane is backed by a real PTY.

import { create } from "zustand";
import type { AccentKey, FontKey } from "../lib/theme";
import { applyTheme } from "../lib/theme";
import type { Suggestion } from "../ai/suggest";
import { ghostFor } from "../lib/commands";
import type { DirEntry } from "../lib/sys";

/** Open Tab folder-completion list anchored on a path token in the prompt. */
export interface Completion {
  items: DirEntry[];
  index: number;
  /** Where the path token starts, and its literal dir prefix — for rebuilding the input on accept. */
  tokenStart: number;
  dir: string;
}

export interface Settings {
  model: string;
  accent: AccentKey;
  fontSize: FontKey;
  ghost: boolean;
  notifyMr: boolean;
}

export const MODEL_OPTIONS = [
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export const DEFAULT_SETTINGS: Settings = {
  model: "claude-sonnet-4-6",
  accent: "teal",
  fontSize: "cozy",
  ghost: true,
  notifyMr: true,
};

export interface Block {
  id: number;
  command: string;
  cwd: string;
  output: string;
  exitCode: number | null;
  running: boolean;
}

export interface ScriptTask {
  dir: string;
  cmd: string;
}
export interface Script {
  name: string;
  desc: string;
  split: boolean;
  tasks: ScriptTask[];
}
export interface RepoScripts {
  scripts: Script[];
  onEnter: string | null;
}
export interface HookInfo {
  name: string;
  label: string;
  desc: string;
}

export interface GitlabMr {
  iid: number;
  title: string;
  branch: string;
  draft: boolean;
  author: string;
  web_url: string;
  updated: string;
}

export interface Notif {
  id: number;
  color: string;
  icon: string;
  headline: string;
  sub: string;
  repo: string;
  url?: string;
  ts: number;
}

export interface PaneState {
  id: number;
  ptyId: string | null;
  isZsh: boolean;
  cwd: string;
  branch: string | null;
  input: string;
  ghost: string;
  history: string[];
  hIndex: number;
  suggestion: Suggestion | null;
  suggestionLoading: boolean;
  pendingFix: string | null;
  completion: Completion | null;
  inputSelected: boolean;
  rawMode: boolean;
  exited: boolean;
  ready: boolean;
  dirNames: string[];
  blocks: Block[];
  repoRoot: string | null;
  firedHooks: string[];
  hook: HookInfo | null;
}

export interface Group {
  id: number;
  panes: PaneState[];
  active: number;
  split: "h" | "v";
}

export type PanelKind = "mr" | "notif" | "scripts" | null;

export interface StoreState {
  tabs: Group[];
  active: number;
  home: string;
  settings: Settings;
  apiKeyPresent: boolean;
  keyEntry: boolean;
  keyError: string | null;
  settingsOpen: boolean;
  panel: PanelKind;
  userScripts: Record<string, RepoScripts>;
  scriptsSetupOpen: boolean;
  repoMrs: Record<string, GitlabMr[]>;
  glabUser: string | null;
  find: { open: boolean; query: string; current: number };
  notifs: Notif[];
  notifLog: Notif[];
  unseen: number;
  muted: boolean;

  // lifecycle
  init: (home: string, settings: Settings, apiKeyPresent: boolean) => void;
  // panes runtime
  setPaneRuntime: (paneId: number, rt: { ptyId: string; isZsh: boolean }) => void;
  markExited: (paneId: number) => void;
  // tabs
  newTab: () => void;
  closeTab: (i: number) => void;
  selectTab: (i: number) => void;
  cycleTab: (dir: number) => void;
  mergeTabs: (src: number, dest: number) => void;
  // panes
  splitPane: (dir: "h" | "v") => void;
  closePane: () => void;
  focusPane: (i: number) => void;
  cyclePane: (dir: number) => void;
  // prompt
  setInput: (paneId: number, value: string) => void;
  setDirNames: (paneId: number, names: string[]) => void;
  setCwd: (paneId: number, cwd: string) => void;
  setBranch: (paneId: number, branch: string | null) => void;
  // command blocks
  startBlock: (paneId: number, command: string, cwd: string) => void;
  markCapture: (paneId: number) => void;
  appendOutput: (paneId: number, text: string) => void;
  endBlock: (paneId: number, exitCode: number | null) => void;
  clearBlocks: (paneId: number) => void;
  pushHistory: (paneId: number, cmd: string) => void;
  histNav: (paneId: number, dir: number) => void;
  setSuggestion: (paneId: number, s: Suggestion | null) => void;
  setSuggestionLoading: (paneId: number, v: boolean) => void;
  setPendingFix: (paneId: number, fix: string | null) => void;
  openCompletion: (paneId: number, c: Omit<Completion, "index">) => void;
  moveCompletion: (paneId: number, delta: number) => void;
  acceptCompletion: (paneId: number) => void;
  closeCompletion: (paneId: number) => void;
  selectAllInput: (paneId: number) => void;
  collapseInputSelection: (paneId: number) => void;
  setRawMode: (paneId: number, v: boolean) => void;
  // settings / panels / key
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openPanel: (p: Exclude<PanelKind, null>) => void;
  closePanel: () => void;
  // scripts + hooks
  setUserScripts: (m: Record<string, RepoScripts>) => void;
  openScriptsSetup: () => void;
  closeScriptsSetup: () => void;
  setRepoRoot: (paneId: number, root: string | null) => void;
  setHook: (paneId: number, hook: HookInfo | null) => void;
  markHookFired: (paneId: number, root: string) => void;
  setReady: (paneId: number) => void;
  // gitlab + notifications
  setRepoMrs: (root: string, mrs: GitlabMr[]) => void;
  setGlabUser: (user: string | null) => void;
  // find-in-output
  openFind: () => void;
  closeFind: () => void;
  setFindQuery: (q: string) => void;
  stepFind: (dir: 1 | -1, total: number) => void;
  notify: (n: Omit<Notif, "id" | "ts">) => void;
  dismissNotif: (id: number) => void;
  clearNotifLog: () => void;
  toggleMute: () => void;
  markNotifsSeen: () => void;
  startKeyEntry: () => void;
  cancelKeyEntry: () => void;
  setKeyError: (e: string | null) => void;
  setApiKeyPresent: (v: boolean) => void;
}

/** Alias for the full store state, for helpers that read a snapshot. */
export type StoreApiState = StoreState;

let paneSeq = 1;
let groupSeq = 1;
let blockSeq = 1;
let notifSeq = 0;

function newPane(cwd: string): PaneState {
  return {
    id: paneSeq++,
    ptyId: null,
    isZsh: false,
    cwd,
    branch: null,
    input: "",
    ghost: "",
    history: [],
    hIndex: -1,
    suggestion: null,
    suggestionLoading: false,
    pendingFix: null,
    completion: null,
    inputSelected: false,
    rawMode: false,
    exited: false,
    ready: false,
    dirNames: [],
    blocks: [],
    repoRoot: null,
    firedHooks: [],
    hook: null,
  };
}

function newGroup(cwd: string): Group {
  return { id: groupSeq++, panes: [newPane(cwd)], active: 0, split: "h" };
}

export function activeGroup(s: StoreState): Group | undefined {
  return s.tabs[s.active];
}
export function activePane(s: StoreState): PaneState | undefined {
  const g = s.tabs[s.active];
  return g ? g.panes[g.active] : undefined;
}

type PanePatch = Partial<PaneState> | ((p: PaneState) => Partial<PaneState>);

function patchPane(tabs: Group[], paneId: number, patch: PanePatch): Group[] {
  return tabs.map((g) => ({
    ...g,
    panes: g.panes.map((p) =>
      p.id === paneId
        ? { ...p, ...(typeof patch === "function" ? patch(p) : patch) }
        : p,
    ),
  }));
}

function recomputeGhost(p: PaneState, ghostEnabled: boolean): string {
  if (!ghostEnabled || p.suggestion) return "";
  return ghostFor(p.input, { dirNames: p.dirNames, history: p.history });
}

export const useStore = create<StoreState>((set, get) => ({
  tabs: [],
  active: 0,
  home: "~",
  settings: DEFAULT_SETTINGS,
  apiKeyPresent: false,
  keyEntry: false,
  keyError: null,
  settingsOpen: false,
  panel: null,
  userScripts: {},
  scriptsSetupOpen: false,
  repoMrs: {},
  glabUser: null,
  find: { open: false, query: "", current: 0 },
  notifs: [],
  notifLog: [],
  unseen: 0,
  muted: false,

  init: (home, settings, apiKeyPresent) => {
    paneSeq = 1;
    groupSeq = 1;
    applyTheme(settings.accent, settings.fontSize);
    set({ home, settings, apiKeyPresent, tabs: [newGroup(home)], active: 0 });
  },

  setPaneRuntime: (paneId, rt) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { ptyId: rt.ptyId, isZsh: rt.isZsh }) })),

  markExited: (paneId) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { exited: true, rawMode: false }) })),

  newTab: () =>
    set((s) => ({ tabs: [...s.tabs, newGroup(s.home)], active: s.tabs.length })),

  closeTab: (i) =>
    set((s) => {
      if (s.tabs.length <= 1) return {};
      const tabs = s.tabs.filter((_, idx) => idx !== i);
      let active = s.active;
      if (i < active) active -= 1;
      else if (i === active) active = Math.min(active, tabs.length - 1);
      return { tabs, active };
    }),

  selectTab: (i) =>
    set((s) => (i >= 0 && i < s.tabs.length ? { active: i } : {})),

  cycleTab: (dir) =>
    set((s) => {
      const n = s.tabs.length;
      if (n < 2) return {};
      return { active: (s.active + dir + n) % n };
    }),

  mergeTabs: (src, dest) =>
    set((s) => {
      if (src === dest) return {};
      const source = s.tabs[src];
      const target = s.tabs[dest];
      if (!source || !target || target.panes.length + source.panes.length > 4) return {};
      const merged: Group = {
        ...target,
        panes: [...target.panes, ...source.panes],
        active: target.panes.length,
        split: "h",
      };
      const tabs = s.tabs
        .map((t, i) => (i === dest ? merged : t))
        .filter((_, i) => i !== src);
      const active = dest > src ? dest - 1 : dest;
      return { tabs, active };
    }),

  splitPane: (dir) =>
    set((s) => {
      const tabs = s.tabs.slice();
      const g = tabs[s.active];
      if (!g || g.panes.length >= 4) return {};
      const panes = g.panes.slice();
      const at = g.active + 1;
      panes.splice(at, 0, newPane(g.panes[g.active]?.cwd ?? s.home));
      tabs[s.active] = { ...g, panes, active: at, split: dir };
      return { tabs };
    }),

  closePane: () =>
    set((s) => {
      const tabs = s.tabs.slice();
      const g = tabs[s.active];
      if (!g) return {};
      if (g.panes.length <= 1) {
        if (tabs.length <= 1) return {};
        const filtered = tabs.filter((_, i) => i !== s.active);
        return { tabs: filtered, active: Math.min(s.active, filtered.length - 1) };
      }
      const panes = g.panes.filter((_, i) => i !== g.active);
      tabs[s.active] = { ...g, panes, active: Math.min(g.active, panes.length - 1) };
      return { tabs };
    }),

  focusPane: (i) =>
    set((s) => {
      const tabs = s.tabs.slice();
      const g = tabs[s.active];
      if (!g || i < 0 || i >= g.panes.length) return {};
      tabs[s.active] = { ...g, active: i };
      return { tabs };
    }),

  cyclePane: (dir) => {
    const s = get();
    const g = s.tabs[s.active];
    if (!g || g.panes.length < 2) return;
    s.focusPane((g.active + dir + g.panes.length) % g.panes.length);
  },

  setInput: (paneId, value) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        const next = { ...p, input: value, hIndex: -1, suggestion: null, pendingFix: null };
        return { input: value, hIndex: -1, suggestion: null, pendingFix: null, completion: null, inputSelected: false, ghost: recomputeGhost(next, s.settings.ghost) };
      }),
    })),

  setDirNames: (paneId, names) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => ({
        dirNames: names,
        ghost: recomputeGhost({ ...p, dirNames: names }, s.settings.ghost),
      })),
    })),

  setCwd: (paneId, cwd) =>
    // No-op when unchanged so a repeated OSC 7 (same path) doesn't wipe the
    // branch the cwd-change effect just fetched.
    set((s) => ({ tabs: patchPane(s.tabs, paneId, (p) => (p.cwd === cwd ? {} : { cwd, branch: null })) })),

  setBranch: (paneId, branch) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { branch }) })),

  startBlock: (paneId, command, cwd) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        const blocks = p.blocks.map((b) => (b.running ? { ...b, running: false } : b));
        blocks.push({ id: blockSeq++, command, cwd, output: "", exitCode: null, running: true });
        return { blocks };
      }),
    })),

  markCapture: (paneId) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        if (!p.blocks.length) return {};
        const blocks = p.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (last.running) blocks[blocks.length - 1] = { ...last, output: "" };
        return { blocks };
      }),
    })),

  appendOutput: (paneId, text) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        if (!p.blocks.length) return {};
        const blocks = p.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (!last.running) return {};
        blocks[blocks.length - 1] = { ...last, output: last.output + text };
        return { blocks };
      }),
    })),

  endBlock: (paneId, exitCode) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        if (!p.blocks.length) return {};
        const blocks = p.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (!last.running) return {};
        blocks[blocks.length - 1] = { ...last, running: false, exitCode };
        return { blocks };
      }),
    })),

  clearBlocks: (paneId) => set((s) => ({ tabs: patchPane(s.tabs, paneId, { blocks: [] }) })),

  pushHistory: (paneId, cmd) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => ({
        history: cmd && p.history[p.history.length - 1] !== cmd ? [...p.history, cmd] : p.history,
      })),
    })),

  histNav: (paneId, dir) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        const h = p.history;
        if (!h.length) return {};
        let i = p.hIndex;
        if (dir < 0) i = i === -1 ? h.length - 1 : Math.max(0, i - 1);
        else {
          if (i === -1) return {};
          i = i + 1;
          if (i >= h.length) return { hIndex: -1, input: "", ghost: "", suggestion: null, completion: null };
        }
        return { hIndex: i, input: h[i], ghost: "", suggestion: null, completion: null };
      }),
    })),

  setSuggestion: (paneId, sug) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { suggestion: sug, suggestionLoading: false, ghost: "", completion: null }) })),

  setSuggestionLoading: (paneId, v) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { suggestionLoading: v }) })),

  setPendingFix: (paneId, fix) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { pendingFix: fix, completion: null }) })),

  openCompletion: (paneId, c) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { completion: { ...c, index: 0 } }) })),

  moveCompletion: (paneId, delta) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        const c = p.completion;
        if (!c || !c.items.length) return {};
        return { completion: { ...c, index: (c.index + delta + c.items.length) % c.items.length } };
      }),
    })),

  acceptCompletion: (paneId) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) => {
        const c = p.completion;
        if (!c || !c.items.length) return {};
        const input = p.input.slice(0, c.tokenStart) + c.dir + c.items[c.index].name + "/";
        return { input, completion: null, suggestion: null, ghost: recomputeGhost({ ...p, input, suggestion: null }, s.settings.ghost) };
      }),
    })),

  closeCompletion: (paneId) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { completion: null }) })),

  selectAllInput: (paneId) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, (p) => (p.input ? { inputSelected: true } : {})) })),

  collapseInputSelection: (paneId) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, (p) => (p.inputSelected ? { inputSelected: false } : {})) })),

  setRawMode: (paneId, v) =>
    set((s) => ({ tabs: patchPane(s.tabs, paneId, { rawMode: v }) })),

  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      try {
        localStorage.setItem("aurora.settings", JSON.stringify(settings));
      } catch {
        /* ignore */
      }
      applyTheme(settings.accent, settings.fontSize);
      return { settings };
    }),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openPanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  closePanel: () => set({ panel: null }),

  setUserScripts: (m) => {
    try {
      localStorage.setItem("aurora.scripts", JSON.stringify(m));
    } catch {
      /* ignore */
    }
    set({ userScripts: m });
  },
  openScriptsSetup: () => set({ scriptsSetupOpen: true, panel: null }),
  closeScriptsSetup: () => set({ scriptsSetupOpen: false }),
  setRepoRoot: (paneId, root) => set((s) => ({ tabs: patchPane(s.tabs, paneId, { repoRoot: root }) })),
  setHook: (paneId, hook) => set((s) => ({ tabs: patchPane(s.tabs, paneId, { hook }) })),
  markHookFired: (paneId, root) =>
    set((s) => ({
      tabs: patchPane(s.tabs, paneId, (p) =>
        p.firedHooks.includes(root) ? {} : { firedHooks: [...p.firedHooks, root] },
      ),
    })),
  setReady: (paneId) => set((s) => ({ tabs: patchPane(s.tabs, paneId, { ready: true }) })),

  setRepoMrs: (root, mrs) => set((s) => ({ repoMrs: { ...s.repoMrs, [root]: mrs } })),
  setGlabUser: (user) => set({ glabUser: user }),

  openFind: () => set((s) => ({ find: { ...s.find, open: true } })),
  closeFind: () => set({ find: { open: false, query: "", current: 0 } }),
  setFindQuery: (q) => set((s) => ({ find: { ...s.find, query: q, current: 0 } })),
  stepFind: (dir, total) =>
    set((s) => {
      if (total <= 0) return { find: { ...s.find, current: 0 } };
      return { find: { ...s.find, current: (s.find.current + dir + total) % total } };
    }),

  notify: (n) => {
    const id = ++notifSeq;
    const entry: Notif = { ...n, id, ts: Date.now() };
    set((s) => {
      const notifLog = [entry, ...s.notifLog].slice(0, 40);
      const unseen = s.unseen + 1;
      if (s.muted) return { notifLog, unseen };
      const notifs = [...s.notifs, entry].slice(-3);
      return { notifLog, unseen, notifs };
    });
    if (!get().muted) setTimeout(() => get().dismissNotif(id), 6500);
  },
  dismissNotif: (id) => set((s) => ({ notifs: s.notifs.filter((n) => n.id !== id) })),
  clearNotifLog: () => set({ notifLog: [], unseen: 0 }),
  toggleMute: () => set((s) => (s.muted ? { muted: false } : { muted: true, notifs: [] })),
  markNotifsSeen: () => set({ unseen: 0 }),

  startKeyEntry: () => set({ keyEntry: true, keyError: null }),
  cancelKeyEntry: () => set({ keyEntry: false, keyError: null }),
  setKeyError: (e) => set({ keyError: e }),
  setApiKeyPresent: (v) => set({ apiKeyPresent: v }),
}));
