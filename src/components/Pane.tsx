// A single pane: a scrollback of command blocks followed by Aurora's live prompt
// (all in one scroll flow, so input sits right under the latest output), plus the
// xterm overlay used only for full-screen programs.

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Terminal } from "./Terminal";
import { FindBar } from "./FindBar";
import { useStore, type PaneState, type Block } from "../state/store";
import { shortenCwd } from "../lib/sys";
import { blockLines, collectMatches, findRangesInLine, highlightLine, lineText, type Match } from "../lib/find";
import { runHook } from "../lib/scripts";
import { paneRunning } from "../lib/running";

const HL_MATCH = "color-mix(in oklab, var(--warn) 30%, transparent)";
const HL_CURRENT = "color-mix(in oklab, var(--ac) 58%, transparent)";

interface Props {
  pane: PaneState;
  index: number;
  isActive: boolean;
  multiple: boolean;
}

function focusRoot() {
  document.getElementById("aurora-root")?.focus();
}

const BlockView = memo(function BlockView({
  block,
  home,
  query,
  current,
  currentRef,
}: {
  block: Block;
  home: string;
  query: string;
  current: Match | null;
  currentRef: (el: HTMLElement | null) => void;
}) {
  const lines = useMemo(() => blockLines(block.output, block.command), [block.output, block.command]);
  const q = query.toLowerCase();
  const hasOutput = lines.length > 0;
  return (
    <div style={{ margin: "0 0 10px" }}>
      <div style={{ wordBreak: "break-word" }}>
        <span style={{ color: "var(--dim)" }}>{shortenCwd(block.cwd, home)}</span>
        <span style={{ color: "var(--ac)", margin: "0 8px" }}>❯</span>
        <span style={{ color: "var(--fg)", whiteSpace: "pre-wrap" }}>{block.command}</span>
        {block.exitCode != null && block.exitCode !== 0 && (
          <span style={{ color: "var(--err)", fontFamily: "var(--sans)", fontSize: 11, marginLeft: 10 }}>
            exit {block.exitCode}
          </span>
        )}
      </div>
      {hasOutput && (
        <div style={{ marginTop: 2, color: "var(--fg)", whiteSpace: "pre-wrap" }}>
          {lines.map((segs, i) => {
            if (segs.length === 0) return <div key={i} style={{ minHeight: "1.2em" }}>{" "}</div>;
            // Fast path: no active query -> render segments as-is.
            if (!q) {
              return (
                <div key={i} style={{ minHeight: "1.2em" }}>
                  {segs.map((s, j) => (
                    <span key={j} style={s.style}>
                      {s.text}
                    </span>
                  ))}
                </div>
              );
            }
            const ranges = findRangesInLine(lineText(segs), q).map((r) => ({
              ...r,
              isCurrent:
                !!current && current.blockId === block.id && current.line === i && current.start === r.start,
            }));
            return (
              <div key={i} style={{ minHeight: "1.2em" }}>
                {highlightLine(segs, ranges).map((sl, j) => (
                  <span
                    key={j}
                    ref={sl.hl === "current" ? currentRef : undefined}
                    style={
                      sl.hl === "none"
                        ? sl.style
                        : { ...sl.style, background: sl.hl === "current" ? HL_CURRENT : HL_MATCH, borderRadius: 2 }
                    }
                  >
                    {sl.text}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// Memoized: PaneArea subscribes to the whole `workspaces` array and re-renders on
// every terminal output chunk (appendOutput → new workspaces array). `patchPane`
// only rebuilds the ONE changed pane object; sibling panes keep their reference.
// So this memo lets React skip re-rendering every other pane (in this split, in
// other tabs, and in background workspaces) on each chunk — the streaming pane is
// the only one that re-renders. All props are primitives except `pane` (a stable
// reference until that pane is patched), so the default shallow compare is correct.
export const Pane = memo(function Pane({ pane, index, isActive, multiple }: Props) {
  const home = useStore((s) => s.home);
  const keyEntry = useStore((s) => s.keyEntry);
  const keyError = useStore((s) => s.keyError);
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const focusPane = useStore((s) => s.focusPane);
  const scrollRef = useRef<HTMLDivElement>(null);

  // sticky-running-server-tabs: read the two runtime-only maps by ptyId — a
  // primitive/reference read per selector (a string, or an existing object
  // reference from the map), never a freshly-built array/object — so this
  // can't repeat the Zustand black-screen selector crash (see paneRunning,
  // computed below as a plain function call, outside any selector).
  const serverStatus = useStore((s) => (pane.ptyId ? s.serverStatus[pane.ptyId] : undefined));
  const fgState = useStore((s) => (pane.ptyId ? s.foregroundState[pane.ptyId] : undefined));
  const running = paneRunning(pane, serverStatus, fgState);

  const showKeyEntry = keyEntry && isActive;
  // While a server holds the pane (running), the prompt line is simply hidden —
  // the pane reads as attached, like a plain terminal with a foreground process.
  const showPrompt = !pane.rawMode && !showKeyEntry && !running;
  // Mirror of showPrompt's running clause: the busy-state banner replaces the
  // prompt exactly when running would otherwise have suppressed it (never in
  // rawMode — vim/top own the pane — and never while key-entry owns the pane).
  const showRunning = !pane.rawMode && !showKeyEntry && running;
  const cwd = shortenCwd(pane.cwd, home);

  const border = multiple ? (isActive ? "var(--ac)" : "var(--line)") : "transparent";
  const bg = multiple && !isActive ? "color-mix(in oklab, var(--win) 55%, var(--page))" : "var(--win)";

  const lastBlock = pane.blocks[pane.blocks.length - 1];
  const tail = (lastBlock ? lastBlock.output.length : 0) + pane.blocks.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail, pane.input, pane.suggestion, pane.suggestionLoading, pane.rawMode]);

  // find-in-output: matches are derived here (active pane only); the store keeps
  // just the current index. The current match scrolls into view as it changes.
  const find = useStore((s) => s.find);
  const findQuery = isActive && find.open && !pane.rawMode ? find.query : "";
  const matches = useMemo(() => collectMatches(pane.blocks, findQuery), [pane.blocks, findQuery]);
  const curIdx = matches.length ? Math.min(find.current, matches.length - 1) : 0;
  const currentMatch = matches.length ? matches[curIdx] : null;
  const currentMatchRef = useRef<HTMLElement | null>(null);
  const setCurrentRef = useCallback((el: HTMLElement | null) => {
    currentMatchRef.current = el;
  }, []);
  useEffect(() => {
    if (findQuery) currentMatchRef.current?.scrollIntoView({ block: "nearest" });
  }, [findQuery, curIdx]);

  return (
    <div
      onMouseDown={() => {
        if (!isActive) focusPane(index);
      }}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        border: `1px solid ${border}`,
        borderRadius: multiple ? 9 : 0,
        background: bg,
      }}
    >
      {multiple && (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 22,
            padding: "6px 7px 0 11px",
            fontFamily: "var(--sans)",
            fontSize: 10,
            letterSpacing: ".02em",
            color: "var(--faint)",
          }}
        >
          <span style={{ color: isActive ? "var(--ac)" : "var(--faint)", fontSize: 7 }}>●</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cwd}</span>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {isActive && find.open && !pane.rawMode && <FindBar total={matches.length} index={curIdx} />}
        {/* scrollback: blocks + live prompt */}
        <div
          ref={scrollRef}
          className="ascroll"
          onMouseDown={(e) => {
            e.stopPropagation();
            if (!isActive) focusPane(index);
            focusRoot();
          }}
          style={{
            position: "absolute",
            inset: 0,
            display: pane.rawMode ? "none" : "block",
            overflowY: "auto",
            padding: "14px 16px 12px",
            background: "var(--win)",
            fontSize: "var(--fs)",
            lineHeight: 1.6,
            color: "var(--fg)",
          }}
        >
          {pane.blocks.map((b) => (
            <BlockView key={b.id} block={b} home={home} query={findQuery} current={currentMatch} currentRef={setCurrentRef} />
          ))}

          {pane.blocks.length === 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: "var(--dim)" }}>aurora · zsh — a shell that understands plain language.</div>
              {apiKeyPresent ? (
                <div style={{ color: "var(--acd)", fontSize: 13, marginTop: 3 }}>
                  ✦ ask claude — start a line with <span style={{ color: "var(--fg)" }}>?</span> (e.g.{" "}
                  <span style={{ color: "var(--fg)" }}>? undo my last commit</span>) or press{" "}
                  <span style={{ color: "var(--fg)" }}>⌘↵</span>
                </div>
              ) : (
                <div style={{ color: "var(--acd)", fontSize: 13, marginTop: 3 }}>
                  ✦ ask claude is bring-your-own-key — run <span style={{ color: "var(--fg)" }}>aurora auth</span> (or “add
                  key” above), then start a line with <span style={{ color: "var(--fg)" }}>?</span> or press ⌘↵
                </div>
              )}
            </div>
          )}

          {pane.hook && (
            <HookCard
              label={pane.hook.label}
              desc={pane.hook.desc}
              onRun={() => runHook(pane.id)}
              onDismiss={() => useStore.getState().setHook(pane.id, null)}
            />
          )}

          {isActive && pane.suggestionLoading && (
            <SuggestionCard label="thinking…" command="" note="asking claude…" footer={false} />
          )}
          {isActive && pane.suggestion && !pane.suggestionLoading && (
            <SuggestionCard
              label={pane.suggestion.command ? "suggests" : pane.suggestion.needsKey ? "locked" : "claude"}
              command={pane.suggestion.command}
              note={pane.suggestion.note}
              needsKey={pane.suggestion.needsKey}
              footer
            />
          )}

          {showRunning && (
            // Busy-state banner that stands in for the prompt: the pane can't
            // take input, so it says what's running and — the whole point —
            // makes Ctrl+C the visible way to get control back. Reuses Aurora's
            // card grammar (tinted fill + left accent rule) but in the --warn
            // running tone, not the --ac assistant tone.
            <div
              style={{
                margin: "2px 0 10px",
                maxWidth: 560,
                display: "flex",
                alignItems: "center",
                gap: 12,
                border: "1px solid color-mix(in oklab, var(--warn) 30%, var(--line))",
                borderLeft: "2px solid var(--warn)",
                borderRadius: 8,
                background: "color-mix(in oklab, var(--warn) 8%, transparent)",
                padding: "9px 12px",
                animation: "rise .13s ease",
              }}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--warn)",
                  boxShadow: "0 0 7px var(--warn)",
                  animation: "pulse 1.8s ease-in-out infinite",
                }}
              />
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "baseline", gap: 9, overflow: "hidden" }}>
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "var(--sans)",
                    fontSize: 11,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: "var(--warn-d)",
                  }}
                >
                  running
                </span>
                {pane.blocks[pane.blocks.length - 1]?.command?.trim() && (
                  <span
                    style={{
                      minWidth: 0,
                      color: "var(--fg)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pane.blocks[pane.blocks.length - 1]!.command.trim()}
                  </span>
                )}
              </div>
              <span
                style={{
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontFamily: "var(--sans)",
                  fontSize: 11.5,
                  color: "var(--dim)",
                }}
              >
                <kbd
                  style={{
                    fontFamily: "var(--sans)",
                    fontSize: 11,
                    color: "var(--warn)",
                    background: "color-mix(in oklab, var(--warn) 10%, transparent)",
                    border: "1px solid color-mix(in oklab, var(--warn) 45%, var(--line))",
                    borderRadius: 5,
                    padding: "1px 6px",
                    boxShadow: "inset 0 -1px 0 color-mix(in oklab, var(--warn) 30%, transparent)",
                  }}
                >
                  ⌃C
                </kbd>
                to stop
              </span>
            </div>
          )}

          {showPrompt && (
            <div style={{ wordBreak: "break-word" }}>
              <span style={{ color: "var(--dim)" }}>{cwd}</span>
              <span style={{ color: "var(--ac)", margin: "0 8px" }}>{pane.input.startsWith("?") ? "✦" : "❯"}</span>
              <span
                style={{
                  color: "var(--fg)",
                  whiteSpace: "pre-wrap",
                  background: pane.inputSelected ? "color-mix(in oklab, var(--ac) 32%, transparent)" : undefined,
                  borderRadius: pane.inputSelected ? 2 : undefined,
                }}
              >
                {pane.input}
              </span>
              {/* While the input is fully selected (⌘A), hide the caret + ghost. */}
              {!pane.inputSelected && (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8.5,
                      height: 17,
                      background: isActive ? "var(--ac)" : "var(--faint)",
                      opacity: isActive ? 1 : 0.45,
                      verticalAlign: -3,
                      margin: "0 1px",
                      borderRadius: 1,
                      animation: isActive ? "blink 1.05s steps(1) infinite" : undefined,
                      boxShadow: isActive ? "0 0 9px color-mix(in oklab, var(--ac) 70%, transparent)" : undefined,
                    }}
                  />
                  <span style={{ color: "var(--faint)" }}>{pane.ghost}</span>
                </>
              )}
            </div>
          )}

          {isActive && pane.completion && (
            <CompletionList items={pane.completion.items} index={pane.completion.index} />
          )}

          {showKeyEntry && <KeyEntry input={pane.input} keyError={keyError} />}
        </div>

        {/* xterm overlay for full-screen programs */}
        <Terminal paneId={pane.id} />

        {pane.rawMode && (
          <span
            style={{
              position: "absolute",
              top: 8,
              right: 10,
              zIndex: 3,
              fontFamily: "var(--sans)",
              fontSize: 10,
              color: "var(--acd)",
              background: "color-mix(in oklab, var(--bar) 80%, transparent)",
              border: "1px solid var(--line)",
              borderRadius: 5,
              padding: "2px 7px",
              pointerEvents: "none",
            }}
          >
            ● interactive
          </span>
        )}
      </div>
    </div>
  );
});

