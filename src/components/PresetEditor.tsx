// The preset editor (Frame 6): the full per-preset form — name, auto-select
// issue types, pane layout, on-open script, env vars, base override, port offset,
// two-way Jira sync — with delete / cancel / save.

import { useEffect, useState } from "react";
import { updatePreset, deletePreset } from "../lib/presets";
import { type Preset, type PaneLayout } from "../lib/repoConfig";
import { type EnvFileSpec } from "../lib/envFiles";
import { scriptsForRoot } from "../lib/scripts";
import { gitBranches } from "../lib/sys";

const LAYOUTS: { key: PaneLayout; label: string }[] = [
  { key: "1", label: "1" },
  { key: "2-split", label: "2-split" },
  { key: "2x2", label: "2×2" },
];

const fieldLabel = {
  fontFamily: "var(--sans)",
  fontSize: 10.5,
  letterSpacing: ".04em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
  marginBottom: 6,
};
const box = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--page)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "7px 10px",
};
const textInput = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--fg)",
  fontFamily: "var(--mono)",
  fontSize: 12.5,
  padding: 0,
};
// A monospace "surface" input for multi-line env-file templates — the box look
// applied directly to a textarea (border-box so width:100% + padding fits).
const codeArea = {
  width: "100%",
  boxSizing: "border-box" as const,
  background: "var(--page)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  outline: "none",
  color: "var(--fg)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  lineHeight: 1.5,
  padding: "7px 10px",
  resize: "vertical" as const,
  minHeight: 44,
};
// Template-token chip for the env-files legend — teaches the substitution
// vocabulary inline, so the feature is self-documenting.
const tokenChip = {
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  color: "var(--dim)",
  background: "var(--page)",
  border: "1px solid var(--line)",
  borderRadius: 5,
  padding: "2px 6px",
};

function Pills<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{ display: "flex", gap: 3, background: "var(--page)", border: "1px solid var(--line)", borderRadius: 7, padding: 3 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <span
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              flex: 1,
              textAlign: "center",
              fontFamily: "var(--sans)",
              fontSize: 11,
              borderRadius: 5,
              padding: "4px 8px",
              cursor: on ? "default" : "pointer",
              color: on ? "var(--page)" : "var(--dim)",
              background: on ? "var(--ac)" : "transparent",
              fontWeight: on ? 500 : 400,
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </span>
        );
      })}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      style={{ width: 38, height: 21, borderRadius: 999, background: on ? "var(--ac)" : "var(--line)", position: "relative", cursor: "pointer", flex: "0 0 auto" }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: on ? "var(--page)" : "var(--dim)", transition: "left .15s" }} />
    </div>
  );
}

