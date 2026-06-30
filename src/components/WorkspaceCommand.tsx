// ⌘K command palette: filter existing workspaces to switch, search Jira issues
// (when connected) to seed new work, or create from a source. ↵ switches /
// creates / opens an issue, ⇥ opens the scope form, ↑↓ navigate, Esc closes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useStore, activeWorkspace, type Repo, type Workspace } from "../state/store";
import { StatusDot } from "./WorkspaceRail";
import { WorkspaceScopeForm, type ScopeInitial } from "./WorkspaceScopeForm";
import { buildBranchName, slugify } from "../lib/branchName";
import { runCreate, buildCreateSpec, resolveCreateDefaults, type CreateSource } from "../lib/create";
import { listPresets } from "../lib/presets";
import { jiraSearch, repoJira, type JiraIssue } from "../lib/jira";

interface SourceDef {
  key: CreateSource;
  glyph: string;
  label: string;
}
const SOURCES: SourceDef[] = [
  { key: "jira", glyph: "▦", label: "a Jira issue" },
  { key: "branch", glyph: "⎇", label: "a new branch off base" },
  { key: "describe", glyph: "✦", label: "a plain-language description" },
  { key: "clone", glyph: "⧉", label: "a clone of this workspace" },
];

interface FormState {
  source: CreateSource;
  repo: Repo;
  initial: ScopeInitial;
}

type Item =
  | { kind: "ws"; ws: Workspace }
  | { kind: "jira"; issue: JiraIssue }
  | { kind: "source"; src: SourceDef };

