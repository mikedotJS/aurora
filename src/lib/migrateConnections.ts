// One-time boot migration to the connection-pool model. Runs before the store
// loads connections + repo configs. Idempotent: once `aurora.connections` exists
// it's a no-op.
//
//  1. The legacy single Jira connection (`aurora.jira` + keychain `aurora-jira/
//     api-token`) becomes the first pooled connection; its token is moved to
//     `aurora-jira/<id>` in the keychain (in Rust, the only place that touches it).
//  2. Per-repo `aiAccounts[]` are harvested into the global AI pool (deduped;
//     their keys already live in `aurora-ai/<id>`, so nothing moves).
//  3. Every repo config is bound to the migrated Jira connection. The rest of the
//     v2→v3 reshape (strip `aiAccounts`, stamp version) is finished by
//     `loadRepoConfigs`'s own migrate, which preserves the binding written here.

import {
  CONNECTIONS_KEY,
  type AiConnection,
  type JiraConnection,
  newConnId,
  saveConnections,
  siteHost,
} from "./connections";
import { REPO_CONFIG_KEY } from "./repoConfig";
import { jiraMigrateToken } from "./jira";

const OLD_JIRA_KEY = "aurora.jira";

export async function migrateToConnections(): Promise<void> {
  if (localStorage.getItem(CONNECTIONS_KEY)) return; // already migrated

  const jira: JiraConnection[] = [];
  const ai: AiConnection[] = [];
  let jiraConnId: string | null = null;

  // 1) Legacy single Jira connection.
  try {
    const raw = localStorage.getItem(OLD_JIRA_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v?.site === "string" && typeof v?.email === "string" && v.site && v.email) {
        jiraConnId = newConnId("jira");
        jira.push({ id: jiraConnId, site: v.site, email: v.email, label: siteHost(v.site) });
        await jiraMigrateToken(jiraConnId); // move keychain api-token → this id (Rust)
      }
    }
  } catch {
    /* ignore */
  }

  // 2+3) Read repo configs, harvest AI accounts, bind Jira.
  let configs: Record<string, Record<string, unknown>>;
  try {
    const raw = localStorage.getItem(REPO_CONFIG_KEY);
    configs = raw ? JSON.parse(raw) : {};
  } catch {
    configs = {};
  }

  const seenAi = new Set<string>();
  let changed = false;
  for (const cfg of Object.values(configs)) {
    if (!cfg || typeof cfg !== "object") continue;
    const accounts = (cfg as { aiAccounts?: unknown }).aiAccounts;
    if (Array.isArray(accounts)) {
      for (const a of accounts) {
        if (a && a.id && a.provider && !seenAi.has(a.id)) {
          seenAi.add(a.id);
          ai.push({ id: a.id, provider: a.provider, label: a.label || a.provider, keyHint: a.keyHint });
        }
      }
    }
    const integrations = (cfg.integrations ?? {}) as Record<string, unknown>;
    if (integrations.jiraConnectionId == null) {
      integrations.jiraConnectionId = jiraConnId;
      cfg.integrations = integrations;
      changed = true;
    }
  }

  // 4) Persist the pool + the bound configs; drop the legacy single-connection key.
  saveConnections({ jira, ai });
  if (changed) {
    try {
      localStorage.setItem(REPO_CONFIG_KEY, JSON.stringify(configs));
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(OLD_JIRA_KEY);
  } catch {
    /* ignore */
  }
}
