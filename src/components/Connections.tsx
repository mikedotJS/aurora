// The global connection pool, shown in app Settings → Connections. Manages the
// credential-bearing accounts that repos *bind* to: Jira sites and AI provider
// accounts. Tokens/keys are written to the OS keychain (keyed by connection id);
// only non-secret site/email/provider cross into the webview. The startup
// Anthropic "terminal key" is a pinned built-in (updated via the key-entry flow).

import { useState } from "react";
import { useStore } from "../state/store";
import { newConnId, siteHost, type AiProvider } from "../lib/connections";
import { getRepoConfig, updateRepoConfig } from "../lib/repoConfig";
import { jiraSetToken, jiraClearToken, jiraValidate } from "../lib/jira";
import { aiKeySet, aiKeyDelete, maskKey } from "../lib/keychain";

const PROVIDERS: { key: AiProvider; label: string; live: boolean }[] = [
  { key: "claude", label: "Claude (Anthropic)", live: true },
  { key: "openai", label: "OpenAI", live: false },
];

const labelStyle = { fontFamily: "var(--sans)", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase" as const, color: "var(--faint)", marginBottom: 5 };
const box = { display: "flex", alignItems: "center", gap: 8, background: "var(--page)", border: "1px solid var(--line)", borderRadius: 7, padding: "6px 9px" };
const input = { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12, padding: 0 };
const removeStyle = { fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)", cursor: "pointer", padding: "0 4px" };

function Section({ title }: { title: string }) {
  return (
    <div style={{ padding: "16px 18px 7px", fontFamily: "var(--sans)", fontSize: 10.5, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--faint)" }}>
      {title}
    </div>
  );
}

function AccountRow({ glyph, color, label, desc, children }: { glyph: string; color?: string; label: string; desc: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 18px" }}>
      <span style={{ color: color ?? "var(--acd)", fontSize: 13, flex: "0 0 auto" }}>{glyph}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{desc}</div>
      </div>
      <div style={{ display: "flex", gap: 7, flex: "0 0 auto", alignItems: "center" }}>{children}</div>
    </div>
  );
}

function humanizeJira(raw: string): string {
  if (raw.includes("401") || raw.includes("403")) return "Invalid email or API token.";
  if (raw.includes("404") || raw.toLowerCase().includes("dns") || raw.toLowerCase().includes("resolve"))
    return "Couldn't reach that site — check the URL (https://your-team.atlassian.net).";
  return raw.replace(/^jira \d+:\s*/, "").slice(0, 160) || "Couldn't connect to Jira.";
}

function JiraConnections() {
  const connections = useStore((s) => s.connections);
  const addJiraConnection = useStore((s) => s.addJiraConnection);
  const removeJiraConnection = useStore((s) => s.removeJiraConnection);
  // re-render to recompute "bound repos" hints when configs change
  useStore((s) => s.repoConfigs);

  const [adding, setAdding] = useState(false);
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAdding(false);
    setSite("");
    setEmail("");
    setToken("");
    setError(null);
  };

  const add = async () => {
    if (busy) return;
    const s = site.trim().replace(/\/$/, "");
    const e = email.trim();
    if (!s || !e || !token.trim()) {
      setError("Enter site, email, and API token.");
      return;
    }
    setBusy(true);
    setError(null);
    const id = newConnId("jira");
    try {
      await jiraSetToken(id, token.trim());
    } catch (err) {
      setError(String(err));
      setBusy(false);
      return;
    }
    const res = await jiraValidate(id, s, e);
    if (res.ok) {
      addJiraConnection({ id, site: s, email: e, label: siteHost(s) });
      reset();
    } else {
      await jiraClearToken(id);
      setError(humanizeJira(res.error));
    }
    setBusy(false);
  };

  const remove = async (id: string) => {
    await jiraClearToken(id);
    removeJiraConnection(id);
    // Clear any repo bindings that pointed at this connection (graceful unbind).
    for (const root of Object.keys(useStore.getState().repoConfigs)) {
      if (getRepoConfig(root).integrations.jiraConnectionId === id) {
        updateRepoConfig(root, (c) => (c.integrations.jiraConnectionId = null));
      }
    }
  };

  const boundCount = (id: string) =>
    Object.keys(useStore.getState().repoConfigs).filter((r) => getRepoConfig(r).integrations.jiraConnectionId === id).length;

  return (
    <>
      <Section title="Connections · Jira" />
      {connections.jira.map((c) => {
        const n = boundCount(c.id);
        return (
          <AccountRow key={c.id} glyph="▦" color="var(--jira)" label={c.label || siteHost(c.site)} desc={`${c.email}${n ? ` · ${n} repo${n === 1 ? "" : "s"}` : ""}`}>
            <span onClick={() => remove(c.id)} style={removeStyle}>remove</span>
          </AccountRow>
        );
      })}
      {connections.jira.length === 0 && (
        <div style={{ padding: "2px 18px 6px", fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--faint)" }}>
          No Jira sites yet. Add one, then bind it per repo in that repo's settings.
        </div>
      )}

      {adding ? (
        <div style={{ margin: "6px 18px 2px", padding: 12, border: "1px solid var(--line)", borderRadius: 9, display: "flex", flexDirection: "column", gap: 9, background: "color-mix(in oklab, var(--ac) 3%, var(--page))" }}>
          <div>
            <div style={labelStyle}>Site URL</div>
            <div style={box}>
              <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://your-team.atlassian.net" spellCheck={false} autoComplete="off" style={input} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Email</div>
              <div style={box}>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@team.com" spellCheck={false} autoComplete="off" style={{ ...input, fontFamily: "var(--sans)" }} />
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>API token</div>
              <div style={box}>
                <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="••••••••" spellCheck={false} autoComplete="off" style={input} />
              </div>
            </div>
          </div>
          {error && <div style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--err)", lineHeight: 1.4 }}>{error}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)" }}>Token is stored in the macOS Keychain.</span>
            <span onClick={reset} style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--dim)", cursor: "pointer" }}>cancel</span>
            <span onClick={add} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--page)", background: "var(--ac)", borderRadius: 7, padding: "5px 13px", fontWeight: 500, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Connecting…" : "Add connection"}
            </span>
          </div>
        </div>
      ) : (
        <div style={{ padding: "6px 18px 2px" }}>
          <span onClick={() => setAdding(true)} style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--acd)", border: "1px dashed var(--line)", borderRadius: 7, padding: "5px 11px", cursor: "pointer" }}>
            + Add Jira site
          </span>
        </div>
      )}
    </>
  );
}

