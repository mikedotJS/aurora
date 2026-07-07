// macOS-style title bar: traffic lights (wired to real window controls), center
// title, connection dot + gear.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, activeWorkspace } from "../state/store";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const startKeyEntry = useStore((s) => s.startKeyEntry);
  const openSettings = useStore((s) => s.openSettings);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const branch = useStore((s) => activeWorkspace(s)?.branch ?? null);

  // The Home terminal lives here — a top-level front door, decoupled from the
  // Workspaces zone, always visible (independent of the rail's collapsed state).
  // Derived from the already-subscribed `workspaces` array (a stable ref) — never
  // a `useStore(s => s.workspaces.find(...))` selector, which would fabricate a
  // fresh value each render and trip the Zustand fresh-ref render loop.
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWs);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const homeWs = workspaces.find((w) => w.kind === "home");
  const homeActive = homeWs != null && activeWs === homeWs.id;

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={async (e) => {
        // macOS's native drag-region double-click-maximize is unreliable
        // (wry#622), so drive it ourselves. Only fire when the double-click
        // landed on a drag-region surface (the bar background / title text) —
        // interactive leaves (traffic lights, Home, status, gear, switcher)
        // are untagged, so double-clicking them no-ops here.
        if ((e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) {
          await appWindow.toggleMaximize();
        }
      }}
      style={{
        height: 42,
        flex: "0 0 42px",
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        padding: "0 16px",
        background: "var(--bar)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <div data-tauri-drag-region style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <span
          onClick={() => appWindow.close()}
          title="close"
          style={{ width: 12, height: 12, borderRadius: "50%", background: "#f0625a", cursor: "pointer" }}
        />
        <span
          onClick={() => appWindow.minimize()}
          title="minimize"
          style={{ width: 12, height: 12, borderRadius: "50%", background: "#f5bd4f", cursor: "pointer" }}
        />
        <span
          onClick={async (e) => {
            // Match native macOS: plain click = real fullscreen, ⌥-click = zoom.
            if (e.altKey) {
              await appWindow.toggleMaximize();
            } else {
              await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
            }
          }}
          title="fullscreen (⌥ to zoom)"
          style={{ width: 12, height: 12, borderRadius: "50%", background: "#5dc466", cursor: "pointer" }}
        />

        {homeWs && (
          <>
            {/* Hairline divider — sets the ~ shell apart from the window controls
                so it reads as its own top-level zone, not a fourth traffic light. */}
            <span
              aria-hidden
              style={{ width: 1, height: 16, marginLeft: 4, background: "var(--line)", flex: "0 0 auto" }}
            />
            <button
              type="button"
              className={`aurora-titlebar-home${homeActive ? " aurora-titlebar-home--active" : ""}`}
              onClick={() => switchWorkspace(homeWs.id)}
              aria-label="Home terminal (~)"
              aria-current={homeActive ? "true" : undefined}
              title="Home terminal — always-on shell in ~  (⌘0)"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <span className="aurora-titlebar-home__glyph" aria-hidden>
                ~
              </span>
            </button>
          </>
        )}
      </div>

      <div
        data-tauri-drag-region
        style={{
          fontFamily: "var(--sans)",
          fontSize: 12.5,
          color: "var(--dim)",
          letterSpacing: ".02em",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        {railCollapsed ? (
          <WorkspaceSwitcher />
        ) : (
          <>
            <span data-tauri-drag-region>aurora</span>
            <span data-tauri-drag-region style={{ color: "var(--faint)" }}>—</span>
            <span
              data-tauri-drag-region
              title={branch ?? undefined}
              style={{
                color: branch ? "var(--acd)" : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {branch ? `⎇ ${branch}` : "zsh"}
            </span>
          </>
        )}
      </div>

      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 11,
          fontFamily: "var(--sans)",
          fontSize: 11,
          color: "var(--faint)",
          minWidth: 0,
        }}
      >
        <span
          onClick={startKeyEntry}
          style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}
        >
          {apiKeyPresent ? (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--ac)",
                  boxShadow: "0 0 8px var(--ac)",
                }}
              />
              <span>connected</span>
            </>
          ) : (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--warn)",
                  boxShadow: "0 0 8px var(--warn)",
                }}
              />
              <span style={{ color: "var(--warn-d)" }}>byok · add key</span>
            </>
          )}
        </span>
        <span
          onClick={openSettings}
          title="settings (⌘,)"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 14,
            color: "var(--dim)",
          }}
        >
          ⚙
        </span>
      </div>
    </div>
  );
}
