// Tab strip with drag-to-merge (drop one tab on another to combine their panes
// into a split group), split badges, and new-tab / split buttons.

import { useRef, useState } from "react";
import { useStore, type Group } from "../state/store";
import { shortenCwd } from "../lib/sys";

function tabTitle(g: Group, home: string): string {
  const pane = g.panes[g.active] ?? g.panes[0];
  const short = shortenCwd(pane?.cwd ?? "", home);
  const seg = short.split("/").filter(Boolean).pop();
  return seg && seg !== "~" ? seg : "zsh";
}

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const home = useStore((s) => s.home);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const newTab = useStore((s) => s.newTab);
  const splitPane = useStore((s) => s.splitPane);
  const mergeTabs = useStore((s) => s.mergeTabs);

  const dragIdx = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  return (
    <div
      style={{
        flex: "0 0 39px",
        display: "flex",
        alignItems: "stretch",
        background: "var(--page)",
        borderBottom: "1px solid var(--line)",
        padding: "6px 8px 0",
        gap: 3,
        fontFamily: "var(--sans)",
      }}
    >
      {tabs.map((tab, i) => {
        const isActive = i === active;
        const isDrop = dropTarget === i;
        return (
          <div
            key={tab.id}
            onClick={() => selectTab(i)}
            draggable
            onDragStart={(e) => {
              dragIdx.current = i;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragIdx.current !== null && dragIdx.current !== i) setDropTarget(i);
            }}
            onDragLeave={() => setDropTarget((t) => (t === i ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              const src = dragIdx.current;
              dragIdx.current = null;
              setDropTarget(null);
              if (src !== null && src !== i) mergeTabs(src, i);
            }}
            onDragEnd={() => {
              dragIdx.current = null;
              setDropTarget(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              height: 33,
              padding: "0 11px 0 13px",
              background: isActive ? "var(--win)" : "transparent",
              border: `1px solid ${isActive ? "var(--line)" : "transparent"}`,
              borderBottom: isActive ? "none" : "1px solid transparent",
              borderRadius: "8px 8px 0 0",
              cursor: isActive ? "default" : "pointer",
              color: isActive ? "var(--fg)" : "var(--dim)",
              position: "relative",
            }}
          >
            {isActive && (
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: "var(--ac)",
                  boxShadow: "0 0 8px var(--ac)",
                  borderRadius: 2,
                }}
              />
            )}
            {isDrop && (
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  border: "1px solid var(--ac)",
                  borderRadius: "8px 8px 0 0",
                  background: "color-mix(in oklab, var(--ac) 16%, transparent)",
                  boxShadow: "0 0 12px -3px var(--ac)",
                  pointerEvents: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  color: "var(--ac)",
                }}
              >
                ⊟ split
              </span>
            )}
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: isActive ? "var(--ac)" : "var(--faint)",
                boxShadow: isActive ? "0 0 6px var(--ac)" : "none",
                flex: "0 0 auto",
              }}
            />
            <span
              style={{
                fontSize: 12,
                maxWidth: 140,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {tabTitle(tab, home)}
            </span>
            {tab.panes.length > 1 && (
              <span
                title={`${tab.panes.length} panes`}
                style={{
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                  fontSize: 9,
                  color: "var(--acd)",
                  border: "1px solid color-mix(in oklab, var(--ac) 35%, var(--line))",
                  borderRadius: 4,
                  padding: "0 4px",
                  height: 14,
                  lineHeight: 1,
                }}
              >
                ⊟{tab.panes.length}
              </span>
            )}
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(i);
              }}
              style={{
                fontSize: 15,
                lineHeight: 1,
                color: "var(--faint)",
                width: 17,
                height: 17,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 5,
                cursor: "pointer",
                opacity: isActive ? 1 : 0.55,
              }}
            >
              ×
            </span>
          </div>
        );
      })}

      <div
        onClick={newTab}
        title="new tab (⌘T)"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 33,
          color: "var(--dim)",
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
          borderRadius: "8px 8px 0 0",
        }}
      >
        +
      </div>
      <div
        onClick={() => splitPane("h")}
        title="split pane (⌘D)"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 33,
          color: "var(--dim)",
          fontSize: 13,
          lineHeight: 1,
          cursor: "pointer",
          borderRadius: "8px 8px 0 0",
        }}
      >
        ⊟
      </div>
    </div>
  );
}
