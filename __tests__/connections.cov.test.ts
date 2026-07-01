// Line-coverage suite for src/lib/connections.ts — pure sync helpers backed by
// localStorage (real localStorage via happy-dom, no Tauri involved).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  CONNECTIONS_KEY,
  emptyConnections,
  newConnId,
  siteHost,
  loadConnections,
  saveConnections,
  type Connections,
} from "../src/lib/connections";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("emptyConnections", () => {
  it("returns empty jira and ai arrays", () => {
    expect(emptyConnections()).toEqual({ jira: [], ai: [] });
  });
});

describe("newConnId", () => {
  it("prefixes the id with the given prefix", () => {
    const id = newConnId("jira");
    expect(id.startsWith("jira-")).toBe(true);
  });

  it("produces distinct ids across calls", () => {
    const a = newConnId("ai");
    const b = newConnId("ai");
    expect(a).not.toBe(b);
  });
});

describe("siteHost", () => {
  it("strips the https:// scheme", () => {
    expect(siteHost("https://acme.atlassian.net")).toBe("acme.atlassian.net");
  });

  it("strips the http:// scheme", () => {
    expect(siteHost("http://acme.atlassian.net")).toBe("acme.atlassian.net");
  });

  it("strips a trailing path", () => {
    expect(siteHost("https://acme.atlassian.net/jira/browse")).toBe("acme.atlassian.net");
  });

  it("trims surrounding whitespace", () => {
    expect(siteHost("  https://acme.atlassian.net  ")).toBe("acme.atlassian.net");
  });

  it("passes through a bare host with no scheme or path", () => {
    expect(siteHost("acme.atlassian.net")).toBe("acme.atlassian.net");
  });
});

describe("loadConnections", () => {
  it("returns empty connections when nothing is stored", () => {
    expect(loadConnections()).toEqual({ jira: [], ai: [] });
  });

  it("returns empty connections when the stored JSON is malformed (catch branch)", () => {
    localStorage.setItem(CONNECTIONS_KEY, "{not json");
    expect(loadConnections()).toEqual({ jira: [], ai: [] });
  });

  it("defaults jira/ai to [] when the parsed shape lacks arrays", () => {
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify({ jira: "nope", ai: null }));
    expect(loadConnections()).toEqual({ jira: [], ai: [] });
  });

  it("filters out malformed jira entries (missing id/site/email) and keeps valid ones", () => {
    localStorage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify({
        jira: [
          { id: "j1", site: "https://a.atlassian.net", email: "a@b.com" },
          { id: "", site: "https://a.atlassian.net", email: "a@b.com" }, // no id
          { id: "j2", site: "", email: "a@b.com" }, // no site
          { id: "j3", site: "https://a.atlassian.net", email: "" }, // no email
          null,
        ],
        ai: [],
      }),
    );
    const loaded = loadConnections();
    expect(loaded.jira).toEqual([{ id: "j1", site: "https://a.atlassian.net", email: "a@b.com" }]);
  });

  it("filters out malformed ai entries (missing id/provider) and keeps valid ones", () => {
    localStorage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify({
        jira: [],
        ai: [
          { id: "a1", provider: "claude", label: "Work" },
          { id: "", provider: "claude", label: "no id" },
          { id: "a2", provider: "", label: "no provider" },
          undefined,
        ],
      }),
    );
    const loaded = loadConnections();
    expect(loaded.ai).toEqual([{ id: "a1", provider: "claude", label: "Work" }]);
  });
});

describe("saveConnections", () => {
  it("round-trips through loadConnections", () => {
    const c: Connections = {
      jira: [{ id: "j1", site: "https://a.atlassian.net", email: "a@b.com", label: "a.atlassian.net" }],
      ai: [{ id: "a1", provider: "claude", label: "Work", keyHint: "sk-ant-…1a2b" }],
    };
    saveConnections(c);
    expect(JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!)).toEqual(c);
    expect(loadConnections()).toEqual(c);
  });

  it("swallows a localStorage.setItem failure (catch branch)", () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => saveConnections(emptyConnections())).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });
});
