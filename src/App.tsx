import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { TabStrip } from "./components/TabStrip";
import { PaneArea } from "./components/PaneGrid";
import { StatusBar } from "./components/StatusBar";
import { SettingsModal } from "./components/SettingsModal";
import { MrSheet } from "./components/MrSheet";
import { ScriptsSheet } from "./components/ScriptsSheet";
import { ScriptsSetupModal } from "./components/ScriptsSetupModal";
import { NotifStack } from "./components/NotifStack";
import { NotifSheet } from "./components/NotifSheet";
import { WorkspaceRail, WorkspaceContextBar } from "./components/WorkspaceRail";
import { WorkspaceCommand } from "./components/WorkspaceCommand";
import { WorkspaceSettings } from "./components/WorkspaceSettings";
import {
  useStore,
  activePane,
  activeGroup,
  activeWorkspace,
  DEFAULT_SETTINGS,
  type Settings,
  type RepoScripts,
  type BootInfo,
} from "./state/store";
import { requestTabName } from "./lib/tabNaming";
import { handleKeyDown } from "./lib/keymap";
import { homeDir, listDir, gitBranch, gitRepoInfo, gitStatusSummary } from "./lib/sys";
import { loadPersisted } from "./lib/workspace";
import { loadRepoConfigs } from "./lib/repoConfig";
import { loadConnections } from "./lib/connections";
import { migrateToConnections } from "./lib/migrateConnections";
import { maybeFireHook } from "./lib/scripts";
import { startNotificationPoller } from "./lib/notifications";
import { checkForUpdates } from "./lib/updater";
import { keyPresent } from "./lib/keychain";

