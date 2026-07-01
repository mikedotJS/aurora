// Coverage suite for src/components/Connections.tsx — the Jira + AI account
// connection pool UI shown in app Settings. Driven entirely through the real
// Zustand store + the shared tauri mock (jira_set_token / jira_validate /
// jira_clear_token / ai_key_set / ai_key_delete all go through invoke()).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import { Connections } from "../src/components/Connections";
import { getRepoConfig, defaultRepoConfig, type RepoConfig } from "../src/lib/repoConfig";
import { maskKey } from "../src/lib/keychain";

function resetStore(overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({
    connections: { jira: [], ai: [] },
    repoConfigs: {},
    apiKeyPresent: false,
    settingsOpen: true,
    keyEntry: false,
    ...overrides,
  });
}

beforeEach(() => {
  tauri.reset();
  resetStore();
});
afterEach(cleanup);

function cfgBoundToJira(root: string, connId: string): RepoConfig {
  const c = defaultRepoConfig(root);
  c.integrations.jiraConnectionId = connId;
  return c;
}
function cfgBoundToAi(root: string, id: string): RepoConfig {
  const c = defaultRepoConfig(root);
  c.defaults.aiDefaultId = id;
  return c;
}

describe("Connections wrapper", () => {
  it("renders both the Jira and AI account sections", () => {
    render(<Connections />);
    expect(screen.getByText("Connections · Jira")).toBeTruthy();
    expect(screen.getByText("Connections · AI accounts")).toBeTruthy();
  });
});

describe("JiraConnections — list rendering", () => {
  it("shows the empty state when there are no jira connections", () => {
    render(<Connections />);
    expect(screen.getByText("No Jira sites yet. Add one, then bind it per repo in that repo's settings.")).toBeTruthy();
  });

  it("labels a row with its explicit label, and shows no repo-count suffix when unbound", () => {
    resetStore({
      connections: { jira: [{ id: "j1", site: "https://acme.atlassian.net", email: "me@acme.com", label: "Acme" }], ai: [] },
    });
    render(<Connections />);
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("me@acme.com")).toBeTruthy();
  });

  it("falls back to siteHost() as the label when no explicit label is set", () => {
    resetStore({
      connections: { jira: [{ id: "j1", site: "https://acme.atlassian.net", email: "me@acme.com" }], ai: [] },
    });
    render(<Connections />);
    expect(screen.getByText("acme.atlassian.net")).toBeTruthy();
  });

  it("shows singular '1 repo' suffix when exactly one repo is bound", () => {
    resetStore({
      connections: { jira: [{ id: "j1", site: "https://acme.atlassian.net", email: "me@acme.com" }], ai: [] },
      repoConfigs: { "/repo/a": cfgBoundToJira("/repo/a", "j1") },
    });
    render(<Connections />);
    expect(screen.getByText("me@acme.com · 1 repo")).toBeTruthy();
  });

  it("shows plural 'N repos' suffix when multiple repos are bound", () => {
    resetStore({
      connections: { jira: [{ id: "j1", site: "https://acme.atlassian.net", email: "me@acme.com" }], ai: [] },
      repoConfigs: {
        "/repo/a": cfgBoundToJira("/repo/a", "j1"),
        "/repo/b": cfgBoundToJira("/repo/b", "j1"),
        "/repo/c": cfgBoundToJira("/repo/c", "other"),
      },
    });
    render(<Connections />);
    expect(screen.getByText("me@acme.com · 2 repos")).toBeTruthy();
  });
});

describe("JiraConnections — remove", () => {
  it("clears the keychain token, drops the connection, and unbinds only repos pointed at it", async () => {
    resetStore({
      connections: { jira: [{ id: "j1", site: "https://acme.atlassian.net", email: "me@acme.com" }], ai: [] },
      repoConfigs: {
        "/repo/a": cfgBoundToJira("/repo/a", "j1"),
        "/repo/b": cfgBoundToJira("/repo/b", "other-conn"),
      },
    });
    render(<Connections />);
    fireEvent.click(screen.getByText("remove"));
    await Promise.resolve();
    await Promise.resolve();

    expect(tauri.lastCall("jira_clear_token")?.args.connId).toBe("j1");
    expect(useStore.getState().connections.jira).toEqual([]);
    expect(getRepoConfig("/repo/a").integrations.jiraConnectionId).toBeNull();
    expect(getRepoConfig("/repo/b").integrations.jiraConnectionId).toBe("other-conn");
  });
});

