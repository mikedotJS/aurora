// Central UI state machine. Durable **workspaces** (repo-grouped, worktree-backed,
// per-branch) sit above the terminal layout: each workspace owns its tabs of
// split panes. Switching workspaces switches the whole tab layout while every
// workspace's PTYs keep running. The Group/PaneState shapes are unchanged from
// the single-tab-strip era — they just live under a workspace now.

import { create } from "zustand";
import type { AccentKey, FontKey } from "../lib/theme";
import { applyTheme } from "../lib/theme";
import type { Suggestion } from "../ai/suggest";
import { ghostFor } from "../lib/commands";
import type { DirEntry } from "../lib/sys";
import { savePersisted, loadRepos, saveRepos, type PersistedWs } from "../lib/workspace";
import type { RepoConfig } from "../lib/repoConfig";
import type { ServerStatus } from "../term/pty";
import {
  type Connections,
  type JiraConnection,
  type AiConnection,
  emptyConnections,
  saveConnections,
} from "../lib/connections";

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
  /** Auto-rename a tab from the command running in its active pane (quick Haiku call). */
  autoRenameTabs: boolean;
  /** One-time onboarding state (the "Introducing Workspaces" dialog) — persisted
   *  with settings so it rides the existing boot pipeline, not a user-facing preference. */
  introSeen: boolean;
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
  autoRenameTabs: true,
  introSeen: false,
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

/** A pane's content mode: the live terminal, or the Changes (diff) view. */
export type PaneView = "terminal" | "changes";

export interface PaneState {
  id: number;
  ptyId: string | null;
  /** Bumped to force the Terminal to tear down + respawn its shell (self-heal
   *  when a boot-time spawn was lost, or a manual "restart shell"). */
  ptyEpoch: number;
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
  view: PaneView;
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
  /** Auto-set tab label (from the running command); falls back to the cwd when unset. */
  name?: string | null;
}

// ---- Workspaces ----

export type WsStatus = "attention" | "idle";

export interface Repo {
  /** Stable id = the repo's main worktree absolute path. */
  id: string;
  root: string;
  name: string;
  defaultBranch: string;
}

export interface WsDiff {
  files: number;
  added: number;
  removed: number;
  conflicted: number;
}

export interface WsMr {
  iid: number;
  state: "draft" | "open" | "merged";
  url: string;
}

export interface Workspace {
  id: string;
  repoId: string | null;
  title: string;
  issueKey: string | null;
  branch: string | null;
  baseBranch: string;
  /** The worktree directory this workspace's panes open in. */
  dir: string;
  preset: string | null;
  diff: WsDiff | null;
  mr: WsMr | null;
  pipeline: "passed" | "failed" | "running" | null;
  jiraStatus: string | null;
  /** Jira issue URL (set when created from an issue), for the context-bar link. */
  jiraUrl: string | null;
  /** Two-way Jira sync enabled for this workspace (transition + MR link). */
  jiraSync: boolean;
  /** Environment variables exported into this workspace's panes (from its preset + port offset). */
  env: Record<string, string>;
  /** Has this workspace been activated at least once? Its panes (and PTYs) are
   *  mounted lazily on first activation, then kept alive across switches. */
  mounted: boolean;
  /** Owned terminal layout (the per-workspace tab strip). */
  tabs: Group[];
  active: number;
  createdAt: number;
  lastActive: number;
  /**
   * Runtime-only: the group id of the dedicated "Servers" tab opened by Run.
   * Null when no server tab exists (servers down, or workspace just restored).
   * Intentionally absent from PersistedWs / savePersisted — PTYs don't survive
   * a relaunch, so restored workspaces always come back with servers down.
   */
  serverTabId: number | null;
}

export type PanelKind = "mr" | "notif" | "scripts" | null;

/** Resolved git repo info passed into `init` from the async boot. */
export interface BootRepo {
  root: string;
  name: string;
  defaultBranch: string;
  currentBranch: string | null;
}
export interface BootInfo {
  repo: BootRepo | null;
  restored: PersistedWs[];
  activeWs: string | null;
}

/** Options to spin up a new workspace (used by the create flow). */
export interface CreateWorkspaceOpts {
  repoId: string | null;
  title: string;
  dir: string;
  branch: string | null;
  baseBranch?: string;
  issueKey?: string | null;
  preset?: string | null;
  paneCount?: number;
  split?: "h" | "v";
  jiraStatus?: string | null;
  jiraUrl?: string | null;
  jiraSync?: boolean;
  env?: Record<string, string>;
}