function AiConnections() {
  const connections = useStore((s) => s.connections);
  const addAiConnection = useStore((s) => s.addAiConnection);
  const removeAiConnection = useStore((s) => s.removeAiConnection);
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const startKeyEntry = useStore((s) => s.startKeyEntry);
  const closeSettings = useStore((s) => s.closeSettings);

  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<AiProvider>("claude");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");

  const add = async () => {
    if (!key.trim()) return;
    const id = newConnId("ai");
    await aiKeySet(id, key.trim());
    addAiConnection({ id, provider, label: label.trim() || PROVIDERS.find((p) => p.key === provider)!.label, keyHint: maskKey(key.trim()) });
    setAdding(false);
    setLabel("");
    setKey("");
    setProvider("claude");
  };

  const remove = async (id: string) => {
    await aiKeyDelete(id);
    removeAiConnection(id);
    for (const root of Object.keys(useStore.getState().repoConfigs)) {
      if (getRepoConfig(root).defaults.aiDefaultId === id) {
        updateRepoConfig(root, (c) => (c.defaults.aiDefaultId = null));
      }
    }
  };

  return (
    <>
      <Section title="Connections · AI accounts" />
      <AccountRow
        glyph="✦"
        color={apiKeyPresent ? "var(--ac)" : "var(--faint)"}
        label="Claude · terminal key"
        desc={apiKeyPresent ? "default · stored in the macOS Keychain" : "no key set — add one to use Claude"}
      >
        <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--acd)", background: "color-mix(in oklab, var(--ac) 14%, transparent)", borderRadius: 6, padding: "3px 9px" }}>default</span>
        <span
          onClick={() => {
            closeSettings();
            startKeyEntry();
          }}
          style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--dim)", border: "1px solid var(--line)", borderRadius: 6, padding: "3px 9px", cursor: "pointer" }}
        >
          {apiKeyPresent ? "update" : "add key"}
        </span>
      </AccountRow>

      {connections.ai.map((a) => (
        <AccountRow key={a.id} glyph="✦" label={a.label} desc={`${a.provider}${a.keyHint ? ` · ${a.keyHint}` : ""}`}>
          <span onClick={() => remove(a.id)} style={removeStyle}>remove</span>
        </AccountRow>
      ))}

      {adding ? (
        <div style={{ margin: "6px 18px 2px", padding: 12, border: "1px solid var(--line)", borderRadius: 9, display: "flex", flexDirection: "column", gap: 9, background: "color-mix(in oklab, var(--ac) 3%, var(--page))" }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <div style={{ display: "flex", gap: 3, background: "var(--page)", border: "1px solid var(--line)", borderRadius: 7, padding: 3 }}>
              {PROVIDERS.map((p) => {
                const on = p.key === provider;
                return (
                  <span key={p.key} onClick={() => setProvider(p.key)} style={{ flex: 1, textAlign: "center", fontFamily: "var(--sans)", fontSize: 11, borderRadius: 5, padding: "4px 8px", cursor: "pointer", color: on ? "var(--page)" : "var(--dim)", background: on ? "var(--ac)" : "transparent", fontWeight: on ? 500 : 400 }}>
                    {p.label}
                    {!p.live && " · soon"}
                  </span>
                );
              })}
            </div>
            {!PROVIDERS.find((p) => p.key === provider)!.live && (
              <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)", marginTop: 5 }}>
                Stored now; Aurora will use it once {provider} support lands.
              </div>
            )}
          </div>
          <div>
            <div style={labelStyle}>Label</div>
            <div style={box}>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. work account" spellCheck={false} style={{ ...input, fontFamily: "var(--sans)" }} />
            </div>
          </div>
          <div>
            <div style={labelStyle}>API key</div>
            <div style={box}>
              <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="••••••••" spellCheck={false} style={input} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--faint)" }}>Stored in the macOS Keychain.</span>
            <span onClick={() => setAdding(false)} style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--dim)", cursor: "pointer" }}>cancel</span>
            <span onClick={add} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--page)", background: "var(--ac)", borderRadius: 7, padding: "5px 13px", fontWeight: 500, cursor: key.trim() ? "pointer" : "default", opacity: key.trim() ? 1 : 0.6 }}>
              Add account
            </span>
          </div>
        </div>
      ) : (
        <div style={{ padding: "6px 18px 2px" }}>
          <span onClick={() => setAdding(true)} style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--acd)", border: "1px dashed var(--line)", borderRadius: 7, padding: "5px 11px", cursor: "pointer" }}>
            + Add account
          </span>
        </div>
      )}
    </>
  );
}

/** The full Connections surface for app settings. */
export function Connections() {
  return (
    <>
      <JiraConnections />
      <AiConnections />
    </>
  );
}
