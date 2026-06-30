// The collapsed-rail switcher: a title-bar pill that opens a grouped dropdown of
// workspaces (filter, ↑↓, ↵, ⌘1–9, click). Mirrors the rail; reuses the
// BranchSwitcher popover look. ⌘1–9 work here because the focused input means the
// global keymap defers to this control.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, activeWorkspace, type Workspace } from "../state/store";
import { StatusDot } from "./WorkspaceRail";

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const active = useStore(activeWorkspace);
  const setRailCollapsed = useStore((s) => s.setRailCollapsed);

  return (
    <span style={{ position: "relative", display: "inline-flex", WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <span
        onClick={() => setOpen((v) => !v)}
        title="switch workspace"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--sans)",
          fontSize: 11.5,
          color: "var(--fg)",
          background: "var(--win)",
          border: "1px solid color-mix(in oklab, var(--ac) 30%, var(--line))",
          borderRadius: 7,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        {active ? <StatusDot ws={active} size={6} /> : null}
        <span style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active ? (active.issueKey ? `${active.issueKey} · ${active.title}` : active.title) : "no workspace"}
        </span>
        <span style={{ color: "var(--faint)", fontSize: 10 }}>▾</span>
      </span>
      <span
        onClick={() => setRailCollapsed(false)}
        title="show rail (⌘B)"
        style={{ marginLeft: 6, color: "var(--faint)", cursor: "pointer", fontSize: 13 }}
      >
        ›
      </span>
      {open && <SwitcherDropdown onClose={() => setOpen(false)} />}
    </span>
  );
}

function SwitcherDropdown({ onClose }: { onClose: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const repos = useStore((s) => s.repos);
  const activeWs = useStore((s) => s.activeWs);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const openCommand = useStore((s) => s.openCommand);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const list = workspaces.filter(
    (w) => !q || [w.issueKey, w.title, w.branch].some((x) => x?.toLowerCase().includes(q)),
  );
  const clamped = Math.min(sel, Math.max(0, list.length - 1));

  useLayoutEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [clamped, list.length]);

  const choose = (w: Workspace | undefined) => {
    if (!w) return;
    switchWorkspace(w.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      choose(list[parseInt(e.key, 10) - 1]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(list[clamped]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // group for display, preserving the flat index for ⌘N + highlight
  const repoName = (id: string | null) => (id ? repos.find((r) => r.id === id)?.name ?? "local" : "local");
  let flat = -1;

  return (
    <>
      <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
      <div
        role="listbox"
        aria-label="Switch workspace"
        style={{
          position: "absolute",
          left: 0,
          top: 30,
          zIndex: 60,
          width: 340,
          maxHeight: "min(60vh, 420px)",
          display: "flex",
          flexDirection: "column",
          background: "color-mix(in oklab, var(--bar) 93%, transparent)",
          backdropFilter: "blur(14px) saturate(1.25)",
          WebkitBackdropFilter: "blur(14px) saturate(1.25)",
          border: "1px solid color-mix(in oklab, var(--ac) 28%, var(--line))",
          borderLeft: "2px solid var(--ac)",
          borderRadius: 11,
          boxShadow: "0 18px 48px -20px rgba(0,0,0,.82)",
          animation: "popIn .16s cubic-bezier(.2,.72,.2,1)",
          overflow: "hidden",
          fontFamily: "var(--mono)",
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            borderBottom: "1px solid color-mix(in oklab, var(--line) 65%, transparent)",
          }}
        >
          <span style={{ color: "var(--ac)", fontSize: 13 }}>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="find a workspace…"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--fg)",
              fontFamily: "var(--mono)",
              fontSize: 13,
              padding: 0,
            }}
          />
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "5px 5px 4px" }}>
          {list.length === 0 && (
            <div
              style={{ padding: "16px 12px", textAlign: "center", fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--faint)" }}
            >
              {query ? `no workspace matches “${query.trim()}”` : "no workspaces"}
            </div>
          )}
          {(() => {
            let lastRepo: string | null | undefined = undefined;
            return list.map((w) => {
              flat += 1;
              const idx = flat;
              const showHeader = w.repoId !== lastRepo;
              lastRepo = w.repoId;
              const isActive = idx === clamped;
              const isCurrent = w.id === activeWs;
              return (
                <div key={w.id}>
                  {showHeader && (
                    <div
                      style={{
                        padding: "6px 10px 4px",
                        fontFamily: "var(--sans)",
                        fontSize: 10,
                        letterSpacing: ".09em",
                        textTransform: "uppercase",
                        color: "var(--faint)",
                      }}
                    >
                      {repoName(w.repoId)}
                    </div>
                  )}
                  <div
                    ref={isActive ? activeRef : null}
                    onMouseEnter={() => setSel(idx)}
                    onClick={() => choose(w)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "7px 9px",
                      borderRadius: 7,
                      cursor: "pointer",
                      borderLeft: `2px solid ${isActive ? "var(--ac)" : "transparent"}`,
                      background: isActive ? "color-mix(in oklab, var(--ac) 13%, transparent)" : "transparent",
                    }}
                  >
                    <StatusDot ws={w} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "var(--sans)",
                        fontSize: 12.5,
                        color: isCurrent ? "var(--fg)" : "var(--dim)",
                      }}
                    >
                      {w.issueKey ? `${w.issueKey} · ${w.title}` : w.title}
                    </span>
                    {idx < 9 && (
                      <span style={{ fontFamily: "var(--sans)", fontSize: 10, color: "var(--acd)" }}>⌘{idx + 1}</span>
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>

        <div
          onClick={() => {
            onClose();
            openCommand();
          }}
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "4px 8px 9px",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px dashed var(--line)",
            fontFamily: "var(--sans)",
            fontSize: 12,
            color: "var(--acd)",
            cursor: "pointer",
          }}
        >
          <span>+</span>New workspace
          <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 11 }}>⌘K</span>
        </div>
      </div>
    </>
  );
}