export interface StoreState {
  repos: Repo[];
  workspaces: Workspace[];
  activeWs: string | null;
  /** True once `init` has run to completion — distinguishes "boot not finished"
   *  (nothing should render as active yet) from "boot finished with zero
   *  workspaces" (the empty state is a legitimate, settled outcome). */
  initialized: boolean;
  railCollapsed: boolean;
  wsFilter: string;
  /** ⌘K command palette (switch + create). Null when closed. */
  command: { query: string; sel: number; repoId?: string | null } | null;
  home: string;
  settings: Settings;
  apiKeyPresent: boolean;
  keyEntry: boolean;
  keyError: string | null;
  settingsOpen: boolean;
  panel: PanelKind;
  userScripts: Record<string, RepoScripts>;
  /** Per-repo workspace config (presets and defaults), keyed by repo root. */
  repoConfigs: Record<string, RepoConfig>;
  /** Repo root whose Workspaces settings panel is open, or null. */
  workspaceSettingsRepo: string | null;
  scriptsSetupOpen: boolean;
  repoMrs: Record<string, GitlabMr[]>;
  glabUser: string | null;
  /** Global connection pool (non-secret; tokens/keys live in the keychain). Repos
   *  bind to entries here by id via their config. */
  connections: Connections;
  find: { open: boolean; query: string; current: number };
  notifs: Notif[];
  notifLog: Notif[];
  unseen: number;
  muted: boolean;