export function PresetEditor({ root, preset, onClose }: { root: string; preset: Preset; onClose: () => void }) {
  const [draft, setDraft] = useState<Preset>(preset);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bases, setBases] = useState<string[]>([]);
  const scripts = scriptsForRoot(root);

  useEffect(() => {
    gitBranches(root).then((bl) => setBases(bl.branches));
  }, [root]);

  const patch = (p: Partial<Preset>) => setDraft((d) => ({ ...d, ...p }));
  const set = <K extends keyof Preset>(k: K, v: Preset[K]) => patch({ [k]: v } as Partial<Preset>);

  const issueTypesText = draft.issueTypes.join(", ");
  const envRows = Object.entries(draft.env);
  const portAuto = draft.portOffset === "auto";
  // Tolerate a preset built before the field existed (undefined) — migration
  // fills it, but never let the editor crash on a stray fixture.
  const envFiles = draft.envFiles ?? [];

  const updateEnvFile = (i: number, p: Partial<EnvFileSpec>) =>
    set("envFiles", envFiles.map((f, fi) => (fi === i ? { ...f, ...p } : f)));
  const removeEnvFile = (i: number) => set("envFiles", envFiles.filter((_, fi) => fi !== i));
  const addEnvFile = () => set("envFiles", [...envFiles, { path: "", content: "" }]);

  const save = () => {
    updatePreset(root, draft.id, draft);
    onClose();
  };
  const remove = () => {
    deletePreset(root, draft.id);
    onClose();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ color: "var(--ac)", fontSize: 14 }}>⚡</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>Edit preset</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--acd)" }}>{draft.name}</span>
      </div>

      <div className="ascroll" style={{ overflowY: "auto", maxHeight: "62vh", padding: "12px 18px 6px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={fieldLabel}>Name</div>
          <div style={box}>
            <input value={draft.name} onChange={(e) => set("name", e.target.value)} spellCheck={false} style={textInput} />
          </div>
        </div>

        <div>
          <div style={fieldLabel}>Auto-select for issue types (comma-separated)</div>
          <div style={box}>
            <input
              value={issueTypesText}
              onChange={(e) => set("issueTypes", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
              placeholder="Bug, Story, Task"
              spellCheck={false}
              style={{ ...textInput, fontFamily: "var(--sans)" }}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>Pane layout</div>
            <Pills options={LAYOUTS} value={draft.paneLayout} onChange={(v) => set("paneLayout", v)} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={fieldLabel}>On-open script</div>
            <select
              value={draft.runOnOpen ?? ""}
              onChange={(e) => set("runOnOpen", e.target.value || null)}
              style={{ ...box, width: "100%", minWidth: 0, color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12.5, appearance: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              <option value="">none</option>
              {scripts.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={fieldLabel}>Base override</div>
            <select
              value={draft.baseOverride ?? ""}
              onChange={(e) => set("baseOverride", e.target.value || null)}
              style={{ ...box, width: "100%", minWidth: 0, color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12.5, appearance: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              <option value="">inherit default</option>
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div style={fieldLabel}>Environment variables</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {envRows.map(([k, v], i) => (
              <div key={i} style={{ display: "flex", gap: 6 }}>
                <div style={{ ...box, flex: "0 0 40%" }}>
                  <input
                    value={k}
                    onChange={(e) => {
                      const next: Record<string, string> = {};
                      envRows.forEach(([ek, ev], ei) => (next[ei === i ? e.target.value : ek] = ev));
                      set("env", next);
                    }}
                    placeholder="NAME"
                    spellCheck={false}
                    style={textInput}
                  />
                </div>
                <div style={{ ...box, flex: 1 }}>
                  <input
                    value={v}
                    onChange={(e) => set("env", { ...draft.env, [k]: e.target.value })}
                    placeholder="value"
                    spellCheck={false}
                    style={textInput}
                  />
                </div>
                <span
                  onClick={() => {
                    const next = { ...draft.env };
                    delete next[k];
                    set("env", next);
                  }}
                  style={{ display: "flex", alignItems: "center", color: "var(--faint)", cursor: "pointer", padding: "0 4px" }}
                >
                  ×
                </span>
              </div>
            ))}
            <span
              onClick={() => set("env", { ...draft.env, "": "" })}
              style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--acd)", cursor: "pointer" }}
            >
              + add variable
            </span>
          </div>
        </div>

        <div>
          <div style={fieldLabel}>Env files · written into each new workspace</div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>Templates expand</span>
            <code style={tokenChip}>{"${port:3000}"} → 3010</code>
            <code style={tokenChip}>{"${offset}"}</code>
            <code style={tokenChip}>{"${workspace}"}</code>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {envFiles.map((f, i) => (
              <div
                key={i}
                style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <div style={{ ...box, flex: 1 }}>
                    <span style={{ color: "var(--faint)", fontFamily: "var(--mono)", fontSize: 12 }}>›</span>
                    <input
                      value={f.path}
                      onChange={(e) => updateEnvFile(i, { path: e.target.value })}
                      placeholder="apps/api/.env.local"
                      spellCheck={false}
                      style={textInput}
                    />
                  </div>
                  <span
                    onClick={() => removeEnvFile(i)}
                    style={{ display: "flex", alignItems: "center", color: "var(--faint)", cursor: "pointer", padding: "0 4px" }}
                  >
                    ×
                  </span>
                </div>
                <textarea
                  value={f.content}
                  onChange={(e) => updateEnvFile(i, { content: e.target.value })}
                  placeholder={"PORT=${port:3000}"}
                  spellCheck={false}
                  rows={2}
                  style={codeArea}
                />
              </div>
            ))}
            <span
              onClick={addEnvFile}
              style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--acd)", cursor: "pointer" }}
            >
              + add env file
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>Port offset</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span
                onClick={() => set("portOffset", portAuto ? 10 : "auto")}
                style={{
                  fontFamily: "var(--sans)",
                  fontSize: 11,
                  color: portAuto ? "var(--page)" : "var(--dim)",
                  background: portAuto ? "var(--ac)" : "transparent",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  padding: "5px 11px",
                  cursor: "pointer",
                }}
              >
                auto
              </span>
              {!portAuto && (
                <div style={{ ...box, flex: "0 0 120px" }}>
                  <span style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12.5 }}>+</span>
                  <input
                    type="number"
                    value={draft.portOffset === "auto" ? 0 : draft.portOffset}
                    onChange={(e) => set("portOffset", Math.max(0, parseInt(e.target.value || "0", 10)))}
                    style={textInput}
                  />
                </div>
              )}
            </div>
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }}>Two-way Jira sync</div>
            </div>
            <Toggle on={draft.jiraSync} onToggle={() => set("jiraSync", !draft.jiraSync)} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
        {confirmDelete ? (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--err)" }}>Delete this preset?</span>
            <span onClick={remove} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--page)", background: "var(--err)", borderRadius: 7, padding: "5px 12px", cursor: "pointer" }}>
              Delete
            </span>
            <span onClick={() => setConfirmDelete(false)} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--dim)", cursor: "pointer" }}>
              keep
            </span>
          </span>
        ) : (
          <span onClick={() => setConfirmDelete(true)} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--err)", cursor: "pointer" }}>
            Delete preset
          </span>
        )}
        <span
          onClick={onClose}
          style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 12, color: "var(--dim)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 15px", cursor: "pointer" }}
        >
          Cancel
        </span>
        <span
          onClick={save}
          style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--page)", background: "var(--ac)", borderRadius: 8, padding: "7px 16px", fontWeight: 500, cursor: "pointer" }}
        >
          Save preset
        </span>
      </div>
    </div>
  );
}