describe("JiraConnections — add flow", () => {
  it("toggles the add form open and closed via cancel", () => {
    render(<Connections />);
    expect(screen.queryByText("Site URL")).toBeNull();
    fireEvent.click(screen.getByText("+ Add Jira site"));
    expect(screen.getByText("Site URL")).toBeTruthy();
    fireEvent.click(screen.getByText("cancel"));
    expect(screen.queryByText("Site URL")).toBeNull();
    expect(screen.getByText("+ Add Jira site")).toBeTruthy();
  });

  it("rejects submission with missing fields", async () => {
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fireEvent.click(screen.getByText("Add connection"));
    await Promise.resolve();
    expect(screen.getByText("Enter site, email, and API token.")).toBeTruthy();
    expect(tauri.lastCall("jira_set_token")).toBeUndefined();
  });

  function fillJiraForm(site: string, email: string, token: string) {
    fireEvent.change(screen.getByPlaceholderText("https://your-team.atlassian.net"), { target: { value: site } });
    fireEvent.change(screen.getByPlaceholderText("you@team.com"), { target: { value: email } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: token } });
  }

  it("on jiraSetToken failure, surfaces the raw error and leaves the form open", async () => {
    tauri.invoke({
      jira_set_token: () => {
        throw new Error("keychain locked");
      },
    });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("https://acme.atlassian.net", "me@acme.com", "tok123");
    fireEvent.click(screen.getByText("Add connection"));
    await Promise.resolve();
    await waitFor(() => expect(screen.getByText(/keychain locked/)).toBeTruthy());
    expect(useStore.getState().connections.jira).toEqual([]);
    expect(screen.getByText("Site URL")).toBeTruthy(); // form still open
  });

  it("humanizes a 401/403 validation error", async () => {
    tauri.invoke({ jira_validate: () => Promise.reject(new Error("jira 401: unauthorized")) });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("https://acme.atlassian.net/", "me@acme.com", "tok123");
    fireEvent.click(screen.getByText("Add connection"));
    await waitFor(() => expect(screen.getByText("Invalid email or API token.")).toBeTruthy());
    // jiraClearToken must be called to roll back the just-stored token
    expect(tauri.lastCall("jira_clear_token")).toBeTruthy();
  });

  it("humanizes a 404/dns/resolve validation error", async () => {
    tauri.invoke({ jira_validate: () => Promise.reject(new Error("jira 404: could not resolve host")) });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("https://acme.atlassian.net/", "me@acme.com", "tok123");
    fireEvent.click(screen.getByText("Add connection"));
    await waitFor(() =>
      expect(screen.getByText("Couldn't reach that site — check the URL (https://your-team.atlassian.net).")).toBeTruthy(),
    );
  });

  it("humanizes an unrecognized validation error by stripping the 'jira NNN:' prefix", async () => {
    // Reject with a plain string (not an Error) so String(e) has no "Error: " prefix,
    // exercising the regex-strip branch precisely.
    tauri.invoke({ jira_validate: () => Promise.reject("jira 500: something odd happened") });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("https://acme.atlassian.net/", "me@acme.com", "tok123");
    fireEvent.click(screen.getByText("Add connection"));
    await waitFor(() => expect(screen.getByText("something odd happened")).toBeTruthy());
  });

  it("falls back to the generic message when the stripped error is empty", async () => {
    // Reject with an empty string (not `new Error("")`, whose String() is "Error").
    tauri.invoke({ jira_validate: () => Promise.reject("") });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("https://acme.atlassian.net/", "me@acme.com", "tok123");
    fireEvent.click(screen.getByText("Add connection"));
    await waitFor(() => expect(screen.getByText("Couldn't connect to Jira.")).toBeTruthy());
  });

  it("on success, stores the connection (trimmed site w/ trailing slash removed) and resets the form", async () => {
    tauri.invoke({ jira_validate: () => Promise.resolve({ account_id: "u1", display_name: "Me" }) });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("  https://acme.atlassian.net/  ", "  me@acme.com  ", "tok123");
    fireEvent.click(screen.getByText("Add connection"));
    await waitFor(() => expect(screen.getByText("+ Add Jira site")).toBeTruthy());
    const jira = useStore.getState().connections.jira;
    expect(jira).toHaveLength(1);
    expect(jira[0].site).toBe("https://acme.atlassian.net");
    expect(jira[0].email).toBe("me@acme.com");
    expect(jira[0].label).toBe("acme.atlassian.net");
    // form reset back to the "+ Add Jira site" link
    expect(screen.getByText("+ Add Jira site")).toBeTruthy();
    expect(screen.queryByText("Site URL")).toBeNull();
  });

  it("ignores a second submit while a request is already in flight (busy guard)", async () => {
    let release!: () => void;
    tauri.invoke({
      jira_set_token: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add Jira site"));
    fillJiraForm("https://acme.atlassian.net", "me@acme.com", "tok123");
    const btn = screen.getByText("Add connection");
    fireEvent.click(btn);
    // still on the same DOM node; button label now reflects the busy state
    expect(screen.getByText("Connecting…")).toBeTruthy();
    fireEvent.click(btn); // second click while busy — must be a no-op
    expect(tauri.calls().filter((c) => c.cmd === "jira_set_token")).toHaveLength(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("AiConnections — terminal key row", () => {
  it("shows the no-key state and starts key entry (closing settings) on click", () => {
    resetStore({ apiKeyPresent: false, settingsOpen: true, keyEntry: false });
    render(<Connections />);
    expect(screen.getByText("no key set — add one to use Claude")).toBeTruthy();
    expect(screen.getByText("add key")).toBeTruthy();
    fireEvent.click(screen.getByText("add key"));
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(useStore.getState().keyEntry).toBe(true);
  });

  it("shows the key-present state with an 'update' action", () => {
    resetStore({ apiKeyPresent: true });
    render(<Connections />);
    expect(screen.getByText("default · stored in the macOS Keychain")).toBeTruthy();
    expect(screen.getByText("update")).toBeTruthy();
  });
});

describe("AiConnections — list rendering", () => {
  it("shows an account row with its key hint appended", () => {
    resetStore({ connections: { jira: [], ai: [{ id: "a1", provider: "claude", label: "Work", keyHint: "sk-ant-…1a2b" }] } });
    render(<Connections />);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("claude · sk-ant-…1a2b")).toBeTruthy();
  });

  it("shows an account row without a key hint suffix when absent", () => {
    resetStore({ connections: { jira: [], ai: [{ id: "a1", provider: "openai", label: "Personal" }] } });
    render(<Connections />);
    expect(screen.getByText("openai")).toBeTruthy();
  });
});

describe("AiConnections — remove", () => {
  it("deletes the keychain key, drops the connection, and unbinds only matching repos", async () => {
    resetStore({
      connections: { jira: [], ai: [{ id: "a1", provider: "claude", label: "Work" }] },
      repoConfigs: {
        "/repo/a": cfgBoundToAi("/repo/a", "a1"),
        "/repo/b": cfgBoundToAi("/repo/b", "other-ai"),
      },
    });
    render(<Connections />);
    fireEvent.click(screen.getByText("remove"));
    await Promise.resolve();
    await Promise.resolve();

    expect(tauri.lastCall("ai_key_delete")?.args.id).toBe("a1");
    expect(useStore.getState().connections.ai).toEqual([]);
    expect(getRepoConfig("/repo/a").defaults.aiDefaultId).toBeNull();
    expect(getRepoConfig("/repo/b").defaults.aiDefaultId).toBe("other-ai");
  });
});

describe("AiConnections — add flow", () => {
  it("toggles the add form open and closed via cancel", () => {
    render(<Connections />);
    expect(screen.queryByText("Provider")).toBeNull();
    fireEvent.click(screen.getByText("+ Add account"));
    expect(screen.getByText("Provider")).toBeTruthy();
    fireEvent.click(screen.getAllByText("cancel")[0]);
    expect(screen.queryByText("Provider")).toBeNull();
  });

  it("does nothing when submitting with an empty key (guard)", async () => {
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add account"));
    fireEvent.click(screen.getByText("Add account"));
    await Promise.resolve();
    expect(tauri.lastCall("ai_key_set")).toBeUndefined();
    expect(useStore.getState().connections.ai).toEqual([]);
    // form stayed open (no reset happened)
    expect(screen.getByText("Provider")).toBeTruthy();
  });

  it("defaults to claude selected, with no 'soon' hint text; switching to openai shows the hint", () => {
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add account"));
    expect(screen.queryByText(/Stored now; Aurora will use it once/)).toBeNull();
    fireEvent.click(screen.getByText("OpenAI · soon"));
    expect(screen.getByText("Stored now; Aurora will use it once openai support lands.")).toBeTruthy();
  });

  it("adds a claude account with an explicit label, storing a masked key hint, then resets the form", async () => {
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add account"));
    fireEvent.change(screen.getByPlaceholderText("e.g. work account"), { target: { value: "  Work laptop  " } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "sk-ant-abcdef1234" } });
    fireEvent.click(screen.getByText("Add account"));
    await Promise.resolve();
    await Promise.resolve();

    const ai = useStore.getState().connections.ai;
    expect(ai).toHaveLength(1);
    expect(ai[0].label).toBe("Work laptop");
    expect(ai[0].provider).toBe("claude");
    expect(ai[0].keyHint).toBe(maskKey("sk-ant-abcdef1234"));
    expect(tauri.lastCall("ai_key_set")?.args).toEqual({ id: ai[0].id, key: "sk-ant-abcdef1234" });
    // form reset back to the "+ Add account" link
    expect(screen.getByText("+ Add account")).toBeTruthy();
  });

  it("falls back to the provider's display label when no label is entered", async () => {
    render(<Connections />);
    fireEvent.click(screen.getByText("+ Add account"));
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "sk-ant-xyz" } });
    fireEvent.click(screen.getByText("Add account"));
    await Promise.resolve();
    await Promise.resolve();
    const ai = useStore.getState().connections.ai;
    expect(ai[0].label).toBe("Claude (Anthropic)");
  });
});
