// Checks the configured update endpoint on launch. When a newer signed build is
// available it downloads + installs it in the background, then relaunches.
// Silent no-op in dev or when the endpoint is unreachable (caught below).

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useStore } from "../state/store";

let ran = false;

export async function checkForUpdates(): Promise<void> {
  if (ran) return; // once per launch
  ran = true;
  try {
    const update = await check();
    if (!update) return; // already on the latest version

    const { notify } = useStore.getState();
    notify({
      color: "var(--ac)",
      icon: "↓",
      headline: `Update ${update.version} available`,
      sub: "Downloading in the background…",
      repo: "",
    });

    await update.downloadAndInstall();

    notify({
      color: "var(--ac)",
      icon: "✓",
      headline: `Updated to ${update.version}`,
      sub: "Restarting Aurora to finish…",
      repo: "",
    });

    await relaunch();
  } catch (e) {
    // No reachable endpoint, unsigned dev build, or offline — nothing to do.
    console.debug("[aurora] update check skipped:", e);
  }
}
