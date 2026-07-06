// The per-repo settings panel: Integrations (Jira binding + project), Presets,
// and New-workspace defaults. Persists per repo (keyed by root) and feeds
// workspace creation. Credentials live in the global connection pool
// (Settings → Connections); this panel only *binds* to them.
// Hosts the preset editor and the branch-naming editor as sub-views.

import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "../state/store";
import {
  getRepoConfig,
  updateRepoConfig,
  saveRepoConfig,
  hasSavedConfig,
  type Preset,
} from "../lib/repoConfig";
import { addPreset } from "../lib/presets";
import { type BranchNamingConfig } from "../lib/branchNaming";
import { gitBranches } from "../lib/sys";
import { jiraProjectStatuses, repoJira } from "../lib/jira";
import { siteHost } from "../lib/connections";
import { PresetEditor } from "./PresetEditor";
import { BranchNamingEditor } from "./BranchNamingEditor";

const BRANCH_SOURCE_LABEL: Record<BranchNamingConfig["source"], string> = {
  manual: "Token template",
  "package-json": "Bound to package.json",
  validator: "Inferred from validator",
  ai: "AI instruction",
};

function Section({ title }: { title: string }) {
  return (
    <div style={{ padding: "16px 18px 7px", fontFamily: "var(--sans)", fontSize: 10.5, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--faint)" }}>
      {title}
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 18px" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ display: "flex", gap: 7, flex: "0 0 auto", alignItems: "center" }}>{children}</div>
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div onClick={onToggle} style={{ width: 38, height: 21, borderRadius: 999, background: on ? "var(--ac)" : "var(--line)", position: "relative", cursor: "pointer", flex: "0 0 auto" }}>
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: on ? "var(--page)" : "var(--dim)", transition: "left .15s" }} />
    </div>
  );
}

