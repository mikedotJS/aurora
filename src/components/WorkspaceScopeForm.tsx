// The create scope form (Frame 3): inherit the repo, override only the diff.
// Rendered inside the command palette once a source is chosen. Presets and the
// branch-naming default come from the per-repo config (workspace-config).

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { gitBranches, validateBranchNameBackend } from "../lib/sys";
import { runCreate, buildCreateSpec, type CreateSource } from "../lib/create";
import { listPresets, presetForIssueType } from "../lib/presets";
import { getRepoConfig } from "../lib/repoConfig";
import { resolveBranchName, type NameIssue } from "../lib/branchNaming";
import { jiraIssue, jiraTransition, repoJira } from "../lib/jira";

const SOURCE_LABEL: Record<CreateSource, string> = {
  jira: "Jira issue",
  branch: "Branch",
  describe: "Describe",
  clone: "Clone",
};

export interface ScopeInitial {
  issueKey?: string | null;
  /** Jira issue type, when issue-backed — auto-selects a matching preset. */
  issueType?: string | null;
  title: string;
  branch: string;
  /** false when checking out an existing branch (clone of an existing branch). */
  newBranch?: boolean;
  /** Seed for the base branch selector (clone: active workspace branch). */
  baseBranch?: string | null;
  /** Seed for the preset picker (clone: active workspace preset name). */
  preset?: string | null;
}

