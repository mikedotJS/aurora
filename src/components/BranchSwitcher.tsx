// The git branch in the status bar is a live control: clicking it unfolds a
// keyboard-first branch switcher right above the chip. The ⎇ glyph carries from
// the chip into the popover's filter field, so the panel reads as having grown
// out of the thing you clicked. Selecting a branch runs a real `git switch`
// (respecting hooks/config); a dirty tree surfaces an inline, plain-language fix.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { gitBranch, gitBranches, gitSwitch } from "../lib/sys";

export function BranchChip({ paneId, cwd, branch }: { paneId: number; cwd: string; branch: string }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const lit = open || hover;

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="switch branch"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          cursor: "pointer",
          padding: "2px 6px",
          margin: "0 -6px", // keep the row's visual rhythm; the hit area just grows
          borderRadius: 6,
          color: open ? "var(--fg)" : undefined,
          background: lit ? "color-mix(in oklab, var(--ac) 13%, transparent)" : "transparent",
          transition: "background .12s ease, color .12s ease",
        }}
      >
        <span style={{ color: "var(--acd)" }}>⎇</span>
        {branch}
        <span
          style={{
            fontSize: 8,
            lineHeight: 1,
            marginLeft: 1,
            color: "var(--faint)",
            opacity: lit ? 1 : 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "opacity .12s ease, transform .16s cubic-bezier(.2,.72,.2,1)",
          }}
        >
          ▾
        </span>
      </span>
      {open && <BranchSwitcher paneId={paneId} cwd={cwd} current={branch} onClose={() => setOpen(false)} />}
    </span>
  );
}

