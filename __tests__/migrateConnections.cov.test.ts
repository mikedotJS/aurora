// Line-coverage suite for src/lib/migrateConnections.ts — the one-time boot
// migration to the connection-pool model. Real localStorage (happy-dom) +
// the shared tauri mock for jira_migrate_token.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { migrateToConnections } from "../src/lib/migrateConnections";
import { CONNECTIONS_KEY } from "../src/lib/connections";
import { REPO_CONFIG_KEY } from "../src/lib/repoConfig";

const OLD_JIRA_KEY = "aurora.jira";

beforeEach(() => {
  tauri.reset();
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("already migrated (no-op)", () => {
  it("returns immediately when aurora.connections already exists, touching nothing", async () => {
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify({ jira: [{ id: "x", site: "s", email: "e" }], ai: [] }));
    localStorage.setItem(OLD_JIRA_KEY, JSON.stringify({ site: "https://should-not-run.atlassian.net", email: "a@b.com" }));
    await migrateToConnections();
    // untouched — still the pre-seeded value, and the legacy key was NOT removed
    expect(JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!).jira[0].id).toBe("x");
    expect(localStorage.getItem(OLD_JIRA_KEY)).not.toBeNull();
    expect(tauri.lastCall("jira_migrate_token")).toBeUndefined();
  });
});

describe("legacy jira migration", () => {
  it("migrates a valid legacy single jira connection, moves the keychain token, and removes the legacy key", async () => {
    localStorage.setItem(OLD_JIRA_KEY, JSON.stringify({ site: "https://acme.atlassian.net/", email: "me@acme.com" }));
    await migrateToConnections();
    const saved = JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!);
    expect(saved.jira).toHaveLength(1);
    expect(saved.jira[0].site).toBe("https://acme.atlassian.net/");
    expect(saved.jira[0].email).toBe("me@acme.com");
    expect(saved.jira[0].label).toBe("acme.atlassian.net");
    expect(saved.jira[0].id.startsWith("jira-")).toBe(true);
    expect(tauri.lastCall("jira_migrate_token")?.args.connId).toBe(saved.jira[0].id);
    expect(localStorage.getItem(OLD_JIRA_KEY)).toBeNull();
  });

  it("skips migration when the legacy key is absent (raw falsy branch)", async () => {
    await migrateToConnections();
    const saved = JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!);
    expect(saved.jira).toEqual([]);
    expect(tauri.lastCall("jira_migrate_token")).toBeUndefined();
  });

  it("skips migration when the legacy value is missing site/email (falls through silently)", async () => {
    localStorage.setItem(OLD_JIRA_KEY, JSON.stringify({ site: "", email: "" }));
    await migrateToConnections();
    const saved = JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!);
    expect(saved.jira).toEqual([]);
  });

  it("swallows malformed legacy JSON (catch branch) and still completes", async () => {
    localStorage.setItem(OLD_JIRA_KEY, "{not json");
    await expect(migrateToConnections()).resolves.toBeUndefined();
    const saved = JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!);
    expect(saved.jira).toEqual([]);
    // the malformed key removal is still attempted (best-effort) at the end
    expect(localStorage.getItem(OLD_JIRA_KEY)).toBeNull();
  });
});

