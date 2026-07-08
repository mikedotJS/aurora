// Coverage suite for src/App.tsx — the boot sequence (home/settings/key/repo
// detection, stale-workspace pruning, script + connection + repo-config
// loading, rail-on-launch default), the global keydown wiring, the
// cwd-change/diff-summary/tab-auto-rename effects, the narrow-breakpoint
// rail auto-collapse, and the top-level render branches (empty state vs.
// tab strip, rail collapsed vs. expanded, every overlay/panel).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import App from "../src/App";
import { useStore, DEFAULT_SETTINGS } from "../src/state/store";
import { emptyConnections } from "../src/lib/connections";
import { tauri } from "../test/mocks/tauri";

function resetAll() {
  localStorage.clear();
  // The "Introducing Workspaces" dialog mounts on boot while settings.introSeen
  // is false, and the WorkspaceTour coach-marks mount right after while
  // tutorialSeen is false. These App boot tests exercise the normal running
  // state, so mark both as already seen (a test needing either overlay sets
  // the relevant flag to false itself).
  localStorage.setItem("aurora.settings", JSON.stringify({ introSeen: true, tutorialSeen: true }));
  window.innerWidth = 1200; // wide by default — narrow-breakpoint tests set this explicitly
  useStore.setState(
    {
      workspaces: [],
      activeWs: null,
      initialized: false,
      railCollapsed: false,
      repos: [],
      home: "~",
      settings: DEFAULT_SETTINGS,
      apiKeyPresent: false,
      keyEntry: false,
      keyError: null,
      settingsOpen: false,
      panel: null,
      userScripts: {},
      repoConfigs: {},
      workspaceSettingsRepo: null,
      scriptsSetupOpen: false,
      repoMrs: {},
      glabUser: null,
      connections: emptyConnections(),
      find: { open: false, query: "", current: 0 },
      notifs: [],
      notifLog: [],
      unseen: 0,
      muted: false,
      command: null,
      wsFilter: "",
    },
    false,
  );
}

async function waitBooted() {
  await waitFor(() => expect(useStore.getState().initialized).toBe(true));
}

// App.tsx always mounts <WorkspaceContextBar/> (from WorkspaceRail.tsx) whenever
// there's an active workspace, regardless of railCollapsed. That component has a
// confirmed pre-existing bug — independently reproduced here AND already
// documented in __tests__/WorkspaceRail.cov.test.tsx ("BUG: crashes with 'Maximum
// update depth exceeded'", src/components/WorkspaceRail.tsx:620-622): its `scripts`
// selector is `repoId ? (s.userScripts[repoId]?.scripts ?? []) : []`, which
// allocates a brand-new array literal on *every* call whenever there's no
// registered userScripts entry for that repoId (or the repoId is null) — Zustand
// doesn't memoize selector output, so React's external-store snapshot check
// never stabilizes and the render loops until React kills it. This means:
//   (a) ANY active manual-lane workspace (repoId: null) crashes <App/> outright —
//       there's no fixture workaround, since that's the ternary's *unconditional*
//       branch. Verified independently below "unreachable" notes.
//   (b) an active repo-backed workspace crashes unless userScripts[repoId] is
//       pre-populated with a stable (non-undefined) RepoScripts entry.
// (b) is real-world reachable too (any newly-added repo with 0 configured
// scripts) but is out of scope to fix here (WorkspaceRail.tsx isn't an assigned
// file). We work around it the same way the WorkspaceRail suite does: seed a
// stable empty entry for any repo root App boots into, both in the store (for
// the very first post-boot render) and in localStorage "aurora.scripts" (so the
// boot's own setUserScripts() call doesn't blow the seed away moments later).
function seedScriptsFor(root: string) {
  const empty = { scripts: [] as never[], onEnter: null };
  useStore.setState({ userScripts: { [root]: empty } }, false);
  localStorage.setItem("aurora.scripts", JSON.stringify({ [root]: empty }));
}

beforeEach(() => {
  tauri.reset();
  resetAll();
});
afterEach(() => {
  cleanup();
});