  // actions
  init: (home: string, settings: Settings, apiKeyPresent: boolean, boot: BootInfo) => void;
  // workspaces
  createWorkspace: (opts: CreateWorkspaceOpts) => string;
  /** A manual lane adopts the repo its pane lands in (registers it + sets repoId once). */
  adoptRepo: (wsId: string, repo: { root: string; name: string; defaultBranch: string }) => void;
  /** Register a repo in the rail (added by selecting a folder); persists it. */
  addRepo: (repo: { root: string; name: string; defaultBranch: string }) => void;
  switchWorkspace: (id: string) => void;
  removeWorkspace: (id: string) => void;
  setWsDiff: (id: string, diff: WsDiff | null) => void;
  setWsMr: (id: string, mr: WsMr | null) => void;
  setWsJiraStatus: (id: string, status: string | null) => void;
  setRailCollapsed: (v: boolean) => void;
  toggleRail: () => void;
  setWsFilter: (q: string) => void;
  // command palette
  openCommand: (repoId?: string | null) => void;
  closeCommand: () => void;
  setCommandQuery: (q: string) => void;
  /** Pin a repo as the command palette target while preserving the current query/sel. */
  setCommandRepo: (repoId: string | null) => void;
  moveCommand: (delta: number, count: number) => void;
  setCommandSel: (i: number) => void;
  // panes runtime
  setPaneRuntime: (paneId: number, rt: { ptyId: string; isZsh: boolean }) => void;
  markExited: (paneId: number) => void;
  /** Tear down + respawn a pane's shell (self-heal a lost spawn / manual restart). */
  respawnPane: (paneId: number) => void;
  setPaneView: (paneId: number, view: PaneView) => void;
  // server tab (workspace-run-servers)
  /**
   * Create (or replace) the dedicated "Servers" tab for a workspace.
   * (a) Removes any existing server tab (state only — caller killed PTYs first).
   * (b) Appends a fresh Group with min(4, max(1, n)) panes.
   * (c) Switches the workspace's active tab to the new one and records its id.
   * Operates on `wsId`, not necessarily the active workspace.
   */
  prepareServerTab: (wsId: string, n: number) => void;
  /**
   * Remove the server tab for a workspace: drops the Group, fixes active index,
   * clears serverTabId. Also clears serverStatus entries for removed panes.
   * Guard: never removes the workspace's last tab.
   */
  dropServerTab: (wsId: string) => void;
  /**
   * Runtime-only server liveness map (keyed by ptyId). Written by the front poll
   * (D8); never persisted. Read by serversUp() and WorkspaceContextBar.
   */
  serverStatus: Record<string, ServerStatus>;
  setServerStatus: (ptyId: string, s: ServerStatus) => void;
  clearServerStatus: (ptyIds: string[]) => void;
  // tabs (scoped to the active workspace)
  newTab: () => void;
  closeTab: (i: number) => void;
  selectTab: (i: number) => void;
  /** Set a tab's auto-generated label (by group id, across workspaces). */
  setTabName: (tabId: number, name: string) => void;
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
  /** Dismiss the one-time "Introducing Workspaces" dialog: persists introSeen = true
   *  so it never shows again. */
  dismissIntro: () => void;
  openPanel: (p: Exclude<PanelKind, null>) => void;
  closePanel: () => void;
  // scripts + hooks
  setUserScripts: (m: Record<string, RepoScripts>) => void;
  openScriptsSetup: () => void;
  closeScriptsSetup: () => void;
  // per-repo workspace config
  setRepoConfigs: (m: Record<string, RepoConfig>) => void;
  setRepoConfig: (root: string, cfg: RepoConfig) => void;
  openWorkspaceSettings: (root: string) => void;
  closeWorkspaceSettings: () => void;
  setRepoRoot: (paneId: number, root: string | null) => void;
  setHook: (paneId: number, hook: HookInfo | null) => void;
  markHookFired: (paneId: number, root: string) => void;
  setReady: (paneId: number) => void;
  // gitlab + notifications
  setRepoMrs: (root: string, mrs: GitlabMr[]) => void;
  setGlabUser: (user: string | null) => void;
  // jira
  setConnections: (c: Connections) => void;
  addJiraConnection: (c: JiraConnection) => void;
  removeJiraConnection: (id: string) => void;
  addAiConnection: (c: AiConnection) => void;
  removeAiConnection: (id: string) => void;
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
let wsSeq = 1;
const NONCE = Date.now().toString(36);

function baseName(p: string): string {
  const seg = p.split("/").filter(Boolean).pop();
  return seg ?? p;
}

function newPane(cwd: string, repoRoot: string | null = null): PaneState {
  return {
    id: paneSeq++,
    ptyId: null,
    ptyEpoch: 0,
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
    view: "terminal",
    exited: false,
    ready: false,
    dirNames: [],
    blocks: [],
    // Seeded from the workspace's repoId (= canonical main_root) so per-repo
    // scripts/MRs key correctly the instant a pane exists — before the async
    // gitRepoInfo resolution runs. Without this, a freshly-restored pane keys
    // off its raw worktree cwd and orphans main_root-keyed scripts.
    repoRoot,
    firedHooks: [],
    hook: null,
  };
}

function newGroup(cwd: string, repoRoot: string | null = null): Group {
  return { id: groupSeq++, panes: [newPane(cwd, repoRoot)], active: 0, split: "h" };
}

function newWorkspace(opts: CreateWorkspaceOpts & { id?: string }): Workspace {
  const count = Math.max(1, Math.min(4, opts.paneCount ?? 1));
  const group = newGroup(opts.dir, opts.repoId);
  if (count > 1) {
    const panes = group.panes.slice();
    for (let i = 1; i < count; i++) panes.push(newPane(opts.dir, opts.repoId));
    group.panes = panes;
    group.split = opts.split ?? "h";
  }
  return {
    id: opts.id ?? `w${wsSeq++}-${NONCE}`,
    repoId: opts.repoId,
    title: opts.title,
    issueKey: opts.issueKey ?? null,
    branch: opts.branch,
    baseBranch: opts.baseBranch ?? "",
    dir: opts.dir,
    preset: opts.preset ?? null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: opts.jiraStatus ?? null,
    jiraUrl: opts.jiraUrl ?? null,
    jiraSync: opts.jiraSync ?? false,
    env: opts.env ?? {},
    mounted: true,
    tabs: [group],
    active: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
  };
}

function rehydrate(p: PersistedWs): Workspace {
  return {
    id: p.id,
    repoId: p.repoId,
    title: p.title,
    issueKey: p.issueKey,
    branch: p.branch,
    baseBranch: p.baseBranch,
    dir: p.dir,
    preset: p.preset,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: p.jiraStatus,
    jiraUrl: p.jiraUrl ?? null,
    jiraSync: p.jiraSync ?? false,
    env: p.env ?? {},
    mounted: false,
    tabs: [newGroup(p.dir, p.repoId)],
    active: 0,
    createdAt: p.createdAt,
    lastActive: p.lastActive,
    serverTabId: null,
  };
}

export function activeWorkspace(s: StoreState): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWs);
}
export function activeGroup(s: StoreState): Group | undefined {
  const w = activeWorkspace(s);
  return w ? w.tabs[w.active] : undefined;
}
export function activePane(s: StoreState): PaneState | undefined {
  const g = activeGroup(s);
  return g ? g.panes[g.active] : undefined;
}
/** Find a pane by id across **all** workspaces (PTYs run in the background too). */
export function findPane(s: StoreState, id: number): PaneState | undefined {
  for (const w of s.workspaces) for (const g of w.tabs) for (const p of g.panes) if (p.id === id) return p;
  return undefined;
}
/** The workspace that owns a pane (for its env when spawning). */
export function workspaceOfPane(s: StoreState, id: number): Workspace | undefined {
  for (const w of s.workspaces) for (const g of w.tabs) for (const p of g.panes) if (p.id === id) return w;
  return undefined;
}
/** Every repo root that currently has a pane (for MR/notification polling). */
export function allRepoRoots(s: StoreState): Set<string> {
  const roots = new Set<string>();
  for (const w of s.workspaces) for (const g of w.tabs) for (const p of g.panes) if (p.repoRoot) roots.add(p.repoRoot);
  return roots;
}

