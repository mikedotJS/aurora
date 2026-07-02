// The workspace rail: durable, repo-grouped homes. Each card shows a status dot
// (git state), the issue/title, branch, a short status line and the diff counts
// (a door into the Changes view).

import { Fragment, memo, useState, useEffect } from "react";
import { useStore, activeWorkspace, type Workspace, type Script } from "../state/store";
import { worktreeSafety, worktreeList } from "../lib/worktree";
import { pathResolve } from "../lib/sys";
import { deleteWorkspace } from "../lib/teardown";
import { statusOf, dotColor, dotPulses, statusLine } from "../lib/workspace";
import { addRepoFromFolder } from "../lib/repo";
import { readOffset, parseDerivedPorts, portScripts, serverUnits } from "../lib/ports";
import { serversUp, runServers, stopServers } from "../lib/servers";

// --- Components ---

export function StatusDot({ ws, size = 7 }: { ws: Workspace; size?: number }) {
  const status = statusOf(ws);
  const color = dotColor(status);
  return (
    <span
      style={{
        flex: "0 0 auto",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: status === "idle" ? "none" : `0 0 7px ${color}`,
        animation: dotPulses(status) ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

// Memoized: WorkspaceRail subscribes to the whole `workspaces` array and re-renders
// on every store mutation (including each terminal output chunk). `patchPane` only
// rebuilds the workspace object that owns the changed pane; every other workspace
// keeps its reference. So this memo lets the cards of unaffected workspaces skip
// re-rendering on each chunk — only the active/streaming workspace's card updates.
// Props are `ws` (a stable reference until that workspace is patched) and `active`
// (a boolean), so the default shallow compare is correct.
const WorkspaceCard = memo(function WorkspaceCard({ ws, active }: { ws: Workspace; active: boolean }) {
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const openChanges = useStore((s) => s.openChanges);
  const line = statusLine(ws);
  const offset = readOffset(ws.env);
  const showPortChip = Number.isFinite(offset);

  // Total workspaces; used to hide trash on the last one.
  const workspaceCount = useStore((s) => s.workspaces.length);

  // Sync guess as initial value (correct in the common case); updated async via the git
  // worktree registry to handle symlinked paths (e.g. /tmp → /private/tmp on macOS) where
  // string comparison `ws.dir !== ws.repoId` is unreliable.
  const [worktreeBacked, setWorktreeBacked] = useState(
    () => ws.repoId != null && ws.dir !== ws.repoId,
  );

  useEffect(() => {
    if (!ws.repoId || ws.dir === ws.repoId) {
      setWorktreeBacked(false);
      return;
    }
    let cancelled = false;
    Promise.all([worktreeList(ws.repoId), pathResolve(ws.dir)])
      .then(([list, resolvedDir]) => {
        if (cancelled) return;
        // list[0] is always the main checkout; secondary worktrees start at index 1.
        setWorktreeBacked(list.slice(1).some((wt) => wt.path === resolvedDir));
      })
      .catch(() => {
        // Keep the sync guess on error — teardown.ts re-verifies at delete time.
      });
    return () => {
      cancelled = true;
    };
  }, [ws.repoId, ws.dir]);

  const isLast = workspaceCount <= 1;
  // Teardown is destructive (it removes a git worktree), so the trash rides only
  // on worktree-backed cards — never the repo's main checkout or a manual lane.
  // `ws.kind !== "home"` is belt-and-suspenders: Home's `repoId: null` already
  // keeps `worktreeBacked` false, but the explicit check makes the "Home is
  // permanent" invariant independent of that derivation.
  const showTrash = worktreeBacked && !isLast && ws.kind !== "home";

  const showChanges = (e: React.MouseEvent) => {
    e.stopPropagation();
    switchWorkspace(ws.id);
    // openChanges targets the (now) active workspace we just switched to.
    openChanges();
  };

  // handleDelete is only reachable when showTrash (= worktreeBacked && !isLast) is true,
  // so worktreeBacked is always true here. The else "Close workspace" branch is removed (M4 —
  // closing manual lanes is deferred to a later change).
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();

    let msg =
      `Delete workspace "${ws.title}"${ws.branch ? ` (${ws.branch})` : ""}?\n\n` +
      `This removes its worktree and stops any servers it's running.\n` +
      `The branch${ws.branch ? ` "${ws.branch}"` : ""} is kept — your commits stay in the repo.`;
    try {
      const s = await worktreeSafety(ws.dir);
      if (s.dirty) msg += "\n\n⚠ Uncommitted changes in the worktree will be lost.";
      if (s.ahead > 0) {
        const one = s.ahead === 1;
        msg += `\n⚠ ${s.ahead} commit${one ? "" : "s"} on this branch ${one ? "isn't" : "aren't"} pushed yet — ${one ? "it stays" : "they stay"} only on this machine.`;
      }
    } catch {
      // safety check is best-effort; proceed without it
    }
    const confirmed = window.confirm(msg);
    if (!confirmed) return;

    const result = await deleteWorkspace(ws.id);
    if (!result.ok) {
      useStore.getState().notify({
        color: "var(--err)",
        icon: "✕",
        headline: "Delete failed",
        sub: result.error,
        repo: ws.repoId ?? "",
      });
    }
  };

  return (
    <div
      className="aurora-ws-card"
      onClick={() => switchWorkspace(ws.id)}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "9px 11px 9px 13px",
        margin: "4px 8px",
        borderRadius: 9,
        overflow: "hidden",
        cursor: active ? "default" : "pointer",
        background: active ? "var(--win)" : "transparent",
        border: `1px solid ${active ? "color-mix(in oklab, var(--ac) 32%, var(--line))" : "var(--line)"}`,
        boxShadow: active ? "0 0 18px -10px var(--ac)" : "none",
      }}
    >
      {showTrash && (
        <button
          type="button"
          className="aurora-ws-trash"
          onClick={handleDelete}
          title={`Delete workspace "${ws.title}"`}
          aria-label={`Delete workspace ${ws.title}`}
        >
          <TrashIcon />
        </button>
      )}
      {active && (
        <span
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: 2,
            background: "var(--ac)",
            boxShadow: "0 0 8px var(--ac)",
          }}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <StatusDot ws={ws} />
        {ws.issueKey && (
          <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--acd)", flex: "0 0 auto" }}>
            {ws.issueKey}
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--sans)",
            fontSize: 12,
            color: active ? "var(--fg)" : "var(--dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {ws.title}
        </span>
      </div>
      {ws.branch && (
        <div
          style={{
            fontSize: 11,
            color: active ? "var(--dim)" : "var(--faint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ⎇ {ws.branch}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--sans)", fontSize: 10, minWidth: 0 }}>
        <span style={{ color: line.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{line.text}</span>
        {ws.diff && (ws.diff.added > 0 || ws.diff.removed > 0) && (
          <span
            onClick={showChanges}
            title="review changes"
            style={{ marginLeft: "auto", display: "inline-flex", gap: 6, cursor: "pointer", flexShrink: 0 }}
          >
            <span style={{ color: "var(--acd)" }}>+{ws.diff.added}</span>
            <span style={{ color: "var(--err)" }}>−{ws.diff.removed}</span>
          </span>
        )}
        {ws.jiraStatus && (
          <span
            style={{
              marginLeft: ws.diff ? 0 : "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              whiteSpace: "nowrap",
              color: "var(--jira)",
              border: "1px solid color-mix(in oklab, var(--jira) 32%, var(--line))",
              borderRadius: 4,
              padding: "0 5px",
            }}
          >
            ◐ {ws.jiraStatus}
          </span>
        )}
        {showPortChip && (
          <span
            className="aurora-ws-port-chip"
            title={`Port offset: +${offset}`}
            style={{
              marginLeft: !ws.diff && !ws.jiraStatus ? "auto" : 0,
              display: "inline-flex",
              alignItems: "center",
              flexShrink: 0,
              fontFamily: "var(--mono)",
              fontSize: 9.5,
              lineHeight: 1,
              letterSpacing: "0.01em",
              color: "var(--acd)",
              background: "color-mix(in oklab, var(--ac) 8%, transparent)",
              border: "1px solid color-mix(in oklab, var(--acd) 30%, var(--line))",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            <span style={{ color: "var(--faint)" }}>+</span>
            <span style={{ color: "var(--ac)" }}>{offset}</span>
          </span>
        )}
      </div>
    </div>
  );
});

// Equal-size centered box; SVG icons (below) are geometrically centered on their
// viewBox, so the gear and + align exactly — unlike text glyphs (⚙ sits low).
const railIconBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  lineHeight: 0,
  borderRadius: 4,
  cursor: "pointer",
} as const;

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// A socket/jack glyph — the shared mark for port isolation. Leads the port
// readout the way ◐ leads the Jira chip and ⚡ the preset chip.
function PortIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <line x1="9" y1="10.5" x2="9" y2="13.5" />
      <line x1="15" y1="10.5" x2="15" y2="13.5" />
    </svg>
  );
}

// Transport glyphs for the Run/Stop server toggle. Filled — unlike the outline
// Port/Gear/Trash marks — so the control you press reads as an action, not meta.
// Both sit centered on the 24 viewBox so the triangle and square align like the
// other rail SVGs.
function PlayIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M8 5l11 7-11 7z" />
    </svg>
  );
}

function StopIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

function RepoHeader({
  name,
  count,
  onNew,
  onSettings,
}: {
  name: string;
  count: number;
  onNew: () => void;
  onSettings?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "11px 12px 5px 13px",
        fontFamily: "var(--sans)",
        fontSize: 10.5,
        letterSpacing: ".04em",
        color: "var(--faint)",
      }}
    >
      <span style={{ color: "var(--dim)", fontSize: 9 }}>▾</span>
      <span style={{ color: "var(--acd)" }}>⇋</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto" }}>
        <span style={{ color: "var(--faint)", marginRight: 2 }}>{count}</span>
        {onSettings && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onSettings();
            }}
            title="repo settings"
            style={{ ...railIconBtn, color: "var(--faint)" }}
          >
            <GearIcon />
          </span>
        )}
        <span
          onClick={(e) => {
            e.stopPropagation();
            onNew();
          }}
          title="new workspace in this repo"
          style={{ ...railIconBtn, color: "var(--dim)" }}
        >
          <PlusIcon />
        </span>
      </span>
    </div>
  );
}

