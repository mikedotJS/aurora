// Per-repo scripts + onEnter hooks. Scripts are keyed by git repo root and
// persisted (via the store) to localStorage. v1 runs a script's tasks joined
// with `&&` in the active pane; split-pane layout is a future enhancement.

import {
  useStore,
  activeGroup,
  findPane,
  type Script,
  type ScriptTask,
  type RepoScripts,
  type PaneState,
} from "../state/store";
import { pty } from "../term/pty";

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

/**
 * Append scripts to a repo (used when adopting AI-generated scripts). A name that
 * collides with an existing script — or another script in the same batch — is
 * auto-suffixed (`build` → `build-2`) rather than overwriting it.
 */
export const appendScripts = (root: string, scripts: Script[]) =>
  mutate(root, (rs) => {
    const taken = new Set(rs.scripts.map((s) => s.name));
    for (const s of scripts) {
      let name = s.name;
      for (let n = 2; taken.has(name); n++) name = `${s.name}-${n}`;
      taken.add(name);
      rs.scripts.push({ ...s, name });
    }
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

function runWhenReady(
  paneId: number,
  cmd: string,
  attempts = 0,
  healed = false,
  onLaunched?: (ptyId: string) => void,
) {
  const pane = findPane(useStore.getState(), paneId);
  if (pane?.ready && pane.ptyId) {
    send(pane, cmd);
    onLaunched?.(pane.ptyId);
    return;
  }
  if (!pane || pane.exited) return; // pane closed / shell exited — nothing to run in
  // A freshly-split pane whose spawn was lost never gets a shell, so the command
  // would silently vanish. If there's still no PTY after ~3s, nudge a respawn
  // once, then keep waiting (up to ~10s) for the fresh shell to come up.
  let didHeal = healed;
  if (!healed && attempts >= 50 && !pane.ptyId) {
    useStore.getState().respawnPane(paneId);
    didHeal = true;
  }
  if (attempts < 165) setTimeout(() => runWhenReady(paneId, cmd, attempts + 1, didHeal, onLaunched), 60);
}

/**
 * Run a repo script in a pane. `opts.lookupRoot` resolves the script from a
 * different repo (used by the workspace create flow: scripts are defined on the
 * main checkout but a new workspace runs in its worktree); `opts.execBase` is the
 * directory tasks `cd` into (the worktree dir), defaulting to the lookup key.
 */
/** Run a single command in a pane once its shell is ready (used for the
 *  auto-install step on worktree create, where the PTY may not exist yet). */
export function runCommand(paneId: number, cmd: string) {
  if (cmd.trim()) runWhenReady(paneId, cmd);
}

export function runScript(
  paneId: number,
  name: string,
  opts?: { lookupRoot?: string; execBase?: string; prelude?: string },
) {
  const st = useStore.getState();
  const pane = findPane(st, paneId);
  if (!pane) return;
  const key = opts?.lookupRoot ?? scriptKey(pane);
  const execBase = opts?.execBase ?? key;
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
    const group = activeGroup(st);
    if (group) {
      const need = n - group.panes.length;
      for (let i = 0; i < need; i++) st.splitPane("h");
    }
    const panes = activeGroup(useStore.getState())?.panes ?? [];
    for (let i = 0; i < n; i++) {
      if (!panes[i]) continue;
      // The prelude (e.g. dependency install) runs once, before the first pane's task.
      const cmd = taskCmd(execBase, tasks[i]);
      runWhenReady(panes[i].id, i === 0 && opts?.prelude ? `${opts.prelude} && ${cmd}` : cmd);
    }
    useStore.getState().focusPane(0);
    return;
  }

  // Wait for the shell to be ready before sending — a freshly-created workspace's
  // pane has no PTY yet at call time (the create flow runs scripts immediately).
  const chain = [opts?.prelude, ...tasks.map((t) => taskCmd(execBase, t))].filter(Boolean).join(" && ");
  runWhenReady(pane.id, chain);
}

/**
 * Run a server script in the given pane without any further split — "the server IS
 * the pane". Reuses the same `runWhenReady` + `taskCmd` primitives as `runScript`.
 *
 * opts.taskIndex (optional): when provided, runs ONLY that task (index into the
 * non-empty tasks array). Used by `runServers` for split-script units — each task
 * gets its own dedicated pane so long-running servers start concurrently (no &&).
 * When absent, all non-empty tasks are chained with && in the given pane.
 *
 * Used by `runServers` (workspace-run-servers): one call per server unit, each in
 * its own dedicated pane inside the Servers tab.
 */
export function runServerScript(
  paneId: number,
  name: string,
  opts: {
    lookupRoot: string;
    execBase: string;
    taskIndex?: number;
    /** Called with the pane's ptyId the instant the command is sent (D7 capture trigger). */
    onLaunched?: (ptyId: string) => void;
  },
): void {
  const st = useStore.getState();
  const pane = findPane(st, paneId);
  if (!pane) return;
  const script = scriptsForRoot(opts.lookupRoot).find((s) => s.name === name);
  if (!script) {
    feedback(pane, `run ${name}`, `run: no script '${name}' here — add one with \`scripts\``);
    return;
  }
  const tasks = script.tasks.filter((t) => t.cmd.trim());
  if (!tasks.length) {
    feedback(pane, `run ${name}`, `run: script '${name}' has no commands`);
    return;
  }
  if (opts.taskIndex != null) {
    // Split path: run only the specified task (concurrent with sibling panes — no &&).
    const task = tasks[opts.taskIndex];
    if (!task) {
      feedback(pane, `run ${name}`, `run: script '${name}' has no task at index ${opts.taskIndex}`);
      return;
    }
    runWhenReady(paneId, taskCmd(opts.execBase, task), 0, false, opts.onLaunched);
    return;
  }
  // Non-split path: chain all tasks with && and run in the given pane.
  const chain = tasks.map((t) => taskCmd(opts.execBase, t)).join(" && ");
  runWhenReady(paneId, chain, 0, false, opts.onLaunched);
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