type PanePatch = Partial<PaneState> | ((p: PaneState) => Partial<PaneState>);

/** Patch a pane by id wherever it lives; workspaces without the pane keep their reference. */
function patchPane(workspaces: Workspace[], paneId: number, patch: PanePatch): Workspace[] {
  return workspaces.map((w) => {
    if (!w.tabs.some((g) => g.panes.some((p) => p.id === paneId))) return w;
    return {
      ...w,
      tabs: w.tabs.map((g) => ({
        ...g,
        panes: g.panes.map((p) =>
          p.id === paneId ? { ...p, ...(typeof patch === "function" ? patch(p) : patch) } : p,
        ),
      })),
    };
  });
}

/** Apply a tab-strip mutation to the active workspace, returning the new list. */
function patchActiveWs(
  workspaces: Workspace[],
  activeWs: string | null,
  fn: (w: Workspace) => Partial<Workspace>,
): Workspace[] {
  return workspaces.map((w) => (w.id === activeWs ? { ...w, ...fn(w) } : w));
}

function deriveRepos(workspaces: Workspace[], extra: Repo[]): Repo[] {
  const map = new Map<string, Repo>();
  for (const r of extra) map.set(r.id, r);
  for (const w of workspaces) {
    if (w.repoId && !map.has(w.repoId)) {
      map.set(w.repoId, {
        id: w.repoId,
        root: w.repoId,
        name: baseName(w.repoId),
        defaultBranch: w.baseBranch || "main",
      });
    }
  }
  return [...map.values()];
}

function recomputeGhost(p: PaneState, ghostEnabled: boolean): string {
  if (!ghostEnabled || p.suggestion) return "";
  return ghostFor(p.input, { dirNames: p.dirNames, history: p.history });
}

