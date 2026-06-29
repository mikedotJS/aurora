// GitLab merge-requests bottom sheet. Reads the poller's cached MR list (instant)
// and force-refreshes on open. A search field + a "mine" toggle filter the list
// client-side. ↑↓ select (within the filtered list), ↵ open in browser,
// ⌘M toggle mine, esc close.

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore, activePane, type GitlabMr } from "../state/store";
import { refreshRepoMrs, ensureGlabUser } from "../lib/notifications";
import { shortenCwd } from "../lib/sys";

function matches(mr: GitlabMr, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const iid = String(mr.iid);
  return (
    mr.title.toLowerCase().includes(needle) ||
    mr.branch.toLowerCase().includes(needle) ||
    mr.author.toLowerCase().includes(needle) ||
    iid.includes(needle) ||
    `!${iid}`.includes(needle)
  );
}

export function MrSheet() {
  const closePanel = useStore((s) => s.closePanel);
  const home = useStore((s) => s.home);
  const pane = useStore((s) => activePane(s));
  const repoMrs = useStore((s) => s.repoMrs);
  const glabUser = useStore((s) => s.glabUser);
  const root = pane?.repoRoot ?? null;
  const mrs = root ? repoMrs[root] : undefined;
  const [refreshed, setRefreshed] = useState(false);
  const [sel, setSel] = useState(0);
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);

  // Focus the search field, but only ONCE the slide-up animation has settled —
  // focusing mid-animation forces a synchronous layout in WKWebView that snaps
  // the sheet's transform and makes it visibly jump.
  const focusSearch = () => {
    if (focusedRef.current) return;
    focusedRef.current = true;
    searchRef.current?.focus({ preventScroll: true });
  };

  // Resolve the current glab user (for "mine") + force-refresh the MR cache.
  useEffect(() => {
    void ensureGlabUser(root);
    if (root) refreshRepoMrs(root).finally(() => setRefreshed(true));
    else setRefreshed(true);
    // Fallback in case animationend doesn't fire (e.g. reduced motion).
    const t = window.setTimeout(focusSearch, 320);
    return () => window.clearTimeout(t);
  }, [root]);

  const filtered = useMemo(() => {
    const items = mrs ?? [];
    return items.filter(
      (mr) => matches(mr, query) && (!mine || (!!glabUser && mr.author === glabUser)),
    );
  }, [mrs, query, mine, glabUser]);

  // Keep the selection inside the filtered list as filters change.
  useEffect(() => {
    setSel((i) => Math.min(Math.max(0, i), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const canMine = !!glabUser;

  // Navigation handled here (not a window listener) so it composes with the
  // focused search input — typing stays in the field, arrows/enter still work.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // The global handler ignores INPUT targets, so close from here while the
      // search field is focused.
      e.preventDefault();
      closePanel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const mr = filtered[sel];
      if (mr?.web_url) openUrl(mr.web_url);
    } else if (e.key === "m" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canMine) setMine((v) => !v);
    }
  };

  return (
    <>
      <div
        onClick={closePanel}
        style={{ position: "absolute", inset: "0 0 30px 0", zIndex: 50, background: "color-mix(in oklab, black 48%, transparent)", animation: "fadeIn .18s ease" }}
      />
      <div
        onKeyDown={onKey}
        onAnimationEnd={focusSearch}
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
            <span style={{ fontFamily: "var(--sans)", fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dim)", display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ color: "var(--acd)" }}>⇋</span>merge requests
              {root && <span style={{ color: "var(--faint)", textTransform: "none", letterSpacing: 0 }}>· {shortenCwd(root, home)}</span>}
            </span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
              <span style={{ color: "var(--acd)" }}>↑↓</span> select · <span style={{ color: "var(--acd)" }}>↵</span> open · <span style={{ color: "var(--acd)" }}>⌘M</span> mine · <span style={{ color: "var(--acd)" }}>esc</span> close
            </span>
            <span
              onClick={closePanel}
              style={{ cursor: "pointer", fontSize: 17, width: 21, height: 21, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, color: "var(--dim)", marginLeft: 12 }}
            >
              ×
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 11 }}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, branch, author, !iid…"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1,
                minWidth: 0,
                background: "var(--bg)",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "7px 11px",
                color: "var(--fg)",
                fontFamily: "var(--sans)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              onClick={() => canMine && setMine((v) => !v)}
              disabled={!canMine}
              title={canMine ? "Show only my merge requests (⌘M)" : "Current GitLab user unavailable — glab not installed or authed"}
              style={{
                flex: "0 0 auto",
                cursor: canMine ? "pointer" : "not-allowed",
                opacity: canMine ? 1 : 0.45,
                background: mine ? "color-mix(in oklab, var(--ac) 20%, transparent)" : "var(--bg)",
                border: `1px solid ${mine ? "color-mix(in oklab, var(--ac) 55%, var(--line))" : "var(--line)"}`,
                borderRadius: 8,
                padding: "7px 13px",
                color: mine ? "var(--ac)" : "var(--dim)",
                fontFamily: "var(--sans)",
                fontSize: 12,
                letterSpacing: ".02em",
              }}
            >
              mine
            </button>
          </div>
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "6px 0 10px" }}>
          {!root && <Empty>not a git repository</Empty>}
          {root && !mrs && !refreshed && <Empty>loading merge requests…</Empty>}
          {root && refreshed && (!mrs || mrs.length === 0) && (
            <Empty>no open merge requests — or glab isn’t installed / authed (`glab auth login`)</Empty>
          )}
          {root && refreshed && mrs && mrs.length > 0 && filtered.length === 0 && (
            <Empty>{mine ? "none of your merge requests match" : "no merge requests match your search"}</Empty>
          )}
          {filtered.map((mr, i) => (
            <div
              key={mr.iid}
              onMouseEnter={() => setSel(i)}
              onClick={() => mr.web_url && openUrl(mr.web_url)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 11,
                padding: "11px 15px 11px 17px",
                cursor: "pointer",
                borderBottom: "1px solid color-mix(in oklab, var(--line) 50%, transparent)",
                borderLeft: `2px solid ${i === sel ? "var(--ac)" : "transparent"}`,
                background: i === sel ? "color-mix(in oklab, var(--ac) 11%, transparent)" : "transparent",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                  <span style={{ color: "var(--ac)", fontSize: 13, flex: "0 0 auto" }}>!{mr.iid}</span>
                  <span style={{ color: "var(--fg)", fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mr.title}</span>
                  {mr.draft && (
                    <span style={{ flex: "0 0 auto", fontFamily: "var(--sans)", fontSize: 9.5, letterSpacing: ".06em", color: "var(--warn-d)", border: "1px solid color-mix(in oklab, var(--warn) 45%, transparent)", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>
                      draft
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 3, fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--faint)" }}>
                  <span style={{ color: "var(--acd)" }}>⎇ {mr.branch}</span>
                  {mr.author && <span>· {mr.author}</span>}
                  {mr.updated && <span>· {new Date(mr.updated).toLocaleDateString()}</span>}
                </div>
              </div>
              <span style={{ flex: "0 0 auto", color: "var(--faint)", fontSize: 13, marginTop: 2 }}>↗</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 7, color: "var(--faint)", fontFamily: "var(--sans)", fontSize: 13, textAlign: "center", padding: "0 24px" }}>
      {children}
    </div>
  );
}
