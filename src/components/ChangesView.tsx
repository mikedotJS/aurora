// The in-app Changes view: a staged/unstaged file list against the workspace's
// base branch, a unified/split diff pane, per-file stage/discard + stage-all, and
// an Open-MR handoff. Rendered in a pane when its view mode is "changes".

import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";
import {
  gitChangedFiles,
  gitDiffFile,
  gitStage,
  gitUnstage,
  gitStageAll,
  gitDiscard,
  glabMrCreate,
  type ChangedFile,
} from "../lib/git";
import { gitStatusSummary } from "../lib/sys";
import { parseUnifiedDiff } from "../lib/diff";
import { UnifiedDiff, SplitDiff } from "./Diff";

const STATUS: Record<string, { label: string; color: string }> = {
  A: { label: "A", color: "var(--ok)" },
  M: { label: "M", color: "var(--warn)" },
  D: { label: "D", color: "var(--err)" },
  R: { label: "R", color: "var(--acd)" },
  C: { label: "C", color: "var(--acd)" },
  "?": { label: "?", color: "var(--faint)" },
};

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}
function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
const fileKey = (f: ChangedFile) => `${f.staged ? "s" : "u"}:${f.path}`;

export function ChangesView({ wsId }: { wsId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === wsId));
  const closeChanges = useStore((s) => s.closeChanges);
  const setWsDiff = useStore((s) => s.setWsDiff);

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [diffText, setDiffText] = useState("");
  const [mrBusy, setMrBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const dir = ws?.dir ?? "";
  const base = ws?.baseBranch ?? "";
  const branch = ws?.branch ?? "";

  // Depend on primitives only — `setWsDiff` re-allocates the workspace object on
  // every call, so depending on `ws` here would re-fire this effect forever.
  const reload = useMemo(
    () => async () => {
      if (!dir) return;
      const list = await gitChangedFiles(dir);
      setFiles(list);
      setSelKey((k) => (k && list.some((f) => fileKey(f) === k) ? k : list.length ? fileKey(list[0]) : null));
      // keep the rail/status counter in sync
      const sum = await gitStatusSummary(dir, base);
      if (sum && wsId) setWsDiff(wsId, sum);
    },
    [dir, base, wsId, setWsDiff],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = files.find((f) => fileKey(f) === selKey) ?? null;

  useEffect(() => {
    if (!selected || !dir) {
      setDiffText("");
      return;
    }
    const m = selected.status === "?" ? "worktree" : selected.staged ? "staged" : "worktree";
    let alive = true;
    gitDiffFile(dir, base, selected.path, m).then((t) => {
      if (alive) setDiffText(t);
    });
    return () => {
      alive = false;
    };
  }, [selKey, selected, dir, base]);

  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);
  const totalAdded = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const totalRemoved = files.reduce((n, f) => n + (f.removed ?? 0), 0);

  const parsed = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  const onStage = async (f: ChangedFile) => {
    const movedKey = `${f.staged ? "u" : "s"}:${f.path}`;
    if (f.staged) await gitUnstage(dir, f.path);
    else await gitStage(dir, f.path);
    await reload();
    // follow the file to its new (staged/unstaged) section rather than jumping away
    setSelKey((k) => (k === movedKey ? k : movedKey));
  };
  const onDiscard = async (f: ChangedFile) => {
    const ok = window.confirm(`Discard changes to ${f.path}? This can't be undone.`);
    if (!ok) return;
    await gitDiscard(dir, f.path, f.status === "?");
    await reload();
  };
  const onStageAll = async () => {
    await gitStageAll(dir);
    await reload();
  };
  const onOpenMr = async () => {
    if (ws?.mr?.url) return void openUrl(ws.mr.url);
    if (!branch) return;
    setMrBusy(true);
    const res = await glabMrCreate(dir, branch);
    setMrBusy(false);
    if (!res.ok) setToast(res.error.includes("not-found") ? "GitLab CLI (glab) not found." : res.error);
  };

  const Row = ({ f }: { f: ChangedFile }) => {
    const st = STATUS[f.status] ?? STATUS["M"];
    const active = fileKey(f) === selKey;
    return (
      <div
        onClick={() => setSelKey(fileKey(f))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px 5px 8px",
          borderRadius: 6,
          cursor: "pointer",
          borderLeft: `2px solid ${active ? "var(--ac)" : "transparent"}`,
          background: active ? "color-mix(in oklab, var(--ac) 12%, transparent)" : "transparent",
        }}
      >
        <span style={{ flex: "0 0 auto", width: 12, textAlign: "center", color: st.color, fontFamily: "var(--mono)", fontSize: 11 }}>
          {st.label}
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: active ? "var(--fg)" : "var(--dim)" }}>
          {baseOf(f.path)}
          {dirOf(f.path) && <span style={{ color: "var(--faint)", marginLeft: 6, fontSize: 11 }}>{dirOf(f.path)}</span>}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 5, fontSize: 10.5, fontFamily: "var(--mono)" }}>
          {f.added ? <span style={{ color: "var(--ok)" }}>+{f.added}</span> : null}
          {f.removed ? <span style={{ color: "var(--err)" }}>−{f.removed}</span> : null}
        </span>
      </div>
    );
  };

  return (
    // zIndex 5 keeps this above the xterm overlay (z-index 2 while a full-screen
    // program runs) and the "interactive" badge (z-index 3), so the Changes view
    // is fully visible even when the pane's terminal is in rawMode.
    <div style={{ position: "absolute", inset: 0, zIndex: 5, display: "flex", background: "var(--win)" }}>
      {/* files list */}
      <div style={{ flex: "0 0 230px", display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)", minWidth: 0 }}>
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--line)", fontFamily: "var(--sans)" }}>
          <span style={{ fontSize: 11, color: "var(--dim)" }}>Changes</span>
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>
            {base ? (
              <>against <span style={{ color: "var(--acd)" }}>⎇ {base}</span></>
            ) : (
              <span style={{ color: "var(--acd)" }}>working tree</span>
            )}
          </span>
          <span onClick={() => closeChanges()} title="close (Esc)" style={{ cursor: "pointer", color: "var(--faint)", fontSize: 13 }}>
            ⌗
          </span>
        </div>
        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "6px 6px 10px", minHeight: 0 }}>
          {files.length === 0 && (
            <div style={{ padding: "18px 12px", textAlign: "center", fontFamily: "var(--sans)", fontSize: 12, color: "var(--faint)" }}>
              {base ? `no changes against ${base}` : "no uncommitted changes"}
            </div>
          )}
          {staged.length > 0 && (
            <div style={{ padding: "6px 8px 3px", fontFamily: "var(--sans)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--faint)" }}>
              Staged · {staged.length}
            </div>
          )}
          {staged.map((f) => (
            <Row key={fileKey(f)} f={f} />
          ))}
          {unstaged.length > 0 && (
            <div style={{ padding: "8px 8px 3px", fontFamily: "var(--sans)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--faint)" }}>
              Changes · {unstaged.length}
            </div>
          )}
          {unstaged.map((f) => (
            <Row key={fileKey(f)} f={f} />
          ))}
        </div>
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--line)", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} · <span style={{ color: "var(--ok)" }}>+{totalAdded}</span>{" "}
            <span style={{ color: "var(--err)" }}>−{totalRemoved}</span>
          </span>
          {unstaged.length > 0 && (
            <span onClick={onStageAll} style={{ marginLeft: "auto", color: "var(--acd)", cursor: "pointer" }}>
              Stage all
            </span>
          )}
        </div>
      </div>

      {/* diff pane */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {selected ? (
          <>
            <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--line)", fontFamily: "var(--sans)", fontSize: 11.5 }}>
              <span style={{ color: (STATUS[selected.status] ?? STATUS.M).color, fontFamily: "var(--mono)" }}>{(STATUS[selected.status] ?? STATUS.M).label}</span>
              <span style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.path}</span>
              <span style={{ display: "flex", gap: 5, fontFamily: "var(--mono)", fontSize: 11 }}>
                {selected.added ? <span style={{ color: "var(--ok)" }}>+{selected.added}</span> : null}
                {selected.removed ? <span style={{ color: "var(--err)" }}>−{selected.removed}</span> : null}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                <Toggle on={mode === "unified"} onClick={() => setMode("unified")}>
                  Unified
                </Toggle>
                <Toggle on={mode === "split"} onClick={() => setMode("split")}>
                  Split
                </Toggle>
                <span onClick={() => onStage(selected)} style={{ marginLeft: 8, color: "var(--acd)", cursor: "pointer" }}>
                  {selected.staged ? "Unstage" : "Stage"}
                </span>
                <span onClick={() => onDiscard(selected)} style={{ color: "var(--err)", cursor: "pointer" }}>
                  Discard
                </span>
              </div>
            </div>
            {mode === "split" && (
              <div style={{ flex: "0 0 auto", display: "flex", fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)", borderBottom: "1px solid var(--line)" }}>
                <span style={{ flex: 1, padding: "4px 12px", color: "var(--err)", borderRight: "1px solid var(--line)" }}>⎇ {base || "HEAD"} · base</span>
                <span style={{ flex: 1, padding: "4px 12px", color: "var(--ok)" }}>⎇ {branch || "working"} · working tree</span>
              </div>
            )}
            <div className="ascroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
              {parsed.binary ? (
                <div style={{ padding: 20, fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--faint)" }}>Binary file — no text diff.</div>
              ) : parsed.hunks.length === 0 ? (
                <div style={{ padding: 20, fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--faint)" }}>
                  {selected.status === "?" ? "Untracked file — stage it to see its diff." : "No textual changes."}
                </div>
              ) : mode === "unified" ? (
                <UnifiedDiff hunks={parsed.hunks} />
              ) : (
                <SplitDiff hunks={parsed.hunks} />
              )}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--sans)", fontSize: 13, color: "var(--faint)" }}>
            select a file to view its diff
          </div>
        )}
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderTop: "1px solid var(--line)", fontFamily: "var(--sans)", fontSize: 11 }}>
          {toast && <span style={{ color: "var(--warn-d)" }}>{toast}</span>}
          <span
            onClick={onOpenMr}
            title="open or create a merge request"
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--page)",
              background: "var(--ac)",
              borderRadius: 7,
              padding: "5px 13px",
              fontWeight: 500,
              cursor: mrBusy ? "default" : "pointer",
              opacity: mrBusy ? 0.6 : 1,
              boxShadow: "0 0 20px -8px var(--ac)",
            }}
          >
            ⇋ {ws?.mr ? "Open MR" : mrBusy ? "Opening…" : "Open MR"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <span
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: "3px 9px",
        borderRadius: 6,
        cursor: "pointer",
        color: on ? "var(--page)" : "var(--dim)",
        background: on ? "var(--ac)" : "transparent",
        border: `1px solid ${on ? "var(--ac)" : "var(--line)"}`,
      }}
    >
      {children}
    </span>
  );
}