export function WorkspaceRail() {
  const workspaces = useStore((s) => s.workspaces);
  const repos = useStore((s) => s.repos);
  const activeWs = useStore((s) => s.activeWs);
  const filter = useStore((s) => s.wsFilter);
  const setWsFilter = useStore((s) => s.setWsFilter);
  const setRailCollapsed = useStore((s) => s.setRailCollapsed);
  const openCommand = useStore((s) => s.openCommand);
  const openWorkspaceSettings = useStore((s) => s.openWorkspaceSettings);

  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const onAddRepo = async () => {
    if (addBusy) return;
    setAddBusy(true);
    setAddError(null);
    const res = await addRepoFromFolder();
    if ("ok" in res && !res.ok) setAddError(res.error);
    setAddBusy(false);
  };

  const q = filter.trim().toLowerCase();
  const match = (w: Workspace) =>
    !q ||
    [w.issueKey, w.title, w.branch].some((x) => x?.toLowerCase().includes(q));
  const hasRepos = repos.length > 0;
  // Home is not a workspace or a repo conceptually: excluded from every group
  // (repo groups and the `local` bucket). It lives in the TitleBar as its own
  // top-level entry, decoupled from the Workspaces zone entirely.
  const shown = workspaces.filter((w) => w.kind !== "home" && match(w));

  // group: every known repo in order (shown even with no workspaces, so a repo
  // added by folder appears), then a "local" bucket for manual lanes. While
  // filtering, drop repos with no matching workspaces.
  const groups: { key: string; name: string; items: Workspace[] }[] = [];
  for (const r of repos) {
    const items = shown.filter((w) => w.repoId === r.id);
    if (items.length || !q) groups.push({ key: r.id, name: r.name, items });
  }
  const manual = shown.filter((w) => !w.repoId);
  if (manual.length) groups.push({ key: "__local", name: "local", items: manual });

  return (
    <div
      style={{
        flex: "0 0 clamp(208px, 22vw, 280px)",
        display: "flex",
        flexDirection: "column",
        background: "var(--page)",
        borderRight: "1px solid var(--line)",
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 10px 11px 14px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--sans)",
            fontSize: 11,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "var(--dim)",
          }}
        >
          Workspaces
        </span>
        <span
          style={{
            fontFamily: "var(--sans)",
            fontSize: 9.5,
            color: "var(--faint)",
            border: "1px solid var(--line)",
            borderRadius: 5,
            padding: "1px 5px",
          }}
        >
          {workspaces.filter((w) => w.kind !== "home").length}
        </span>
        <span
          onClick={() => setRailCollapsed(true)}
          title="collapse rail (⌘B)"
          style={{
            // right-aligned now that the global gear moved into each repo header
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 6,
            color: "var(--faint)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ‹
        </span>
      </div>

      <div style={{ flex: "0 0 auto", padding: "9px 10px", borderBottom: "1px solid var(--line)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--win)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "6px 9px",
          }}
        >
          <span style={{ color: "var(--faint)", fontSize: 12 }}>⌕</span>
          <input
            value={filter}
            onChange={(e) => setWsFilter(e.target.value)}
            placeholder="Filter…"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--fg)",
              fontFamily: "var(--sans)",
              fontSize: 11.5,
              padding: 0,
            }}
          />
          <span
            style={{
              fontFamily: "var(--sans)",
              fontSize: 10,
              color: "var(--faint)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            ⌘K
          </span>
        </div>
      </div>

      <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "7px 0 10px", minHeight: 0 }}>
        {groups.length === 0 &&
          (q ? (
            <div className="aurora-rail-nomatch">no workspace matches "{filter.trim()}"</div>
          ) : (
            // Reachable only with zero known repos: every known repo always gets
            // its own group entry (pushed unconditionally outside a filter — see
            // the groups loop above), so groups.length > 0 whenever repos.length
            // > 0. The "repos exist, create a workspace" case is instead covered
            // by each repo group's own header ⊕ / empty-row affordance below.
            //
            // The onboarding *is* the primary CTA here — the app's single gesture
            // in the zero-repo state is "Add repository" (a workspace can't exist
            // without one). It's wired to the same `onAddRepo` handler the footer
            // uses; when the rail is empty the footer is hidden (see `hasRepos &&`
            // below) so there's never a duplicate "Add repository" control.
            <div className="aurora-rail-empty">
              <div className="aurora-rail-empty-title">Start with a repository</div>
              <button
                type="button"
                className="aurora-empty-primary aurora-rail-empty-cta"
                onClick={onAddRepo}
                disabled={addBusy}
                title="add an existing repository folder"
                aria-label="Add repository"
              >
                <span className="aurora-rail-empty-plus" aria-hidden>
                  ⇋
                </span>
                {addBusy ? "Opening…" : "Add repository"}
              </button>
              {addError ? (
                <div className="aurora-rail-empty-error" role="alert">
                  {addError}
                </div>
              ) : (
                <div className="aurora-rail-empty-hint">
                  <span className="aurora-rail-empty-hash" aria-hidden>
                    #
                  </span>
                  the ~ shell is always one click away
                </div>
              )}
            </div>
          ))}
        {groups.map((g) => {
          const repoId = g.key === "__local" ? undefined : g.key;
          return (
            <div key={g.key}>
              <RepoHeader
                name={g.name}
                count={g.items.length}
                onNew={() => openCommand(repoId)}
                onSettings={repoId ? () => openWorkspaceSettings(repoId) : undefined}
              />
              {g.items.length === 0 ? (
                <div
                  onClick={() => openCommand(repoId)}
                  style={{
                    margin: "2px 8px 7px",
                    padding: "9px 11px",
                    borderRadius: 9,
                    border: "1px dashed var(--line)",
                    cursor: "pointer",
                    fontFamily: "var(--sans)",
                    fontSize: 11,
                    color: "var(--faint)",
                  }}
                >
                  + New workspace in {g.name}
                </div>
              ) : (
                g.items.map((w) => <WorkspaceCard key={w.id} ws={w} active={w.id === activeWs} />)
              )}
            </div>
          );
        })}
      </div>

      {/* Footer "Add repository" — the quiet, always-there control once at least
          one repo exists. Hidden in the zero-repo state, where the onboarding
          block above owns the (single) primary "Add repository" CTA instead, so
          the two never compete. Both share `onAddRepo` / `addBusy` / `addError`,
          but carry distinct title/aria-label ("add another…") so an automated
          query (or a screen reader) never conflates the two controls. */}
      {hasRepos && (
        <div style={{ flex: "0 0 auto", padding: "9px 10px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 7 }}>
          <button
            type="button"
            onClick={onAddRepo}
            disabled={addBusy}
            title="add another repository folder"
            aria-label="Add another repository"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              width: "100%",
              fontFamily: "var(--sans)",
              fontSize: 11,
              color: "var(--dim)",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 7,
              cursor: addBusy ? "default" : "pointer",
              opacity: addBusy ? 0.6 : 1,
            }}
          >
            <span style={{ color: "var(--acd)" }}>⇋</span>
            {addBusy ? "Opening…" : "Add repository"}
          </button>
          {addError && (
            <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--err)", lineHeight: 1.35, padding: "0 2px" }}>
              {addError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Stable empty-scripts reference. Returning a fresh `[]` from the selector
    below would change identity on every render, so Zustand's getSnapshot is
    never cached and React spins into an infinite re-render loop ("Maximum update
    depth exceeded") — the black-screen crash on a repoId-less / script-less lane. */
const EMPTY_SCRIPTS: Script[] = [];

/** The context bar above the tab strip — branch · seed · preset · port. */
export function WorkspaceContextBar() {
  const ws = useStore(activeWorkspace);
  // Hooks must run before early returns.
  const repoId = ws?.repoId ?? null;
  const scripts = useStore((s): Script[] =>
    repoId ? (s.userScripts[repoId]?.scripts ?? EMPTY_SCRIPTS) : EMPTY_SCRIPTS,
  );
  // Runtime-only liveness map (D3 revised) — must be before early returns.
  const serverStatus = useStore((s) => s.serverStatus);

  if (!ws) return null;

  const offset = readOffset(ws.env);
  const hasOffset = Number.isFinite(offset);

  // Show the bar whenever there's meaningful meta: issue, preset, or an offset.
  if (!ws.issueKey && !ws.preset && !hasOffset) return null;

  // Derive concrete ports from generated scripts when possible — never fabricate.
  const derivedPorts = hasOffset ? parseDerivedPorts(scripts, offset) : [];

  // Server toggle: visibility = at least one port-script exists; count = number of
  // server units (honoring split: split script → 1 pane per task, concurrent).
  // serverStatus feeds the revised D3 liveness check (alive/capturing → up, dead → down).
  const servers = portScripts(scripts);
  const units = serverUnits(scripts);
  const up = serversUp(ws, serverStatus);

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px",
        background: "color-mix(in oklab, var(--ac) 5%, var(--page))",
        borderBottom: "1px solid var(--line)",
        fontFamily: "var(--sans)",
        fontSize: 11,
        color: "var(--dim)",
        minWidth: 0,
      }}
    >
      {ws.branch && (
        <span
          title={ws.branch}
          style={{
            color: "var(--acd)",
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ⎇ {ws.branch}
        </span>
      )}
      {ws.issueKey && (
        <>
          <span style={{ color: "var(--faint)", flex: "0 0 auto" }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "0 0 auto", whiteSpace: "nowrap" }}>
            seeded from <span style={{ color: "var(--jira)" }}>{ws.issueKey}</span>
          </span>
        </>
      )}
      {ws.jiraStatus && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            flex: "0 0 auto",
            whiteSpace: "nowrap",
            color: "var(--jira)",
            border: "1px solid color-mix(in oklab, var(--jira) 32%, var(--line))",
            borderRadius: 4,
            padding: "0 6px",
          }}
        >
          ◐ {ws.jiraStatus}
        </span>
      )}
      {ws.preset && (
        <>
          <span style={{ color: "var(--faint)", flex: "0 0 auto" }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "0 1 auto", minWidth: 0 }}>
            <span style={{ color: "var(--ac)", flex: "0 0 auto" }}>⚡</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              preset: {ws.preset}
            </span>
          </span>
        </>
      )}
      {hasOffset && (
        <>
          {/* Dot separator: pinned, never scrolls */}
          <span style={{ color: "var(--faint)", flex: "0 0 auto" }}>·</span>
          {/* Port chips: scroll horizontally when they overflow the bar.
              The pill keeps its internal nowrap; only this wrapper scrolls. */}
          <div
            className="ascroll-x"
            style={{ flex: "1 1 auto", minWidth: 0, overflowX: "auto", overflowY: "hidden" }}
          >
            {derivedPorts.length > 0 ? (
              <span
                className="aurora-ws-ports"
                title="Ports these scripts will bind in this workspace"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "2px 9px",
                  borderRadius: 6,
                  whiteSpace: "nowrap",
                  color: "var(--acd)",
                  background: "color-mix(in oklab, var(--ac) 9%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--acd) 30%, var(--line))",
                }}
              >
                <PortIcon size={11} />
                {derivedPorts.map(({ label, port }, i) => (
                  <Fragment key={port}>
                    {i > 0 && <span style={{ color: "var(--faint)" }}>·</span>}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontFamily: "var(--sans)", fontSize: 10, color: "var(--dim)", letterSpacing: "0.01em" }}>
                        {label}
                      </span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--ac)" }}>
                        <span style={{ color: "var(--acd)" }}>:</span>
                        {port}
                      </span>
                    </span>
                  </Fragment>
                ))}
              </span>
            ) : (
              <span
                className="aurora-ws-offset"
                title={`Port offset: +${offset}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "2px 8px",
                  borderRadius: 6,
                  color: "var(--faint)",
                  border: "1px solid color-mix(in oklab, var(--acd) 18%, var(--line))",
                }}
              >
                <PortIcon size={11} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1, color: "var(--acd)" }}>
                  <span style={{ color: "var(--faint)" }}>+</span>
                  {offset}
                </span>
                <span style={{ fontFamily: "var(--sans)", fontSize: 10, color: "var(--faint)" }}>offset</span>
              </span>
            )}
          </div>
          {/* Run/Stop toggle: pinned outside the scroll region, always reachable. */}
          {servers.length > 0 && (
            <button
              type="button"
              className={`aurora-ws-runtoggle${up ? " aurora-ws-runtoggle--up" : ""}`}
              aria-label={up ? "Stop servers" : "Run servers"}
              title={`${up ? "Stop" : "Run"} ${units.length} server${units.length !== 1 ? "s" : ""}`}
              style={{ flex: "0 0 auto" }}
              onClick={() => {
                (up ? stopServers(ws.id) : runServers(ws.id)).catch((e: unknown) => {
                  useStore.getState().notify({
                    color: "var(--err)",
                    icon: "⚡",
                    headline: up ? "Stop servers failed" : "Run servers failed",
                    sub: e instanceof Error ? e.message : String(e),
                    repo: ws.repoId ?? "",
                  });
                });
              }}
            >
              <span className="aurora-ws-runtoggle__icon" aria-hidden>
                {up ? <StopIcon /> : <PlayIcon />}
              </span>
              {up ? "Stop" : "Run"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
