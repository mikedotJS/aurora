// Line-coverage suite for src/lib/notifications.ts — MR polling, MR-driven
// two-way Jira sync, and the glab-user resolver. Uses the real Zustand store +
// the shared Tauri invoke mock. Module-level state (notGitlab/snapshots/
// userByRoot/timer) persists for the lifetime of this file, so each scenario
// uses a distinct repo root to stay isolated.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, DEFAULT_SETTINGS, type GitlabMr } from "../src/state/store";
import { defaultRepoConfig } from "../src/lib/repoConfig";
import { startNotificationPoller, refreshRepoMrs, ensureGlabUser } from "../src/lib/notifications";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function mr(overrides: Partial<GitlabMr> = {}): GitlabMr {
  return { iid: 1, project_id: 100, title: "Fix thing", branch: "feat/x", draft: false, author: "ada", web_url: "https://gl/mr/1", updated: "t1", notes: 0, sha: "sha1", ...overrides };
}

beforeEach(() => {
  tauri.reset();
  useStore.setState(
    {
      workspaces: [],
      repoConfigs: {},
      connections: { jira: [], ai: [] },
      repoMrs: {},
      notifs: [],
      notifLog: [],
      unseen: 0,
      muted: false,
      glabUser: null,
      settings: { ...DEFAULT_SETTINGS, notifyMr: true },
    },
    false,
  );
});

// ── pollRepo / refreshRepoMrs ────────────────────────────────────────────────

describe("refreshRepoMrs — MR polling + notification diffing", () => {
  it("glab missing/not-authed: swallows the error, never sets repoMrs", async () => {
    tauri.invoke({
      glab_mr_list: () => {
        throw new Error("glab: command not found");
      },
    });
    await refreshRepoMrs("/repo/no-glab");
    expect(useStore.getState().repoMrs["/repo/no-glab"]).toBeUndefined();
  });

  it("first poll seeds the cache + snapshot without notifying", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 1 })] });
    await refreshRepoMrs("/repo/aurora");
    expect(useStore.getState().repoMrs["/repo/aurora"]).toHaveLength(1);
    expect(useStore.getState().notifs).toHaveLength(0);
  });

  it("a newly-appeared MR on a later poll raises a 'New MR' notification", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 1 })] });
    await refreshRepoMrs("/repo/aurora");
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 1 }), mr({ iid: 2, title: "Second" })] });
    await refreshRepoMrs("/repo/aurora");
    const notif = useStore.getState().notifs.find((n) => n.headline.includes("New MR !2"));
    expect(notif).toBeDefined();
    expect(notif?.repo).toBe("aurora");
    expect(notif?.sub).toBe("Second");
  });

  it("a draft MR turning ready raises a 'ready for review' notification", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 5, draft: true })] });
    await refreshRepoMrs("/repo/draft");
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 5, draft: false })] });
    await refreshRepoMrs("/repo/draft");
    const notif = useStore.getState().notifs.find((n) => n.headline.includes("ready for review"));
    expect(notif).toBeDefined();
  });

  it("an MR's updated timestamp changing (no draft flip) raises an 'updated' notification", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 7, updated: "t1" })] });
    await refreshRepoMrs("/repo/updated");
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 7, updated: "t2" })] });
    await refreshRepoMrs("/repo/updated");
    const notif = useStore.getState().notifs.find((n) => n.headline.includes("MR !7 updated"));
    expect(notif).toBeDefined();
  });

  it("a rising comment count raises a 'New comment' notification naming the author", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 8, notes: 1 })] });
    await refreshRepoMrs("/repo/comment");
    tauri.invoke({
      glab_mr_list: () => [mr({ iid: 8, notes: 2, updated: "t2" })],
      glab_mr_note_author: () => "bob",
    });
    await refreshRepoMrs("/repo/comment");
    await flush();
    const notif = useStore.getState().notifs.find((n) => n.headline.includes("New comment"));
    expect(notif?.headline).toBe("New comment from @bob on MR !8");
  });

  it("falls back to an author-less 'New comment' when the note-author lookup fails", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 11, notes: 0 })] });
    await refreshRepoMrs("/repo/comment-noauthor");
    tauri.invoke({
      glab_mr_list: () => [mr({ iid: 11, notes: 3, updated: "t2" })],
      glab_mr_note_author: () => {
        throw new Error("glab: no human note author");
      },
    });
    await refreshRepoMrs("/repo/comment-noauthor");
    await flush();
    const notif = useStore.getState().notifs.find((n) => n.headline.includes("new comments"));
    expect(notif?.headline).toBe("3 new comments on MR !11");
  });

  it("a changed head sha (no new comment) raises a 'New commits' notification", async () => {
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 9, sha: "aaa" })] });
    await refreshRepoMrs("/repo/pushed");
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 9, sha: "bbb", updated: "t2" })] });
    await refreshRepoMrs("/repo/pushed");
    const notif = useStore.getState().notifs.find((n) => n.headline.includes("New commits on MR !9"));
    expect(notif).toBeDefined();
  });

  it("settings.notifyMr = false suppresses notifications even when the MR list changes", async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, notifyMr: false } }, false);
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 1 })] });
    await refreshRepoMrs("/repo/muted");
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 1 }), mr({ iid: 2 })] });
    await refreshRepoMrs("/repo/muted");
    expect(useStore.getState().notifs).toHaveLength(0);
    // The cache itself still updates regardless of notification muting.
    expect(useStore.getState().repoMrs["/repo/muted"]).toHaveLength(2);
  });
});

