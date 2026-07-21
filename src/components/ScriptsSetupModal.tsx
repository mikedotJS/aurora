// Primary scripts editor — the repo's `aurora.json` (managed-server-lifecycle
// task 5.4+, reshaped for the corrected model: "1 command → 1 pane, 1 run
// script → multiple commands"): three user-facing categories, laid out as
// distinct sections — Setup Script (`setup`, runs once at workspace create),
// Run Script (`run` — a single ORDERED LIST of commands; Run/⌘R launches every
// one together, each in its own split pane) and Custom Scripts (`custom.<id>`
// entries — arbitrary named scripts triggered on demand, one at a time, from
// the rail's ▾ run menu). Archive is a global/rare setting, grouped under a
// smaller "Advanced" row rather than competing with the three primary
// categories for attention. Local draft + explicit Save (like PresetEditor),
// not live-persisted per keystroke — aurora.json is a file write, not a
// localStorage mutation.
//
// For a repo with only legacy scripts (no committed aurora.json yet),
// `ensureAuroraConfigLoaded` already resolves the migrated view (see
// lib/auroraConfigStore.ts / lib/scriptsMigration.ts) — opening this editor
// shows those scripts (the onEnter script as Run Script commands, everything
// else as Custom Scripts), and clicking Save commits them as the repo's first
// aurora.json. That IS the migration path from this surface, same
// non-destructive contract as ScriptsSheet's banner (never runs unless the
// user explicitly saves).
//
// The "generate with AI" flow still asks Claude for the legacy Script[] shape
// (lib/aiScripts.ts's prompt/schema, task 5.5) — review is unchanged — but a
// generated Script is named/described, the same shape a Custom Scripts entry
// is, so adopting a reviewed script folds it into this draft's CUSTOM entries
// in-memory (via scriptsMigration.ts's scriptToCustomEntries) instead of
// writing to the legacy userScripts store. Promoting a custom script into the
// Run Script (if it's actually a server) is a manual copy-the-command step —
// Run has no "id" to adopt into, it's just an ordered command list.

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useStore, activePane, type Script } from "../state/store";
import { shortenCwd } from "../lib/sys";
import { commandSpecToShell, type AuroraConfig, type RunCommand, type CustomScript } from "../lib/auroraConfig";
import { ensureAuroraConfigLoaded, saveAuroraConfigEdit } from "../lib/auroraConfigStore";
import { scriptToCustomEntries } from "../lib/scriptsMigration";
import { slugify } from "../lib/branchName";
import { generateRepoScripts } from "../lib/aiScripts";
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
const fieldLabel: CSSProperties = {
  fontFamily: "var(--sans)",
  fontSize: 10.5,
  letterSpacing: ".05em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 5,
};
const sectionHint: CSSProperties = {
  fontFamily: "var(--sans)",
  fontSize: 11,
  color: "var(--faint)",
  marginTop: 2,
};
const emptyHint: CSSProperties = {
  fontFamily: "var(--sans)",
  fontSize: 12,
  color: "var(--faint)",
  padding: "8px 2px",
};
const dashedAddBtn: CSSProperties = {
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--sans)",
  fontSize: 12,
  color: "var(--acd)",
  border: "1px dashed var(--line)",
  borderRadius: 8,
  padding: "8px 14px",
};

function uniqueId(base: string, taken: Set<string>): string {
  const safe = slugify(base) || "script";
  let id = safe;
  for (let n = 2; taken.has(id); n++) id = `${safe}-${n}`;
  return id;
}