function KeyEntry({ input, keyError }: { input: string; keyError: string | null }) {
  return (
    <div>
      <div style={{ wordBreak: "break-all" }}>
        <span style={{ color: "var(--warn-d)" }}>paste anthropic key</span>
        <span style={{ color: "var(--ac)", margin: "0 8px" }}>❯</span>
        <span style={{ color: "var(--fg)", letterSpacing: 2 }}>{"•".repeat(input.length)}</span>
        <span
          style={{
            display: "inline-block",
            width: 8.5,
            height: 17,
            background: "var(--ac)",
            verticalAlign: -3,
            margin: "0 1px",
            borderRadius: 1,
            animation: "blink 1.05s steps(1) infinite",
          }}
        />
      </div>
      <div
        style={{
          color: "var(--faint)",
          fontSize: 11.5,
          fontFamily: "var(--sans)",
          marginTop: 4,
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <span>sk-ant-… · stored in your macOS Keychain</span>
        <span>
          <span style={{ color: "var(--acd)" }}>⌘V</span> paste
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>↵</span> save
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>esc</span> cancel
        </span>
      </div>
      {keyError && <div style={{ color: "var(--err)", fontSize: 12.5, marginTop: 4 }}>{keyError}</div>}
    </div>
  );
}

function HookCard({
  label,
  desc,
  onRun,
  onDismiss,
}: {
  label: string;
  desc: string;
  onRun: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        margin: "2px 0 10px",
        border: "1px solid color-mix(in oklab, var(--ac) 28%, var(--line))",
        borderLeft: "2px solid var(--ac)",
        borderRadius: 8,
        background: "color-mix(in oklab, var(--ac) 7%, transparent)",
        padding: "10px 13px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        maxWidth: 560,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontFamily: "var(--sans)",
            fontSize: 11,
            letterSpacing: ".04em",
            color: "var(--acd)",
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          <span style={{ color: "var(--ac)" }}>⚡</span>repo hook · onEnter
        </div>
        <div style={{ color: "var(--fg)", fontSize: 13.5 }}>
          {label}
          {desc && <span style={{ color: "var(--faint)", fontSize: 12, marginLeft: 8 }}>{desc}</span>}
        </div>
      </div>
      <span
        onClick={onRun}
        style={{
          flex: "0 0 auto",
          cursor: "pointer",
          fontFamily: "var(--sans)",
          fontSize: 12,
          color: "var(--page)",
          background: "var(--ac)",
          borderRadius: 6,
          padding: "5px 12px",
          fontWeight: 500,
        }}
      >
        ▶ run
      </span>
      <span
        onClick={onDismiss}
        title="dismiss"
        style={{ flex: "0 0 auto", cursor: "pointer", color: "var(--faint)", fontSize: 14 }}
      >
        ×
      </span>
    </div>
  );
}

const COMPLETION_LIMIT = 8;

function CompletionList({ items, index }: { items: { name: string; is_dir: boolean }[]; index: number }) {
  // Keep the highlighted row in view when the list overflows the cap.
  const start = Math.min(Math.max(0, index - COMPLETION_LIMIT + 1), Math.max(0, items.length - COMPLETION_LIMIT));
  const shown = items.slice(start, start + COMPLETION_LIMIT);
  const hiddenAfter = items.length - (start + shown.length);
  return (
    <div
      style={{
        margin: "2px 0 10px",
        border: "1px solid color-mix(in oklab, var(--ac) 32%, var(--line))",
        borderLeft: "2px solid var(--ac)",
        borderRadius: 8,
        background: "color-mix(in oklab, var(--ac) 8%, transparent)",
        padding: "8px 6px 6px",
        animation: "rise .13s ease",
        boxShadow: "0 8px 30px -16px color-mix(in oklab, var(--ac) 80%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--sans)",
          fontSize: 11,
          letterSpacing: ".04em",
          color: "var(--acd)",
          textTransform: "uppercase",
          margin: "0 8px 6px",
        }}
      >
        <span style={{ color: "var(--ac)" }}>⇥</span>folders
        <span style={{ color: "var(--faint)" }}>· {items.length}</span>
      </div>
      {start > 0 && (
        <div style={{ padding: "0 10px 2px", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>↑ {start} more…</div>
      )}
      {shown.map((it, i) => {
        const active = start + i === index;
        return (
          <div
            key={it.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 10px",
              borderRadius: 6,
              fontSize: 14,
              color: active ? "var(--fg)" : "var(--dim)",
              background: active ? "color-mix(in oklab, var(--ac) 18%, transparent)" : undefined,
            }}
          >
            <span>
              {it.name}
              <span style={{ color: "var(--faint)" }}>/</span>
            </span>
          </div>
        );
      })}
      {hiddenAfter > 0 && (
        <div style={{ padding: "2px 10px 0", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>↓ {hiddenAfter} more…</div>
      )}
      <div
        style={{
          margin: "7px 8px 0",
          fontFamily: "var(--sans)",
          fontSize: 11,
          color: "var(--faint)",
          display: "flex",
          gap: 16,
        }}
      >
        <span>
          <span style={{ color: "var(--acd)" }}>↑↓</span> move
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>⇥/↵</span> select
        </span>
        <span>
          <span style={{ color: "var(--acd)" }}>esc</span> dismiss
        </span>
      </div>
    </div>
  );
}

function SuggestionCard({
  label,
  command,
  note,
  footer,
  needsKey,
}: {
  label: string;
  command: string;
  note: string;
  footer?: boolean;
  needsKey?: boolean;
}) {
  return (
    <div
      style={{
        margin: "2px 0 10px",
        border: "1px solid color-mix(in oklab, var(--ac) 32%, var(--line))",
        borderLeft: "2px solid var(--ac)",
        borderRadius: 8,
        background: "color-mix(in oklab, var(--ac) 8%, transparent)",
        padding: "11px 14px",
        animation: "rise .13s ease",
        boxShadow: "0 8px 30px -16px color-mix(in oklab, var(--ac) 80%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--sans)",
          fontSize: 11,
          letterSpacing: ".04em",
          color: "var(--acd)",
          textTransform: "uppercase",
          marginBottom: 7,
        }}
      >
        <span style={{ color: "var(--ac)" }}>✦</span>claude
        <span style={{ color: "var(--faint)" }}>· {label}</span>
      </div>
      {command && (
        <div style={{ color: "var(--fg)", fontSize: 14.5 }}>
          <span style={{ color: "var(--faint)", marginRight: 8 }}>❯</span>
          {command}
        </div>
      )}
      <div style={{ color: "var(--dim)", fontSize: 12.5, marginTop: command ? 5 : 0 }}>{note}</div>
      {footer && (
        <div
          style={{
            marginTop: 9,
            fontFamily: "var(--sans)",
            fontSize: 11,
            color: "var(--faint)",
            display: "flex",
            gap: 16,
          }}
        >
          {command ? (
            <>
              <span>
                <span style={{ color: "var(--acd)" }}>↵</span> run
              </span>
              <span>
                <span style={{ color: "var(--acd)" }}>⇥</span> edit
              </span>
              <span>
                <span style={{ color: "var(--acd)" }}>esc</span> dismiss
              </span>
            </>
          ) : needsKey ? (
            <>
              <span>
                <span style={{ color: "var(--warn-d)" }}>↵</span> add your key
              </span>
              <span>
                <span style={{ color: "var(--acd)" }}>esc</span> dismiss
              </span>
            </>
          ) : (
            <span>
              <span style={{ color: "var(--acd)" }}>esc</span> dismiss
            </span>
          )}
        </div>
      )}
    </div>
  );
}
