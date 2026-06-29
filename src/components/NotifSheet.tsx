// Notifications history bottom sheet: full log, mute toggle, clear.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 8) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function NotifSheet() {
  const closePanel = useStore((s) => s.closePanel);
  const log = useStore((s) => s.notifLog);
  const muted = useStore((s) => s.muted);
  const toggleMute = useStore((s) => s.toggleMute);
  const clearNotifLog = useStore((s) => s.clearNotifLog);

  return (
    <>
      <div
        onClick={closePanel}
        style={{
          position: "absolute",
          inset: "0 0 30px 0",
          zIndex: 50,
          background: "color-mix(in oklab, black 48%, transparent)",
          animation: "fadeIn .18s ease",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 30,
          zIndex: 51,
          height: "66%",
          display: "flex",
          flexDirection: "column",
          background: "var(--win)",
          borderTop: "1px solid color-mix(in oklab, var(--ac) 22%, var(--line))",
          borderRadius: "15px 15px 0 0",
          boxShadow: "0 -24px 60px -22px rgba(0,0,0,.78)",
          animation: "slideUp .26s cubic-bezier(.2,.72,.2,1)",
        }}
      >
        <div style={{ flex: "0 0 auto", padding: "11px 16px 12px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ width: 34, height: 4, borderRadius: 4, background: "var(--line)", margin: "0 auto 12px" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                fontFamily: "var(--sans)",
                fontSize: 11,
                letterSpacing: ".05em",
                textTransform: "uppercase",
                color: "var(--dim)",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <span style={{ color: "var(--acd)" }}>◉</span>notifications
            </span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
              <span
                onClick={toggleMute}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
              >
                {muted ? (
                  <>
                    <span style={{ color: "var(--faint)" }}>○</span>muted
                  </>
                ) : (
                  <>
                    <span style={{ color: "var(--acd)" }}>◉</span>alerts on
                  </>
                )}
              </span>
              <span
                onClick={clearNotifLog}
                style={{ cursor: "pointer", padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
              >
                clear
              </span>
              <span
                onClick={closePanel}
                style={{ cursor: "pointer", fontSize: 17, width: 21, height: 21, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, color: "var(--dim)" }}
              >
                ×
              </span>
            </span>
          </div>
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "6px 0 10px" }}>
          {log.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 7, color: "var(--faint)", fontFamily: "var(--sans)", fontSize: 13 }}>
              <span style={{ fontSize: 22, color: "var(--line)" }}>◉</span>
              <span>no notifications yet</span>
              <span style={{ fontSize: 11.5 }}>merge-request events will appear here</span>
            </div>
          )}
          {log.map((n) => (
            <div
              key={n.id}
              onClick={() => n.url && openUrl(n.url)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 11,
                padding: "11px 15px 11px 17px",
                cursor: n.url ? "pointer" : "default",
                borderBottom: "1px solid color-mix(in oklab, var(--line) 50%, transparent)",
              }}
            >
              <span style={{ flex: "0 0 auto", width: 18, textAlign: "center", fontSize: 13, lineHeight: 1.4, color: n.color }}>{n.icon}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {n.headline}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 11.5, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.sub}</span>
                  {n.repo && (
                    <span style={{ flex: "0 0 auto", fontFamily: "var(--sans)", fontSize: 10, color: "var(--faint)", border: "1px solid var(--line)", borderRadius: 5, padding: "1px 6px" }}>
                      <span style={{ color: "var(--acd)" }}>⇋</span> {n.repo}
                    </span>
                  )}
                </div>
              </div>
              <span style={{ flex: "0 0 auto", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap", marginTop: 2 }}>
                {timeAgo(n.ts)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