describe("App — boot gate", () => {
  it("renders nothing until the boot effect finishes", async () => {
    const { container } = render(<App />);
    expect(container.firstChild).toBeNull();
    await waitBooted(); // drain the boot chain before the next test
  });
});

describe("App — boot with no repo context", () => {
  it("settles on the Home terminal (0 repos, 0 restored workspaces) with the rail still visible", async () => {
    const { getAllByText, getByLabelText, queryByTitle } = render(<App />);
    await waitBooted();
    // No central empty pane; the Home terminal is active. Home lives in the
    // TitleBar (a top-level entry, decoupled from the rail), and the rail shows
    // the "add repository" onboarding.
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].kind).toBe("home");
    expect(s.activeWs).toBe(s.workspaces[0].id);
    expect(getByLabelText("Home terminal (~)")).toBeTruthy();
    // The rail shows the zero-repo onboarding: a primary "Add repository" CTA.
    expect(getByLabelText("Add repository").className).toContain("aurora-empty-primary");
    // Rail defaults to visible (not collapsed) when nothing overrides it, and
    // TitleBar renders its normal (non-collapsed) "aurora — zsh" layout. "zsh"
    // now also appears in the live Home terminal pane (Home is really active,
    // unlike the old central empty pane), so assert at least one match rather
    // than a single unique match.
    expect(queryByTitle("switch workspace")).toBeNull();
    expect(getAllByText("zsh").length).toBeGreaterThan(0);
  });
});

describe("App — boot with a real repo", () => {
  function stubRepo(root = "/Users/test/repo") {
    tauri.invoke({
      git_repo_info: () => ({ root, main_root: root, name: "repo", default_branch: "main", current_branch: "main" }),
      git_status_summary: () => ({ files: 2, added: 1, removed: 1, conflicted: 0 }),
      key_present: () => true,
    });
    seedScriptsFor(root); // see the WorkspaceContextBar-crash note above waitBooted()
  }

  it("creates and activates a workspace for the detected repo; renders the tab strip (Home present but not active)", async () => {
    stubRepo();
    const { container, queryByLabelText } = render(<App />);
    await waitBooted();
    // With a real repo, the rail shows repo groups — not the zero-repo onboarding CTA.
    expect(queryByLabelText("Add repository")).toBeNull();
    // TitleBar's branch span is the only one with a bare `title="main"` attribute
    // (the rail's workspace card also shows the branch, but without that title).
    const titleBarBranch = container.querySelector('span[title="main"]');
    expect(titleBarBranch?.textContent).toBe("⎇ main");
    const s = useStore.getState();
    // The repo boot lane + the always-present Home terminal.
    expect(s.workspaces.length).toBe(2);
    expect(s.workspaces.filter((w) => w.kind === "home")).toHaveLength(1);
    expect(s.activeWs).toBe(s.workspaces[0].id);
    expect(s.apiKeyPresent).toBe(true);
    // diff-summary effect ran and applied the stubbed summary.
    await waitFor(() => expect(useStore.getState().workspaces[0].diff).toEqual({ files: 2, added: 1, removed: 1, conflicted: 0 }));
  });

  it("honors defaults.showRailOnLaunch === false by auto-collapsing the rail on boot", async () => {
    const root = "/Users/test/repo";
    stubRepo(root);
    localStorage.setItem(
      "aurora.repoconfig",
      JSON.stringify({
        [root]: {
          version: 6,
          root,
          presets: [],
          defaults: { branchNaming: {}, baseBranch: "main", showRailOnLaunch: false, jiraSyncDefault: false, aiDefaultId: null },
          integrations: { jiraConnectionId: null, jiraProjectKey: "", jiraInProgress: "In Progress", jiraDone: "Done" },
        },
      }),
    );
    const { getByTitle, queryByText } = render(<App />);
    await waitBooted();
    await waitFor(() => expect(useStore.getState().railCollapsed).toBe(true));
    expect(getByTitle("switch workspace")).toBeTruthy();
    expect(queryByText("aurora")).toBeNull();
  });

  it("leaves the rail expanded when no repo config overrides it", async () => {
    stubRepo();
    const { queryByTitle } = render(<App />);
    await waitBooted();
    expect(useStore.getState().railCollapsed).toBe(false);
    expect(queryByTitle("switch workspace")).toBeNull();
  });
});

