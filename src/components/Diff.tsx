// Unified + split diff renderers. Colors come from tokens (removed = --err wash,
// added = --ok wash); line numbers are tabular.

import { pairForSplit, type Hunk } from "../lib/diff";

const ADD_BG = "color-mix(in oklab, var(--ok) 15%, transparent)";
const DEL_BG = "color-mix(in oklab, var(--err) 14%, transparent)";
const ADD_NO = "color-mix(in oklab, var(--ok) 24%, transparent)";
const DEL_NO = "color-mix(in oklab, var(--err) 22%, transparent)";

const num: React.CSSProperties = {
  flex: "0 0 auto",
  width: 42,
  textAlign: "right",
  paddingRight: 10,
  color: "var(--faint)",
  fontVariantNumeric: "tabular-nums",
  userSelect: "none",
};
const cell: React.CSSProperties = {
  whiteSpace: "pre",
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function HunkHeader({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "3px 12px",
        background: "color-mix(in oklab, var(--ac) 9%, transparent)",
        color: "var(--acd)",
        fontSize: 11.5,
        whiteSpace: "pre",
      }}
    >
      {text}
    </div>
  );
}

export function UnifiedDiff({ hunks }: { hunks: Hunk[] }) {
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: 1.55 }}>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <HunkHeader text={h.header} />
          {h.lines.map((l, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                background: l.kind === "+" ? ADD_BG : l.kind === "-" ? DEL_BG : "transparent",
              }}
            >
              <span style={num}>{l.oldNo ?? ""}</span>
              <span style={num}>{l.newNo ?? ""}</span>
              <span
                style={{
                  flex: "0 0 auto",
                  width: 14,
                  textAlign: "center",
                  color: l.kind === "+" ? "var(--ok)" : l.kind === "-" ? "var(--err)" : "var(--faint)",
                }}
              >
                {l.kind === " " ? "" : l.kind}
              </span>
              <span style={{ ...cell, color: "var(--fg)" }}>{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SplitDiff({ hunks }: { hunks: Hunk[] }) {
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: 1.55 }}>
      {hunks.map((h, hi) => {
        const rows = pairForSplit(h);
        return (
          <div key={hi}>
            <HunkHeader text={h.header} />
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex" }}>
                {/* left (base) */}
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    background: r.left?.kind === "-" ? DEL_BG : "transparent",
                    borderRight: "1px solid var(--line)",
                  }}
                >
                  <span style={{ ...num, background: r.left?.kind === "-" ? DEL_NO : "transparent" }}>
                    {r.left?.oldNo ?? ""}
                  </span>
                  <span style={{ ...cell, color: r.left ? "var(--fg)" : "var(--faint)" }}>
                    {r.left ? r.left.text || " " : ""}
                  </span>
                </div>
                {/* right (working tree) */}
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    background: r.right?.kind === "+" ? ADD_BG : "transparent",
                  }}
                >
                  <span style={{ ...num, background: r.right?.kind === "+" ? ADD_NO : "transparent" }}>
                    {r.right?.newNo ?? ""}
                  </span>
                  <span style={{ ...cell, color: r.right ? "var(--fg)" : "var(--faint)" }}>
                    {r.right ? r.right.text || " " : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
