// Editor for per-repo scripts + the onEnter hook. Persists via lib/scripts.

import type { CSSProperties } from "react";
import { useStore, activePane } from "../state/store";
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
  const root = pane ? (pane.repoRoot ?? pane.cwd) : null;
  void userScripts; // re-render on edits
  const scripts = scriptsForRoot(root);
  const onEnter = onEnterFor(root) ?? "";

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
                      onClick={() => pane && runScript(pane.id, s.name)}
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

              <div style={{ padding: "13px 16px 16px" }}>
                <span
                  onClick={() => addScript(root)}
                  style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--sans)", fontSize: 12, color: "var(--acd)", border: "1px dashed var(--line)", borderRadius: 8, padding: "8px 14px" }}
                >
                  + add script
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
