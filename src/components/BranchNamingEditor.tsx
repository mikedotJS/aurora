// The four-mode branch-naming editor (Frames 7–10). A source selector plus the
// per-source editor: a manual token composer with a live preview, a
// package.json-bound read-only view, a validator-inferred guided composer, and
// an AI-instruction box with reasoning + ✓/✕ preview and a chain-validator toggle.

import { useEffect, useMemo, useState } from "react";
import {
  applyTemplate,
  parseRegexToAlternatives,
  pickAlternative,
  composeFromGroups,
  resolveBranchName,
  type BranchNamingConfig,
  type RegexGroup,
  type NameIssue,
} from "../lib/branchNaming";
import { readPackageField, detectBranchValidator, validateBranchNameBackend } from "../lib/sys";
import { useStore } from "../state/store";

/** The sample issue used for every live preview (mirrors the spec example). */
const SAMPLE: NameIssue = {
  key: "PROJ-1423",
  type: "Bug",
  title: "Login redirect drops the return URL",
  component: "api",
  assignee: "you",
  sprint: "24",
};

type SourceKey = BranchNamingConfig["source"];
const SOURCES: { key: SourceKey; label: string }[] = [
  { key: "manual", label: "Template" },
  { key: "package-json", label: "package.json" },
  { key: "validator", label: "Validator" },
  { key: "ai", label: "AI" },
];

const TOKENS = ["{key}", "{type}", "{slug}", "{assignee}", "{sprint}", "{yy-mm}"];

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
const inputStyle = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--ac)",
  fontFamily: "var(--mono)",
  fontSize: 12.5,
  padding: 0,
};

function Preview({ name, valid, note }: { name: string; valid: boolean | null; note?: string }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={fieldLabel}>Preview</div>
      <div style={{ ...box, justifyContent: "space-between" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: name ? "var(--ac)" : "var(--faint)" }}>
          {name || "—"}
        </span>
        {valid != null && (
          <span style={{ fontSize: 12, color: valid ? "var(--ok)" : "var(--err)", fontFamily: "var(--sans)" }}>
            {valid ? "✓ valid" : "✕ invalid"}
          </span>
        )}
      </div>
      {note && (
        <div style={{ marginTop: 6, fontFamily: "var(--sans)", fontSize: 11, color: "var(--dim)", lineHeight: 1.4 }}>
          {note}
        </div>
      )}
    </div>
  );
}

export function BranchNamingEditor({
  value,
  repoDir,
  onChange,
}: {
  value: BranchNamingConfig;
  repoDir: string;
  onChange: (cfg: BranchNamingConfig) => void;
}) {
  const setSource = (source: SourceKey) => {
    if (source === value.source) return;
    if (source === "manual") onChange({ source, template: "{key}/{slug}" });
    else if (source === "package-json") onChange({ source, field: "aurora.branchPattern" });
    else if (source === "validator") onChange({ source, regex: "", groups: [] });
    else onChange({ source, instruction: "Name branches as <type>/<key>-<short-slug>.", chainValidator: true });
  };

  return (
    <div>
      {/* source selector */}
      <div style={{ display: "flex", gap: 3, background: "var(--page)", border: "1px solid var(--line)", borderRadius: 8, padding: 3, marginBottom: 12 }}>
        {SOURCES.map((s) => {
          const on = s.key === value.source;
          return (
            <span
              key={s.key}
              onClick={() => setSource(s.key)}
              style={{
                flex: 1,
                textAlign: "center",
                fontFamily: "var(--sans)",
                fontSize: 11.5,
                borderRadius: 6,
                padding: "5px 0",
                cursor: on ? "default" : "pointer",
                color: on ? "var(--page)" : "var(--dim)",
                background: on ? "var(--ac)" : "transparent",
                fontWeight: on ? 500 : 400,
              }}
            >
              {s.label}
            </span>
          );
        })}
      </div>

      {value.source === "manual" && <ManualEditor value={value} onChange={onChange} />}
      {value.source === "package-json" && <PackageJsonEditor value={value} repoDir={repoDir} onChange={onChange} />}
      {value.source === "validator" && <ValidatorEditor value={value} repoDir={repoDir} onChange={onChange} />}
      {value.source === "ai" && <AiEditor value={value} repoDir={repoDir} onChange={onChange} />}
    </div>
  );
}