describe("repo config harvesting + binding", () => {
  it("handles an absent repo-config key (configs = {})", async () => {
    await migrateToConnections();
    expect(localStorage.getItem(REPO_CONFIG_KEY)).toBeNull();
  });

  it("swallows malformed repo-config JSON (catch branch → configs = {})", async () => {
    localStorage.setItem(REPO_CONFIG_KEY, "{not json");
    await expect(migrateToConnections()).resolves.toBeUndefined();
    // configs stayed {} so nothing was rewritten
    expect(localStorage.getItem(REPO_CONFIG_KEY)).toBe("{not json");
  });

  it("skips non-object / null config entries", async () => {
    localStorage.setItem(REPO_CONFIG_KEY, JSON.stringify({ "/r1": null, "/r2": "nope" }));
    await expect(migrateToConnections()).resolves.toBeUndefined();
    // neither entry produced a rewrite (both skipped by `continue`)
    expect(localStorage.getItem(REPO_CONFIG_KEY)).toBe(JSON.stringify({ "/r1": null, "/r2": "nope" }));
  });

  it("harvests aiAccounts across repos, dedupes by id, and binds every unbound repo to the migrated jira connection", async () => {
    localStorage.setItem(OLD_JIRA_KEY, JSON.stringify({ site: "https://acme.atlassian.net", email: "me@acme.com" }));
    localStorage.setItem(
      REPO_CONFIG_KEY,
      JSON.stringify({
        "/repo/a": {
          root: "/repo/a",
          aiAccounts: [
            { id: "ai-1", provider: "claude", label: "Work", keyHint: "sk-…1a2b" },
            { id: "ai-2", provider: "openai" }, // no label -> falls back to provider
          ],
          integrations: {}, // jiraConnectionId absent (== null via ??) -> gets bound
        },
        "/repo/b": {
          root: "/repo/b",
          aiAccounts: [
            { id: "ai-1", provider: "claude", label: "Duplicate" }, // dedup: same id as repo a's, skipped
            { id: "not-valid" }, // missing provider -> skipped
            null, // falsy entry -> skipped
          ],
          integrations: { jiraConnectionId: "already-bound" }, // already bound -> untouched
        },
        "/repo/c": {
          root: "/repo/c",
          // no aiAccounts array at all -> Array.isArray branch false
          integrations: { jiraConnectionId: null },
        },
      }),
    );

    await migrateToConnections();

    const savedConn = JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!);
    expect(savedConn.ai).toHaveLength(2);
    expect(savedConn.ai.find((a: { id: string }) => a.id === "ai-1")).toEqual({
      id: "ai-1",
      provider: "claude",
      label: "Work",
      keyHint: "sk-…1a2b",
    });
    expect(savedConn.ai.find((a: { id: string }) => a.id === "ai-2")).toEqual({
      id: "ai-2",
      provider: "openai",
      label: "openai",
      keyHint: undefined,
    });
    const jiraConnId = savedConn.jira[0].id;

    const savedConfigs = JSON.parse(localStorage.getItem(REPO_CONFIG_KEY)!);
    expect(savedConfigs["/repo/a"].integrations.jiraConnectionId).toBe(jiraConnId);
    expect(savedConfigs["/repo/b"].integrations.jiraConnectionId).toBe("already-bound"); // untouched
    expect(savedConfigs["/repo/c"].integrations.jiraConnectionId).toBe(jiraConnId);
  });

  it("does not rewrite the repo-config key when nothing changed (every repo already bound)", async () => {
    localStorage.setItem(
      REPO_CONFIG_KEY,
      JSON.stringify({ "/repo/a": { root: "/repo/a", integrations: { jiraConnectionId: "already-bound" } } }),
    );
    await migrateToConnections();
    // unchanged -> `changed` stays false -> setItem for REPO_CONFIG_KEY skipped -> value untouched
    const savedConfigs = JSON.parse(localStorage.getItem(REPO_CONFIG_KEY)!);
    expect(savedConfigs["/repo/a"].integrations.jiraConnectionId).toBe("already-bound");
  });

  it("swallows a localStorage.setItem failure while persisting rewritten repo configs (catch branch)", async () => {
    localStorage.setItem(
      REPO_CONFIG_KEY,
      JSON.stringify({ "/repo/a": { root: "/repo/a", integrations: {} } }),
    );
    const orig = localStorage.setItem.bind(localStorage);
    let calls = 0;
    localStorage.setItem = (key: string, value: string) => {
      calls++;
      // let the CONNECTIONS_KEY write through, but fail the REPO_CONFIG_KEY rewrite
      if (key === REPO_CONFIG_KEY && calls > 1) throw new Error("quota exceeded");
      return orig(key, value);
    };
    try {
      await expect(migrateToConnections()).resolves.toBeUndefined();
    } finally {
      localStorage.setItem = orig;
    }
  });
});

describe("legacy key removal failure", () => {
  it("swallows a localStorage.removeItem failure (final catch branch)", async () => {
    localStorage.setItem(OLD_JIRA_KEY, JSON.stringify({ site: "https://acme.atlassian.net", email: "me@acme.com" }));
    const orig = localStorage.removeItem.bind(localStorage);
    localStorage.removeItem = () => {
      throw new Error("boom");
    };
    try {
      await expect(migrateToConnections()).resolves.toBeUndefined();
    } finally {
      localStorage.removeItem = orig;
    }
  });
});