export function WorkspaceCommand() {
  const command = useStore((s) => s.command);
  const setQuery = useStore((s) => s.setCommandQuery);
  const moveCommand = useStore((s) => s.moveCommand);
  const setSel = useStore((s) => s.setCommandSel);
  const closeCommand = useStore((s) => s.closeCommand);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const setCommandRepo = useStore((s) => s.setCommandRepo);
  const workspaces = useStore((s) => s.workspaces);
  const repos = useStore((s) => s.repos);
  const active = useStore(activeWorkspace);
  // Subscribe so the bound-connection resolution re-runs when the pool / configs change.
  useStore((s) => s.connections);
  useStore((s) => s.repoConfigs);

  const [form, setForm] = useState<FormState | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([]);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);

  const query = command?.query ?? "";
  const sel = command?.sel ?? 0;

  useEffect(() => {
    if (!form) inputRef.current?.focus();
  }, [form]);

  // The repo new workspaces are created under: an explicit target (a repo's "+"
  // in the rail), else the active workspace's repo, else the first known repo.
  const targetRepoId = command?.repoId ?? null;
  const repo: Repo | undefined = useMemo(() => {
    if (targetRepoId) {
      const r = repos.find((x) => x.id === targetRepoId);
      if (r) return r;
    }
    if (active?.repoId) return repos.find((r) => r.id === active.repoId);
    return repos[0];
  }, [active, repos, targetRepoId]);

  // Multiple repos with no active workspace and no explicit pin → creation target
  // is ambiguous and must be chosen explicitly via the chip.
  const noContext = repos.length > 1 && !active && !targetRepoId;

  // Resolved defaults to show under branch/clone rows before ↵ is pressed.
  // Both helpers delegate to resolveCreateDefaults so displayed values and the
  // actual CreateSpec built by buildCreateSpec can never drift.
  const branchDisplayDefaults = useMemo(() => {
    if (!repo) return null;
    const list = listPresets(repo.root);
    const preset = list.find((p) => p.name === "feature") ?? list[0] ?? null;
    const { base, presetName, scriptName } = resolveCreateDefaults({ repo, preset });
    return { base, presetName, script: scriptName };
  }, [repo]);

  const cloneDisplayDefaults = useMemo(() => {
    if (!repo) return null;
    const presetName = active?.preset ?? null;
    const list = listPresets(repo.root);
    const preset = presetName ? list.find((p) => p.name === presetName) ?? null : null;
    const { base, scriptName } = resolveCreateDefaults({
      repo,
      preset,
      baseBranch: active?.branch ?? repo.defaultBranch,
    });
    return { base, presetName, script: scriptName };
  }, [repo, active]);

  // The Jira connection this repo is bound to (from the pool), or null.
  const rj = repo ? repoJira(repo.root) : null;
  const jiraConnected = !!rj;

  // Debounced Jira search (empty query → my issues). Degrades to [] silently.
  useEffect(() => {
    if (!rj) {
      setJiraIssues([]);
      return;
    }
    let live = true;
    const t = setTimeout(
      () => {
        void jiraSearch(rj.connId, rj.site, rj.email, query.trim()).then((res) => {
          if (live) setJiraIssues(res);
        });
      },
      query.trim() ? 280 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // rj is recomputed each render; the stable connId/site/email drive re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, rj?.connId, rj?.site, rj?.email]);

  const q = query.trim().toLowerCase();
  const matches = workspaces.filter(
    (w) => q && [w.issueKey, w.title, w.branch].some((x) => x?.toLowerCase().includes(q)),
  );
  // Drop the "Jira issue" source row when connected (issues are listed live).
  const sources = SOURCES.filter((s) => s.key !== "jira" || !jiraConnected);

  const items: Item[] = useMemo(
    () => [
      ...matches.map((ws) => ({ kind: "ws" as const, ws })),
      ...jiraIssues.map((issue) => ({ kind: "jira" as const, issue })),
      ...sources.map((src) => ({ kind: "source" as const, src })),
    ],
    [matches, jiraIssues, sources],
  );
  const count = items.length;
  const clamped = Math.min(sel, Math.max(0, count - 1));

  const openJiraIssue = (issue: JiraIssue) => {
    if (!repo || noContext) return;
    setForm({
      source: "jira",
      repo,
      initial: {
        issueKey: issue.key,
        issueType: issue.issue_type,
        title: issue.summary,
        branch: buildBranchName({ issueKey: issue.key, title: issue.summary }),
      },
    });
  };

  const openForm = (source: CreateSource) => {
    if (!repo || noContext) return;
    let initial: ScopeInitial;
    if (source === "clone") {
      initial = {
        title: `${active?.title ?? repo.name} (copy)`,
        branch: `${slugify(active?.branch ?? "work")}-copy`,
        newBranch: true,
        // Seed base branch + preset so ⇥ (form) and ↵ (quickCreate) are identical.
        baseBranch: active?.branch,
        preset: active?.preset,
      };
    } else if (source === "describe") {
      const text = query.trim();
      initial = { title: text || "new workspace", branch: buildBranchName({ title: text || "work" }) };
    } else {
      // branch
      initial = { title: query.trim() || "", branch: query.trim() };
    }
    setForm({ source, repo, initial });
  };

  // The repo's default preset (named "feature", else the first configured one).
  const defaultPreset = (root: string) => {
    const list = listPresets(root);
    return list.find((p) => p.name === "feature") ?? list[0];
  };

  // ↵ create-with-defaults for the simple sources; others open the form.
  const quickCreate = async (source: CreateSource) => {
    if (!repo || noContext) return;
    if (source === "clone") {
      const preset = active?.preset ? listPresets(repo.root).find((p) => p.name === active.preset) ?? null : null;
      const res = await runCreate(
        buildCreateSpec({
          repo,
          source: "clone",
          preset,
          branch: `${slugify(active?.branch ?? "work")}-copy`,
          title: `${active?.title ?? repo.name} (copy)`,
          baseBranch: active?.branch ?? repo.defaultBranch,
          newBranch: true,
          // no scriptName → falls back to preset.runOnOpen
        }),
      );
      if (res.ok) closeCommand();
      else setCreateError(res.error);
      return;
    }
    if (source === "branch" && query.trim()) {
      const preset = defaultPreset(repo.root);
      const res = await runCreate(
        buildCreateSpec({
          repo,
          source: "branch",
          preset: preset ?? null,
          branch: query.trim(),
          title: query.trim(),
          newBranch: true,
          // no baseBranch → buildCreateSpec resolves preset.baseOverride → cfg.defaults → repo.defaultBranch
          // no scriptName → falls back to preset.runOnOpen
        }),
      );
      if (res.ok) closeCommand();
      else setCreateError(res.error);
      return;
    }
    openForm(source);
  };

  const activateAt = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "ws") {
      switchWorkspace(item.ws.id);
      closeCommand();
    } else if (item.kind === "jira") {
      openJiraIssue(item.issue);
    } else {
      quickCreate(item.src.key);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return void (e.preventDefault(), closeCommand());
    if (e.key === "ArrowDown") return void (e.preventDefault(), moveCommand(1, count));
    if (e.key === "ArrowUp") return void (e.preventDefault(), moveCommand(-1, count));
    if (e.key === "Enter") return void (e.preventDefault(), activateAt(clamped));
    if (e.key === "Tab") {
      e.preventDefault();
      const item = items[clamped];
      if (item?.kind === "source") openForm(item.src.key);
      else if (item?.kind === "jira") openJiraIssue(item.issue);
    }
  };

  const openRepoMenu = () => {
    if (chipRef.current) {
      const rect = chipRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setRepoMenuOpen(true);
  };

  // index where each section starts in the flat list
  const jiraStart = matches.length;
  const sourceStart = matches.length + jiraIssues.length;

  return (
    <div
      onMouseDown={closeCommand}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "color-mix(in oklab, var(--page) 55%, transparent)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        animation: "fadeIn .12s ease",
      }}
    >
      <div
        role="dialog"
        aria-label="Workspace command"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 600,
          maxWidth: "92vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--win)",
          border: "1px solid var(--line)",
          borderRadius: 13,
          overflow: "hidden",
          fontFamily: "var(--mono)",
          boxShadow: "0 34px 90px -30px rgba(0,0,0,.6)",
          // centered by the flex parent, so popIn animates only Y/scale (no X jump)
          animation: "popIn .16s cubic-bezier(.2,.72,.2,1)",
        }}
      >
        {form ? (
          <WorkspaceScopeForm repo={form.repo} source={form.source} initial={form.initial} onCancel={() => setForm(null)} />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid var(--line)" }}>
              <span style={{ color: "var(--acd)", fontSize: 14 }}>✦</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={jiraConnected ? "Switch, search Jira, or describe / name a workspace…" : "Switch workspace, or describe / name one to create…"}
                spellCheck={false}
                autoComplete="off"
                style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 15, padding: 0 }}
              />
              {/* Target repo chip — always visible, changeable when >1 repo */}
              {repos.length > 0 && (
                <span
                  ref={chipRef}
                  onClick={repos.length > 1 ? openRepoMenu : undefined}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontFamily: "var(--sans)",
                    fontSize: 10.5,
                    color: noContext ? "var(--warn-d)" : "var(--dim)",
                    background: "var(--page)",
                    border: `1px solid ${noContext ? "color-mix(in oklab, var(--warn-d) 60%, transparent)" : "var(--line)"}`,
                    borderRadius: 5,
                    padding: "2px 7px",
                    cursor: repos.length > 1 ? "pointer" : "default",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {noContext ? "Choose repo" : (repo?.name ?? "?")}
                  {repos.length > 1 && <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>}
                </span>
              )}
              <span style={{ fontFamily: "var(--sans)", fontSize: 10, color: "var(--faint)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>esc</span>
            </div>
            {/* Repo picker dropdown — rendered as fixed overlay to escape overflow:hidden */}
            {repoMenuOpen && repos.length > 1 && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 89 }} onMouseDown={() => setRepoMenuOpen(false)} />
                <div
                  style={{
                    position: "fixed",
                    top: menuPos?.top ?? 0,
                    right: menuPos?.right ?? 0,
                    background: "var(--win)",
                    border: "1px solid var(--line)",
                    borderRadius: 9,
                    boxShadow: "0 8px 28px -8px rgba(0,0,0,.5)",
                    minWidth: 170,
                    zIndex: 90,
                    overflow: "hidden",
                    fontFamily: "var(--sans)",
                  }}
                >
                  {repos.map((r) => (
                    <RepoMenuItem
                      key={r.id}
                      name={r.name}
                      selected={r.id === (targetRepoId ?? active?.repoId ?? null)}
                      onPick={() => {
                        setCommandRepo(r.id);
                        setRepoMenuOpen(false);
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            <div className="ascroll" style={{ maxHeight: 460, overflowY: "auto", padding: "8px 0 10px" }}>
              {!repo && (
                <div style={{ padding: "14px 18px", fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--warn-d)" }}>
                  Open a git repository to create workspaces.
                </div>
              )}
              {matches.length > 0 && (
                <>
                  <Section label="Switch to" />
                  {matches.map((w, i) => (
                    <Row key={w.id} active={i === clamped} onHover={() => setSel(i)} onClick={() => activateAt(i)}>
                      <StatusDot ws={w} />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }}>
                        {w.issueKey ? `${w.issueKey} · ${w.title}` : w.title}
                      </span>
                      {w.branch && <span style={{ fontSize: 11, color: "var(--faint)" }}>⎇ {w.branch}</span>}
                    </Row>
                  ))}
                </>
              )}

              {jiraIssues.length > 0 && (
                <>
                  <Section label={q ? "Jira · matching issues" : "Jira · my sprint"} />
                  {jiraIssues.map((iss, i) => {
                    const idx = jiraStart + i;
                    return (
                      <Row key={iss.key} active={idx === clamped} dim={noContext} onHover={() => setSel(idx)} onClick={noContext ? () => undefined : () => activateAt(idx)}>
                        <span style={{ color: "var(--jira)", width: 16, textAlign: "center", flex: "0 0 auto" }}>▦</span>
                        <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--jira)", flex: "0 0 auto" }}>{iss.key}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }}>
                          {iss.summary}
                        </span>
                        {iss.status && (
                          <span style={{ flex: "0 0 auto", fontFamily: "var(--sans)", fontSize: 10, color: "var(--dim)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 6px" }}>
                            {iss.status}
                          </span>
                        )}
                      </Row>
                    );
                  })}
                </>
              )}

              {jiraConnected && jiraIssues.length === 0 && (
                <>
                  <Section label="Jira" />
                  <div style={{ padding: "2px 18px 8px", fontFamily: "var(--sans)", fontSize: 12, color: "var(--faint)" }}>
                    {q ? "No matching issues — try an issue key like PROJ-123." : "Type an issue key or keywords to find your Jira issues."}
                  </div>
                </>
              )}

              <Section label="Create new workspace from…" />
              {noContext && (
                <div style={{ padding: "2px 18px 8px", fontFamily: "var(--sans)", fontSize: 12, color: "var(--faint)" }}>
                  Pick a target repo (chip above) to enable workspace creation.
                </div>
              )}
              {sources.map((src, i) => {
                const idx = sourceStart + i;
                const jiraDisabled = src.key === "jira" && !jiraConnected;
                const disabled = jiraDisabled || noContext;
                const showDefaults = !noContext && !disabled;
                return (
                  <SourceRowGroup
                    key={src.key}
                    src={src}
                    idx={idx}
                    clamped={clamped}
                    disabled={disabled}
                    jiraDisabled={jiraDisabled}
                    onHover={() => setSel(idx)}
                    onActivate={() => activateAt(idx)}
                    defaults={
                      showDefaults && src.key === "branch" && branchDisplayDefaults
                        ? branchDisplayDefaults
                        : showDefaults && src.key === "clone" && cloneDisplayDefaults
                          ? cloneDisplayDefaults
                          : null
                    }
                  />
                );
              })}

              {createError && (
                <div style={{ margin: "8px 18px 0", color: "var(--err)", fontFamily: "var(--sans)", fontSize: 12 }}>{createError}</div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "10px 18px", borderTop: "1px solid var(--line)", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
              <span><span style={{ color: "var(--acd)" }}>↵</span> create / switch</span>
              <span><span style={{ color: "var(--acd)" }}>⇥</span> edit scope first</span>
              <span style={{ marginLeft: "auto" }}><span style={{ color: "var(--acd)" }}>↑↓</span> navigate</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <div style={{ padding: "9px 18px 5px", fontFamily: "var(--sans)", fontSize: 10, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--faint)" }}>
      {label}
    </div>
  );
}

function Row({
  active,
  dim,
  onHover,
  onClick,
  children,
}: {
  active: boolean;
  dim?: boolean;
  onHover: () => void;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseEnter={onHover}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "0 8px",
        padding: "8px 10px",
        borderRadius: 8,
        cursor: dim ? "default" : "pointer",
        background: active ? "color-mix(in oklab, var(--ac) 9%, transparent)" : "transparent",
        borderLeft: `2px solid ${active ? "var(--ac)" : "transparent"}`,
      }}
    >
      {children}
    </div>
  );
}

function SourceRowGroup({
  src,
  idx,
  clamped,
  disabled,
  jiraDisabled,
  onHover,
  onActivate,
  defaults,
}: {
  src: SourceDef;
  idx: number;
  clamped: number;
  disabled: boolean;
  jiraDisabled: boolean;
  onHover: () => void;
  onActivate: () => void;
  defaults: { base: string; presetName: string | null; script: string | null } | null;
}) {
  const defaultsText = defaults
    ? `${defaults.base}${defaults.presetName ? ` · ${defaults.presetName}` : ""} · on-open: ${defaults.script ?? "none"}`
    : null;

  return (
    <>
      <Row active={idx === clamped} onHover={onHover} onClick={disabled ? () => undefined : onActivate} dim={disabled}>
        <span style={{ color: disabled ? "var(--faint)" : "var(--acd)", width: 16, textAlign: "center" }}>{src.glyph}</span>
        <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 12.5, color: disabled ? "var(--faint)" : "var(--dim)" }}>
          {src.label}
          {jiraDisabled && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--faint)" }}>· connect Jira in settings</span>}
        </span>
      </Row>
      {defaultsText && (
        <div
          style={
            {
              margin: "0 8px",
              padding: "0 10px 6px 36px",
              fontFamily: "var(--sans)",
              fontSize: 10,
              color: "var(--faint)",
              lineHeight: 1.3,
            } satisfies CSSProperties
          }
        >
          {defaultsText}
        </div>
      )}
    </>
  );
}

function RepoMenuItem({
  name,
  selected,
  onPick,
}: {
  name: string;
  selected: boolean;
  onPick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={onPick}
      style={{
        padding: "8px 14px",
        fontFamily: "var(--sans)",
        fontSize: 12,
        cursor: "pointer",
        color: selected ? "var(--ac)" : "var(--fg)",
        background: hovered ? "color-mix(in oklab, var(--ac) 9%, transparent)" : "transparent",
      }}
    >
      {name}
    </div>
  );
}
