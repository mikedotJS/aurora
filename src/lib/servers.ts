// Run/Stop orchestrator for a workspace's managed dev servers
// (managed-server-lifecycle). THE MODEL: `scripts.run` is ONE ordered LIST of
// commands (`RunCommand[]`, aurora.json) — EACH command is its own managed
// process, spawned via `server_spawn` (lib/server.ts) — a real pid/pgid on its
// own PTY — NOT text written into a shared shell, and lands in its OWN split
// pane. Run/⌘R launches every entry together (concurrent split panes); there
// is no "pick one run script" concept and no run_mode — a flat list is always
// concurrent. `scripts.custom` is the separate on-demand category: many named
// scripts, each run individually. "Up" is real `server_status` (a waitpid) +
// `server_probe` (a real bound port), never OSC-133/pgid-sampling heuristics.
// See design.md Decisions 4/5.
//
// The dedicated "Servers" tab UX is preserved: each running command gets its
// own pane (store.addServerPane/removeServerPane), displaying that process's
// own output stream via ManagedServerPane (Terminal.tsx branches on
// pane.serverId — see design.md's "servers keep a visible pane" assumption).
//
// ID SCHEME: a Run Script entry is keyed by its INDEX in the ordered list —
// `run:<i>` — stable across a run so probe/stop/status stay per-command even
// though entries carry no id of their own (order is the identity). A Custom
// Scripts entry is keyed by its own map key (e.g. "lint"). Both are namespaced
// per-workspace via `managedServerId` before touching `store.managedServers`
// or Rust's `ServerManager` registry, so the two id spaces never collide
// (`run:0` vs a custom script literally named `0` produce distinct
// `${wsId}:…` keys either way).
//
// Superseded by this module (now DORMANT, intentionally left in place rather
// than half-removed — see tasks.md 4.1): `scripts.ts`'s `runServerScript`
// (pty.write into a shared shell) and `ports.ts`'s regex-based
// `portScripts`/`serverUnits` server *identification* (a `run`/`custom` entry
// in aurora.json is now the explicit signal). `ports.ts`'s
// `parseDerivedPorts`/the branch-bar port chips are UNCHANGED — still a valid
// informational display of the legacy `$((N + AURORA_PORT_OFFSET))` idiom for
// scripts that haven't migrated.

import { useStore, type ManagedServerEntry } from "../state/store";
import type { RunCommand } from "./auroraConfig";
import { ensureAuroraConfigLoaded, getCachedAuroraConfig } from "./auroraConfigStore";
import { spawnServer, stopServer as rustStopServer, serverStatus as rustServerStatus, probeServer } from "./server";
import { detectPortCollisions, readOffset, type WorkspacePortState } from "./ports";
import { slugify } from "./branchName";

/** Short repo label for a notification chip — the repo folder name, not its full
 *  path (which would overflow the compact chip). Empty when no repo. */
export function repoLabel(repoId: string | null): string {
  return repoId?.split("/").filter(Boolean).pop() ?? "";
}

/** Stable id for one workspace's one managed script — the key used
 *  throughout `store.managedServers`, `server_spawn/status/stop/probe`, and
 *  `pane.serverId`. Namespaced by wsId so the same scriptId in two
 *  workspaces (or two repos) never collides on one Rust-side registry entry. */
export function managedServerId(wsId: string, scriptId: string): string {
  return `${wsId}:${scriptId}`;
}

/** The Run Script command list's per-entry scriptId — index-based since a
 *  `RunCommand` carries no id of its own (see module doc's ID SCHEME). */
export function runCommandId(index: number): string {
  return `run:${index}`;
}

/** Human label for a Run Script entry — its explicit `name`, else a slug of
 *  its command, else a positional fallback. Used for the pane header/Run-menu
 *  row/notify text; never used as the managedServers key (that's
 *  `runCommandId`'s job — it must stay stable even if two commands slugify
 *  to the same text). */
export function runCommandLabel(rc: RunCommand, index: number): string {
  if (rc.name && rc.name.trim()) return rc.name.trim();
  return slugify(rc.command) || `cmd-${index + 1}`;
}

/** The repo's Run Script — the CACHED config (sync — never triggers IO).
 *  Callers that need the real committed/migrated set (not just whatever's
 *  cached, possibly still `defaultAuroraConfig()`) must
 *  `await ensureAuroraConfigLoaded(repoId)` first — the UI does this on
 *  mount; `runOneRunCommand`/`runServers` do it inline. */