function BranchSwitcher({
  paneId,
  cwd,
  current,
  onClose,
}: {
  paneId: number;
  cwd: string;
  current: string;
  onClose: () => void;
}) {
  const setBranch = useStore((s) => s.setBranch);
  const [branches, setBranches] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    gitBranches(cwd).then((bl) => {
      if (!alive) return;
      const list = bl.branches.length ? bl.branches : bl.current ? [bl.current] : [];
      setBranches(list);
      // Start on the first switchable branch so ↵ does the useful thing.
      const firstOther = list.findIndex((b) => b !== current);
      setSel(firstOther === -1 ? 0 : firstOther);
    });
    inputRef.current?.focus();
    return () => {
      alive = false;
    };
  }, [cwd, current]);

  const q = query.trim().toLowerCase();
  const filtered = branches.filter((b) => b.toLowerCase().includes(q));
  const clampedSel = Math.min(sel, Math.max(0, filtered.length - 1));

  // Keep the highlighted row in view as you arrow through a long list.
  useLayoutEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [clampedSel, filtered.length]);

  const switchTo = async (b: string) => {
    if (!b || busy) return;
    if (b === current) return void onClose();
    setBusy(b);
    setError(null);
    const res = await gitSwitch(cwd, b);
    if (res.ok) {
      const now = await gitBranch(cwd);
      setBranch(paneId, now ?? b);
      onClose();
    } else {
      setBusy(null);
      setError(humanizeGitError(res.error, b));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = filtered[clampedSel];
      if (b) switchTo(b);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      {/* Lightweight outside-click catcher (no dimming — the panel is small). */}
      <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
      <div
        role="listbox"
        aria-label="Switch branch"
        style={{
          position: "absolute",
          left: -6,
          bottom: 26,
          zIndex: 60,
          width: 312,
          maxHeight: "min(60vh, 380px)",
          display: "flex",
          flexDirection: "column",
          transformOrigin: "bottom left",
          background: "color-mix(in oklab, var(--bar) 93%, transparent)",
          backdropFilter: "blur(14px) saturate(1.25)",
          WebkitBackdropFilter: "blur(14px) saturate(1.25)",
          border: "1px solid color-mix(in oklab, var(--ac) 28%, var(--line))",
          borderLeft: "2px solid var(--ac)",
          borderRadius: 11,
          boxShadow: "0 18px 48px -20px rgba(0,0,0,.82), 0 0 0 1px color-mix(in oklab, var(--ac) 8%, transparent)",
          animation: "popIn .16s cubic-bezier(.2,.72,.2,1)",
          overflow: "hidden",
          fontFamily: "var(--mono)",
        }}
      >
        {/* Filter — the chip's ⎇ glyph continues here as the leading icon. */}
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
          <span style={{ color: "var(--ac)", fontSize: 13, lineHeight: 1 }}>⎇</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="find a branch…"
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

        {/* Branch list */}
        <div ref={listRef} className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "5px 5px 4px" }}>
          {filtered.length === 0 && (
            <div
              style={{
                padding: "16px 12px",
                textAlign: "center",
                fontFamily: "var(--sans)",
                fontSize: 12.5,
                color: "var(--faint)",
              }}
            >
              {branches.length === 0 ? "no other branches yet" : `no branch matches “${query.trim()}”`}
            </div>
          )}
          {filtered.map((b, i) => {
            const isCurrent = b === current;
            const active = i === clampedSel;
            const switching = busy === b;
            return (
              <div
                key={b}
                ref={active ? activeRef : null}
                onMouseEnter={() => setSel(i)}
                onClick={() => switchTo(b)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  borderRadius: 7,
                  cursor: isCurrent ? "default" : "pointer",
                  borderLeft: `2px solid ${active && !isCurrent ? "var(--ac)" : "transparent"}`,
                  background: active && !isCurrent ? "color-mix(in oklab, var(--ac) 13%, transparent)" : "transparent",
                  opacity: busy && !switching ? 0.4 : 1,
                  transition: "opacity .12s ease",
                }}
              >
                <span style={{ color: isCurrent ? "var(--ac)" : "var(--faint)", fontSize: 12, width: 11, textAlign: "center" }}>
                  {isCurrent ? "⎇" : switching ? "↻" : "›"}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                    color: isCurrent ? "var(--ac)" : "var(--fg)",
                  }}
                >
                  {b}
                </span>
                {isCurrent && <Tag>current</Tag>}
                {switching && (
                  <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--acd)" }}>switching…</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Inline error (e.g. dirty tree), in the interface's voice */}
        {error && (
          <div
            style={{
              flex: "0 0 auto",
              padding: "8px 12px",
              borderTop: "1px solid color-mix(in oklab, var(--err) 24%, var(--line))",
              background: "color-mix(in oklab, var(--err) 12%, transparent)",
              fontFamily: "var(--sans)",
              fontSize: 12,
              lineHeight: 1.4,
              color: "var(--err)",
            }}
          >
            {error}
          </div>
        )}

        {/* Footer hint + count */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "7px 12px",
            borderTop: "1px solid color-mix(in oklab, var(--line) 65%, transparent)",
            fontFamily: "var(--sans)",
            fontSize: 10.5,
            color: "var(--faint)",
          }}
        >
          <span>
            <Key>↑↓</Key> select · <Key>↵</Key> switch · <Key>esc</Key> close
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {filtered.length}
            {q && filtered.length !== branches.length ? `/${branches.length}` : ""}
          </span>
        </div>
      </div>
    </>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        flex: "0 0 auto",
        fontFamily: "var(--sans)",
        fontSize: 9.5,
        letterSpacing: ".03em",
        textTransform: "uppercase",
        color: "var(--acd)",
        border: "1px solid color-mix(in oklab, var(--ac) 35%, var(--line))",
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--acd)" }}>{children}</span>;
}

/** Turn git's stderr into a short, actionable line — specific over clever. */
function humanizeGitError(raw: string, branch: string): string {
  const r = raw.toLowerCase();
  if (r.includes("would be overwritten") || r.includes("local changes") || r.includes("overwritten by"))
    return "You have uncommitted changes — commit or stash them first.";
  if (r.includes("did not match") || r.includes("invalid reference") || r.includes("unknown revision"))
    return `“${branch}” no longer exists.`;
  const first = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return (first ?? "Couldn't switch branch.").replace(/^(error|fatal):\s*/i, "");
}
