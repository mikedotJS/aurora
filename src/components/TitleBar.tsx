// macOS-style title bar: traffic lights (wired to real window controls), center
// title, connection dot + gear.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../state/store";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const startKeyEntry = useStore((s) => s.startKeyEntry);
  const openSettings = useStore((s) => s.openSettings);

  return (
    <div
      data-tauri-drag-region
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
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
      </div>

      <div
        style={{
          fontFamily: "var(--sans)",
          fontSize: 12.5,
          color: "var(--dim)",
          letterSpacing: ".02em",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>aurora</span>
        <span style={{ color: "var(--faint)" }}>—</span>
        <span>zsh</span>
        <span style={{ color: "var(--faint)" }}>—</span>
        <span style={{ color: "var(--acd)" }}>✦ claude</span>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 11,
          fontFamily: "var(--sans)",
          fontSize: 11,
          color: "var(--faint)",
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
