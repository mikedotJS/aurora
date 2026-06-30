// Editor for per-repo scripts + the onEnter hook. Persists via lib/scripts.

import type { CSSProperties } from "react";
import { useState } from "react";
import { useStore, activePane, type Script } from "../state/store";
import { shortenCwd } from "../lib/sys";
import {
  scriptsForRoot,
  onEnterFor,
  addScript,
  updateScript,
  deleteScript,
  addTask,
  updateTask,
  removeTask,
  setOnEnter,
  runScript,
} from "../lib/scripts";
import { generateRepoScripts, adoptGeneratedScripts } from "../lib/aiScripts";
import { NoKeyError } from "../ai/suggest";

type GenState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review"; scripts: Script[]; keep: boolean[] };

const inputBase: CSSProperties = {
  background: "var(--page)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--fg)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  padding: "6px 9px",
  outline: "none",
};

export function ScriptsSetupModal() {
  const closeScriptsSetup = useStore((s) => s.closeScriptsSetup);
  const userScripts = useStore((s) => s.userScripts);
  const home = useStore((s) => s.home);
  const pane = useStore((s) => activePane(s));
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const startKeyEntry = useStore((s) => s.startKeyEntry);
  const model = useStore((s) => s.settings.model);
  const root = pane ? (pane.repoRoot ?? pane.cwd) : null;
  void userScripts; // re-render on edits
  const scripts = scriptsForRoot(root);
  const onEnter = onEnterFor(root) ?? "";

  const [gen, setGen] = useState<GenState>({ kind: "idle" });

  const generate = async () => {
    if (!root) return;
    if (!apiKeyPresent) {
      // No key — route to the key-entry flow; never call the model.
      closeScriptsSetup();
      startKeyEntry();
      return;
    }
    setGen({ kind: "loading" });
    try {
      const proposed = await generateRepoScripts(root, model);
      if (!proposed.length) {
        setGen({ kind: "error", message: "Claude didn't return any usable scripts for this repo." });
        return;
      }
      setGen({ kind: "review", scripts: proposed, keep: proposed.map(() => true) });
    } catch (e) {
      if (e instanceof NoKeyError) {
        closeScriptsSetup();
        startKeyEntry();
        return;
      }
      setGen({ kind: "error", message: String(e instanceof Error ? e.message : e) });
    }
  };

  // Edit a proposed script in-place during review (local, pre-adopt).
  const patchReview = (i: number, patch: Partial<Script>) =>
    setGen((g) =>
      g.kind === "review"
        ? { ...g, scripts: g.scripts.map((s, j) => (j === i ? { ...s, ...patch } : s)) }
        : g,
    );
  const toggleKeep = (i: number) =>
    setGen((g) => (g.kind === "review" ? { ...g, keep: g.keep.map((k, j) => (j === i ? !k : k)) } : g));
  const adopt = () => {
    if (gen.kind !== "review" || !root) return;
    adoptGeneratedScripts(
      root,
      gen.scripts.filter((_, i) => gen.keep[i]),
    );
    setGen({ kind: "idle" });
  };

  if (gen.kind === "review") {
    return (
      <ReviewPanel
        root={root}
        home={home}
        scripts={gen.scripts}
        keep={gen.keep}
        onPatch={patchReview}
        onToggle={toggleKeep}
        onAdopt={adopt}
        onCancel={() => setGen({ kind: "idle" })}
      />
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 26,
      }}
    >
      <div
        onClick={closeScriptsSetup}
        style={{ position: "absolute", inset: 0, background: "color-mix(in oklab, black 55%, transparent)", animation: "fadeIn .16s ease" }}
      />
      <div
        style={{
          position: "relative",
          width: "min(580px, 100%)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--win)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "0 34px 90px -26px rgba(0,0,0,.82)",
          animation: "popIn .2s cubic-bezier(.2,.7,.2,1)",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 9, padding: "15px 18px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--acd)", fontSize: 14 }}>⚡</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>Scripts</span>
          {root && <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>· {shortenCwd(root, home)}</span>}
          <span
            onClick={closeScriptsSetup}
            style={{ marginLeft: "auto", cursor: "pointer", fontSize: 18, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, color: "var(--dim)" }}
          >
            ×
          </span>
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "6px 0 4px" }}>
          {!root ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "46px 20px", gap: 8, color: "var(--faint)", fontFamily: "var(--sans)", fontSize: 13 }}>
              <span style={{ fontSize: 22, color: "var(--line)" }}>⚡</span>
              <span>cd into a repo to edit its scripts</span>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px 14px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>Run on entering repo</div>
                  <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>onEnter hook — offered once when you cd in</div>
                </div>
                <select
                  value={onEnter}
                  onChange={(e) => setOnEnter(root, e.target.value)}
                  style={{ ...inputBase, fontFamily: "var(--sans)", cursor: "pointer" }}
                >
                  <option value="">none</option>
                  {scripts.map((s, i) => (
                    <option key={i} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              {scripts.map((s, i) => (
                <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 13px", margin: "12px 16px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <input
                      value={s.name}
                      onChange={(e) => updateScript(root, i, { name: e.target.value })}
                      placeholder="name"
                      style={{ ...inputBase, flex: "0 0 132px", color: "var(--ac)" }}
                    />
                    <input
                      value={s.desc}
                      onChange={(e) => updateScript(root, i, { desc: e.target.value })}
                      placeholder="description"
                      style={{ ...inputBase, flex: 1, minWidth: 0, fontFamily: "var(--sans)" }}
                    />
                    <span
                      onClick={() => {
                        if (!pane) return;
                        closeScriptsSetup(); // the modal covers the terminal — close it so the output is visible
                        runScript(pane.id, s.name);
                      }}
                      title="run now"
                      style={{ cursor: "pointer", color: "var(--acd)", fontSize: 13, padding: "3px 5px" }}
                    >
                      ▶
                    </span>
                    <span
                      onClick={() => deleteScript(root, i)}
                      title="delete script"
                      style={{ cursor: "pointer", color: "var(--faint)", fontSize: 15 }}
                    >
                      ×
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "11px 0 7px" }}>
                    <span style={{ fontFamily: "var(--sans)", fontSize: 10.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--faint)" }}>
                      commands
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--dim)" }}>split panes</span>
                    <div
                      onClick={() => updateScript(root, i, { split: !s.split })}
                      style={{ width: 34, height: 19, borderRadius: 999, background: s.split ? "var(--ac)" : "var(--line)", position: "relative", cursor: "pointer", flex: "0 0 auto" }}
                    >
                      <span style={{ position: "absolute", top: 2, left: s.split ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: s.split ? "var(--page)" : "var(--dim)" }} />
                    </div>
                  </div>

                  {s.tasks.map((t, j) => (
                    <div key={j} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                      <input
                        value={t.dir}
                        onChange={(e) => updateTask(root, i, j, { dir: e.target.value })}
                        placeholder="dir"
                        title="subdirectory (optional)"
                        style={{ ...inputBase, flex: "0 0 84px", color: "var(--dim)", fontSize: 11.5 }}
                      />
                      <span style={{ color: "var(--ac)", flex: "0 0 auto" }}>❯</span>
                      <input
                        value={t.cmd}
                        onChange={(e) => updateTask(root, i, j, { cmd: e.target.value })}
                        placeholder="command to run"
                        style={{ ...inputBase, flex: 1, minWidth: 0 }}
                      />
                      <span
                        onClick={() => removeTask(root, i, j)}
                        title="remove command"
                        style={{ cursor: "pointer", color: "var(--faint)", fontSize: 14, flex: "0 0 auto" }}
                      >
                        ×
                      </span>
                    </div>
                  ))}
                  <span onClick={() => addTask(root, i)} style={{ cursor: "pointer", fontFamily: "var(--sans)", fontSize: 11, color: "var(--acd)" }}>
                    + command
                  </span>
                </div>
              ))}

              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 16px 16px" }}>
                <span
                  onClick={() => addScript(root)}
                  style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--sans)", fontSize: 12, color: "var(--acd)", border: "1px dashed var(--line)", borderRadius: 8, padding: "8px 14px" }}
                >
                  + add script
                </span>
                <span
                  onClick={gen.kind === "loading" ? undefined : generate}
                  title={apiKeyPresent ? "Ask Claude to propose scripts for this repo" : "Set an Anthropic key to generate"}
                  style={{
                    cursor: gen.kind === "loading" ? "default" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: "var(--sans)",
                    fontSize: 12,
                    color: gen.kind === "loading" ? "var(--dim)" : "var(--ac)",
                    border: "1px solid color-mix(in oklab, var(--ac) 35%, var(--line))",
                    borderRadius: 8,
                    padding: "8px 14px",
                  }}
                >
                  {gen.kind === "loading" ? "✨ generating…" : "✨ generate with AI"}
                </span>
                {gen.kind === "error" && (
                  <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--err, #e5484d)", minWidth: 0 }}>
                    {gen.message}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Review step for AI-generated scripts: the user edits the proposals and picks
 * which to keep before they're adopted. Nothing here runs a command.
 */
function ReviewPanel({
  root,
  home,
  scripts,
  keep,
  onPatch,
  onToggle,
  onAdopt,
  onCancel,
}: {
  root: string | null;
  home: string;
  scripts: Script[];
  keep: boolean[];
  onPatch: (i: number, patch: Partial<Script>) => void;
  onToggle: (i: number) => void;
  onAdopt: () => void;
  onCancel: () => void;
}) {
  const selected = keep.filter(Boolean).length;
  const patchTask = (i: number, j: number, p: { dir?: string; cmd?: string }) =>
    onPatch(i, { tasks: scripts[i].tasks.map((t, k) => (k === j ? { ...t, ...p } : t)) });

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 26 }}>
      <div onClick={onCancel} style={{ position: "absolute", inset: 0, background: "color-mix(in oklab, black 55%, transparent)", animation: "fadeIn .16s ease" }} />
      <div
        style={{
          position: "relative",
          width: "min(580px, 100%)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--win)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "0 34px 90px -26px rgba(0,0,0,.82)",
          animation: "popIn .2s cubic-bezier(.2,.7,.2,1)",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 9, padding: "15px 18px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--acd)", fontSize: 14 }}>✨</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>Review generated scripts</span>
          {root && <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>· {shortenCwd(root, home)}</span>}
          <span
            onClick={onCancel}
            style={{ marginLeft: "auto", cursor: "pointer", fontSize: 18, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, color: "var(--dim)" }}
          >
            ×
          </span>
        </div>

        <div style={{ flex: "0 0 auto", padding: "9px 18px", borderBottom: "1px solid var(--line)", fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--dim)" }}>
          Claude proposed these — edit and pick which to keep. Nothing runs until you choose it later with <span style={{ color: "var(--acd)" }}>run</span>.
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "6px 0 4px" }}>
          {scripts.map((s, i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: "12px 13px",
                margin: "12px 16px 0",
                opacity: keep[i] ? 1 : 0.5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <input type="checkbox" checked={keep[i]} onChange={() => onToggle(i)} style={{ cursor: "pointer", flex: "0 0 auto" }} title="keep this script" />
                <input
                  value={s.name}
                  onChange={(e) => onPatch(i, { name: e.target.value })}
                  placeholder="name"
                  style={{ ...inputBase, flex: "0 0 132px", color: "var(--ac)" }}
                />
                <input
                  value={s.desc}
                  onChange={(e) => onPatch(i, { desc: e.target.value })}
                  placeholder="description"
                  style={{ ...inputBase, flex: 1, minWidth: 0, fontFamily: "var(--sans)" }}
                />
                {s.split && (
                  <span style={{ flex: "0 0 auto", fontFamily: "var(--sans)", fontSize: 9.5, color: "var(--acd)", border: "1px solid color-mix(in oklab, var(--ac) 35%, var(--line))", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>
                    split
                  </span>
                )}
              </div>
              <div style={{ marginTop: 9 }}>
                {s.tasks.map((t, j) => (
                  <div key={j} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                    <input
                      value={t.dir}
                      onChange={(e) => patchTask(i, j, { dir: e.target.value })}
                      placeholder="dir"
                      style={{ ...inputBase, flex: "0 0 84px", color: "var(--dim)", fontSize: 11.5 }}
                    />
                    <span style={{ color: "var(--ac)", flex: "0 0 auto" }}>❯</span>
                    <input
                      value={t.cmd}
                      onChange={(e) => patchTask(i, j, { cmd: e.target.value })}
                      placeholder="command"
                      style={{ ...inputBase, flex: 1, minWidth: 0 }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
          <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--dim)" }}>{selected} of {scripts.length} selected</span>
          <span style={{ flex: 1 }} />
          <span onClick={onCancel} style={{ cursor: "pointer", fontFamily: "var(--sans)", fontSize: 12, color: "var(--dim)", padding: "7px 12px" }}>
            Cancel
          </span>
          <span
            onClick={selected ? onAdopt : undefined}
            style={{
              cursor: selected ? "pointer" : "default",
              fontFamily: "var(--sans)",
              fontSize: 12,
              color: selected ? "var(--page)" : "var(--faint)",
              background: selected ? "var(--ac)" : "var(--line)",
              borderRadius: 8,
              padding: "7px 14px",
              fontWeight: 500,
            }}
          >
            Add {selected > 0 ? selected : ""} script{selected === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}
