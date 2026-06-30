// The global connection pool: credential-bearing accounts that repos *reference*
// (they don't own the secret). A repo's config stores only a connection id; the
// site/email/provider live here (non-secret, in localStorage["aurora.connections"])
// and the token/key lives in the OS keychain, keyed by the connection id.
//
// Two kinds today: Jira sites (site + email; token in keychain `aurora-jira/<id>`)
// and AI accounts (provider; key in keychain `aurora-ai/<id>`). The startup
// Anthropic "terminal key" is a pinned built-in, not stored here.

export type AiProvider = "claude" | "openai";

export interface JiraConnection {
  id: string;
  site: string;
  email: string;
  /** Display label; defaults to the site host. */
  label?: string;
}

export interface AiConnection {
  id: string;
  provider: AiProvider;
  label: string;
  /** Masked key preview (non-secret), e.g. `sk-ant-…1a2b`. */
  keyHint?: string;
}

export interface Connections {
  jira: JiraConnection[];
  ai: AiConnection[];
}

export const CONNECTIONS_KEY = "aurora.connections";

export function emptyConnections(): Connections {
  return { jira: [], ai: [] };
}

/** A stable id for a new connection. */
export function newConnId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The host of a Jira site URL, for a default label (e.g. `acme.atlassian.net`). */
export function siteHost(site: string): string {
  return site
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

export function loadConnections(): Connections {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return emptyConnections();
    const parsed = JSON.parse(raw);
    const jira = Array.isArray(parsed?.jira)
      ? parsed.jira.filter((c: JiraConnection) => c && c.id && c.site && c.email)
      : [];
    const ai = Array.isArray(parsed?.ai)
      ? parsed.ai.filter((c: AiConnection) => c && c.id && c.provider)
      : [];
    return { jira, ai };
  } catch {
    return emptyConnections();
  }
}

export function saveConnections(c: Connections): void {
  try {
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