describe("startNotificationPoller — runs pollAll once, then guards against re-entry", () => {
  it("second call is a no-op; a root already flagged non-gitlab is skipped by the background poll", async () => {
    const root = "/repo/flagged";
    // 1) Mark the repo non-gitlab via a direct failed poll.
    tauri.invoke({
      glab_mr_list: () => {
        throw new Error("not a gitlab repo");
      },
    });
    await refreshRepoMrs(root);
    expect(tauri.calls().filter((c) => c.cmd === "glab_mr_list").length).toBe(1);

    // 2) Register a pane rooted at that repo so allRepoRoots() surfaces it, then
    //    make glab_mr_list succeed — if the early-return guard works, pollAll
    //    must NOT call it again for this still-flagged root.
    useStore.setState(
      {
        workspaces: [
          {
            id: "w1",
            tabs: [{ id: 1, active: 0, split: "h", panes: [{ id: 1, repoRoot: root }] }],
          } as never,
        ],
      },
      false,
    );
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 9 })] });

    const realSetInterval = globalThis.setInterval;
    let intervalCalls = 0;
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((fn: () => void, _ms?: number) => {
      intervalCalls++;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      startNotificationPoller();
      await flush();
      startNotificationPoller(); // guarded: timer already set, must be a no-op
      await flush();
      expect(intervalCalls).toBe(1);
      // Still only the one call from step 1 — the guarded root was skipped.
      expect(tauri.calls().filter((c) => c.cmd === "glab_mr_list").length).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});

// ── syncJiraForRepo (reached through a successful pollRepo when Jira is bound) ──

