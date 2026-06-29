// Per-repo scripts + onEnter hooks. Scripts are keyed by git repo root and
// persisted (via the store) to localStorage. v1 runs a script's tasks joined
// with `&&` in the active pane; split-pane layout is a future enhancement.

import {
  useStore,
  type Script,
  type ScriptTask,
  type RepoScripts,
  type PaneState,
  type StoreApiState,
} from "../state/store";
import { pty } from "../term/pty";

function findPane(s: StoreApiState, id: number): PaneState | undefined {
  for (const g of s.tabs) for (const p of g.panes) if (p.id === id) return p;
  return undefined;
}

export function repoScripts(root: string | null): RepoScripts {
  if (!root) return { scripts: [], onEnter: null };
  return useStore.getState().userScripts[root] ?? { scripts: [], onEnter: null };
}
export function scriptsForRoot(root: string | null): Script[] {
  return repoScripts(root).scripts;
}
export function onEnterFor(root: string | null): string | null {
  return repoScripts(root).onEnter;
}

function mutate(root: string, fn: (rs: RepoScripts) => void) {
  const st = useStore.getState();
  const map = { ...st.userScripts };
  const existing = map[root] ?? { scripts: [], onEnter: null };
  const next: RepoScripts = JSON.parse(JSON.stringify(existing));
  fn(next);
  map[root] = next;
  st.setUserScripts(map);
}

export const addScript = (root: string) =>
  mutate(root, (rs) =>
    rs.scripts.push({ name: `script${rs.scripts.length + 1}`, desc: "", split: false, tasks: [{ dir: "", cmd: "" }] }),
  );
export const updateScript = (root: string, i: number, patch: Partial<Script>) =>
  mutate(root, (rs) => {
    rs.scripts[i] = { ...rs.scripts[i], ...patch };
  });
export const deleteScript = (root: string, i: number) =>
  mutate(root, (rs) => {
    rs.scripts.splice(i, 1);
  });
export const addTask = (root: string, i: number) =>
  mutate(root, (rs) => rs.scripts[i].tasks.push({ dir: "", cmd: "" }));
export const updateTask = (root: string, i: number, j: number, patch: Partial<ScriptTask>) =>
  mutate(root, (rs) => {
    rs.scripts[i].tasks[j] = { ...rs.scripts[i].tasks[j], ...patch };
  });
export const removeTask = (root: string, i: number, j: number) =>
  mutate(root, (rs) => {
    rs.scripts[i].tasks.splice(j, 1);
  });
export const setOnEnter = (root: string, name: string | null) =>
  mutate(root, (rs) => {
    rs.onEnter = name || null;
  });

function send(pane: PaneState, cmd: string) {
  useStore.getState().startBlock(pane.id, cmd, pane.cwd);
  if (pane.ptyId) pty.write(pane.ptyId, cmd + "\n");
}

function taskCmd(root: string, t: ScriptTask): string {
  return t.dir ? `cd ${root}/${t.dir} && ${t.cmd}` : t.cmd;
}

/** The key scripts are stored under: the git repo root, or the cwd otherwise. */
export function scriptKey(pane: PaneState): string {
  return pane.repoRoot ?? pane.cwd;
}

function feedback(pane: PaneState, command: string, message: string, code = 1) {
  const st = useStore.getState();
  st.startBlock(pane.id, command, pane.cwd);
  st.appendOutput(pane.id, `\x1b[31m${message}\x1b[0m\n`);
  st.endBlock(pane.id, code);
}

function runWhenReady(paneId: number, cmd: string, attempts = 0) {
  const pane = findPane(useStore.getState(), paneId);
  if (pane?.ready && pane.ptyId) {
    send(pane, cmd);
    return;
  }
  if (attempts < 80) setTimeout(() => runWhenReady(paneId, cmd, attempts + 1), 60);
}

export function runScript(paneId: number, name: string) {
  const st = useStore.getState();
  const pane = findPane(st, paneId);
  if (!pane) return;
  const key = scriptKey(pane);
  const script = scriptsForRoot(key).find((s) => s.name === name);
  if (!script) {
    feedback(pane, `run ${name}`, `run: no script '${name}' here — add one with \`scripts\``);
    return;
  }
  const tasks = script.tasks.filter((t) => t.cmd.trim());
  if (!tasks.length) {
    feedback(pane, `run ${name}`, `run: script '${name}' has no commands`);
    return;
  }

  if (script.split && tasks.length > 1) {
    // one pane per task (capped at 4), running each when its shell is ready
    const n = Math.min(4, tasks.length);
    const group = st.tabs[st.active];
    if (group) {
      const need = n - group.panes.length;
      for (let i = 0; i < need; i++) st.splitPane("h");
    }
    const panes = useStore.getState().tabs[useStore.getState().active].panes;
    for (let i = 0; i < n; i++) {
      if (panes[i]) runWhenReady(panes[i].id, taskCmd(key, tasks[i]));
    }
    useStore.getState().focusPane(0);
    return;
  }

  send(pane, tasks.map((t) => taskCmd(key, t)).join(" && "));
}

export function runHook(paneId: number) {
  const pane = findPane(useStore.getState(), paneId);
  if (!pane?.hook) return;
  const name = pane.hook.name;
  useStore.getState().setHook(paneId, null);
  runScript(paneId, name);
}

/**
 * Fire the onEnter hook once when a pane lands on a script location — the git
 * repo root, or any directory with scripts configured.
 */
export function maybeFireHook(paneId: number) {
  const pane = findPane(useStore.getState(), paneId);
  if (!pane) return;
  // inside a repo, only fire at the repo root
  if (pane.repoRoot && pane.cwd !== pane.repoRoot) return;
  const key = scriptKey(pane);
  if (pane.firedHooks.includes(key)) return;
  const onEnter = onEnterFor(key);
  if (!onEnter) return;
  const script = scriptsForRoot(key).find((s) => s.name === onEnter);
  if (!script) return;
  useStore.getState().markHookFired(paneId, key);
  useStore.getState().setHook(paneId, { name: script.name, label: script.name, desc: script.desc });
}