function ManualEditor({
  value,
  onChange,
}: {
  value: Extract<BranchNamingConfig, { source: "manual" }>;
  onChange: (cfg: BranchNamingConfig) => void;
}) {
  const preview = applyTemplate(value.template, SAMPLE);
  const insert = (tok: string) => onChange({ ...value, template: value.template + tok });
  return (
    <div>
      <div style={fieldLabel}>Template</div>
      <div style={box}>
        <span style={{ color: "var(--acd)" }}>⎇</span>
        <input
          value={value.template}
          onChange={(e) => onChange({ ...value, template: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle}
        />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {TOKENS.map((t) => (
          <span
            key={t}
            onClick={() => insert(t)}
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--acd)",
              border: "1px solid var(--line)",
              borderRadius: 5,
              padding: "2px 7px",
              cursor: "pointer",
            }}
          >
            {t}
          </span>
        ))}
      </div>
      <Preview name={preview} valid={null} note={`Sample · ${SAMPLE.key} (${SAMPLE.type}) “${SAMPLE.title}”`} />
    </div>
  );
}

function PackageJsonEditor({
  value,
  repoDir,
  onChange,
}: {
  value: Extract<BranchNamingConfig, { source: "package-json" }>;
  repoDir: string;
  onChange: (cfg: BranchNamingConfig) => void;
}) {
  const [pattern, setPattern] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reread = async () => {
    setLoading(true);
    const p = await readPackageField(repoDir, value.field);
    setPattern(p);
    setLoading(false);
  };
  useEffect(() => {
    void reread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.field, repoDir]);

  const preview = pattern ? applyTemplate(pattern, SAMPLE) : "";
  return (
    <div>
      <div style={fieldLabel}>package.json field</div>
      <div style={box}>
        <span style={{ color: "var(--acd)" }}>{`{}`}</span>
        <input
          value={value.field}
          onChange={(e) => onChange({ ...value, field: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          style={{ ...inputStyle, color: "var(--fg)" }}
        />
        <span onClick={reread} style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--acd)", cursor: "pointer" }}>
          {loading ? "…" : "re-read"}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={fieldLabel}>Bound pattern · shared with your team</div>
        <div style={{ ...box, opacity: pattern ? 1 : 0.6 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: pattern ? "var(--fg)" : "var(--faint)" }}>
            {pattern ?? "not found in package.json"}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>read-only</span>
        </div>
      </div>
      {pattern && <Preview name={preview} valid={null} />}
    </div>
  );
}

/** A short label for one alternative shape, from its first enum or literal. */
function altLabel(groups: RegexGroup[], i: number): string {
  const firstEnum = groups.find((g) => g.kind === "enum");
  if (firstEnum && firstEnum.kind === "enum") {
    const opts = firstEnum.options;
    return opts.slice(0, 3).join("|") + (opts.length > 3 ? "…" : "");
  }
  const lit = groups.find((g) => g.kind === "literal");
  if (lit && lit.kind === "literal") {
    const t = lit.text.replace(/[^a-z0-9/_-]/gi, "").replace(/^\/|\/$/g, "");
    if (t) return t;
  }
  return `shape ${i + 1}`;
}

function ValidatorEditor({
  value,
  repoDir,
  onChange,
}: {
  value: Extract<BranchNamingConfig, { source: "validator" }>;
  repoDir: string;
  onChange: (cfg: BranchNamingConfig) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  // which top-level alternative (branch shape) is selected
  const [altIndex, setAltIndex] = useState(0);
  // picker option index per enum group within the selected alternative
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [valid, setValid] = useState<boolean | null>(null);

  const detect = async () => {
    setDetecting(true);
    const bv = await detectBranchValidator(repoDir);
    setDetecting(false);
    if (bv) {
      onChange({ source: "validator", regex: bv.regex, groups: [] });
      setSource(bv.source);
    } else {
      setSource("none");
    }
  };

  // The regex is a top-level alternation of branch shapes; parse them out.
  const alts = useMemo(() => (value.regex ? parseRegexToAlternatives(value.regex) : []), [value.regex]);

  // Default to the shape that best matches the sample issue when the regex changes.
  useEffect(() => {
    if (alts.length) {
      setAltIndex(pickAlternative(alts, SAMPLE));
      setPicks({});
    }
  }, [alts]);

  const groups = alts[altIndex] ?? [];
  const enumChoices: Record<number, string> = {};
  groups.forEach((g, i) => {
    if (g.kind === "enum") enumChoices[i] = g.options[picks[i] ?? g.options.indexOf(composeFromGroups([g], SAMPLE))] ?? g.options[0];
  });
  const composed = groups.length ? composeFromGroups(groups, SAMPLE, enumChoices) : "";

  useEffect(() => {
    if (!composed || !value.regex) {
      setValid(null);
      return;
    }
    let live = true;
    validateBranchNameBackend(repoDir, composed).then((r) => live && setValid(r.ok));
    return () => {
      live = false;
    };
  }, [composed, value.regex, repoDir]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          onClick={detect}
          style={{
            fontFamily: "var(--sans)",
            fontSize: 12,
            color: "var(--page)",
            background: "var(--ac)",
            borderRadius: 7,
            padding: "6px 13px",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {detecting ? "Detecting…" : "Detect validator"}
        </span>
        {source && (
          <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: source === "none" ? "var(--warn-d)" : "var(--dim)" }}>
            {source === "none" ? "no validate-branch-name rule found" : `found in ${source}`}
          </span>
        )}
      </div>

      {value.regex && (
        <>
          <div style={{ marginTop: 10 }}>
            <div style={fieldLabel}>Detected rule</div>
            <div style={{ ...box, display: "block" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--dim)", wordBreak: "break-all", lineHeight: 1.5 }}>{value.regex}</span>
            </div>
          </div>

          {alts.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <div style={fieldLabel}>Branch shape</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {alts.map((alt, i) => {
                  const on = i === altIndex;
                  return (
                    <span
                      key={i}
                      onClick={() => {
                        setAltIndex(i);
                        setPicks({});
                      }}
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        borderRadius: 6,
                        padding: "4px 9px",
                        cursor: on ? "default" : "pointer",
                        color: on ? "var(--page)" : "var(--dim)",
                        background: on ? "var(--ac)" : "transparent",
                        border: `1px solid ${on ? "var(--ac)" : "var(--line)"}`,
                      }}
                    >
                      {altLabel(alt, i)}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {groups.some((g) => g.kind === "enum") && (
            <div style={{ marginTop: 10 }}>
              <div style={fieldLabel}>Pickers</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {groups.map((g, i) =>
                  g.kind === "enum" ? (
                    <select
                      key={i}
                      value={picks[i] ?? Math.max(0, g.options.indexOf(enumChoices[i]))}
                      onChange={(e) => setPicks({ ...picks, [i]: parseInt(e.target.value, 10) })}
                      style={{ background: "var(--page)", border: "1px solid var(--line)", borderRadius: 7, color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12, appearance: "none", padding: "5px 9px" }}
                    >
                      {g.options.map((o, oi) => (
                        <option key={o} value={oi}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : null,
                )}
              </div>
            </div>
          )}

          <Preview name={composed} valid={valid} note="Sample preview · composed names are validated against the rule before a workspace is created." />
        </>
      )}
    </div>
  );
}

function AiEditor({
  value,
  repoDir,
  onChange,
}: {
  value: Extract<BranchNamingConfig, { source: "ai" }>;
  repoDir: string;
  onChange: (cfg: BranchNamingConfig) => void;
}) {
  const model = useStore((s) => s.settings.model);
  const [result, setResult] = useState<{ name: string; valid: boolean; explanation?: string } | null>(null);
  const [running, setRunning] = useState(false);

  const preview = async () => {
    setRunning(true);
    const r = await resolveBranchName(value, SAMPLE, repoDir, model);
    setResult({ name: r.name, valid: r.valid, explanation: r.explanation });
    setRunning(false);
  };

  return (
    <div>
      <div style={fieldLabel}>Instruction to Claude</div>
      <textarea
        value={value.instruction}
        onChange={(e) => onChange({ ...value, instruction: e.target.value })}
        rows={3}
        spellCheck={false}
        style={{
          width: "100%",
          background: "var(--page)",
          border: "1px solid var(--line)",
          borderRadius: 7,
          padding: "8px 10px",
          color: "var(--fg)",
          fontFamily: "var(--sans)",
          fontSize: 12.5,
          outline: "none",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--sans)", fontSize: 12, color: "var(--dim)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={value.chainValidator}
            onChange={(e) => onChange({ ...value, chainValidator: e.target.checked })}
          />
          Chain through the repo validator (retry until it passes)
        </label>
        <span
          onClick={preview}
          style={{
            marginLeft: "auto",
            fontFamily: "var(--sans)",
            fontSize: 12,
            color: "var(--page)",
            background: "var(--ac)",
            borderRadius: 7,
            padding: "6px 13px",
            cursor: running ? "default" : "pointer",
            opacity: running ? 0.6 : 1,
            fontWeight: 500,
          }}
        >
          {running ? "Asking Claude…" : "Preview"}
        </span>
      </div>
      {result && <Preview name={result.name} valid={result.valid} note={result.explanation} />}
    </div>
  );
}