export function WorkspaceScopeForm({
  repo,
  source,
  initial,
  justResolved,
  onCancel,
}: {
  repo: { root: string; name: string; defaultBranch: string };
  source: CreateSource;
  initial: ScopeInitial;
  // True only right after the ⌘⏎ "describe" flow resolved title/branch via AI.
  // Plays a one-shot reveal on those two fields, materializing the real,
  // just-arrived text — see RevealCover below.
  justResolved?: boolean;
  onCancel: () => void;
}) {
  const closeCommand = useStore((s) => s.closeCommand);
  const model = useStore((s) => s.settings.model);
  const notify = useStore((s) => s.notify);
  // re-render when config / pool changes (presets/defaults + Jira binding below)
  useStore((s) => s.repoConfigs);
  useStore((s) => s.connections);

  const cfg = getRepoConfig(repo.root);
  // The Jira connection this repo is bound to (from the pool), or null.
  const jira = repoJira(repo.root);
  const jiraConnected = !!jira;
  const presets = listPresets(repo.root);
  const initialPreset =
    (initial.preset ? presets.find((p) => p.name === initial.preset) : null) ??
    presetForIssueType(repo.root, initial.issueType) ??
    presets.find((p) => p.name === "feature") ??
    presets[0];

  const [presetId, setPresetId] = useState<string>(initialPreset?.id ?? "");
  const selected = presets.find((p) => p.id === presetId) ?? initialPreset ?? presets[0];

  const defaultBase = selected?.baseOverride ?? cfg.defaults.baseBranch ?? repo.defaultBranch ?? "main";
  const [branch, setBranch] = useState(initial.branch);
  const [branchTouched, setBranchTouched] = useState(false);
  const [branchValid, setBranchValid] = useState<boolean | null>(null);
  const [branchNote, setBranchNote] = useState<string | null>(null);
  // initial.baseBranch seeds the base for clone (the active workspace's branch);
  // falls back to the preset/config-resolved default for all other sources.
  const [base, setBase] = useState(initial.baseBranch ?? defaultBase);
  const [bases, setBases] = useState<string[]>([defaultBase]);
  const [scriptName, setScriptName] = useState<string>(selected?.runOnOpen ?? "");
  const [jiraSyncOn, setJiraSyncOn] = useState<boolean>(
    jiraConnected && (selected?.jiraSync ?? cfg.defaults.jiraSyncDefault),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(initial.title);

  const issue: NameIssue = useMemo(
    () => ({ key: initial.issueKey ?? null, type: initial.issueType ?? null, title: initial.title }),
    [initial.issueKey, initial.issueType, initial.title],
  );

  useEffect(() => {
    gitBranches(repo.root).then((bl) => {
      const list = bl.branches.length ? bl.branches : bl.current ? [bl.current] : [defaultBase];
      setBases(list);
      if (!list.includes(base) && list.length) setBase(list.includes(defaultBase) ? defaultBase : list[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.root]);

  // Resolve the configured branch name once for issue-backed (Jira) sources (the
  // user can still override). Falls back to whatever the palette prefilled.
  // "describe" is excluded: openDescribeForm() already resolved + validated an
  // AI-generated branch via the "ai" naming source before the form ever opened —
  // re-resolving here with the repo's *configured* branchNaming (default: manual
  // "{key}/{slug}") would clobber it with a bare slug (no issue key to key off).
  useEffect(() => {
    if (branchTouched) return;
    if (!initial.issueKey || source === "describe") return;
    let live = true;
    resolveBranchName(cfg.defaults.branchNaming, issue, repo.root, model).then((r) => {
      if (live && !branchTouched && r.name) setBranch(r.name);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.root]);

  // Authoritative ✓/✕ for the current branch name (the repo's validator if any).
  useEffect(() => {
    const name = branch.trim();
    if (!name) {
      setBranchValid(null);
      setBranchNote(null);
      return;
    }
    let live = true;
    validateBranchNameBackend(repo.root, name).then((r) => {
      if (!live) return;
      setBranchValid(r.enforced ? r.ok : null);
      setBranchNote(r.ok ? null : r.message ?? null);
    });
    return () => {
      live = false;
    };
  }, [branch, repo.root]);

  const pickPreset = (p: { id: string; runOnOpen: string | null; jiraSync: boolean }) => {
    setPresetId(p.id);
    setScriptName(p.runOnOpen ?? "");
    if (jiraConnected) setJiraSyncOn(p.jiraSync);
  };

  const overrides =
    (base !== defaultBase ? 1 : 0) +
    (selected && presetId !== initialPreset?.id ? 1 : 0) +
    (scriptName !== (selected?.runOnOpen ?? "") ? 1 : 0);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    // For a Jira issue, fetch detail to record status/url on the workspace.
    let jiraStatus: string | null = null;
    let jiraUrl: string | null = null;
    if (source === "jira" && jira && initial.issueKey) {
      const detail = await jiraIssue(jira.connId, jira.site, jira.email, initial.issueKey);
      if (detail) {
        jiraStatus = detail.status;
        jiraUrl = detail.url;
      }
    }

    const spec = buildCreateSpec({
      repo,
      source,
      preset: selected ?? null,
      branch: branch.trim(),
      title: title.trim(),
      baseBranch: base,
      // Pass raw string — buildCreateSpec normalises "" → null.
      scriptName,
      newBranch: initial.newBranch ?? true,
      issueKey: initial.issueKey ?? null,
      jiraStatus,
      jiraUrl,
      jiraSync: jiraSyncOn,
    });
    const res = await runCreate(spec);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }

    // Two-way sync: transition the issue to In Progress (best-effort; never blocks).
    if (jiraSyncOn && jira && initial.issueKey) {
      const inProgress = getRepoConfig(repo.root).integrations.jiraInProgress || "In Progress";
      jiraTransition(jira.connId, jira.site, jira.email, initial.issueKey, inProgress).then((r) => {
        if (r.ok) useStore.getState().setWsJiraStatus(res.wsId, inProgress);
        else notify({ color: "var(--warn)", icon: "⚠", headline: "Jira not updated", sub: `Couldn't move ${initial.issueKey} to ${inProgress}`, repo: repo.name });
      });
    }
    closeCommand();
  };

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

  return (
    <div
      // The signature "land": on the AI handoff the whole scope panel drops into
      // place with a single settle (--ease-settle overshoot), so the machine's
      // answer arrives as one gesture rather than swapping in. Other sources
      // (Jira/branch/clone) open without it — the boldness is spent only here.
      className={justResolved ? "cmd-form-land" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        animation: justResolved ? "cmdFormLand var(--dur-ui) var(--ease-settle) both" : undefined,
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ color: "var(--acd)", fontSize: 14 }}>＋</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>New workspace</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>· {repo.name}</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
          {SOURCE_LABEL[source]}
        </span>
      </div>

      <div className="ascroll" style={{ maxHeight: 440, overflowY: "auto", padding: "12px 0 4px" }}>
        {initial.issueKey && (
          <div style={{ margin: "0 18px 8px", display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--jira)" }}>{initial.issueKey}</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {initial.title}
            </span>
          </div>
        )}

        {/* title — editable, AI-generated for "describe" (issue-backed sources keep
            the read-only summary above; the title there is the issue's, not free text) */}
        {source === "describe" && (
          <div style={{ padding: "0 18px 4px" }}>
            <div style={fieldLabel}>Title</div>
            <div style={{ ...box, position: "relative" }}>
              <span style={{ color: "var(--acd)" }}>✦</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--fg)", fontFamily: "var(--sans)", fontSize: 12.5, padding: 0 }}
              />
              {justResolved && <RevealCover delay={0.14} />}
            </div>
          </div>
        )}

        {/* branch */}
        <div style={{ padding: "8px 18px 4px" }}>
          <div style={fieldLabel}>Branch</div>
          <div style={{ ...box, position: "relative" }}>
            <span style={{ color: "var(--acd)" }}>⎇</span>
            <input
              value={branch}
              onChange={(e) => {
                setBranchTouched(true);
                setBranch(e.target.value);
              }}
              spellCheck={false}
              autoComplete="off"
              style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--ac)", fontFamily: "var(--mono)", fontSize: 12.5, padding: 0 }}
            />
            {branchValid != null && (
              <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: branchValid ? "var(--ok)" : "var(--err)" }}>
                {branchValid ? "✓" : "✕"}
              </span>
            )}
            {justResolved && <RevealCover delay={source === "describe" ? 0.14 + STAGGER_S : 0.14} />}
          </div>
          {branchNote && (
            <div style={{ marginTop: 5, fontFamily: "var(--sans)", fontSize: 11, color: "var(--err)", lineHeight: 1.4 }}>{branchNote}</div>
          )}
        </div>

        {/* base + preset */}
        <div style={{ display: "flex", gap: 10, padding: "8px 18px 4px" }}>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>Base branch</div>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              style={{ ...box, width: "100%", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12.5, appearance: "none" }}
            >
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>Preset</div>
            <div style={{ display: "flex", gap: 3, background: "var(--page)", border: "1px solid var(--line)", borderRadius: 7, padding: presets.length ? 3 : "7px 10px", fontFamily: "var(--sans)", flexWrap: "wrap" }}>
              {presets.length === 0 && (
                <span style={{ fontSize: 11, color: "var(--faint)" }}>none — add presets in Workspace settings</span>
              )}
              {presets.map((p) => (
                <span
                  key={p.id}
                  onClick={() => pickPreset(p)}
                  style={{
                    flex: "1 0 auto",
                    textAlign: "center",
                    fontSize: 11,
                    borderRadius: 5,
                    padding: "4px 8px",
                    cursor: "pointer",
                    color: presetId === p.id ? "var(--page)" : "var(--dim)",
                    background: presetId === p.id ? "var(--ac)" : "transparent",
                    fontWeight: presetId === p.id ? 500 : 400,
                  }}
                >
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* on-open script */}
        <div style={{ padding: "10px 18px 4px" }}>
          <div style={fieldLabel}>On-open script</div>
          <select
            value={scriptName}
            onChange={(e) => setScriptName(e.target.value)}
            style={{ ...box, width: "100%", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12.5, appearance: "none" }}
          >
            <option value="">none</option>
            {useStore.getState().userScripts[repo.root]?.scripts.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {/* two-way jira sync — live when Jira is connected */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 18px 6px", opacity: jiraConnected ? 1 : 0.55 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }}>Two-way Jira sync</div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--dim)", marginTop: 2 }}>
              {jiraConnected
                ? "Move the issue to In Progress on create; post the MR link and transition on merge."
                : "Connect Jira in settings to enable transitions & MR-link posting."}
            </div>
          </div>
          <div
            onClick={() => jiraConnected && setJiraSyncOn((v) => !v)}
            style={{
              width: 38,
              height: 21,
              borderRadius: 999,
              background: jiraSyncOn ? "var(--ac)" : "var(--line)",
              position: "relative",
              flex: "0 0 auto",
              cursor: jiraConnected ? "pointer" : "default",
              transition: "background .15s",
            }}
          >
            <span style={{ position: "absolute", top: 2, left: jiraSyncOn ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: jiraSyncOn ? "var(--page)" : "var(--faint)", transition: "left .15s" }} />
          </div>
        </div>

        {error && (
          <div style={{ margin: "6px 18px 0", color: "var(--err)", fontFamily: "var(--sans)", fontSize: 12, lineHeight: 1.4 }}>
            {error}
          </div>
        )}
      </div>

      {/* actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
        <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
          Inherits {repo.name} · overrides {overrides} field{overrides === 1 ? "" : "s"}
        </span>
        <span
          onClick={onCancel}
          style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 12, color: "var(--dim)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 15px", cursor: "pointer" }}
        >
          Back
        </span>
        <span
          onClick={create}
          style={{
            fontFamily: "var(--sans)",
            fontSize: 12,
            color: "var(--page)",
            background: "var(--ac)",
            borderRadius: 8,
            padding: "7px 16px",
            fontWeight: 500,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
            boxShadow: "0 0 24px -8px var(--ac)",
          }}
        >
          {busy ? "Creating…" : "Create workspace"}
        </span>
      </div>
    </div>
  );
}

// Title→branch cascade offset, mirrored from --stagger-reveal (90ms) so the JS
// delays and the CSS token can't drift. In seconds for the animation shorthand.
const STAGGER_S = 0.09;

// The signature "materialize" moment, layered. Over each just-arrived field
// sits an opaque cover — the panel's own background (--win), so it reads as
// concealment, never a skeleton — that shrinks away via transform: scaleX
// (origin right), never touching the glyphs underneath. Two things ride with
// the wipe, both keyed to --ease-settle / --dur-signature so the line
// accelerates then LOCKS:
//   • cmdCoverEdge — the right edge is a teal cursor that flares brighter and
//     casts a brief glow as it reaches the end (the tactile "clack" of the
//     line settling), then fades to transparent.
//   • cmdRevealSweep — a soft accent glow sweeps L→R behind the text as it
//     appears (energy on arrival), clipped to the field, gone in one pass.
// One-shot: the cover unmounts itself after playing (onAnimationEnd) so it
// never lingers over an editable field. `delay` cascades branch behind title.
function RevealCover({ delay }: { delay: number }) {
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <div
      aria-hidden
      // Clip the sweep glow to the field's rounded box so it can't bleed past
      // the input border.
      style={{ position: "absolute", inset: 0, borderRadius: 7, overflow: "hidden", pointerEvents: "none" }}
    >
      {/* LAYER 3: accent glow sweeping behind the text as it materializes. */}
      <div
        className="cmd-reveal-sweep"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 18,
          width: "32%",
          background:
            "radial-gradient(closest-side, color-mix(in oklab, var(--ac) 20%, transparent), transparent)",
          animation: `cmdRevealSweep var(--dur-signature) var(--ease-scan) ${delay}s both`,
        }}
      />
      {/* LAYER 2: the cover + its riding cursor edge, unmounting on end. */}
      <div
        className="cmd-reveal-cover"
        onAnimationEnd={(e) => {
          // Only the wipe (transform) end unmounts; the edge/border animation
          // finishes at the same time but guard on the longest to be safe.
          if (e.animationName.startsWith("cmdCoverWipe")) setDone(true);
        }}
        style={{
          position: "absolute",
          inset: "-1px -1px -1px 22px", // clears the leading ✦/⎇ glyph column
          background: "var(--win)",
          transformOrigin: "right center",
          borderRight: "1.5px solid var(--acd)",
          animation:
            `cmdCoverWipe var(--dur-signature) var(--ease-settle) ${delay}s both,` +
            `cmdCoverEdge var(--dur-signature) var(--ease-settle) ${delay}s both`,
        }}
      />
    </div>
  );
}