export const useStore = create<StoreState>((set, get) => ({
  repos: [],
  workspaces: [],
  activeWs: null,
  initialized: false,
  railCollapsed: false,
  wsFilter: "",
  command: null,
  home: "~",
  settings: DEFAULT_SETTINGS,
  apiKeyPresent: false,
  keyEntry: false,
  keyError: null,
  settingsOpen: false,
  panel: null,
  userScripts: {},
  repoConfigs: {},
  workspaceSettingsRepo: null,
  scriptsSetupOpen: false,
  repoMrs: {},
  glabUser: null,
  connections: emptyConnections(),
  find: { open: false, query: "", current: 0 },
  notifs: [],
  notifLog: [],
  unseen: 0,
  muted: false,
  // Runtime-only — not persisted; restored workspaces start with no server status.
  serverStatus: {} as Record<string, ServerStatus>,

  init: (home, settings, apiKeyPresent, boot) => {
    paneSeq = 1;
    groupSeq = 1;
    wsSeq = 1;
    applyTheme(settings.accent, settings.fontSize);

    const workspaces: Workspace[] = boot.restored.map(rehydrate);

    // The boot workspace only exists for a real repo checkout (boot.repo set) —
    // a repo launch is a real context worth opening. Reuse a restored workspace
    // already rooted at that repo, else create one. When there is no repo
    // context, NO lane is synthesized (no manual/home fallback) — an empty boot
    // (0 repo context, 0 restored) legitimately settles on zero workspaces.
    let bootWs: Workspace | undefined;
    if (boot.repo) {
      const bootDir = boot.repo.root;
      bootWs = workspaces.find((w) => w.dir === bootDir);
      if (!bootWs) {
        bootWs = newWorkspace({
          repoId: boot.repo.root,
          title: boot.repo.currentBranch ?? boot.repo.name,
          dir: bootDir,
          branch: boot.repo.currentBranch ?? boot.repo.defaultBranch,
          baseBranch: boot.repo.defaultBranch,
        });
        workspaces.unshift(bootWs);
      }
    }

    // Persisted repos (added by folder, may have no workspaces) first, then the
    // boot repo (its fresh info wins on id collision), then workspace-derived.
    const persisted = loadRepos();
    const extra: Repo[] = boot.repo
      ? [...persisted, { id: boot.repo.root, root: boot.repo.root, name: boot.repo.name, defaultBranch: boot.repo.defaultBranch }]
      : persisted;
    const repos = deriveRepos(workspaces, extra);

    // activeWs: a valid restored/boot activeWs wins, else the boot lane, else the
    // first restored workspace (restored, no repo launch, stale activeWs), else
    // null — 0 repo context + 0 restored is the empty state.
    const activeWs: string | null =
      boot.activeWs && workspaces.some((w) => w.id === boot.activeWs)
        ? boot.activeWs
        : (bootWs?.id ?? workspaces[0]?.id ?? null);
    // Mount only the active workspace at boot; others spawn on first activation.
    // (activeWs === null → every workspace, if any, stays unmounted.)
    for (const w of workspaces) w.mounted = w.id === activeWs;

    set({ home, settings, apiKeyPresent, repos, workspaces, activeWs, initialized: true });
    savePersisted(workspaces, activeWs);
  },

  createWorkspace: (opts) => {
    const s = get();
    const ws = newWorkspace(opts);
    const repos =
      opts.repoId && !s.repos.some((r) => r.id === opts.repoId)
        ? [
            ...s.repos,
            { id: opts.repoId, root: opts.repoId, name: baseName(opts.repoId), defaultBranch: opts.baseBranch || "main" },
          ]
        : s.repos;
    const workspaces = [...s.workspaces, ws];
    set({ workspaces, repos, activeWs: ws.id });
    savePersisted(workspaces, ws.id);
    return ws.id;
  },

  adoptRepo: (wsId, repo) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === wsId);
      if (!ws || ws.repoId) return {}; // only a manual lane, and only once
      const repos = s.repos.some((r) => r.id === repo.root)
        ? s.repos
        : [...s.repos, { id: repo.root, root: repo.root, name: repo.name, defaultBranch: repo.defaultBranch }];
      const workspaces = s.workspaces.map((w) =>
        w.id === wsId ? { ...w, repoId: repo.root, baseBranch: w.baseBranch || repo.defaultBranch } : w,
      );
      savePersisted(workspaces, s.activeWs);
      return { repos, workspaces };
    }),

  addRepo: (repo) =>
    set((s) => {
      if (s.repos.some((r) => r.id === repo.root)) return {};
      const repos = [...s.repos, { id: repo.root, root: repo.root, name: repo.name, defaultBranch: repo.defaultBranch }];
      saveRepos(repos);
      return { repos };
    }),

  switchWorkspace: (id) =>
    set((s) => {
      if (id === s.activeWs || !s.workspaces.some((w) => w.id === id)) return {};
      const workspaces = s.workspaces.map((w) =>
        w.id === id ? { ...w, mounted: true, lastActive: Date.now() } : w,
      );
      savePersisted(workspaces, id);
      return { workspaces, activeWs: id };
    }),

  removeWorkspace: (id) =>
    set((s) => {
      if (s.workspaces.length <= 1) return {};
      const idx = s.workspaces.findIndex((w) => w.id === id);
      if (idx === -1) return {};
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeWs =
        s.activeWs === id ? workspaces[Math.min(idx, workspaces.length - 1)].id : s.activeWs;
      savePersisted(workspaces, activeWs);
      return { workspaces, activeWs };
    }),

  setWsDiff: (id, diff) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, diff } : w)) })),

  setWsMr: (id, mr) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, mr } : w)) })),

  setWsJiraStatus: (id, status) =>
    set((s) => {
      const workspaces = s.workspaces.map((w) => (w.id === id ? { ...w, jiraStatus: status } : w));
      savePersisted(workspaces, s.activeWs);
      return { workspaces };
    }),

  setRailCollapsed: (v) => set({ railCollapsed: v }),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  setWsFilter: (q) => set({ wsFilter: q }),

  openCommand: (repoId) => set({ command: { query: "", sel: 0, repoId: repoId ?? null } }),
  closeCommand: () => set({ command: null }),
  setCommandQuery: (q) => set((s) => ({ command: s.command ? { ...s.command, query: q, sel: 0 } : s.command })),
  setCommandRepo: (repoId) => set((s) => (s.command ? { command: { ...s.command, repoId } } : {})),
  moveCommand: (delta, count) =>
    set((s) => {
      if (!s.command || count <= 0) return {};
      return { command: { ...s.command, sel: (s.command.sel + delta + count) % count } };
    }),
  setCommandSel: (i) => set((s) => (s.command ? { command: { ...s.command, sel: i } } : {})),

  setPaneRuntime: (paneId, rt) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { ptyId: rt.ptyId, isZsh: rt.isZsh }) })),

  markExited: (paneId) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { exited: true, rawMode: false }) })),

  respawnPane: (paneId) =>
    set((s) => {
      const pane = findPane(s, paneId);
      if (!pane) return {};
      return {
        workspaces: patchPane(s.workspaces, paneId, {
          ptyId: null,
          ptyEpoch: pane.ptyEpoch + 1,
          ready: false,
          exited: false,
          rawMode: false,
        }),
      };
    }),

  setPaneView: (paneId, view) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { view }) })),

  prepareServerTab: (wsId, n) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === wsId);
      if (!ws) return {};
      const count = Math.min(4, Math.max(1, n));

      // (a) Remove stale server tab if it still exists (PTY kills already done by caller).
      // No length guard here — step (c) always appends a fresh server tab, so a momentary
      // empty tabs array within this atomic set is safe and avoids leaving a zombie stale tab.
      let tabs = ws.tabs;
      if (ws.serverTabId != null) {
        const staleIdx = tabs.findIndex((g) => g.id === ws.serverTabId);
        if (staleIdx !== -1) {
          tabs = tabs.filter((_, i) => i !== staleIdx);
        }
      }

      // (b) Fresh group with count panes (same pattern as newWorkspace multi-pane).
      const group = newGroup(ws.dir, ws.repoId);
      if (count > 1) {
        const panes = group.panes.slice();
        for (let i = 1; i < count; i++) panes.push(newPane(ws.dir, ws.repoId));
        group.panes = panes;
        group.split = "h";
      }

      // (c) Append, switch active to the new tab, record its id.
      const newTabs = [...tabs, group];
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === wsId
            ? { ...w, tabs: newTabs, active: newTabs.length - 1, serverTabId: group.id }
            : w,
        ),
      };
    }),

  dropServerTab: (wsId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === wsId);
      if (!ws || ws.serverTabId == null) return {};

      // Collect ptyIds from the server tab so we can clear their serverStatus entries.
      const tab = ws.tabs.find((g) => g.id === ws.serverTabId);
      const serverPtyIds = tab
        ? tab.panes.map((p) => p.ptyId).filter((id): id is string => id !== null)
        : [];
      const serverStatus = { ...s.serverStatus };
      for (const id of serverPtyIds) delete serverStatus[id];

      const tabIdx = ws.tabs.findIndex((g) => g.id === ws.serverTabId);
      if (tabIdx === -1) {
        // Tab already gone — just clear the id and status.
        return {
          workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, serverTabId: null } : w)),
          serverStatus,
        };
      }
      // Last tab: replace with a fresh work tab rather than leaving an empty workspace.
      // This ensures serversUp() returns false (serverTabId → null) and the user always
      // has a usable tab. Covers the "server tab is the last tab → Stop" bug.
      if (ws.tabs.length <= 1) {
        const freshGroup = newGroup(ws.dir, ws.repoId);
        return {
          workspaces: s.workspaces.map((w) =>
            w.id === wsId ? { ...w, tabs: [freshGroup], active: 0, serverTabId: null } : w,
          ),
          serverStatus,
        };
      }
      const tabs = ws.tabs.filter((_, i) => i !== tabIdx);
      let active = ws.active;
      if (tabIdx < active) active -= 1;
      else if (tabIdx === active) active = Math.min(active, tabs.length - 1);
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === wsId ? { ...w, tabs, active, serverTabId: null } : w,
        ),
        serverStatus,
      };
    }),

  setServerStatus: (ptyId, status) =>
    set((s) => ({ serverStatus: { ...s.serverStatus, [ptyId]: status } })),

  clearServerStatus: (ptyIds) =>
    set((s) => {
      const serverStatus = { ...s.serverStatus };
      for (const id of ptyIds) delete serverStatus[id];
      return { serverStatus };
    }),

  newTab: () =>
    set((s) => ({
      workspaces: patchActiveWs(s.workspaces, s.activeWs, (w) => ({
        tabs: [...w.tabs, newGroup(w.dir, w.repoId)],
        active: w.tabs.length,
      })),
    })),

  closeTab: (i) =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w || w.tabs.length <= 1) return {};
      const tabs = w.tabs.filter((_, idx) => idx !== i);
      let active = w.active;
      if (i < active) active -= 1;
      else if (i === active) active = Math.min(active, tabs.length - 1);
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ tabs, active })) };
    }),

  selectTab: (i) =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w || i < 0 || i >= w.tabs.length) return {};
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ active: i })) };
    }),

  setTabName: (tabId, name) =>
    set((s) => {
      let changed = false;
      const workspaces = s.workspaces.map((w) => {
        if (!w.tabs.some((g) => g.id === tabId && g.name !== name)) return w;
        changed = true;
        return { ...w, tabs: w.tabs.map((g) => (g.id === tabId ? { ...g, name } : g)) };
      });
      return changed ? { workspaces } : {};
    }),

  cycleTab: (dir) =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w) return {};
      const n = w.tabs.length;
      if (n < 2) return {};
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ active: (w.active + dir + n) % n })) };
    }),

  mergeTabs: (src, dest) =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w || src === dest) return {};
      const source = w.tabs[src];
      const target = w.tabs[dest];
      if (!source || !target || target.panes.length + source.panes.length > 4) return {};
      const merged: Group = {
        ...target,
        panes: [...target.panes, ...source.panes],
        active: target.panes.length,
        split: "h",
      };
      const tabs = w.tabs.map((t, i) => (i === dest ? merged : t)).filter((_, i) => i !== src);
      const active = dest > src ? dest - 1 : dest;
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ tabs, active })) };
    }),

  splitPane: (dir) =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w) return {};
      const g = w.tabs[w.active];
      if (!g || g.panes.length >= 4) return {};
      const panes = g.panes.slice();
      const at = g.active + 1;
      panes.splice(at, 0, newPane(g.panes[g.active]?.cwd ?? w.dir, g.panes[g.active]?.repoRoot ?? w.repoId));
      const tabs = w.tabs.slice();
      tabs[w.active] = { ...g, panes, active: at, split: dir };
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ tabs })) };
    }),

  closePane: () =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w) return {};
      const g = w.tabs[w.active];
      if (!g) return {};
      if (g.panes.length <= 1) {
        // last pane of this tab → close the tab (but never the last tab).
        if (w.tabs.length <= 1) return {};
        const tabs = w.tabs.filter((_, i) => i !== w.active);
        const active = Math.min(w.active, tabs.length - 1);
        return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ tabs, active })) };
      }
      const panes = g.panes.filter((_, i) => i !== g.active);
      const tabs = w.tabs.slice();
      tabs[w.active] = { ...g, panes, active: Math.min(g.active, panes.length - 1) };
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ tabs })) };
    }),

  focusPane: (i) =>
    set((s) => {
      const w = activeWorkspace(s);
      if (!w) return {};
      const g = w.tabs[w.active];
      if (!g || i < 0 || i >= g.panes.length) return {};
      const tabs = w.tabs.slice();
      tabs[w.active] = { ...g, active: i };
      return { workspaces: patchActiveWs(s.workspaces, s.activeWs, () => ({ tabs })) };
    }),

  cyclePane: (dir) => {
    const s = get();
    const g = activeGroup(s);
    if (!g || g.panes.length < 2) return;
    s.focusPane((g.active + dir + g.panes.length) % g.panes.length);
  },

  setInput: (paneId, value) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        const next = { ...p, input: value, hIndex: -1, suggestion: null, pendingFix: null };
        return {
          input: value,
          hIndex: -1,
          suggestion: null,
          pendingFix: null,
          completion: null,
          inputSelected: false,
          ghost: recomputeGhost(next, s.settings.ghost),
        };
      }),
    })),

  setDirNames: (paneId, names) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => ({
        dirNames: names,
        ghost: recomputeGhost({ ...p, dirNames: names }, s.settings.ghost),
      })),
    })),

  setCwd: (paneId, cwd) =>
    // No-op when unchanged so a repeated OSC 7 (same path) doesn't wipe the
    // branch the cwd-change effect just fetched.
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, (p) => (p.cwd === cwd ? {} : { cwd, branch: null })) })),

  setBranch: (paneId, branch) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { branch }) })),

  startBlock: (paneId, command, cwd) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        const blocks = p.blocks.map((b) => (b.running ? { ...b, running: false } : b));
        blocks.push({ id: blockSeq++, command, cwd, output: "", exitCode: null, running: true });
        return { blocks };
      }),
    })),

  markCapture: (paneId) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        if (!p.blocks.length) return {};
        const blocks = p.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (last.running) blocks[blocks.length - 1] = { ...last, output: "" };
        return { blocks };
      }),
    })),

  appendOutput: (paneId, text) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        if (!p.blocks.length) return {};
        const blocks = p.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (!last.running) return {};
        // Bound block output so a heavy stream (e.g. `pnpm install` progress) can't
        // grow unbounded and blow up memory/DOM — keep the tail, cut on a newline.
        const CAP = 262144; // 256 KB
        let output = last.output + text;
        if (output.length > CAP) {
          const cut = output.length - CAP;
          const nl = output.indexOf("\n", cut);
          output = output.slice(nl === -1 ? cut : nl + 1);
        }
        blocks[blocks.length - 1] = { ...last, output };
        return { blocks };
      }),
    })),

  endBlock: (paneId, exitCode) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        if (!p.blocks.length) return {};
        const blocks = p.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (!last.running) return {};
        blocks[blocks.length - 1] = { ...last, running: false, exitCode };
        return { blocks };
      }),
    })),

  clearBlocks: (paneId) => set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { blocks: [] }) })),

  pushHistory: (paneId, cmd) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => ({
        history: cmd && p.history[p.history.length - 1] !== cmd ? [...p.history, cmd] : p.history,
      })),
    })),

  histNav: (paneId, dir) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
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
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, { suggestion: sug, suggestionLoading: false, ghost: "", completion: null }),
    })),

  setSuggestionLoading: (paneId, v) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { suggestionLoading: v }) })),

  setPendingFix: (paneId, fix) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { pendingFix: fix, completion: null }) })),

  openCompletion: (paneId, c) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { completion: { ...c, index: 0 } }) })),

  moveCompletion: (paneId, delta) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        const c = p.completion;
        if (!c || !c.items.length) return {};
        return { completion: { ...c, index: (c.index + delta + c.items.length) % c.items.length } };
      }),
    })),

  acceptCompletion: (paneId) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) => {
        const c = p.completion;
        if (!c || !c.items.length) return {};
        const input = p.input.slice(0, c.tokenStart) + c.dir + c.items[c.index].name + "/";
        return { input, completion: null, suggestion: null, ghost: recomputeGhost({ ...p, input, suggestion: null }, s.settings.ghost) };
      }),
    })),

  closeCompletion: (paneId) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { completion: null }) })),

  selectAllInput: (paneId) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, (p) => (p.input ? { inputSelected: true } : {})) })),

  collapseInputSelection: (paneId) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, (p) => (p.inputSelected ? { inputSelected: false } : {})) })),

  setRawMode: (paneId, v) =>
    set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { rawMode: v }) })),

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
  dismissIntro: () => get().setSetting("introSeen", true),
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

  setRepoConfigs: (m) => {
    try {
      localStorage.setItem("aurora.repoconfig", JSON.stringify(m));
    } catch {
      /* ignore */
    }
    set({ repoConfigs: m });
  },
  setRepoConfig: (root, cfg) => {
    const m = { ...get().repoConfigs, [root]: cfg };
    try {
      localStorage.setItem("aurora.repoconfig", JSON.stringify(m));
    } catch {
      /* ignore */
    }
    set({ repoConfigs: m });
  },
  openWorkspaceSettings: (root) => set({ workspaceSettingsRepo: root, settingsOpen: false }),
  closeWorkspaceSettings: () => set({ workspaceSettingsRepo: null }),

  setRepoRoot: (paneId, root) => set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { repoRoot: root }) })),
  setHook: (paneId, hook) => set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { hook }) })),
  markHookFired: (paneId, root) =>
    set((s) => ({
      workspaces: patchPane(s.workspaces, paneId, (p) =>
        p.firedHooks.includes(root) ? {} : { firedHooks: [...p.firedHooks, root] },
      ),
    })),
  setReady: (paneId) => set((s) => ({ workspaces: patchPane(s.workspaces, paneId, { ready: true }) })),

  setRepoMrs: (root, mrs) => set((s) => ({ repoMrs: { ...s.repoMrs, [root]: mrs } })),
  setGlabUser: (user) => set({ glabUser: user }),

  setConnections: (c) => {
    saveConnections(c);
    set({ connections: c });
  },
  addJiraConnection: (c) =>
    set((s) => {
      const jira = [...s.connections.jira.filter((x) => x.id !== c.id), c];
      const connections = { ...s.connections, jira };
      saveConnections(connections);
      return { connections };
    }),
  removeJiraConnection: (id) =>
    set((s) => {
      const connections = { ...s.connections, jira: s.connections.jira.filter((x) => x.id !== id) };
      saveConnections(connections);
      return { connections };
    }),
  addAiConnection: (c) =>
    set((s) => {
      const ai = [...s.connections.ai.filter((x) => x.id !== c.id), c];
      const connections = { ...s.connections, ai };
      saveConnections(connections);
      return { connections };
    }),
  removeAiConnection: (id) =>
    set((s) => {
      const connections = { ...s.connections, ai: s.connections.ai.filter((x) => x.id !== id) };
      saveConnections(connections);
      return { connections };
    }),

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