export function runCommands(repoId: string | null): RunCommand[] {
  return getCachedAuroraConfig(repoId).scripts.run;
}

/** True when ANY of this workspace's managed servers is running or still
 *  starting. Pure selector over the store's `managedServers` map. */
export function serversUp(wsId: string, managedServers: Record<string, ManagedServerEntry>): boolean {
  return Object.values(managedServers).some((m) => m.wsId === wsId && m.status !== "exited");
}

/** scriptIds currently running/starting for a workspace (for the Run menu's
 *  per-entry toggle state). */
export function runningScriptIds(wsId: string, managedServers: Record<string, ManagedServerEntry>): string[] {
  return Object.values(managedServers)
    .filter((m) => m.wsId === wsId && m.status !== "exited")
    .map((m) => m.scriptId);
}

function resolveCwd(wsDir: string, scriptCwd: string | undefined): string {
  if (!scriptCwd || scriptCwd === ".") return wsDir;
  if (scriptCwd.startsWith("/")) return scriptCwd;
  return `${wsDir.replace(/\/$/, "")}/${scriptCwd}`;
}

// ── start / stop one command ────────────────────────────────────────────

/** True when `id` is already running/starting for `wsId` — if so, focuses its
 *  Servers-tab pane (when this workspace is active) rather than a no-op. */
function alreadyRunningFocus(wsId: string, id: string, ws: { serverTabId: number | null; tabs: { id: number }[] }): boolean {
  const existing = useStore.getState().managedServers[id];
  if (!existing || existing.status === "exited") return false;
  if (useStore.getState().activeWs === wsId && ws.serverTabId != null) {
    const tabIdx = ws.tabs.findIndex((g) => g.id === ws.serverTabId);
    if (tabIdx !== -1) useStore.getState().selectTab(tabIdx);
  }
  return true;
}

/** Shared by `runOneRunCommand`/`runCustom`: ensures a Servers-tab pane exists
 *  for `id`, spawns `command` via `server_spawn`, records it in
 *  `store.managedServers`, and kicks off the status/probe poll. Assumes the
 *  "already running" check already happened — callers do that first. `label`
 *  is the human-readable name used in pane output/notify text; `scriptId` is
 *  the stable key recorded on the store entry (see module doc's ID SCHEME —
 *  the two intentionally differ for Run Script entries). */
