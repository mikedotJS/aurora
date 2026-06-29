// Toast stack (top-right, ≤3, auto-dismiss). Click opens the related URL.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";

export function NotifStack() {
  const notifs = useStore((s) => s.notifs);
  const dismissNotif = useStore((s) => s.dismissNotif);

  if (notifs.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 90,
        right: 14,
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        gap: 9,
        width: 298,
        pointerEvents: "none",
      }}
    >
      {notifs.map((n) => (
        <div
          key={n.id}
          onClick={() => n.url && openUrl(n.url)}
          style={{
            pointerEvents: "auto",
            cursor: "pointer",
            display: "flex",
            gap: 11,
            alignItems: "flex-start",
            padding: "11px 11px 11px 12px",
            background:
              "linear-gradient(180deg, color-mix(in oklab, var(--bar) 88%, black), color-mix(in oklab, var(--win) 80%, black))",
            border: "1px solid var(--line)",
            borderLeft: `2px solid ${n.color}`,
            borderRadius: 9,
            boxShadow: `0 12px 32px -14px rgba(0,0,0,.8), 0 0 22px -14px ${n.color}`,
            animation: "slideInRight .22s cubic-bezier(.2,.7,.3,1)",
          }}
        >
          <span
            style={{
              flex: "0 0 auto",
              width: 18,
              textAlign: "center",
              fontSize: 13,
              lineHeight: 1.3,
              color: n.color,
            }}
          >
            {n.icon}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontFamily: "var(--sans)",
                fontSize: 12.5,
                color: "var(--fg)",
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.headline}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--dim)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.sub}
            </div>
            {n.repo && (
              <div
                style={{
                  marginTop: 5,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--sans)",
                  fontSize: 10,
                  color: "var(--faint)",
                  border: "1px solid var(--line)",
                  borderRadius: 5,
                  padding: "1px 6px",
                }}
              >
                <span style={{ color: "var(--acd)" }}>⇋</span>
                {n.repo}
              </div>
            )}
          </div>
          <span
            onClick={(e) => {
              e.stopPropagation();
              dismissNotif(n.id);
            }}
            style={{
              flex: "0 0 auto",
              fontSize: 14,
              lineHeight: 1,
              color: "var(--faint)",
              width: 16,
              height: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            ×
          </span>
        </div>
      ))}
    </div>
  );
}
