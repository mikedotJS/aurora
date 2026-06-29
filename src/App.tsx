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
import { useStore, activePane, DEFAULT_SETTINGS, type Settings, type RepoScripts } from "./state/store";
import { handleKeyDown } from "./lib/keymap";
import { homeDir, listDir, gitBranch, gitRoot } from "./lib/sys";
import { maybeFireHook } from "./lib/scripts";
import { startNotificationPoller } from "./lib/notifications";
import { checkForUpdates } from "./lib/updater";
import { keyPresent } from "./lib/keychain";

export default function App() {
  const ready = useStore((s) => s.tabs.length > 0);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const scriptsSetupOpen = useStore((s) => s.scriptsSetupOpen);
  const panel = useStore((s) => s.panel);
  const apId = useStore((s) => activePane(s)?.id);
  const apCwd = useStore((s) => activePane(s)?.cwd);

  // boot: home dir, persisted settings, key presence
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
      useStore.getState().init(home, settings, present);
      let userScripts: Record<string, RepoScripts> = {};
      try {
        const raw = localStorage.getItem("aurora.scripts");
        if (raw) userScripts = JSON.parse(raw) || {};
      } catch {
        /* ignore */
      }
      useStore.getState().setUserScripts(userScripts);
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
    gitRoot(apCwd).then((root) => {
      useStore.getState().setRepoRoot(apId, root);
      maybeFireHook(apId);
    });
  }, [apId, apCwd]);

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
      <TabStrip />
      <PaneArea />
      <StatusBar />
      <NotifStack />
      {panel === "mr" && <MrSheet />}
      {panel === "scripts" && <ScriptsSheet />}
      {panel === "notif" && <NotifSheet />}
      {scriptsSetupOpen && <ScriptsSetupModal />}
      {settingsOpen && <SettingsModal />}
    </div>
  );
}
