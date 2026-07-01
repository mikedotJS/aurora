// Bottom status bar: live cwd + git branch, merge-requests entry, tab counter,
// and keyboard hints.

import { useStore, activePane, activeWorkspace } from "../state/store";
import { shortenCwd } from "../lib/sys";
import { scriptsForRoot } from "../lib/scripts";
import { BranchChip } from "./BranchSwitcher";

export function StatusBar() {
  const home = useStore((s) => s.home);
  const pane = useStore((s) => activePane(s));
  const tabsLen = useStore((s) => activeWorkspace(s)?.tabs.length ?? 1);
  const active = useStore((s) => activeWorkspace(s)?.active ?? 0);
  const diff = useStore((s) => activeWorkspace(s)?.diff ?? null);
  const openPanel = useStore((s) => s.openPanel);
  const setPaneView = useStore((s) => s.setPaneView);
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
      <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "0 1 auto", minWidth: 0 }}>
        <span style={{ color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{cwd}</span>
        {branch && pane && (
          <>
            <BranchChip paneId={pane.id} cwd={pane.cwd} branch={branch} />
            <span
              onClick={() => openPanel("mr")}
              title="show open merge requests"
              style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}
            >
              <span style={{ color: "var(--acd)" }}>⇋</span>
              {mrs ? `${mrs.length} MRs` : "MRs"}
            </span>
          </>
        )}
        {/* Always-available door into the Changes view — the diff summary is only
            populated for the active workspace and only when the tree differs from
            base, so gating this on `diff` left committed / base-branch / inactive
            states with no way in. Shown whenever there's a pane; renders the ±
            counts when a summary exists, or a plain "Changes" label otherwise. */}
        {pane && (
          <span
            onClick={() => setPaneView(pane.id, "changes")}
            title="review changes (⌘G)"
            style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}
          >
            <span style={{ color: "var(--acd)" }}>⊟</span>
            {diff && diff.files > 0 ? (
              <>
                {diff.files} changed
                {diff.added > 0 && <span style={{ color: "var(--acd)" }}>+{diff.added}</span>}
                {diff.removed > 0 && <span style={{ color: "var(--err)" }}>−{diff.removed}</span>}
              </>
            ) : (
              "Changes"
            )}
          </span>
        )}
        {hasScripts && (
          <span
            onClick={() => openPanel("scripts")}
            title="run a script"
            style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}
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
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}
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
        {tabsLen > 1 && <span style={{ color: "var(--faint)", flexShrink: 0, whiteSpace: "nowrap" }}>tab {active + 1}/{tabsLen}</span>}
      </div>

      <div className="aurora-statusbar-hints" style={{ gap: 16, flex: "0 0 auto" }}>
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
