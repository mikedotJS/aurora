// Find-in-output bar: floats at the top-right of the active pane. A mono search
// field, an "n/total" counter, prev/next steppers, and close. Keyboard-first:
// Enter → next, Shift-Enter / ↑ → prev, ↓ → next, Esc → close.

import { useEffect, useRef } from "react";
import { useStore } from "../state/store";

export function FindBar({ total, index }: { total: number; index: number }) {
  const query = useStore((s) => s.find.query);
  const setFindQuery = useStore((s) => s.setFindQuery);
  const stepFind = useStore((s) => s.stepFind);
  const closeFind = useStore((s) => s.closeFind);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);

  const has = total > 0;
  const empty = query.length > 0 && !has;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1, total);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      stepFind(1, total);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      stepFind(-1, total);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 10,
        right: 12,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 7px 6px 11px",
        background: "color-mix(in oklab, var(--bar) 88%, transparent)",
        backdropFilter: "blur(10px) saturate(1.2)",
        WebkitBackdropFilter: "blur(10px) saturate(1.2)",
        border: "1px solid color-mix(in oklab, var(--ac) 26%, var(--line))",
        borderRadius: 10,
        boxShadow: "0 12px 34px -16px rgba(0,0,0,.78), 0 0 0 1px color-mix(in oklab, var(--ac) 8%, transparent)",
        animation: "rise .14s ease",
      }}
    >
      <span style={{ color: "var(--acd)", fontSize: 12, lineHeight: 1, opacity: 0.85 }}>⌕</span>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in output"
        spellCheck={false}
        autoComplete="off"
        style={{
          width: 158,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--fg)",
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          padding: 0,
        }}
      />
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: ".02em",
          color: empty ? "var(--warn-d)" : "var(--faint)",
          minWidth: 38,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {has ? `${index + 1}/${total}` : query.length ? "0/0" : ""}
      </span>
      <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 1px" }} />
      <Step glyph="‹" label="previous match (⇧↵)" disabled={!has} onClick={() => stepFind(-1, total)} rotate />
      <Step glyph="›" label="next match (↵)" disabled={!has} onClick={() => stepFind(1, total)} rotate />
      <span
        onClick={closeFind}
        title="close (esc)"
        style={{
          cursor: "pointer",
          width: 21,
          height: 21,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          color: "var(--dim)",
          fontSize: 15,
        }}
      >
        ×
      </span>
    </div>
  );
}

function Step({
  glyph,
  label,
  disabled,
  onClick,
  rotate,
}: {
  glyph: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  rotate?: boolean;
}) {
  return (
    <span
      onClick={() => !disabled && onClick()}
      title={label}
      style={{
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.32 : 1,
        width: 20,
        height: 21,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        color: "var(--dim)",
        fontSize: 16,
        lineHeight: 1,
        transform: rotate ? "rotate(90deg)" : undefined,
      }}
    >
      {glyph}
    </span>
  );
}