export default function App() {
  const ready = useStore((s) => s.workspaces.length > 0);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const workspaceSettingsOpen = useStore((s) => s.workspaceSettingsRepo !== null);
  const scriptsSetupOpen = useStore((s) => s.scriptsSetupOpen);
  const commandOpen = useStore((s) => s.command !== null);
  const panel = useStore((s) => s.panel);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const apId = useStore((s) => activePane(s)?.id);
  const apCwd = useStore((s) => activePane(s)?.cwd);
  const wsId = useStore((s) => s.activeWs);
  const wsDir = useStore((s) => activeWorkspace(s)?.dir);
  const wsBase = useStore((s) => activeWorkspace(s)?.baseBranch);

  // auto-rename tabs: a stable string of the running command in EVERY pane of the
  // active tab (a split tab is named from all its panes). A primitive key, derived
  // from commands only, so the effect re-runs when the running set changes — not on
  // every output chunk.
  const activeTabId = useStore((s) => activeGroup(s)?.id ?? null);
  const tabRunKey = useStore((s) => {
    const g = activeGroup(s);
    if (!g) return "";
    return g.panes
      .map((p) => {
        const b = p.blocks[p.blocks.length - 1];
        return b?.running ? b.command.trim() : "";
      })
      .join("␟");
  });

  // boot: home dir, persisted settings, key presence, repo + workspaces
  useEffect(() => {
    (async () => {
      const home = await homeDir().catch(() => "~");
      let settings: Settings = DEFAULT_SETTINGS;
      try {
        const raw = localStorage.getItem("aurora.settings");
        if (raw) settings = { ...settings, ...JSON.parse(raw) };
      } catch {
        /* ignore */
      }
      const present = await keyPresent().catch(() => false);

      const repoInfo = await gitRepoInfo(home);
      const persisted = loadPersisted();
      // Stale-prune: drop restored repo-backed workspaces whose dir is gone.
      const alive = await Promise.all(
        persisted.workspaces.map(async (w) => (w.repoId ? !!(await gitRepoInfo(w.dir)) : true)),
      );
      const restored = persisted.workspaces.filter((_, i) => alive[i]);

      const boot: BootInfo = {
        repo: repoInfo
          ? {
              // identity = the main repo root, shared across worktrees
              root: repoInfo.main_root,
              name: repoInfo.name,
              defaultBranch: repoInfo.default_branch,
              currentBranch: repoInfo.current_branch,
            }
          : null,
        restored,
        activeWs: persisted.activeWs,
      };
      useStore.getState().init(home, settings, present, boot);

      let userScripts: Record<string, RepoScripts> = {};
      try {
        const raw = localStorage.getItem("aurora.scripts");
        if (raw) userScripts = JSON.parse(raw) || {};
      } catch {
        /* ignore */
      }
      useStore.getState().setUserScripts(userScripts);

      // Migrate to the connection-pool model (idempotent) BEFORE loading repo
      // configs, so the legacy single Jira connection is harvested into the pool
      // and each repo's config carries its binding. Then load the pool + configs.
      await migrateToConnections();
      useStore.getState().setConnections(loadConnections());
      const repoConfigs = loadRepoConfigs();
      useStore.getState().setRepoConfigs(repoConfigs);
      // Honor the boot repo's "show rail on launch" default (only collapse when
      // it was explicitly turned off, so the rail shows by default).
      if (repoInfo && repoConfigs[repoInfo.root]?.defaults.showRailOnLaunch === false) {
        useStore.getState().setRailCollapsed(true);
      }
      startNotificationPoller();
      void checkForUpdates();
      setTimeout(() => document.getElementById("aurora-root")?.focus(), 0);
    })();
  }, []);

  // global keyboard
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // refresh fs entries (ghost) + git branch when the active pane's cwd changes
  useEffect(() => {
    if (apId == null || !apCwd) return;
    listDir(apCwd).then((entries) =>
      useStore.getState().setDirNames(
        apId,
        entries.map((e) => e.name),
      ),
    );
    gitBranch(apCwd).then((b) => useStore.getState().setBranch(apId, b));
    // Identify the canonical (main) repo for this cwd so per-repo scripts/config
    // are shared across the repo's worktrees (a worktree's toplevel differs).
    gitRepoInfo(apCwd).then((info) => {
      const root = info?.main_root ?? null;
      useStore.getState().setRepoRoot(apId, root);
      maybeFireHook(apId);
      // A manual lane (booted outside a repo) adopts the repo its pane is in, so
      // create / settings / rail grouping work once you cd into one.
      if (info) {
        const st = useStore.getState();
        const ws = st.workspaces.find((w) => w.id === st.activeWs);
        if (ws && !ws.repoId) st.adoptRepo(ws.id, { root: info.main_root, name: info.name, defaultBranch: info.default_branch });
      }
    });
  }, [apId, apCwd]);

  // refresh the active workspace's diff summary (rail counts + status bar)
  useEffect(() => {
    if (!wsId || !wsDir) return;
    gitStatusSummary(wsDir, wsBase ?? "").then((sum) => {
      if (sum) useStore.getState().setWsDiff(wsId, sum);
    });
  }, [wsId, wsDir, wsBase, apCwd]);

  // auto-rename the active tab once its command(s) have been running a moment (so
  // a quick `ls` is ignored). The timer is the debounce; the key only changes when
  // the running command set changes, so output growth doesn't reset it. At fire
  // time, gather every still-running pane in the tab and ask Haiku for one label
  // covering them all. When commands end, the key empties → no rename; the tab
  // keeps its last name.
  useEffect(() => {
    if (activeTabId == null || !tabRunKey.replace(/␟/g, "").trim()) return;
    const t = window.setTimeout(() => {
      const g = activeGroup(useStore.getState());
      if (!g || g.id !== activeTabId) return;
      const panes = g.panes
        .map((p) => {
          const b = p.blocks[p.blocks.length - 1];
          return b?.running && b.command.trim() ? { command: b.command, output: b.output.slice(-1000) } : null;
        })
        .filter((x): x is { command: string; output: string } => x !== null);
      if (panes.length) void requestTabName(activeTabId, panes);
    }, 1500);
    return () => clearTimeout(t);
  }, [activeTabId, tabRunKey]);

  if (!ready) return null;

  return (
    <div
      id="aurora-root"
      tabIndex={-1}
      style={{
        height: "100%",
        outline: "none",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, var(--line) 75%, transparent)",
        background:
          "radial-gradient(120% 90% at 50% -10%, color-mix(in oklab, var(--ac) 9%, transparent), transparent 55%), var(--page)",
        fontFamily: "var(--mono)",
      }}
    >
      <TitleBar />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {!railCollapsed && <WorkspaceRail />}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <WorkspaceContextBar />
          <TabStrip />
          <PaneArea />
        </div>
      </div>
      <StatusBar />
      <NotifStack />
      {panel === "mr" && <MrSheet />}
      {panel === "scripts" && <ScriptsSheet />}
      {panel === "notif" && <NotifSheet />}
      {scriptsSetupOpen && <ScriptsSetupModal />}
      {settingsOpen && <SettingsModal />}
      {workspaceSettingsOpen && <WorkspaceSettings />}
      {commandOpen && <WorkspaceCommand />}
    </div>
  );
}