async function spawnManaged(
  wsId: string,
  scriptId: string,
  id: string,
  label: string,
  command: string,
  cwd: string | undefined,
  ws: { dir: string; env: Record<string, string>; title: string; repoId: string | null },
): Promise<void> {
  const paneId = useStore.getState().addServerPane(wsId, id);
  if (paneId == null) {
    useStore.getState().notify({
      color: "var(--err)",
      icon: "⚡",
      headline: `Server pane limit reached — ${ws.title}`,
      sub: "Aurora caps concurrent server panes at 4 — stop another server first.",
      repo: repoLabel(ws.repoId),
    });
    return;
  }

  const resolvedCwd = resolveCwd(ws.dir, cwd);
  useStore.getState().startBlock(paneId, command, resolvedCwd);
  useStore.getState().setManagedServer(id, { wsId, scriptId, label, paneId, status: "starting", exitCode: null, ports: [] });

  try {
    await spawnServer(id, command, [], resolvedCwd, ws.env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useStore.getState().appendOutput(paneId, `\x1b[31maurora: couldn't start '${label}' — ${msg}\x1b[0m\n`);
    useStore.getState().endBlock(paneId, 1);
    useStore.getState().patchManagedServer(id, { status: "exited", exitCode: 1 });
    useStore.getState().removeManagedServers([id]);
    useStore.getState().removeServerPane(wsId, id);
    useStore.getState().notify({
      color: "var(--err)",
      icon: "⚡",
      headline: `Couldn't start ${label} — ${ws.title}`,
      sub: msg,
      repo: repoLabel(ws.repoId),
    });
    return;
  }

  useStore.getState().patchManagedServer(id, { status: "running" });
  ensureServerPoll();
}

/**
 * Start the Run Script's `index`-th command for `wsId` (idempotent — a no-op,
 * beyond focusing the Servers tab, when it's already running/starting). Each
 * entry is independent — no run_mode, no stop-siblings side effect.
 */
export async function runOneRunCommand(wsId: string, index: number): Promise<void> {
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
  if (!ws || !ws.repoId) return;

  const scriptId = runCommandId(index);
  const id = managedServerId(wsId, scriptId);
  if (alreadyRunningFocus(wsId, id, ws)) return;

  const config = await ensureAuroraConfigLoaded(ws.repoId);
  const rc = config.scripts.run[index];
  if (!rc) return;

  await spawnManaged(wsId, scriptId, id, runCommandLabel(rc, index), rc.command, rc.cwd, ws);
}

/**
 * Start ONE `scripts.custom` entry for `wsId`, on demand — mirrors
 * `runOneRunCommand` but reads from `config.scripts.custom` and never
 * participates in the Run-all flow (custom scripts are independent,
 * user-triggered one-offs).
 */
export async function runCustom(wsId: string, customId: string): Promise<void> {
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
  if (!ws || !ws.repoId) return;

  const id = managedServerId(wsId, customId);
  if (alreadyRunningFocus(wsId, id, ws)) return;

  const config = await ensureAuroraConfigLoaded(ws.repoId);
  const script = config.scripts.custom[customId];
  if (!script) return;

  await spawnManaged(wsId, customId, id, customId, script.command, script.cwd, ws);
}

/** Stop one workspace's one managed process (no-op if it isn't tracked).
 *  `scriptId` is either a Run Script id (`runCommandId(i)`) or a custom
 *  script's own key. */
export async function stopServer(wsId: string, scriptId: string): Promise<void> {
  const id = managedServerId(wsId, scriptId);
  const entry = useStore.getState().managedServers[id];
  if (!entry) return;
  await rustStopServer(id).catch(() => {
    // stop() itself shouldn't throw (Rust makes it a no-op for an untracked
    // id), but never let a transport error strand the pane in "running".
  });
  useStore.getState().endBlock(entry.paneId, entry.exitCode);
  useStore.getState().removeManagedServers([id]);
  useStore.getState().removeServerPane(wsId, id);
}

// ── workspace-level (the rail's bare Run/Stop + ⌘R) ─────────────────────

/**
 * Start EVERY command in the Run Script for the workspace, concurrently (the
 * bare Run-button click / ⌘R when servers are down) — each lands as its own
 * split pane in the Servers tab via `runOneRunCommand`'s shared
 * `addServerPane` (see store.ts: the tab's `Group.split`/`panes[]` IS the
 * split-pane layout, capped at 4 concurrent panes — a 5th+ entry gets
 * `runOneRunCommand`'s existing "pane limit reached" notify and simply
 * doesn't start, so a big run list still launches everything that fits).
 * No-op when the repo's Run Script is empty (visibility guard).
 */
export async function runServers(wsId: string): Promise<void> {
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
  if (!ws || !ws.repoId) return;
  const config = await ensureAuroraConfigLoaded(ws.repoId);
  if (config.scripts.run.length === 0) return;
  await Promise.all(config.scripts.run.map((_, i) => runOneRunCommand(wsId, i)));
}

/** Stop every managed server currently tracked for this workspace (the bare
 *  Stop-button click / ⌘R when servers are up). No-op when none are running. */
export async function stopServers(wsId: string): Promise<void> {
  const scriptIds = Object.values(useStore.getState().managedServers)
    .filter((m) => m.wsId === wsId)
    .map((m) => m.scriptId);
  await Promise.all(scriptIds.map((scriptId) => stopServer(wsId, scriptId)));
}

// ── status/probe poll ────────────────────────────────────────────────────

let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _pollRunning = false;

function liveManagedServerIds(): string[] {
  return Object.entries(useStore.getState().managedServers)
    .filter(([, m]) => m.status !== "exited")
    .map(([id]) => id);
}

/** Re-run collision detection (task 3.6) over every managed server's last
 *  probed ports, write the result into `store.portCollisions`, and `notify`
 *  once per newly-appeared collision (not every tick). */
function recomputeCollisions(): void {
  const st = useStore.getState();
  const byWs = new Map<string, WorkspacePortState>();
  for (const m of Object.values(st.managedServers)) {
    if (m.status === "exited" || !m.ports.length) continue;
    const ws = st.workspaces.find((w) => w.id === m.wsId);
    if (!ws) continue;
    const offset = readOffset(ws.env);
    if (!Number.isFinite(offset)) continue;
    const entry = byWs.get(m.wsId) ?? { wsId: m.wsId, offset, boundPorts: [] as number[] };
    entry.boundPorts.push(...m.ports);
    byWs.set(m.wsId, entry);
  }
  const collisions = detectPortCollisions([...byWs.values()]);
  const prev = st.portCollisions;
  const same =
    prev.length === collisions.length &&
    prev.every((c, i) => c.wsId === collisions[i].wsId && c.port === collisions[i].port && c.reason === collisions[i].reason);
  if (same) return;

  st.setPortCollisions(collisions);
  for (const c of collisions) {
    const alreadyNotified = prev.some((p) => p.wsId === c.wsId && p.port === c.port && p.reason === c.reason);
    if (alreadyNotified) continue;
    const ws = st.workspaces.find((w) => w.id === c.wsId);
    st.notify({
      color: "var(--err)",
      icon: "⚡",
      headline: `Port collision on :${c.port}`,
      sub:
        c.reason === "outside-range"
          ? `Bound outside ${ws?.title ?? c.wsId}'s reserved range.`
          : "Also bound by another workspace.",
      repo: repoLabel(ws?.repoId ?? null),
    });
  }
}

/**
 * Ensure a single ~1.5s poll is running over every tracked managed server,
 * writing real `server_status`/`server_probe` results into the store and
 * recomputing collisions. Idempotent. Auto-stops when nothing is tracked.
 */
export function ensureServerPoll(): void {
  if (_pollInterval !== null) return;

  _pollInterval = setInterval(async () => {
    if (_pollRunning) return;
    _pollRunning = true;
    try {
      const ids = liveManagedServerIds();
      if (ids.length === 0) {
        stopServerPoll();
        return;
      }
      await Promise.all(
        ids.map(async (id) => {
          const before = useStore.getState().managedServers[id];
          if (!before) return; // removed mid-tick
          try {
            const [status, ports] = await Promise.all([rustServerStatus(id), probeServer(id)]);
            const current = useStore.getState().managedServers[id];
            if (!current) return; // removed while the probe was in-flight
            if (status.state === "exited") {
              useStore.getState().patchManagedServer(id, { status: "exited", exitCode: status.code, ports });
              useStore.getState().endBlock(current.paneId, status.code);
              // Reap the Rust-side registry entry now that its terminal exit
              // has been surfaced — otherwise a later runServer/spawnServer
              // for this same id hits Rust's `contains_key` guard ("already
              // tracked") and a naturally-exited single-server workspace can
              // never be restarted (multi-server ones self-heal today only
              // because stopServers filters+reaps by wsId on the NEXT
              // explicit Stop). stop() is a cheap no-op here — Rust's
              // exit_code is already cached from the status() call above, so
              // it short-circuits straight to removal without signaling a
              // live process (server.rs:190-193).
              await rustStopServer(id).catch(() => {});
            } else {
              useStore.getState().patchManagedServer(id, { status: "running", ports });
            }
          } catch {
            // server_status rejects when `id` isn't tracked Rust-side. Usually
            // that means the process died and got reaped/removed some other
            // way — treat as exited rather than spinning forever on a server
            // that will never answer again. BUT while an entry is still
            // `status:"starting"`, spawnServer() may simply not have returned
            // yet (Rust hasn't inserted the id into its registry), and a poll
            // tick landing in that window would otherwise flip a
            // just-starting CONCURRENT server (started while another is
            // already up and being polled) to a spurious "exited"/endBlock —
            // skip it and let the next tick (or runOneRunCommand's own
            // try/catch around spawnServer) resolve it once spawnServer
            // settles.
            const current = useStore.getState().managedServers[id];
            if (!current) return;
            if (current.status === "starting") return;
            useStore.getState().patchManagedServer(id, { status: "exited", exitCode: null });
            useStore.getState().endBlock(current.paneId, null);
          }
        }),
      );
      recomputeCollisions();
    } finally {
      _pollRunning = false;
    }
  }, 1500);
}

/** Stop the managed-server poll. Safe to call multiple times. */
export function stopServerPoll(): void {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}