const textBox = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--page)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "5px 9px",
  minWidth: 150,
};
const textInput = { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12, padding: 0 };
// A `<select>` sizes to its widest <option>, so a long branch name would blow out
// the row and crush the label. Fix its width and ellipsize the shown value.
const selectStyle = {
  flex: "0 0 auto" as const,
  width: 180,
  maxWidth: 180,
  background: "var(--page)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "6px 9px",
  color: "var(--fg)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  appearance: "none" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};
// Narrower select for the two side-by-side sync-status pickers.
const statusSelectStyle = { ...selectStyle, width: 148, maxWidth: 148 };
const linkPill = {
  fontFamily: "var(--sans)",
  fontSize: 11.5,
  color: "var(--acd)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  padding: "4px 11px",
  cursor: "pointer",
} as const;

export function WorkspaceSettings() {
  const root = useStore((s) => s.workspaceSettingsRepo);
  const close = useStore((s) => s.closeWorkspaceSettings);
  // subscribe so edits re-render; cfg is derived below.
  useStore((s) => s.repoConfigs);
  const repos = useStore((s) => s.repos);
  const connections = useStore((s) => s.connections);
  const openSettings = useStore((s) => s.openSettings);
  const [view, setView] = useState<{ kind: "main" } | { kind: "preset"; preset: Preset } | { kind: "branch" }>({ kind: "main" });
  const [bases, setBases] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  // Seed the built-in config on first open of this repo's settings.
  useEffect(() => {
    if (root && !hasSavedConfig(root)) saveRepoConfig(getRepoConfig(root));
  }, [root]);
  useEffect(() => {
    if (root) gitBranches(root).then((bl) => setBases(bl.branches));
  }, [root]);

  // Pull the project's real workflow statuses (via the repo's bound Jira
  // connection) so the sync pickers offer actual statuses; falls back to free
  // text when unbound / no project key yet.
  const projectKey = root ? getRepoConfig(root).integrations.jiraProjectKey.trim() : "";
  const boundConnId = root ? (repoJira(root)?.connId ?? "") : "";
  useEffect(() => {
    const rj = root ? repoJira(root) : null;
    if (!rj || !projectKey) {
      setStatuses([]);
      return;
    }
    let cancelled = false;
    jiraProjectStatuses(rj.connId, rj.site, rj.email, projectKey).then((s) => {
      if (!cancelled) setStatuses(s);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundConnId, projectKey]);

  if (!root) return null;
  const cfg = getRepoConfig(root);
  const repoName = repos.find((r) => r.id === root)?.name ?? root.split("/").filter(Boolean).pop() ?? root;

  // Jump to the global connection pool (app settings).
  const openConnections = () => {
    close();
    openSettings();
  };

  const setDefaults = (p: Partial<typeof cfg.defaults>) => updateRepoConfig(root, (c) => Object.assign(c.defaults, p));
  const setIntegrations = (p: Partial<typeof cfg.integrations>) => updateRepoConfig(root, (c) => Object.assign(c.integrations, p));

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={close} style={{ position: "absolute", inset: 0, background: "color-mix(in oklab, black 55%, transparent)", animation: "fadeIn .16s ease" }} />
      <div
        style={{
          position: "relative",
          width: "min(640px, 100%)",
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
        {/* header */}
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "15px 18px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--acd)", fontSize: 14 }}>⚙</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>Repo settings</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--faint)" }}>· {repoName}</span>
          {view.kind !== "main" && (
            <span onClick={() => setView({ kind: "main" })} style={{ marginLeft: 14, fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--acd)", cursor: "pointer" }}>
              ‹ all settings
            </span>
          )}
          <span onClick={close} style={{ marginLeft: "auto", cursor: "pointer", fontSize: 18, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, color: "var(--dim)" }}>
            ×
          </span>
        </div>

        {view.kind === "preset" ? (
          <PresetEditor root={root} preset={view.preset} onClose={() => setView({ kind: "main" })} />
        ) : view.kind === "branch" ? (
          <div style={{ padding: "16px 18px" }} className="ascroll">
            <BranchNamingEditor value={cfg.defaults.branchNaming} repoDir={root} onChange={(b) => setDefaults({ branchNaming: b })} />
          </div>
        ) : (
          <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "4px 0 16px" }}>
            {/* Integrations */}
            <Section title="Integrations" />
            <Row label="Jira connection" desc="Which Jira site this repo uses · add sites in Settings → Connections.">
              {connections.jira.length === 0 ? (
                <span onClick={openConnections} style={linkPill}>Connect a site…</span>
              ) : (
                <select value={cfg.integrations.jiraConnectionId ?? ""} onChange={(e) => setIntegrations({ jiraConnectionId: e.target.value || null })} style={selectStyle}>
                  <option value="">none</option>
                  {connections.jira.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label || siteHost(c.site)}
                    </option>
                  ))}
                </select>
              )}
            </Row>
            <Row label="Jira project key" desc="Scopes issue search to this project.">
              <div style={textBox}>
                <input value={cfg.integrations.jiraProjectKey} onChange={(e) => setIntegrations({ jiraProjectKey: e.target.value })} placeholder="PROJ" spellCheck={false} style={{ ...textInput, color: "var(--jira)" }} />
              </div>
            </Row>
            <Row label="Sync status names" desc={statuses.length ? "Pulled from the project workflow; applied on start / merge." : "Status to set on start / merge (bind a connection + set a project key to pick from the workflow)."}>
              <StatusField caption="on start" value={cfg.integrations.jiraInProgress ?? "In Progress"} fallback="In Progress" options={statuses} onChange={(v) => setIntegrations({ jiraInProgress: v })} />
              <StatusField caption="on merge" value={cfg.integrations.jiraDone ?? "Done"} fallback="Done" options={statuses} onChange={(v) => setIntegrations({ jiraDone: v })} />
            </Row>
            <Row label="GitLab" desc="Detected from the repo's git remote via the glab CLI.">
              <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--faint)" }}>auto · via glab</span>
            </Row>
            <Row label="Two-way sync by default" desc="New workspaces sync status & MR links to Jira.">
              <Toggle on={cfg.defaults.jiraSyncDefault} onToggle={() => setDefaults({ jiraSyncDefault: !cfg.defaults.jiraSyncDefault })} />
            </Row>

            {/* AI account picker intentionally omitted: multi-account AI is
                DEFERred (see docs/workspaces-reprise-roadmap.md). `aiDefaultId`
                is persisted for forward-compat but read by no AI call, so
                surfacing a picker here would be a dead knob — the flow keeps the
                single terminal key until the account-pool wiring lands. */}

            {/* Presets */}
            <Section title="Presets" />
            {cfg.presets.map((p) => (
              <div
                key={p.id}
                onClick={() => setView({ kind: "preset", preset: p })}
                style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 12px", padding: "9px 8px", borderRadius: 8, cursor: "pointer", borderBottom: "1px solid color-mix(in oklab, var(--line) 50%, transparent)" }}
              >
                <span style={{ color: "var(--ac)" }}>⚡</span>
                <span style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)", flex: "0 0 auto" }}>{p.name}</span>
                <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.paneLayout} · {p.issueTypes.length ? p.issueTypes.join("/") : "no auto-types"}
                </span>
                <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 13 }}>›</span>
              </div>
            ))}
            <div style={{ padding: "8px 18px 2px" }}>
              <AddChip label="+ New preset" onClick={() => setView({ kind: "preset", preset: addPreset(root) })} />
            </div>

            {/* New-workspace defaults */}
            <Section title="New-workspace defaults" />
            <Row label="Branch naming" desc={BRANCH_SOURCE_LABEL[cfg.defaults.branchNaming.source]}>
              <span onClick={() => setView({ kind: "branch" })} style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--acd)", border: "1px solid var(--line)", borderRadius: 6, padding: "4px 11px", cursor: "pointer" }}>
                edit
              </span>
            </Row>
            <Row label="Default base branch" desc="Where new branches fork from.">
              <select value={cfg.defaults.baseBranch} onChange={(e) => setDefaults({ baseBranch: e.target.value })} style={selectStyle}>
                {[cfg.defaults.baseBranch, ...bases.filter((b) => b !== cfg.defaults.baseBranch)].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Show rail on launch" desc="Open with the workspace rail expanded.">
              <Toggle on={cfg.defaults.showRailOnLaunch} onToggle={() => setDefaults({ showRailOnLaunch: !cfg.defaults.showRailOnLaunch })} />
            </Row>

          </div>
        )}
      </div>
    </div>
  );
}

// One sync-status picker: a dropdown of the project's real workflow statuses,
// or a free-text box when none are available yet (Jira not connected / no key).
// `value` is preserved as an option even if absent from `options`, so a status
// configured before the workflow loaded is never silently dropped.
function StatusField({
  caption,
  value,
  fallback,
  options,
  onChange,
}: {
  caption: string;
  value: string;
  fallback: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const cur = value || fallback;
  const opts = options.includes(cur) ? options : [cur, ...options];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: "var(--sans)", fontSize: 9.5, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--faint)", paddingLeft: 2 }}>{caption}</span>
      {options.length === 0 ? (
        <div style={{ ...textBox, width: 148, minWidth: 148 }}>
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={fallback} spellCheck={false} style={{ ...textInput, fontFamily: "var(--sans)" }} />
        </div>
      ) : (
        <select value={cur} onChange={(e) => onChange(e.target.value)} style={statusSelectStyle}>
          {opts.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function AddChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <span
      onClick={onClick}
      style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--acd)", border: "1px dashed var(--line)", borderRadius: 7, padding: "5px 11px", cursor: "pointer" }}
    >
      {label}
    </span>
  );
}
