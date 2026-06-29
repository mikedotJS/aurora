// Scripts bottom sheet: pick a per-repo script to run (↑↓ select, ↵ run, esc
// close). "✎ edit" opens the setup modal.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useStore, activePane } from "../state/store";
import { scriptsForRoot, runScript } from "../lib/scripts";
import { shortenCwd } from "../lib/sys";

export function ScriptsSheet() {
  const closePanel = useStore((s) => s.closePanel);
  const openScriptsSetup = useStore((s) => s.openScriptsSetup);
  const userScripts = useStore((s) => s.userScripts);
  const home = useStore((s) => s.home);
  const pane = useStore((s) => activePane(s));
  const root = pane ? (pane.repoRoot ?? pane.cwd) : null;
  void userScripts; // re-render when scripts change
  const list = scriptsForRoot(root);

  const [sel, setSel] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((i) => Math.min(i + 1, Math.max(0, list.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const s = list[sel];
        if (s && pane) {
          closePanel();
          runScript(pane.id, s.name);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [list, sel, pane, closePanel]);

  return (
    <Sheet title="scripts" subtitle={root ? shortenCwd(root, home) : undefined} onClose={closePanel} height="60%">
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 15px 6px" }}>
        <span
          onClick={openScriptsSetup}
          style={{
            cursor: "pointer",
            fontFamily: "var(--sans)",
            fontSize: 11,
            color: "var(--acd)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: "3px 9px",
          }}
        >
          ✎ edit scripts
        </span>
      </div>
      {root && list.length === 0 && <Empty>no scripts here yet — “✎ edit scripts” to add one</Empty>}
      {list.map((s, i) => (
        <div
          key={s.name + i}
          onMouseEnter={() => setSel(i)}
          onClick={() => {
            if (pane) {
              closePanel();
              runScript(pane.id, s.name);
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 15px 12px 17px",
            cursor: "pointer",
            borderBottom: "1px solid color-mix(in oklab, var(--line) 50%, transparent)",
            borderLeft: `2px solid ${i === sel ? "var(--ac)" : "transparent"}`,
            background: i === sel ? "color-mix(in oklab, var(--ac) 11%, transparent)" : "transparent",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ color: "var(--ac)", fontSize: 13.5 }}>{s.name}</span>
              {s.split && (
                <span
                  style={{
                    fontFamily: "var(--sans)",
                    fontSize: 9.5,
                    color: "var(--acd)",
                    border: "1px solid color-mix(in oklab, var(--ac) 35%, var(--line))",
                    borderRadius: 4,
                    padding: "1px 5px",
                    textTransform: "uppercase",
                  }}
                >
                  split
                </span>
              )}
            </div>
            {s.desc && <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 2 }}>{s.desc}</div>}
          </div>
          <span style={{ flex: "0 0 auto", fontFamily: "var(--sans)", fontSize: 12, color: "var(--acd)" }}>▶ run</span>
        </div>
      ))}
    </Sheet>
  );
}

export function Sheet({
  title,
  subtitle,
  onClose,
  height,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  height: string;
  children: ReactNode;
}) {
  return (
    <>
      <div
        onClick={onClose}
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
          height,
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
              <span style={{ color: "var(--acd)" }}>⚡</span>
              {title}
              {subtitle && (
                <span style={{ color: "var(--faint)", textTransform: "none", letterSpacing: 0 }}>· {subtitle}</span>
              )}
            </span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
              <span style={{ color: "var(--acd)" }}>↑↓</span> select · <span style={{ color: "var(--acd)" }}>↵</span> run
              · <span style={{ color: "var(--acd)" }}>esc</span> close
            </span>
            <span
              onClick={onClose}
              style={{
                cursor: "pointer",
                fontSize: 17,
                width: 21,
                height: 21,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                color: "var(--dim)",
              }}
            >
              ×
            </span>
          </div>
        </div>
        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "8px 0 10px" }}>
          {children}
        </div>
      </div>
    </>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        gap: 7,
        color: "var(--faint)",
        fontFamily: "var(--sans)",
        fontSize: 13,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
