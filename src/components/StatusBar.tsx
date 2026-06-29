// Bottom status bar: live cwd + git branch, merge-requests entry, tab counter,
// and keyboard hints.

import { useStore, activePane } from "../state/store";
import { shortenCwd } from "../lib/sys";
import { scriptsForRoot } from "../lib/scripts";
import { BranchChip } from "./BranchSwitcher";

export function StatusBar() {
  const home = useStore((s) => s.home);
  const pane = useStore((s) => activePane(s));
  const tabsLen = useStore((s) => s.tabs.length);
  const active = useStore((s) => s.active);
  const openPanel = useStore((s) => s.openPanel);
  const userScripts = useStore((s) => s.userScripts);
  const repoMrs = useStore((s) => s.repoMrs);
  const unseen = useStore((s) => s.unseen);
  const muted = useStore((s) => s.muted);
  const markNotifsSeen = useStore((s) => s.markNotifsSeen);

  const cwd = pane ? shortenCwd(pane.cwd, home) : "~";
  const branch = pane?.branch ?? null;
  void userScripts; // re-render when scripts change
  const hasScripts = scriptsForRoot(pane ? (pane.repoRoot ?? pane.cwd) : null).length > 0;
  const mrs = pane?.repoRoot ? repoMrs[pane.repoRoot] : undefined;

  return (
    <div
      style={{
        flex: "0 0 30px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        background: "var(--bar)",
        borderTop: "1px solid var(--line)",
        fontFamily: "var(--sans)",
        fontSize: 11,
        color: "var(--faint)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ color: "var(--dim)" }}>{cwd}</span>
        {branch && pane && (
          <>
            <BranchChip paneId={pane.id} cwd={pane.cwd} branch={branch} />
            <span
              onClick={() => openPanel("mr")}
              title="show open merge requests"
              style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
            >
              <span style={{ color: "var(--acd)" }}>⇋</span>
              {mrs ? `${mrs.length} MRs` : "MRs"}
            </span>
          </>
        )}
        {hasScripts && (
          <span
            onClick={() => openPanel("scripts")}
            title="run a script"
            style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
          >
            <span style={{ color: "var(--acd)" }}>⚡</span>
            scripts
          </span>
        )}
        <span
          onClick={() => {
            openPanel("notif");
            markNotifsSeen();
          }}
          title="notification history"
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
        >
          {muted ? (
            <>
              <span style={{ color: "var(--faint)" }}>○</span>muted
            </>
          ) : (
            <>
              <span style={{ color: "var(--acd)" }}>◉</span>alerts
            </>
          )}
          {unseen > 0 && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 13,
                height: 13,
                padding: "0 3px",
                borderRadius: 4,
                background: "oklch(0.62 0.23 27)",
                color: "#fff",
                fontSize: 8.5,
                fontWeight: 600,
                lineHeight: 1,
              }}
            >
              {unseen > 9 ? "9+" : unseen}
            </span>
          )}
        </span>
        {tabsLen > 1 && <span style={{ color: "var(--faint)" }}>tab {active + 1}/{tabsLen}</span>}
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        <span>
          <span style={{ color: "var(--acd)" }}>⌘T</span> new tab
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>⌘D</span> split
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>⇥</span> accept
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>?</span> / <span style={{ color: "var(--acd)" }}>⌘↵</span> ask claude
        </span>
      </div>
    </div>
  );
}