export function ScriptsSetupModal() {
  const closeScriptsSetup = useStore((s) => s.closeScriptsSetup);
  const home = useStore((s) => s.home);
  const pane = useStore((s) => activePane(s));
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const startKeyEntry = useStore((s) => s.startKeyEntry);
  const model = useStore((s) => s.settings.model);
  const root = pane ? (pane.repoRoot ?? pane.cwd) : null;

  const [draft, setDraft] = useState<AuroraConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [gen, setGen] = useState<GenState>({ kind: "idle" });

  useEffect(() => {
    setDraft(null);
    setSaveError(null);
    setGen({ kind: "idle" });
    if (!root) return;
    let cancelled = false;
    ensureAuroraConfigLoaded(root).then((cfg) => {
      if (!cancelled) setDraft(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const patchScripts = (p: Partial<AuroraConfig["scripts"]>) =>
    setDraft((d) => (d ? { ...d, scripts: { ...d.scripts, ...p } } : d));

  // ── Run Script (`scripts.run` — one ordered command list) ────────────────

  const addRunCommand = () =>
    setDraft((d) => (d ? { ...d, scripts: { ...d.scripts, run: [...d.scripts.run, { command: "" }] } } : d));

  const updateRunCommand = (i: number, patch: Partial<RunCommand>) =>
    setDraft((d) => {
      if (!d) return d;
      const run = d.scripts.run.map((rc, j) => (j === i ? { ...rc, ...patch } : rc));
      return { ...d, scripts: { ...d.scripts, run } };
    });

  const removeRunCommand = (i: number) =>
    setDraft((d) => {
      if (!d) return d;
      const run = d.scripts.run.filter((_, j) => j !== i);
      return { ...d, scripts: { ...d.scripts, run } };
    });

  const moveRunCommand = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.scripts.run.length) return d;
      const run = [...d.scripts.run];
      [run[i], run[j]] = [run[j], run[i]];
      return { ...d, scripts: { ...d.scripts, run } };
    });

  // ── Custom Scripts (`scripts.custom`) ─────────────────────────────────────

  const updateCustomEntry = (id: string, patch: Partial<CustomScript>) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = d.scripts.custom[id];
      if (!cur) return d;
      return { ...d, scripts: { ...d.scripts, custom: { ...d.scripts.custom, [id]: { ...cur, ...patch } } } };
    });

  const renameCustomEntry = (oldId: string, rawNewId: string) =>
    setDraft((d) => {
      if (!d) return d;
      const newId = slugify(rawNewId);
      if (!newId || newId === oldId || newId in d.scripts.custom) return d;
      const entry = d.scripts.custom[oldId];
      if (!entry) return d;
      const custom = { ...d.scripts.custom };
      delete custom[oldId];
      custom[newId] = entry;
      return { ...d, scripts: { ...d.scripts, custom } };
    });

  const removeCustomEntry = (id: string) =>
    setDraft((d) => {
      if (!d) return d;
      const custom = { ...d.scripts.custom };
      delete custom[id];
      return { ...d, scripts: { ...d.scripts, custom } };
    });

  const addCustomEntry = () =>
    setDraft((d) => {
      if (!d) return d;
      const id = uniqueId("task", new Set(Object.keys(d.scripts.custom)));
      return { ...d, scripts: { ...d.scripts, custom: { ...d.scripts.custom, [id]: { command: "" } } } };
    });

  const save = async () => {
    if (!root || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveAuroraConfigEdit(root, draft);
      setSaving(false);
      closeScriptsSetup();
    } catch (e) {
      setSaving(false);
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const generate = async () => {
    if (!root) return;
    if (!apiKeyPresent) {
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

  const patchReview = (i: number, patch: Partial<Script>) =>
    setGen((g) =>
      g.kind === "review" ? { ...g, scripts: g.scripts.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : g,
    );
  const toggleKeep = (i: number) =>
    setGen((g) => (g.kind === "review" ? { ...g, keep: g.keep.map((k, j) => (j === i ? !k : k)) } : g));

  // Fold reviewed legacy-shaped scripts into the draft's CUSTOM entries — AI
  // proposals are named/described, the same shape a custom script is; never
  // touches the legacy userScripts store (task 5.4).
  const adopt = () => {
    if (gen.kind !== "review" || !draft) return;
    const kept = gen.scripts.filter((_, i) => gen.keep[i]);
    const taken = new Set(Object.keys(draft.scripts.custom));
    const custom = { ...draft.scripts.custom };
    for (const script of kept) {
      for (const [id, entry] of scriptToCustomEntries(script, taken)) {
        custom[id] = entry;
      }
    }
    setDraft({ ...draft, scripts: { ...draft.scripts, custom } });
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

  const runCommands = draft?.scripts.run ?? [];
  const customEntries = draft ? Object.entries(draft.scripts.custom) : [];

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 26 }}>
      <div onClick={closeScriptsSetup} style={{ position: "absolute", inset: 0, background: "color-mix(in oklab, black 55%, transparent)", animation: "fadeIn .16s ease" }} />
      <div
        style={{
          position: "relative",
          width: "min(660px, 100%)",
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
          {root && <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>· {shortenCwd(root, home)} · aurora.json</span>}
          <span
            onClick={closeScriptsSetup}
            style={{ marginLeft: "auto", cursor: "pointer", fontSize: 18, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, color: "var(--dim)" }}
          >
            ×
          </span>
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "14px 18px 6px" }}>
          {!root ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "46px 20px", gap: 8, color: "var(--faint)", fontFamily: "var(--sans)", fontSize: 13 }}>
              <span style={{ fontSize: 22, color: "var(--line)" }}>⚡</span>
              <span>cd into a repo to edit its scripts</span>
            </div>
          ) : !draft ? (
            <div style={{ padding: "46px 20px", textAlign: "center", color: "var(--faint)", fontFamily: "var(--sans)", fontSize: 13 }}>loading…</div>
          ) : (
            <>
              {/* ── Setup Script ─────────────────────────────────────────── */}
              <SectionHeading title="Setup Script" hint="runs once, right after workspace create" first />
              <input
                value={commandSpecToShell(draft.scripts.setup) ?? ""}
                onChange={(e) => patchScripts({ setup: e.target.value || null })}
                placeholder="e.g. bun install"
                spellCheck={false}
                style={{ ...inputBase, width: "100%", boxSizing: "border-box" }}
              />

              {/* ── Run Script ───────────────────────────────────────────── */}
              <SectionHeading title="Run Script" hint="servers — an ordered list of commands; Run / ⌘R launches every one together, each in its own split pane" />
              {runCommands.length === 0 && (
                <div style={emptyHint}>
                  no run commands yet — the Run/Stop button in the rail shows up once you add one
                </div>
              )}
              {runCommands.map((entry, i) => (
                <RunCommandRow
                  key={i}
                  index={i}
                  total={runCommands.length}
                  entry={entry}
                  onPatch={(p) => updateRunCommand(i, p)}
                  onRemove={() => removeRunCommand(i)}
                  onMove={(dir) => moveRunCommand(i, dir)}
                />
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 0 4px" }}>
                <span onClick={addRunCommand} style={dashedAddBtn}>
                  + add run command
                </span>
              </div>

              {/* ── Custom Scripts ───────────────────────────────────────── */}
              <SectionHeading title="Custom Scripts" hint="run on demand, one at a time — from the rail's ▾ run menu" />
              {customEntries.length === 0 && (
                <div style={emptyHint}>no custom scripts yet — add one, then trigger it from the ▾ run menu</div>
              )}
              {customEntries.map(([id, entry]) => (
                <CustomScriptRow
                  key={id}
                  id={id}
                  entry={entry}
                  onRename={(newId) => renameCustomEntry(id, newId)}
                  onPatch={(p) => updateCustomEntry(id, p)}
                  onRemove={() => removeCustomEntry(id)}
                />
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 0 4px" }}>
                <span onClick={addCustomEntry} style={dashedAddBtn}>
                  + add custom script
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
                  <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--err, #e5484d)", minWidth: 0 }}>{gen.message}</span>
                )}
              </div>

              {/* ── Advanced (Archive) ────────────────────────────────────── */}
              <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
                <div style={{ ...fieldLabel, marginBottom: 10 }}>Advanced</div>
                <div style={{ flex: "1 1 200px", minWidth: 160 }}>
                  <div style={fieldLabel}>Archive script · once, right before teardown</div>
                  <input
                    value={commandSpecToShell(draft.scripts.archive) ?? ""}
                    onChange={(e) => patchScripts({ archive: e.target.value || null })}
                    placeholder="e.g. docker compose down"
                    spellCheck={false}
                    style={{ ...inputBase, width: "100%", boxSizing: "border-box", fontSize: 11.5 }}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {root && draft && (
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
            {saveError && <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--err)" }}>{saveError}</span>}
            <span style={{ flex: 1 }} />
            <span onClick={closeScriptsSetup} style={{ cursor: "pointer", fontFamily: "var(--sans)", fontSize: 12, color: "var(--dim)", padding: "7px 12px" }}>
              Cancel
            </span>
            <span
              onClick={saving ? undefined : save}
              style={{
                cursor: saving ? "default" : "pointer",
                opacity: saving ? 0.7 : 1,
                fontFamily: "var(--sans)",
                fontSize: 12,
                color: "var(--page)",
                background: "var(--ac)",
                borderRadius: 8,
                padding: "7px 16px",
                fontWeight: 500,
              }}
            >
              {saving ? "Saving…" : "Save aurora.json"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A section title + one-line hint — the typographic hierarchy that makes the
 *  three script categories (and the Advanced row) read as distinct, named
 *  blocks rather than one flat list of fields. Same font stack/palette as the
 *  rest of the modal (`var(--sans)`/`var(--fg)`/`var(--faint)`), just
 *  promoted a step above `fieldLabel` — a restructure of the existing
 *  typographic system, not a new one. */
function SectionHeading({ title, hint, first }: { title: string; hint: string; first?: boolean }) {
  return (
    <div style={{ margin: first ? "2px 0 9px" : "20px 0 9px" }}>
      <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)" }}>{title}</div>
      <div style={sectionHint}>{hint}</div>
    </div>
  );
}

/** One `scripts.run[i]` row — no id (order IS the identity): reorder via ▲▼,
 *  a command field, an optional pane-label `name`, an optional `cwd`, remove. */
function RunCommandRow({
  index,
  total,
  entry,
  onPatch,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  entry: RunCommand;
  onPatch: (patch: Partial<RunCommand>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const canUp = index > 0;
  const canDown = index < total - 1;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 13px", margin: "10px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: "0 0 auto" }}>
          <span
            onClick={canUp ? () => onMove(-1) : undefined}
            title="move up"
            style={{ cursor: canUp ? "pointer" : "default", opacity: canUp ? 1 : 0.3, fontSize: 9, lineHeight: 1, color: "var(--faint)" }}
          >
            ▲
          </span>
          <span
            onClick={canDown ? () => onMove(1) : undefined}
            title="move down"
            style={{ cursor: canDown ? "pointer" : "default", opacity: canDown ? 1 : 0.3, fontSize: 9, lineHeight: 1, color: "var(--faint)" }}
          >
            ▼
          </span>
        </div>
        <input
          value={entry.command}
          onChange={(e) => onPatch({ command: e.target.value })}
          placeholder="command — e.g. bun run dev -p $AURORA_PORT"
          spellCheck={false}
          style={{ ...inputBase, flex: 1, minWidth: 0 }}
        />
        <span onClick={onRemove} title="remove" style={{ cursor: "pointer", color: "var(--faint)", fontSize: 15, flex: "0 0 auto" }}>
          ×
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)" }}>name</span>
          <input
            value={entry.name ?? ""}
            onChange={(e) => onPatch({ name: e.target.value || undefined })}
            placeholder="pane label (optional)"
            spellCheck={false}
            style={{ ...inputBase, width: 148, color: "var(--dim)", fontSize: 11.5 }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)" }}>cwd</span>
          <input
            value={entry.cwd ?? ""}
            onChange={(e) => onPatch({ cwd: e.target.value || undefined })}
            placeholder="."
            spellCheck={false}
            style={{ ...inputBase, width: 84, color: "var(--dim)", fontSize: 11.5 }}
          />
        </div>
      </div>
    </div>
  );
}

/** One `custom.<id>` entry: id (renames on blur — collision/empty is a no-op),
 *  command, cwd, remove. */
function CustomScriptRow({
  id,
  entry,
  onRename,
  onPatch,
  onRemove,
}: {
  id: string;
  entry: CustomScript;
  onRename: (newId: string) => void;
  onPatch: (patch: Partial<CustomScript>) => void;
  onRemove: () => void;
}) {
  const [idText, setIdText] = useState(id);
  useEffect(() => setIdText(id), [id]);

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 13px", margin: "10px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <input
          value={idText}
          onChange={(e) => setIdText(e.target.value)}
          onBlur={() => onRename(idText)}
          placeholder="id"
          spellCheck={false}
          style={{ ...inputBase, flex: "0 0 118px", color: "var(--ac)" }}
        />
        <input
          value={entry.command}
          onChange={(e) => onPatch({ command: e.target.value })}
          placeholder="command — e.g. bun run lint"
          spellCheck={false}
          style={{ ...inputBase, flex: 1, minWidth: 0 }}
        />
        <span onClick={onRemove} title="remove" style={{ cursor: "pointer", color: "var(--faint)", fontSize: 15, flex: "0 0 auto" }}>
          ×
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)" }}>cwd</span>
          <input
            value={entry.cwd ?? ""}
            onChange={(e) => onPatch({ cwd: e.target.value || undefined })}
            placeholder="."
            spellCheck={false}
            style={{ ...inputBase, width: 84, color: "var(--dim)", fontSize: 11.5 }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Review step for AI-generated scripts: the user edits the proposals and picks
 * which to keep before they're folded into the aurora.json draft. Nothing here
 * runs a command or writes to disk.
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
          Claude proposed these — edit and pick which to keep, then <span style={{ color: "var(--acd)" }}>Save aurora.json</span> to persist them.
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