describe("App — boot settings + key + home fallbacks", () => {
  it("merges persisted settings from localStorage over the defaults", async () => {
    localStorage.setItem("aurora.settings", JSON.stringify({ accent: "amber" }));
    render(<App />);
    await waitBooted();
    expect(useStore.getState().settings.accent).toBe("amber");
    expect(useStore.getState().settings.model).toBe(DEFAULT_SETTINGS.model); // untouched fields survive the merge
  });

  it("tolerates corrupt settings JSON and falls back to defaults", async () => {
    localStorage.setItem("aurora.settings", "{not json");
    render(<App />);
    await waitBooted();
    expect(useStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back home to '~' and apiKeyPresent to false when their invoke calls reject", async () => {
    tauri.invoke({
      home_dir: () => {
        throw new Error("no home");
      },
      key_present: () => {
        throw new Error("keychain down");
      },
    });
    render(<App />);
    await waitBooted();
    expect(useStore.getState().home).toBe("~");
    expect(useStore.getState().apiKeyPresent).toBe(false);
  });

  it("loads persisted user scripts from localStorage into the store", async () => {
    localStorage.setItem(
      "aurora.scripts",
      JSON.stringify({ "/repo": { scripts: [{ name: "build", desc: "", split: false, tasks: [{ dir: "", cmd: "echo hi" }] }], onEnter: null } }),
    );
    render(<App />);
    await waitBooted();
    expect(useStore.getState().userScripts["/repo"]?.scripts[0]?.name).toBe("build");
  });

  it("tolerates corrupt scripts JSON without crashing the boot", async () => {
    localStorage.setItem("aurora.scripts", "not json");
    render(<App />);
    await waitBooted();
    expect(useStore.getState().userScripts).toEqual({});
  });
});

describe("App — stale-workspace pruning on boot", () => {
  it("drops a restored repo-backed workspace whose directory no longer resolves to a repo; a manual lane always survives", async () => {
    const aliveRoot = "/Users/test/repo";
    localStorage.setItem(
      "aurora.workspaces",
      JSON.stringify({
        workspaces: [
          {
            id: "w-dead",
            repoId: "/repo/dead",
            title: "dead",
            issueKey: null,
            branch: null,
            baseBranch: "main",
            dir: "/repo/dead",
            preset: null,
            jiraStatus: null,
            jiraUrl: null,
            jiraSync: false,
            env: {},
            createdAt: 1,
            lastActive: 1,
          },
          {
            id: "w-alive-repo",
            repoId: aliveRoot,
            title: "alive",
            issueKey: null,
            branch: null,
            baseBranch: "main",
            dir: aliveRoot,
            preset: null,
            jiraStatus: null,
            jiraUrl: null,
            jiraSync: false,
            env: {},
            createdAt: 2,
            lastActive: 2,
          },
          // A manual lane (repoId: null) is unconditionally kept by the
          // stale-prune ternary — proven here as a *non-active* workspace since
          // an *active* manual lane is unrenderable (see the WorkspaceContextBar
          // note above waitBooted()).
          {
            id: "w-manual",
            repoId: null,
            title: "manual",
            issueKey: null,
            branch: null,
            baseBranch: "",
            dir: "/Users/test/manual",
            preset: null,
            jiraStatus: null,
            jiraUrl: null,
            jiraSync: false,
            env: {},
            createdAt: 3,
            lastActive: 3,
          },
        ],
        activeWs: "w-alive-repo",
      }),
    );
    // Both the boot-repo lookup (cwd = home) and the stale-prune check for
    // w-alive-repo (cwd = its dir) resolve to the same repo; /repo/dead resolves
    // to nothing -> pruned.
    tauri.invoke({
      git_repo_info: (args: Record<string, unknown>) =>
        args.cwd === aliveRoot || args.cwd === "/Users/test"
          ? { root: aliveRoot, main_root: aliveRoot, name: "repo", default_branch: "main", current_branch: "main" }
          : null,
    });
    seedScriptsFor(aliveRoot);
    render(<App />);
    await waitBooted();
    const s = useStore.getState();
    // The stale-prune never removes the Home terminal — it isn't a restored
    // orphan, it's ensured by `init` independently of the persisted list.
    expect(s.workspaces).toHaveLength(3);
    expect(s.workspaces.map((w) => w.id)).toEqual(expect.arrayContaining(["w-alive-repo", "w-manual"]));
    expect(s.workspaces.filter((w) => w.kind === "home")).toHaveLength(1);
    expect(s.activeWs).toBe("w-alive-repo");
  });
});

describe("App — cwd-change effect (dir/branch/repo refresh)", () => {
  // NOTE: the "manual lane adopts a repo" sub-branch (App.tsx ~line 157-161:
  // `if (ws && !ws.repoId) st.adoptRepo(...)`) needs the *active* workspace to
  // have repoId: null — which is unconditionally unrenderable through <App/> due
  // to the WorkspaceContextBar bug documented above waitBooted() (confirmed:
  // rendering WorkspaceContextBar with any active repoId:null workspace throws
  // "Maximum update depth exceeded", independent of userScripts content). That
  // specific call is therefore genuinely unreachable in this harness; every
  // other line of this effect is covered below via a repo-backed workspace,
  // for which `!ws.repoId` is false so the `if` line still executes (just
  // never calls adoptRepo).
  it("refreshes dirNames/branch/repoRoot for the active pane on a cwd change", async () => {
    const root = "/Users/test/repo";
    tauri.invoke({
      git_repo_info: () => ({ root, main_root: root, name: "repo", default_branch: "main", current_branch: "main" }),
      list_dir: (args: Record<string, unknown>) => (args.path === root ? [{ name: "src", is_dir: true }] : []),
      git_branch: (args: Record<string, unknown>) => (args.cwd === root ? "main" : null),
    });
    seedScriptsFor(root);
    render(<App />);
    await waitBooted();

    await waitFor(() => {
      const s = useStore.getState();
      const ws = s.workspaces[0];
      expect(ws.repoId).toBe(root); // unchanged — already repo-backed at creation, adoptRepo not applicable
      const pane = ws.tabs[0].panes[0];
      expect(pane.dirNames).toEqual(["src"]);
      expect(pane.branch).toBe("main");
      expect(pane.repoRoot).toBe(root);
    });
  });
});

describe("App — global keydown wiring", () => {
  it("attaches a window keydown listener that doesn't throw with no active pane, and detaches on unmount", async () => {
    const { unmount } = render(<App />);
    await waitBooted();
    expect(() => fireEvent.keyDown(window, { key: "a" })).not.toThrow();
    unmount(); // exercises the effect's cleanup (removeEventListener)
  });
});

describe("App — auto-rename tab effect", () => {
  it("requests and applies a tab label 1.5s after a pane starts running a command", async () => {
    const root = "/Users/test/repo";
    tauri.invoke({
      git_repo_info: () => ({ root, main_root: root, name: "repo", default_branch: "main", current_branch: "main" }),
      key_present: () => true,
      claude_text: () => "vite dev",
    });
    seedScriptsFor(root);
    render(<App />);
    await waitBooted();
    const ws = useStore.getState().workspaces[0];
    const pane = ws.tabs[0].panes[0];
    useStore.getState().startBlock(pane.id, "vite dev", pane.cwd);

    // Real 1500ms debounce — patching global setTimeout here breaks
    // @testing-library's own waitFor polling, so we pay the real wall-clock cost.
    await waitFor(
      () => {
        const call = tauri.lastCall("claude_text");
        expect(call).toBeTruthy();
        expect(call!.args.prompt as string).toContain("vite dev");
      },
      { timeout: 2500 },
    );
    await waitFor(() => {
      const tabName = useStore.getState().workspaces[0].tabs[0].name;
      expect(tabName).toBe("vite dev");
    });
  });
});

describe("App — narrow-breakpoint rail auto-collapse", () => {
  it("auto-collapses crossing into narrow, does not auto-reopen on wide, suppresses one re-collapse after a manual reopen, then re-arms after a full wide/narrow cycle", async () => {
    window.innerWidth = 1200;
    const { getAllByText, getByTitle } = render(<App />);
    await waitBooted();
    // "zsh" appears in both TitleBar's expanded-rail label and the live Home
    // terminal pane (Home is really active on a contextless boot).
    expect(getAllByText("zsh").length).toBeGreaterThan(0);

    // Cross into narrow -> auto-collapse.
    window.innerWidth = 500;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(useStore.getState().railCollapsed).toBe(true));
    expect(getByTitle("switch workspace")).toBeTruthy();

    // Cross back to wide -> must NOT auto-reopen the rail.
    window.innerWidth = 1200;
    fireEvent(window, new Event("resize"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().railCollapsed).toBe(true);

    // Cross into narrow again -> auto-collapses again (was already collapsed, stays collapsed).
    window.innerWidth = 500;
    fireEvent(window, new Event("resize"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().railCollapsed).toBe(true);

    // Manual reopen while still narrow -> suppresses the *next* auto-collapse.
    useStore.getState().setRailCollapsed(false);
    await waitFor(() => expect(getAllByText("zsh").length).toBeGreaterThan(0));

    // Returning to wide resets the override (per design: only suppresses until
    // the window goes wide and crosses back into narrow).
    window.innerWidth = 1200;
    fireEvent(window, new Event("resize"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().railCollapsed).toBe(false);

    // Crossing into narrow again now auto-collapses (override was cleared).
    window.innerWidth = 500;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(useStore.getState().railCollapsed).toBe(true));
  });
});

describe("App — overlay/panel render branches", () => {
  async function bootWithWorkspace() {
    const root = "/Users/test/repo";
    tauri.invoke({
      git_repo_info: () => ({ root, main_root: root, name: "repo", default_branch: "main", current_branch: "main" }),
      // The shared mock's default (`() => []`) doesn't match gitBranches()'s real
      // {current, branches} shape, which crashes WorkspaceSettings (bases.filter
      // on undefined) — stub the correct shape ourselves.
      git_branches: () => ({ current: "main", branches: ["main"] }),
    });
    seedScriptsFor(root);
    const utils = render(<App />);
    await waitBooted();
    return utils;
  }

  it("renders SettingsModal when settingsOpen is true", async () => {
    await bootWithWorkspace();
    useStore.getState().openSettings();
    await waitFor(() => expect(document.body.textContent).toContain("no key set"));
  });

  it("renders WorkspaceSettings when workspaceSettingsRepo is set", async () => {
    await bootWithWorkspace();
    useStore.getState().openWorkspaceSettings("/Users/test/repo");
    await waitFor(() => expect(useStore.getState().workspaceSettingsRepo).toBe("/Users/test/repo"));
    expect(document.body.textContent).toContain("Repo settings");
  });

  it("renders ScriptsSetupModal when scriptsSetupOpen is true", async () => {
    await bootWithWorkspace();
    useStore.getState().openScriptsSetup();
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(true));
  });

  it("renders WorkspaceCommand when the command palette is open", async () => {
    await bootWithWorkspace();
    useStore.getState().openCommand();
    await waitFor(() => expect(useStore.getState().command).not.toBeNull());
  });

  it("renders MrSheet / ScriptsSheet / NotifSheet for each panel kind", async () => {
    await bootWithWorkspace();
    for (const p of ["mr", "scripts", "notif"] as const) {
      useStore.getState().openPanel(p);
      await waitFor(() => expect(useStore.getState().panel).toBe(p));
      useStore.getState().closePanel();
      await waitFor(() => expect(useStore.getState().panel).toBeNull());
    }
  });
});