describe("MR-driven Jira sync (via refreshRepoMrs)", () => {
  function bindJira(root: string, doneName = "Done") {
    const cfg = defaultRepoConfig(root);
    cfg.integrations.jiraConnectionId = "jc1";
    cfg.integrations.jiraDone = doneName;
    useStore.setState(
      {
        repoConfigs: { [root]: cfg },
        connections: { jira: [{ id: "jc1", site: "https://acme.atlassian.net", email: "a@b.com" }], ai: [] },
      },
      false,
    );
  }

  it("posts the MR link once when an MR appears for a synced workspace's branch", async () => {
    const root = "/repo/jira-open";
    bindJira(root);
    useStore.setState(
      {
        workspaces: [
          {
            id: "w1",
            repoId: root,
            jiraSync: true,
            issueKey: "PROJ-1",
            branch: "feat/x",
            mr: null,
            tabs: [],
          } as never,
        ],
      },
      false,
    );
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 3, branch: "feat/x" })], jira_add_remote_link: () => undefined });
    await refreshRepoMrs(root);
    await flush();
    const w = useStore.getState().workspaces.find((w) => w.id === "w1")!;
    expect(w.mr).toEqual({ iid: 3, state: "open", url: "https://gl/mr/1" });
    expect(tauri.lastCall("jira_add_remote_link")?.args).toMatchObject({ connId: "jc1", key: "PROJ-1" });
  });

  it("does not re-post the link on a later poll for the same iid (guard)", async () => {
    const root = "/repo/jira-guard";
    bindJira(root);
    useStore.setState(
      {
        workspaces: [{ id: "w1", repoId: root, jiraSync: true, issueKey: "PROJ-1", branch: "feat/x", mr: null, tabs: [] } as never],
      },
      false,
    );
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 3, branch: "feat/x" })] });
    await refreshRepoMrs(root);
    await flush();
    const mrAfterFirst = useStore.getState().workspaces.find((w) => w.id === "w1")!.mr;
    const callsAfterFirst = tauri.calls().filter((c) => c.cmd === "jira_add_remote_link").length;

    await refreshRepoMrs(root); // same iid again
    await flush();
    const mrAfterSecond = useStore.getState().workspaces.find((w) => w.id === "w1")!.mr;
    expect(mrAfterSecond).toBe(mrAfterFirst); // same reference: setWsMr not re-invoked
    expect(tauri.calls().filter((c) => c.cmd === "jira_add_remote_link").length).toBe(callsAfterFirst);
  });

  it("transitions the issue to Done once a previously-open MR disappears (merged)", async () => {
    const root = "/repo/jira-merged";
    bindJira(root, "Shipped");
    useStore.setState(
      {
        workspaces: [
          {
            id: "w1",
            repoId: root,
            jiraSync: true,
            issueKey: "PROJ-1",
            branch: "feat/x",
            mr: { iid: 3, state: "open", url: "https://gl/mr/1" },
            tabs: [],
          } as never,
        ],
      },
      false,
    );
    tauri.invoke({ glab_mr_list: () => [], jira_transition: () => undefined }); // MR gone → merged
    await refreshRepoMrs(root);
    await flush();
    await flush();
    const w = useStore.getState().workspaces.find((w) => w.id === "w1")!;
    expect(w.mr?.state).toBe("merged");
    expect(tauri.lastCall("jira_transition")?.args).toMatchObject({ key: "PROJ-1", toName: "Shipped" });
    expect(w.jiraStatus).toBe("Shipped");
  });

  it("skips workspaces that don't match repo/jiraSync/issueKey/branch (continue branch)", async () => {
    const root = "/repo/jira-skip";
    bindJira(root);
    useStore.setState(
      {
        workspaces: [
          { id: "other-repo", repoId: "/repo/elsewhere", jiraSync: true, issueKey: "P-1", branch: "b", mr: null, tabs: [] } as never,
          { id: "not-synced", repoId: root, jiraSync: false, issueKey: "P-2", branch: "b", mr: null, tabs: [] } as never,
          { id: "no-issue", repoId: root, jiraSync: true, issueKey: null, branch: "b", mr: null, tabs: [] } as never,
          { id: "no-branch", repoId: root, jiraSync: true, issueKey: "P-3", branch: null, mr: null, tabs: [] } as never,
        ],
      },
      false,
    );
    tauri.invoke({ glab_mr_list: () => [mr({ iid: 1, branch: "b" })] });
    await expect(refreshRepoMrs(root)).resolves.toBeUndefined();
    // None of the skipped workspaces were touched.
    for (const w of useStore.getState().workspaces) expect(w.mr).toBeNull();
  });
});

// ── ensureGlabUser ────────────────────────────────────────────────────────────

describe("ensureGlabUser", () => {
  it("resets glabUser to null for a null root", async () => {
    useStore.setState({ glabUser: "someone" }, false);
    await ensureGlabUser(null);
    expect(useStore.getState().glabUser).toBeNull();
  });

  it("resolves + caches the username on success; a second call for the same root skips invoke", async () => {
    const root = "/repo/user-ok";
    tauri.invoke({ glab_current_user: () => "octocat" });
    await ensureGlabUser(root);
    expect(useStore.getState().glabUser).toBe("octocat");
    expect(tauri.calls().filter((c) => c.cmd === "glab_current_user").length).toBe(1);

    tauri.invoke({
      glab_current_user: () => {
        throw new Error("should not be called again");
      },
    });
    await ensureGlabUser(root);
    expect(useStore.getState().glabUser).toBe("octocat");
    expect(tauri.calls().filter((c) => c.cmd === "glab_current_user").length).toBe(1);
  });

  it("caches null on failure; a second call for the same failed root skips invoke", async () => {
    const root = "/repo/user-fail";
    tauri.invoke({
      glab_current_user: () => {
        throw new Error("not authed");
      },
    });
    await ensureGlabUser(root);
    expect(useStore.getState().glabUser).toBeNull();
    expect(tauri.calls().filter((c) => c.cmd === "glab_current_user").length).toBe(1);

    await ensureGlabUser(root);
    expect(useStore.getState().glabUser).toBeNull();
    expect(tauri.calls().filter((c) => c.cmd === "glab_current_user").length).toBe(1);
  });
});
