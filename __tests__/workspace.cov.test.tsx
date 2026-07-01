// Coverage suite for src/lib/workspace.ts — status-dot state machine + localStorage
// persistence of the workspace/repo lists.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  statusOf,
  dotColor,
  dotPulses,
  statusLine,
  loadPersisted,
  savePersisted,
  loadRepos,
  saveRepos,
} from "../src/lib/workspace";
import type { Workspace, Repo } from "../src/state/store";

function makeWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    repoId: "/repo",
    title: "feat/x",
    issueKey: null,
    branch: "feat/x",
    baseBranch: "main",
    dir: "/repo/.aurora-worktrees/feat-x",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [],
    active: 0,
    createdAt: 1000,
    lastActive: 2000,
    serverTabId: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("statusOf", () => {
  it("is 'attention' when the pipeline failed", () => {
    expect(statusOf(makeWs({ pipeline: "failed" }))).toBe("attention");
  });
  it("is 'attention' when the diff has conflicts", () => {
    expect(statusOf(makeWs({ diff: { files: 1, added: 0, removed: 0, conflicted: 1 } }))).toBe("attention");
  });
  it("is 'idle' when pipeline passed and no conflicts", () => {
    expect(statusOf(makeWs({ pipeline: "passed", diff: { files: 3, added: 1, removed: 1, conflicted: 0 } }))).toBe(
      "idle",
    );
  });
  it("is 'idle' when diff is null and pipeline is null", () => {
    expect(statusOf(makeWs())).toBe("idle");
  });
});

describe("dotColor", () => {
  it("returns the error color for attention", () => {
    expect(dotColor("attention")).toBe("var(--err)");
  });
  it("returns the faint color for idle", () => {
    expect(dotColor("idle")).toBe("var(--faint)");
  });
});

describe("dotPulses", () => {
  it("always returns false regardless of status", () => {
    expect(dotPulses("attention")).toBe(false);
    expect(dotPulses("idle")).toBe(false);
  });
});

describe("statusLine", () => {
  it("reports a failed pipeline", () => {
    const line = statusLine(makeWs({ pipeline: "failed" }));
    expect(line.text).toBe("✕ pipeline failed");
    expect(line.color).toBe("var(--err)");
  });
  it("reports a merge conflict when not a failed pipeline", () => {
    const line = statusLine(makeWs({ diff: { files: 1, added: 0, removed: 0, conflicted: 2 } }));
    expect(line.text).toBe("merge conflict");
  });
  it("reports uncommitted file count when idle with changes", () => {
    const line = statusLine(makeWs({ diff: { files: 4, added: 2, removed: 1, conflicted: 0 } }));
    expect(line.text).toBe("4 uncommitted");
    expect(line.color).toBe("var(--dim)");
  });
  it("reports 'idle' for a repo-linked workspace with no changes", () => {
    const line = statusLine(makeWs({ diff: { files: 0, added: 0, removed: 0, conflicted: 0 } }));
    expect(line.text).toBe("idle");
  });
  it("reports 'manual branch' for a repoId==null workspace with no changes", () => {
    const line = statusLine(makeWs({ repoId: null, diff: null }));
    expect(line.text).toBe("manual branch");
  });
  it("treats a null diff as zero files (idle, repo-linked)", () => {
    const line = statusLine(makeWs({ diff: null }));
    expect(line.text).toBe("idle");
  });
});

describe("loadPersisted / savePersisted", () => {
  it("returns the empty shape when nothing is stored", () => {
    expect(loadPersisted()).toEqual({ workspaces: [], activeWs: null });
  });

  it("round-trips workspaces + activeWs through savePersisted/loadPersisted", () => {
    const ws = makeWs({ id: "w1" });
    savePersisted([ws], "w1");
    const loaded = loadPersisted();
    expect(loaded.activeWs).toBe("w1");
    expect(loaded.workspaces.length).toBe(1);
    expect(loaded.workspaces[0]).toMatchObject({
      id: "w1",
      repoId: "/repo",
      title: "feat/x",
      branch: "feat/x",
      baseBranch: "main",
      dir: ws.dir,
      jiraSync: false,
      env: {},
      createdAt: 1000,
      lastActive: 2000,
    });
    // Runtime-only fields must NOT be persisted.
    expect((loaded.workspaces[0] as unknown as Record<string, unknown>).mounted).toBeUndefined();
    expect((loaded.workspaces[0] as unknown as Record<string, unknown>).serverTabId).toBeUndefined();
  });

  it("savePersisted with activeWs=null persists null", () => {
    savePersisted([makeWs()], null);
    expect(loadPersisted().activeWs).toBeNull();
  });

  it("loadPersisted returns [] when the stored workspaces value is not an array", () => {
    localStorage.setItem("aurora.workspaces", JSON.stringify({ workspaces: "not-an-array", activeWs: "w1" }));
    const loaded = loadPersisted();
    expect(loaded.workspaces).toEqual([]);
    expect(loaded.activeWs).toBe("w1");
  });

  it("loadPersisted returns activeWs=null when the stored value is not a string", () => {
    localStorage.setItem("aurora.workspaces", JSON.stringify({ workspaces: [], activeWs: 42 }));
    expect(loadPersisted().activeWs).toBeNull();
  });

  it("loadPersisted swallows malformed JSON and returns the empty shape", () => {
    localStorage.setItem("aurora.workspaces", "{not json");
    expect(loadPersisted()).toEqual({ workspaces: [], activeWs: null });
  });

  it("savePersisted swallows a localStorage.setItem failure", () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => savePersisted([makeWs()], "w1")).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });
});

describe("loadRepos / saveRepos", () => {
  const repo: Repo = { id: "/repo", root: "/repo", name: "repo", defaultBranch: "main" };

  it("returns [] when nothing is stored", () => {
    expect(loadRepos()).toEqual([]);
  });

  it("round-trips repos through saveRepos/loadRepos", () => {
    saveRepos([repo]);
    expect(loadRepos()).toEqual([repo]);
  });

  it("returns [] when the stored value is not an array", () => {
    localStorage.setItem("aurora.repos", JSON.stringify({ not: "an array" }));
    expect(loadRepos()).toEqual([]);
  });

  it("filters out malformed entries missing required string fields", () => {
    localStorage.setItem(
      "aurora.repos",
      JSON.stringify([repo, { id: "/bad" }, null, { id: 5, root: "/x", name: "x" }, "nope"]),
    );
    expect(loadRepos()).toEqual([repo]);
  });

  it("swallows malformed JSON and returns []", () => {
    localStorage.setItem("aurora.repos", "{not json");
    expect(loadRepos()).toEqual([]);
  });

  it("saveRepos swallows a localStorage.setItem failure", () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => saveRepos([repo])).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });
});
