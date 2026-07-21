import { useEffect, useRef } from "react";
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
import { WorkspacesIntro } from "./components/WorkspacesIntro";
import { WorkspaceTour } from "./components/WorkspaceTour";
import { MigrationBanner } from "./components/MigrationBanner";
import {
  useStore,
  activePane,
  activeGroup,
  activeWorkspace,
  workspaceOfPane,
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
import { checkMigrationOffer } from "./lib/auroraConfigStore";
import { startNotificationPoller } from "./lib/notifications";
import { checkForUpdates } from "./lib/updater";
import { keyPresent } from "./lib/keychain";
import { BP_NARROW_PX } from "./lib/useMediaQuery";

export default function App() {
  const ready = useStore((s) => s.initialized);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const workspaceSettingsOpen = useStore((s) => s.workspaceSettingsRepo !== null);
  const scriptsSetupOpen = useStore((s) => s.scriptsSetupOpen);
  const commandOpen = useStore((s) => s.command !== null);
  const introSeen = useStore((s) => s.settings.introSeen);
  const tutorialSeen = useStore((s) => s.settings.tutorialSeen);
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
      // Don't steal focus from the intro's "Got it" button on first launch: the
      // intro mounts and focuses it synchronously, but this boot effect's
      // setTimeout(0) would otherwise fire after and move focus to #aurora-root.
      // Re-read introSeen at fire time (not the `settings` closed over above —
      // it hasn't been updated by dismissIntro yet at this point in boot).
      setTimeout(() => {
        if (useStore.getState().settings.introSeen) document.getElementById("aurora-root")?.focus();
      }, 0);
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
    // `cancelled` drops a late resolution once the active pane/cwd has moved on,
    // so a slow gitRepoInfo can't bind the wrong repo into whichever lane is now
    // active.
    let cancelled = false;
    gitRepoInfo(apCwd).then((info) => {
      if (cancelled) return;
      const root = info?.main_root ?? null;
      useStore.getState().setRepoRoot(apId, root);
      maybeFireHook(apId);
      // A manual lane (booted outside a repo) adopts the repo its pane is in, so
      // create / settings / rail grouping work once you cd into one. Adopt the
      // workspace that OWNS this pane, not whatever is active at resolution time.
      if (info) {
        const st = useStore.getState();
        const ws = workspaceOfPane(st, apId);
        if (ws && !ws.repoId) st.adoptRepo(ws.id, { root: info.main_root, name: info.name, defaultBranch: info.default_branch });
        // Repo-open migration offer (managed-server-lifecycle task 6.2): fire
        // whenever a repo becomes known to the active pane, not just when the
        // Scripts panel happens to be opened. Fire-and-forget; never blocks.
        void checkMigrationOffer(info.main_root);
      }
    });
    return () => {
      cancelled = true;
    };
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

  // Rail auto-collapse (D3): when the window crosses from wide into narrow, collapse
  // the rail once. A user who manually re-opens while narrow is never force-collapsed
  // again until the window returns to wide and crosses back into narrow.
  //
  // Two effects cooperate:
  //   (a) The matchMedia effect fires on threshold crossings — the only place we
  //       collapse or reset the override flag.
  //   (b) The railCollapsed watch detects a true→false transition while narrow and
  //       sets the session override, suppressing the next auto-collapse.
  //
  // railCollapsed is NOT persisted; this is session-only behaviour by design.
  const userOpenedWhileNarrow = useRef(false);
  const prevRailCollapsed = useRef(railCollapsed);

  // (b) Detect manual re-open (true → false) while the window is narrow.
  useEffect(() => {
    const was = prevRailCollapsed.current;
    prevRailCollapsed.current = railCollapsed;
    if (was && !railCollapsed && window.matchMedia(`(max-width: ${BP_NARROW_PX}px)`).matches) {
      userOpenedWhileNarrow.current = true;
    }
  }, [railCollapsed]);

  // (a) Auto-collapse on narrow entry; reset override on wide return.
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${BP_NARROW_PX}px)`);
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        // Crossed into narrow — collapse once unless the user overrode it.
        if (!userOpenedWhileNarrow.current) {
          useStore.getState().setRailCollapsed(true);
        }
      } else {
        // Returned to wide — reset the override; do NOT auto-open.
        userOpenedWhileNarrow.current = false;
      }
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

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
          {/* The Home terminal guarantees an active workspace after `init` — there
              is no reachable "no active workspace" state, so the content column
              always renders the active terminal (never a central empty pane). */}
          <MigrationBanner />
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
      {!introSeen && <WorkspacesIntro />}
      {introSeen && !tutorialSeen && <WorkspaceTour />}
    </div>
  );
}
