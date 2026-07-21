// Coverage suite for src/components/WorkspaceRail.tsx.
//
// Three of WorkspaceRail's collaborators are mocked at the module level (like
// teardown.test.ts does for lib/worktree) rather than driven purely through
// tauri.invoke():
//   - lib/repo    (addRepoFromFolder) wraps @tauri-apps/plugin-dialog's `open`,
//     which the shared mock hardcodes to resolve `null` — there is no way to
//     reach the ok:true/ok:false branches through the real dialog, so we
//     control addRepoFromFolder's return value directly.
//   - lib/teardown (deleteWorkspace) has its own guard/removability logic
//     that's already covered by teardown.test.ts; here we only need to
//     control its ok/error result to exercise WorkspaceRail's own
//     notify-on-failure branch.
//   - lib/servers (serversUp/runServers/stopServers) is a whole orchestrator
//     (pane creation, script launch, liveness poll) that's out of scope for
//     this file; we only need serversUp()'s boolean and to observe
//     runServers/stopServers being invoked (and simulate rejection) from the
//     Run/Stop button handler in WorkspaceContextBar.
//
// Everything else (worktreeSafety, worktreeList, pathResolve — all backed by
// a single invoke() call) is driven for real through the shared tauri mock.
import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";

// ---- Controllable mocks (must precede the dynamic import below) -----------

let addRepoCalls = 0;
let addRepoImpl: () => Promise<unknown> = () => Promise.resolve({ cancelled: true });
mock.module("../src/lib/repo", () => ({
  addRepoFromFolder: () => {
    addRepoCalls++;
    return addRepoImpl();
  },
}));

let deleteWorkspaceCalls: string[] = [];
let deleteWorkspaceResult: { ok: true } | { ok: false; error: string } = { ok: true };
mock.module("../src/lib/teardown", () => ({
  deleteWorkspace: (id: string) => {
    deleteWorkspaceCalls.push(id);
    return Promise.resolve(deleteWorkspaceResult);
  },
}));

let serversUpValue = false;
const serversCalls: Array<{ fn: "run" | "stop"; wsId: string; scriptId?: string }> = [];
let runServersImpl: (id: string) => Promise<void> = () => Promise.resolve();
let stopServersImpl: (id: string) => Promise<void> = () => Promise.resolve();
let runCustomImpl: (id: string) => Promise<void> = () => Promise.resolve();
let runningScriptIdsValue: string[] = [];
mock.module("../src/lib/servers", () => ({
  serversUp: () => serversUpValue,
  runningScriptIds: () => runningScriptIdsValue,
  runCommandId: (i: number) => `run:${i}`,
  runCommandLabel: (rc: { command: string; name?: string }, i: number) => rc.name ?? rc.command ?? `cmd-${i + 1}`,
  runServers: (id: string) => {
    serversCalls.push({ fn: "run", wsId: id });
    return runServersImpl(id);
  },
  stopServers: (id: string) => {
    serversCalls.push({ fn: "stop", wsId: id });
    return stopServersImpl(id);
  },
  runOneRunCommand: (wsId: string, index: number) => {
    serversCalls.push({ fn: "run", wsId, scriptId: `run:${index}` });
    return runServersImpl(wsId);
  },
  runCustom: (wsId: string, scriptId: string) => {
    serversCalls.push({ fn: "run", wsId, scriptId });
    return runCustomImpl(wsId);
  },
  stopServer: (wsId: string, scriptId: string) => {
    serversCalls.push({ fn: "stop", wsId, scriptId });
    return stopServersImpl(wsId);
  },
  repoLabel: (repoId: string | null) => repoId?.split("/").filter(Boolean).pop() ?? "",
}));

const { useStore } = await import("../src/state/store");
const { WorkspaceRail, WorkspaceContextBar, StatusDot } = await import(
  "../src/components/WorkspaceRail"
);
type Workspace = InstanceType<typeof Object> & Record<string, unknown>;

// ---- Fixture builders -------------------------------------------------------

let paneSeq = 1;
let groupSeq = 1;
let wsIdx = 0;

function makePane(overrides: Record<string, unknown> = {}) {
  return {
    id: paneSeq++,
    ptyId: null,
    ptyEpoch: 0,
    isZsh: false,
    cwd: "/repo",
    branch: null,
    input: "",
    ghost: "",
    history: [],
    hIndex: -1,
    suggestion: null,
    suggestionLoading: false,
    pendingFix: null,
    completion: null,
    inputSelected: false,
    rawMode: false,
    exited: false,
    ready: false,
    dirNames: [],
    blocks: [],
    repoRoot: null,
    firedHooks: [],
    hook: null,
    ...overrides,
  };
}

function makeGroup(overrides: Record<string, unknown> = {}) {
  const panes = (overrides.panes as unknown[]) ?? [makePane()];
  return { id: groupSeq++, active: 0, split: "h", ...overrides, panes };
}

function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  const id = (overrides.id as string) ?? `w${++wsIdx}`;
  const dir = (overrides.dir as string) ?? "/repo";
  const pane = makePane({ cwd: dir });
  const group = makeGroup({ panes: [pane] });
  return {
    id,
    kind: "workspace",
    repoId: null,
    title: "Workspace",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir,
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [group],
    active: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
    ...overrides,
  } as Workspace;
}

function seed(overrides: Record<string, unknown> = {}) {
  useStore.setState(
    {
      repos: [],
      workspaces: [],
      activeWs: null,
      initialized: true,
      wsFilter: "",
      command: null,
      userScripts: {},
      serverStatus: {},
      managedServers: {},
      auroraConfigs: {},
      portCollisions: [],
      runMenuWsId: null,
      workspaceSettingsRepo: null,
      settingsOpen: false,
      notifs: [],
      notifLog: [],
      unseen: 0,
      muted: false,
      railCollapsed: false,
      ...overrides,
    },
    false,
  );
}

/** A registered repo — WorkspaceRail only renders repoId-linked workspaces that
 *  appear in the `repos` list (repos not yet in that list are silently dropped
 *  from the rail, even though the workspace count badge still counts them). */
const REPO = { id: "/repo", root: "/repo", name: "repo", defaultBranch: "main" };

/** A minimal `auroraConfigs` entry — Run/Stop visibility now comes from
 *  aurora.json's `scripts.run` (an ORDERED ARRAY), not the legacy
 *  port-scripts regex. Pass `custom` too to exercise the ▾ run menu's Custom
 *  Scripts group. `run` here is keyed by a label purely for test readability
 *  — it becomes each RunCommand's `name` so assertions can find rows by text;
 *  the real store keys entries by index (`run:<i>`), not by this label. */
function auroraRunConfig(
  run: Record<string, { command?: string; cwd?: string }>,
  custom: Record<string, { command?: string; cwd?: string }> = {},
) {
  const runList = Object.entries(run).map(([name, s]) => ({ command: s.command ?? "cmd", cwd: s.cwd, name }));
  const customMap: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(custom)) customMap[id] = { command: s.command ?? "cmd", cwd: s.cwd };
  return { version: 1, scripts: { setup: null, run: runList, custom: customMap, archive: null } };
}

// A microtask + macrotask flush for the async worktreeBacked effect.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

let confirmMock: ReturnType<typeof mock>;

beforeEach(() => {
  tauri.reset();
  addRepoCalls = 0;
  addRepoImpl = () => Promise.resolve({ cancelled: true });
  deleteWorkspaceCalls = [];
  deleteWorkspaceResult = { ok: true };
  serversUpValue = false;
  serversCalls.length = 0;
  runServersImpl = () => Promise.resolve();
  stopServersImpl = () => Promise.resolve();
  runCustomImpl = () => Promise.resolve();
  confirmMock = mock(() => true);
  (globalThis as unknown as { confirm: unknown }).confirm = confirmMock;
  seed();
});

afterEach(() => {
  cleanup();
});

// ── StatusDot ────────────────────────────────────────────────────────────────

describe("StatusDot", () => {
  it("renders idle (no glow, no animation)", () => {
    const ws = makeWorkspace({ pipeline: null, diff: null });
    const { container } = render(<StatusDot ws={ws as never} />);
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.boxShadow).toBe("none");
  });

  it("renders attention on a failed pipeline", () => {
    const ws = makeWorkspace({ pipeline: "failed" });
    const { container } = render(<StatusDot ws={ws as never} />);
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.boxShadow).not.toBe("none");
  });

  it("renders attention on a conflicted diff", () => {
    const ws = makeWorkspace({ diff: { files: 1, added: 0, removed: 0, conflicted: 2 } });
    const { container } = render(<StatusDot ws={ws as never} size={12} />);
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.width).toBe("12px");
    expect(dot.style.boxShadow).not.toBe("none");
  });
});

// ── WorkspaceRail: empty states + repo groups ──────────────────────────────

describe("WorkspaceRail — empty & repo groups", () => {
  it("shows the add-repository onboarding as a primary CTA with zero repos/workspaces and no filter", () => {
    seed();
    const { container, getByLabelText } = render(<WorkspaceRail />);
    // The onboarding *is* the primary CTA now (accent .aurora-empty-primary),
    // anchored on a stable aria-label rather than prose. A short title sits above
    // it and a faint shell-voiced reassurance line sits below.
    const cta = getByLabelText("Add repository");
    expect(cta.className).toContain("aurora-empty-primary");
    expect(cta.className).toContain("aurora-rail-empty-cta");
    expect(container.querySelector(".aurora-rail-empty-title")?.textContent).toBe("Start with a repository");
    expect(container.textContent).toContain("the ~ shell is always one click away");
    // The prose the user disliked is gone.
    expect(container.textContent).not.toContain("no repositories yet");
    expect(container.textContent).not.toContain("below to begin");
  });

  it("in the zero-repo onboarding, the footer's duplicate 'Add repository' control is hidden (single CTA)", () => {
    seed();
    const { container, getAllByLabelText } = render(<WorkspaceRail />);
    // Exactly one Add-repository control while empty: the primary CTA. The footer
    // control (distinct title="add another repository folder (⌘O)") is not rendered.
    expect(container.querySelector('[title="add another repository folder (⌘O)"]')).toBeNull();
    expect(getAllByLabelText("Add repository")).toHaveLength(1);
  });

  it("clicking the onboarding CTA calls addRepoFromFolder and shows 'Opening…' while busy", async () => {
    let resolveAdd!: (v: unknown) => void;
    addRepoImpl = () => new Promise((res) => (resolveAdd = res));
    seed();
    const { getByLabelText } = render(<WorkspaceRail />);
    const cta = getByLabelText("Add repository") as HTMLButtonElement;
    fireEvent.click(cta);
    await flush();
    expect(addRepoCalls).toBe(1);
    expect(cta.textContent).toContain("Opening…");
    expect(cta.disabled).toBe(true);
    resolveAdd({ cancelled: true });
    await flush();
    expect(cta.textContent).toContain("Add repository");
  });

  it("shows the add-repo error in the onboarding CTA slot (replacing the shell hint) on ok:false", async () => {
    addRepoImpl = () => Promise.resolve({ ok: false, error: "That folder isn't inside a git repository." });
    seed();
    const { container, getByLabelText } = render(<WorkspaceRail />);
    fireEvent.click(getByLabelText("Add repository"));
    await flush();
    const err = container.querySelector(".aurora-rail-empty-error");
    expect(err?.textContent).toContain("That folder isn't inside a git repository.");
    // The reassurance hint yields its slot to the error.
    expect(container.querySelector(".aurora-rail-empty-hint")).toBeNull();
  });

  it("does not offer 'Create a workspace' in onboarding when no repos are known", () => {
    seed();
    const { queryByText } = render(<WorkspaceRail />);
    expect(queryByText("Create a workspace")).toBeNull();
  });

  it("a registered repo with zero workspaces renders its own empty-group row instead of onboarding (groups.length > 0)", () => {
    // NOTE: every known repo always gets its own group entry (the "every known
    // repo in order" loop pushes unconditionally when there's no active filter),
    // so `groups.length` is never 0 while `repos.length > 0` outside a filter —
    // the onboarding's "Create a workspace" branch is reachable only in the
    // filtered-to-nothing case, which task 4.5 explicitly keeps on the
    // "no workspace matches" message instead. This test documents the actual,
    // reachable behavior rather than asserting the unreachable branch.
    const repo = { id: "/r1", root: "/r1", name: "repo-one", defaultBranch: "main" };
    seed({ repos: [repo] });
    const { container, getByText } = render(<WorkspaceRail />);
    // No zero-repo onboarding CTA when a repo group exists.
    expect(container.querySelector(".aurora-rail-empty")).toBeNull();
    expect(getByText("+ New workspace in repo-one")).toBeTruthy();
  });

  it("shows 'no workspace matches' when filtered to nothing", () => {
    seed({ wsFilter: "zzz" });
    const { container } = render(<WorkspaceRail />);
    expect(container.textContent).toContain('no workspace matches "zzz"');
  });

  it("shows an empty repo group with a '+ New workspace' row, and clicking it opens the command palette pinned to that repo", () => {
    const repo = { id: "/r1", root: "/r1", name: "repo-one", defaultBranch: "main" };
    seed({ repos: [repo] });
    const { container } = render(<WorkspaceRail />);
    expect(container.textContent).toContain("repo-one");
    const row = within(container).getByText("+ New workspace in repo-one");
    fireEvent.click(row);
    expect(useStore.getState().command).toEqual({ query: "", sel: 0, repoId: "/r1" });
  });

  it("repo header gear opens workspace settings for that repo; plus opens the command palette", () => {
    const repo = { id: "/r1", root: "/r1", name: "repo-one", defaultBranch: "main" };
    seed({ repos: [repo] });
    const { container } = render(<WorkspaceRail />);
    const gear = container.querySelector('[title="repo settings"]') as HTMLElement;
    expect(gear).toBeTruthy();
    fireEvent.click(gear);
    expect(useStore.getState().workspaceSettingsRepo).toBe("/r1");

    const plus = container.querySelector('[title="new workspace in this repo"]') as HTMLElement;
    fireEvent.click(plus);
    expect(useStore.getState().command).toEqual({ query: "", sel: 0, repoId: "/r1" });
  });

  it("a manual-lane (local) workspace group has no repo-settings gear", () => {
    const w = makeWorkspace({ id: "wlocal", repoId: null, title: "manual lane" });
    seed({ workspaces: [w], activeWs: w.id });
    const { container } = render(<WorkspaceRail />);
    expect(container.textContent).toContain("local");
    expect(container.querySelector('[title="repo settings"]')).toBeNull();
  });

  it("the Home terminal is excluded from every repo group and from the local bucket, and never renders in the rail", () => {
    const repo = { id: "/r1", root: "/r1", name: "repo-one", defaultBranch: "main" };
    const home = makeWorkspace({ id: "home", kind: "home", repoId: null, title: "Home", dir: "/Users/tester" });
    const repoWs = makeWorkspace({ id: "wrepo", repoId: "/r1", title: "repo workspace" });
    const manual = makeWorkspace({ id: "wlocal", repoId: null, title: "manual lane" });
    seed({ repos: [repo], workspaces: [home, repoWs, manual], activeWs: "wrepo" });
    const { container, getByText, queryByLabelText } = render(<WorkspaceRail />);
    // The Home terminal now lives in the TitleBar, not the rail — it must not
    // appear here at all (no entry, and not doubled into "repo-one" or "local").
    expect(queryByLabelText("Home terminal (~)")).toBeNull();
    // Home has no workspace card either — only the two real lanes render cards.
    expect(container.querySelectorAll(".aurora-ws-card")).toHaveLength(2);
    expect(getByText("repo workspace")).toBeTruthy();
    expect(getByText("manual lane")).toBeTruthy();
    expect(getByText("local")).toBeTruthy();
  });

  it("with only Home present, groups.length === 0 and the rail shows onboarding, not a repo group", () => {
    const home = makeWorkspace({ id: "home", kind: "home", repoId: null, title: "Home", dir: "/Users/tester" });
    seed({ workspaces: [home], activeWs: "home" });
    const { getByLabelText, queryByLabelText, queryByText } = render(<WorkspaceRail />);
    // Home isn't in the rail (it's in the TitleBar); the rail is truly empty and
    // shows the onboarding CTA.
    expect(queryByLabelText("Home terminal (~)")).toBeNull();
    expect(getByLabelText("Add repository").className).toContain("aurora-empty-primary");
    expect(queryByText("local")).toBeNull();
  });

  it("the rail renders no trash affordance for a Home-only state", () => {
    const home = makeWorkspace({ id: "home", kind: "home", repoId: null, title: "Home", dir: "/Users/tester" });
    seed({ workspaces: [home], activeWs: "home" });
    const { container } = render(<WorkspaceRail />);
    // Home never renders a WorkspaceCard (it's not in the rail at all), so no
    // trash icon exists anywhere in the rail.
    expect(container.querySelector(".aurora-ws-trash")).toBeNull();
  });

  it("typing in the filter box updates wsFilter, and the collapse button collapses the rail", () => {
    const { container } = render(<WorkspaceRail />);
    const input = container.querySelector('input[placeholder="Filter…"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(useStore.getState().wsFilter).toBe("abc");

    const collapse = container.querySelector('[title="collapse rail (⌘B)"]') as HTMLElement;
    expect(useStore.getState().railCollapsed).toBe(false);
    fireEvent.click(collapse);
    expect(useStore.getState().railCollapsed).toBe(true);
  });

  it("renders one card per workspace inside a populated repo group", () => {
    const repo = { id: "/r1", root: "/r1", name: "repo-one", defaultBranch: "main" };
    const w1 = makeWorkspace({ id: "w1", repoId: "/r1", title: "Alpha" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/r1", title: "Beta" });
    seed({ repos: [repo], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    expect(container.querySelectorAll(".aurora-ws-card").length).toBe(2);
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
  });
});

// ── WorkspaceRail: filtering ────────────────────────────────────────────────

describe("WorkspaceRail — filtering", () => {
  it("matches on issueKey, title, or branch independently, and hides repos with zero matches while filtered", () => {
    const repoA = { id: "/a", root: "/a", name: "repoA", defaultBranch: "main" };
    const repoB = { id: "/b", root: "/b", name: "repoB", defaultBranch: "main" };
    const byIssue = makeWorkspace({ id: "w1", repoId: "/a", title: "nomatch", issueKey: "ABC-1", branch: null });
    const byTitle = makeWorkspace({ id: "w2", repoId: "/a", title: "findme-title", issueKey: null, branch: null });
    const byBranch = makeWorkspace({ id: "w3", repoId: "/a", title: "nomatch2", issueKey: null, branch: "findme-branch" });
    const noMatchB = makeWorkspace({ id: "w4", repoId: "/b", title: "other", issueKey: null, branch: null });
    seed({ repos: [repoA, repoB], workspaces: [byIssue, byTitle, byBranch, noMatchB], activeWs: "w1", wsFilter: "findme" });
    const { container } = render(<WorkspaceRail />);
    expect(container.textContent).toContain("findme-title");
    expect(container.textContent).toContain("findme-branch");
    // repoB has no matches and the filter is active -> its group is dropped entirely.
    expect(container.textContent).not.toContain("repoB");
  });

  it("matching on issueKey works even when title/branch are null", () => {
    const repoA = { id: "/a", root: "/a", name: "repoA", defaultBranch: "main" };
    const w = makeWorkspace({ id: "w1", repoId: "/a", title: "plain", issueKey: "XYZ-9", branch: null });
    seed({ repos: [repoA], workspaces: [w], activeWs: "w1", wsFilter: "xyz-9" });
    const { container } = render(<WorkspaceRail />);
    expect(container.textContent).toContain("XYZ-9");
  });
});

// ── WorkspaceCard: content variety (rendered through WorkspaceRail) ────────

describe("WorkspaceCard — content branches", () => {
  it("shows issueKey, branch, jira chip and port chip when present; omits them when absent", () => {
    const withMeta = makeWorkspace({
      id: "w1",
      title: "With meta",
      issueKey: "PROJ-42",
      branch: "feat/x",
      jiraStatus: "In Progress",
      env: { AURORA_PORT_OFFSET: "7" },
    });
    const bare = makeWorkspace({ id: "w2", title: "Bare", issueKey: null, branch: null, jiraStatus: null, env: {} });
    seed({ workspaces: [withMeta, bare], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    expect(container.textContent).toContain("PROJ-42");
    expect(container.textContent).toContain("feat/x");
    expect(container.textContent).toContain("In Progress");
    expect(container.querySelector(".aurora-ws-port-chip")).toBeTruthy();

    const cards = container.querySelectorAll(".aurora-ws-card");
    const bareCard = cards[1] as HTMLElement;
    expect(bareCard.textContent).not.toContain("undefined");
    expect(bareCard.querySelector(".aurora-ws-port-chip")).toBeNull();
  });

  it("hides the diff chip when both added and removed are zero, and when diff is null", () => {
    const zeroDiff = makeWorkspace({ id: "w1", diff: { files: 0, added: 0, removed: 0, conflicted: 0 } });
    const nullDiff = makeWorkspace({ id: "w2", diff: null });
    seed({ workspaces: [zeroDiff, nullDiff], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    expect(container.querySelector('[title="review changes"]')).toBeNull();
  });

  it("clicking the diff chip switches workspace and opens the Changes overlay exactly once (stopPropagation works)", () => {
    const w = makeWorkspace({
      id: "w1",
      title: "Has diff",
      diff: { files: 3, added: 5, removed: 2, conflicted: 0 },
    });
    const other = makeWorkspace({ id: "w2", title: "Other" });
    seed({ workspaces: [w, other], activeWs: "w2" });

    const switchSpy = mock((id: string) => realSwitch(id));
    const realSwitch = useStore.getState().switchWorkspace;
    useStore.setState({ switchWorkspace: switchSpy as never }, false);

    const { container } = render(<WorkspaceRail />);
    const chip = container.querySelector('[title="review changes"]') as HTMLElement;
    expect(chip.textContent).toContain("+5");
    expect(chip.textContent).toContain("−2");
    fireEvent.click(chip);

    // stopPropagation means the outer card's onClick(switchWorkspace) must NOT
    // also fire — only the one call made by openChanges itself.
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(useStore.getState().activeWs).toBe("w1");
    // The overlay opens for the workspace we switched to — no pane is touched.
    expect(useStore.getState().changesWsId).toBe("w1");
  });

  it("clicking an inactive card switches the active workspace", () => {
    const w1 = makeWorkspace({ id: "w1", title: "One" });
    const w2 = makeWorkspace({ id: "w2", title: "Two" });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    const cards = container.querySelectorAll(".aurora-ws-card");
    expect((cards[0] as HTMLElement).style.cursor).toBe("default");
    expect((cards[1] as HTMLElement).style.cursor).toBe("pointer");
    fireEvent.click(cards[1]);
    expect(useStore.getState().activeWs).toBe("w2");
  });
});

// ── WorkspaceCard: worktreeBacked / trash / handleDelete ───────────────────

describe("WorkspaceCard — trash visibility (worktreeBacked)", () => {
  it("never shows trash for the main checkout (dir === repoId)", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo/.worktrees/w2" });
    tauri.invoke({
      worktree_list: () => [{ path: "/repo", branch: "main", head: null }, { path: "/repo/.worktrees/w2", branch: "b", head: null }],
      path_resolve: (a: Record<string, unknown>) => a.path,
    });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    await flush();
    const cards = container.querySelectorAll(".aurora-ws-card");
    expect((cards[0] as HTMLElement).querySelector(".aurora-ws-trash")).toBeNull();
  });

  it("never shows trash for a manual lane (repoId null)", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: null, dir: "/manual", title: "Manual lane" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo/.worktrees/w2", title: "Repo card" });
    tauri.invoke({ worktree_list: () => [{ path: "/repo" }, { path: "/repo/.worktrees/w2" }], path_resolve: (a: Record<string, unknown>) => a.path });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    await flush();
    const cards = Array.from(container.querySelectorAll(".aurora-ws-card")) as HTMLElement[];
    const manualCard = cards.find((c) => c.textContent?.includes("Manual lane"))!;
    expect(manualCard).toBeTruthy();
    expect(manualCard.querySelector(".aurora-ws-trash")).toBeNull();
  });

  it("hides trash on the last remaining workspace even if worktree-backed", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo/.worktrees/w1" });
    tauri.invoke({ worktree_list: () => [{ path: "/repo" }, { path: "/repo/.worktrees/w1" }], path_resolve: (a: Record<string, unknown>) => a.path });
    seed({ workspaces: [w1], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    await flush();
    expect(container.querySelector(".aurora-ws-trash")).toBeNull();
  });

  it("shows trash once the async worktree-registry check confirms a secondary worktree", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo/.worktrees/w1" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo" });
    tauri.invoke({ worktree_list: () => [{ path: "/repo" }, { path: "/repo/.worktrees/w1" }], path_resolve: (a: Record<string, unknown>) => a.path });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => {
      expect(container.querySelector(".aurora-ws-trash")).toBeTruthy();
    });
  });

  it("flips the sync guess off when the registry check says the dir isn't a registered secondary worktree", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo/.worktrees/gone" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo" });
    // list does NOT contain "/repo/.worktrees/gone" among the secondaries.
    tauri.invoke({ worktree_list: () => [{ path: "/repo" }, { path: "/repo/.worktrees/other" }], path_resolve: (a: Record<string, unknown>) => a.path });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".aurora-ws-card");
      expect((cards[0] as HTMLElement).querySelector(".aurora-ws-trash")).toBeNull();
    });
  });

  it("swallows malformed worktree_list entries via the effect's catch (no crash)", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo/.worktrees/w1" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo" });
    // A null entry among the secondaries makes `wt.path` throw inside .some(),
    // which is caught by the effect's outer .catch (keeps the sync guess).
    tauri.invoke({ worktree_list: () => [{ path: "/repo" }, null], path_resolve: (a: Record<string, unknown>) => a.path });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    expect(() => render(<WorkspaceRail />)).not.toThrow();
    await flush();
  });

  it("does not crash or update state after unmounting before the worktree check resolves (cancelled cleanup)", async () => {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo/.worktrees/w1" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo" });
    let resolveList!: (v: unknown) => void;
    tauri.invoke({
      worktree_list: () => new Promise((res) => (resolveList = res)),
      path_resolve: (a: Record<string, unknown>) => a.path,
    });
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { unmount } = render(<WorkspaceRail />);
    unmount();
    resolveList([{ path: "/repo" }, { path: "/repo/.worktrees/w1" }]);
    await flush();
    // No assertion beyond "didn't throw" — React would warn/throw on a
    // post-unmount state update if the `cancelled` guard were missing.
  });
});

describe("WorkspaceCard — handleDelete", () => {
  function backedPair() {
    const w1 = makeWorkspace({ id: "w1", repoId: "/repo", dir: "/repo/.worktrees/w1", title: "Doomed", branch: "feat/doomed" });
    const w2 = makeWorkspace({ id: "w2", repoId: "/repo", dir: "/repo" });
    tauri.invoke({
      worktree_list: () => [{ path: "/repo" }, { path: "/repo/.worktrees/w1" }],
      path_resolve: (a: Record<string, unknown>) => a.path,
    });
    return [w1, w2];
  }

  it("does not call deleteWorkspace when the confirm dialog is dismissed", async () => {
    confirmMock.mockImplementation(() => false);
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    tauri.invoke({ git_worktree_safety: () => ({ dirty: false, ahead: 0, has_upstream: true }) });
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    expect(deleteWorkspaceCalls.length).toBe(0);
  });

  it("clicking trash does not also switch the active workspace (stopPropagation)", async () => {
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w2" });
    tauri.invoke({ git_worktree_safety: () => ({ dirty: false, ahead: 0, has_upstream: true }) });
    confirmMock.mockImplementation(() => false);
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    expect(useStore.getState().activeWs).toBe("w2");
  });

  it("builds the confirm message with plural dirty+ahead wording and calls deleteWorkspace; success path does not notify", async () => {
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    tauri.invoke({ git_worktree_safety: () => ({ dirty: true, ahead: 3, has_upstream: true }) });
    deleteWorkspaceResult = { ok: true };
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const msg = confirmMock.mock.calls[0]![0] as string;
    expect(msg).toContain('Delete workspace "Doomed" (feat/doomed)?');
    expect(msg).toContain("Uncommitted changes in the worktree will be lost");
    expect(msg).toContain("3 commits on this branch aren't pushed yet");
    expect(msg).toContain('they stay only on this machine');
    expect(deleteWorkspaceCalls).toEqual(["w1"]);
    expect(useStore.getState().notifLog.length).toBe(0);
  });

  it("uses singular wording for exactly one unpushed commit", async () => {
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    tauri.invoke({ git_worktree_safety: () => ({ dirty: false, ahead: 1, has_upstream: true }) });
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    const msg = confirmMock.mock.calls[0]![0] as string;
    expect(msg).toContain("1 commit on this branch isn't pushed yet");
    expect(msg).toContain("it stays only on this machine");
    expect(msg).not.toContain("Uncommitted changes");
  });

  it("swallows a worktreeSafety failure and still proceeds to confirm with the base message", async () => {
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    tauri.invoke({
      git_worktree_safety: () => {
        throw new Error("safety check exploded");
      },
    });
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const msg = confirmMock.mock.calls[0]![0] as string;
    expect(msg).toContain('Delete workspace "Doomed"');
    expect(msg).not.toContain("Uncommitted changes");
    expect(deleteWorkspaceCalls).toEqual(["w1"]);
  });

  it("notifies 'Delete failed' with the error and repo id when deleteWorkspace fails", async () => {
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    tauri.invoke({ git_worktree_safety: () => ({ dirty: false, ahead: 0, has_upstream: true }) });
    deleteWorkspaceResult = { ok: false, error: "worktree removal failed: boom" };
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif.headline).toBe("Couldn't delete Doomed");
    expect(notif.sub).toBe("worktree removal failed: boom");
    expect(notif.repo).toBe("repo");
  });

  it("also shows no 'ahead' line when ahead is zero", async () => {
    const [w1, w2] = backedPair();
    seed({ repos: [REPO], workspaces: [w1, w2], activeWs: "w1" });
    tauri.invoke({ git_worktree_safety: () => ({ dirty: false, ahead: 0, has_upstream: true }) });
    const { container } = render(<WorkspaceRail />);
    await waitFor(() => expect(container.querySelector(".aurora-ws-trash")).toBeTruthy());
    fireEvent.click(container.querySelector(".aurora-ws-trash")!);
    await flush();
    const msg = confirmMock.mock.calls[0]![0] as string;
    expect(msg).not.toContain("pushed yet");
  });
});

// ── WorkspaceRail: add repository ──────────────────────────────────────────

describe("WorkspaceRail — add repository (footer)", () => {
  // The footer "Add repository" control only renders once at least one repo
  // exists (hasRepos); in the zero-repo state the onboarding CTA owns the action
  // instead (covered in the "empty & repo groups" suite). So each test here
  // seeds a repo, then targets the footer by its stable `title`.
  const footerAddRepo = (container: HTMLElement) =>
    container.querySelector('[title="add another repository folder (⌘O)"]') as HTMLElement;
  const seedWithRepo = () => seed({ repos: [REPO] });

  it("renders the footer control once a repo exists (and not in the zero-repo state)", () => {
    seed();
    const { container: empty } = render(<WorkspaceRail />);
    expect(footerAddRepo(empty)).toBeNull();
    cleanup();
    seedWithRepo();
    const { container: withRepo } = render(<WorkspaceRail />);
    expect(footerAddRepo(withRepo)).toBeTruthy();
  });

  it("shows 'Opening…' while busy and ignores a second click until it settles", async () => {
    let resolveAdd!: (v: unknown) => void;
    addRepoImpl = () => new Promise((res) => (resolveAdd = res));
    seedWithRepo();
    const { container } = render(<WorkspaceRail />);
    fireEvent.click(footerAddRepo(container));
    await flush();
    expect(footerAddRepo(container).textContent).toContain("Opening…");
    fireEvent.click(footerAddRepo(container));
    await flush();
    expect(addRepoCalls).toBe(1);
    resolveAdd({ cancelled: true });
    await flush();
    expect(footerAddRepo(container).textContent).toContain("Add repository");
  });

  it("shows no error text when the folder pick is cancelled", async () => {
    addRepoImpl = () => Promise.resolve({ cancelled: true });
    seedWithRepo();
    const { container } = render(<WorkspaceRail />);
    fireEvent.click(footerAddRepo(container));
    await flush();
    expect(container.textContent).not.toContain("isn't inside a git repository");
  });

  it("shows the error message when addRepoFromFolder resolves ok:false", async () => {
    addRepoImpl = () => Promise.resolve({ ok: false, error: "That folder isn't inside a git repository." });
    seedWithRepo();
    const { container } = render(<WorkspaceRail />);
    fireEvent.click(footerAddRepo(container));
    await flush();
    expect(container.textContent).toContain("That folder isn't inside a git repository.");
  });

  it("shows no error message on success", async () => {
    addRepoImpl = () => Promise.resolve({ ok: true, root: "/new", name: "new-repo" });
    seedWithRepo();
    const { container } = render(<WorkspaceRail />);
    fireEvent.click(footerAddRepo(container));
    await flush();
    expect(container.textContent).not.toContain("isn't inside a git repository");
  });
});

// ── WorkspaceContextBar ─────────────────────────────────────────────────────

describe("WorkspaceContextBar", () => {
  // Regression: WorkspaceContextBar's `scripts` selector used to allocate a fresh
  // `[]` on every invocation (the repoId-falsy branch and the `?? []` fallback).
  // Zustand v5's plain useStore doesn't memoize selector output, so React's
  // external-store snapshot saw a "new" value every render → infinite loop →
  // "Maximum update depth exceeded" (black-screen crash) whenever there was no
  // active workspace, or a manual lane (repoId null) — the hooks run before the
  // `if (!ws) return null` early return. Fixed with a stable EMPTY_SCRIPTS
  // constant so the selector returns a referentially-stable value.
  it("renders nothing (no crash / no infinite loop) when there is no active workspace", () => {
    seed({ activeWs: null });
    expect(() => render(<WorkspaceContextBar />)).not.toThrow();
  });

  it("renders a manual-lane active workspace (repoId null) without an infinite loop", () => {
    const w = makeWorkspace({ id: "w1", repoId: null, issueKey: "X-1" });
    seed({ workspaces: [w], activeWs: "w1" });
    expect(() => render(<WorkspaceContextBar />)).not.toThrow();
  });

  it("renders nothing when the active workspace has no issueKey/preset/offset", () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", issueKey: null, preset: null, env: {} });
    seed({ workspaces: [w], activeWs: "w1", userScripts: { "/repo": { scripts: [], onEnter: null } } });
    const { container } = render(<WorkspaceContextBar />);
    expect(container.firstChild).toBeNull();
  });

  it("renders branch, issueKey, jira and preset chips when set", () => {
    const w = makeWorkspace({
      id: "w1",
      repoId: "/repo",
      branch: "feat/y",
      issueKey: "PROJ-7",
      jiraStatus: "Review",
      preset: "backend",
      env: { AURORA_PORT_OFFSET: "2" },
    });
    seed({ workspaces: [w], activeWs: "w1", userScripts: { "/repo": { scripts: [], onEnter: null } } });
    const { container } = render(<WorkspaceContextBar />);
    expect(container.textContent).toContain("feat/y");
    expect(container.textContent).toContain("PROJ-7");
    expect(container.textContent).toContain("Review");
    expect(container.textContent).toContain("preset: backend");
  });

  it("omits branch/issueKey/preset chips when unset but keeps the bar visible via offset", () => {
    const w = makeWorkspace({
      id: "w1",
      repoId: "/repo",
      branch: null,
      issueKey: null,
      preset: null,
      env: { AURORA_PORT_OFFSET: "3" },
    });
    seed({ workspaces: [w], activeWs: "w1", userScripts: { "/repo": { scripts: [], onEnter: null } } });
    const { container } = render(<WorkspaceContextBar />);
    expect(container.firstChild).toBeTruthy();
    expect(container.textContent).not.toContain("seeded from");
    expect(container.textContent).not.toContain("preset:");
  });

  it("shows the derived-ports chip (with a separator dot between entries) when scripts declare ports", () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    const scripts = [
      { name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) next dev" }] },
      { name: "api", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((4000 + AURORA_PORT_OFFSET)) node server.js" }] },
    ];
    seed({ workspaces: [w], activeWs: "w1", userScripts: { "/repo": { scripts, onEnter: null } } });
    const { container } = render(<WorkspaceContextBar />);
    expect(container.querySelector(".aurora-ws-ports")).toBeTruthy();
    expect(container.textContent).toContain("3005");
    expect(container.textContent).toContain("4005");
    expect(container.querySelector(".aurora-ws-offset")).toBeNull();
  });

  it("falls back to the plain offset chip and hides the Run/Stop button when no scripts declare ports", () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    seed({ workspaces: [w], activeWs: "w1", userScripts: { "/repo": { scripts: [], onEnter: null } } });
    const { container } = render(<WorkspaceContextBar />);
    expect(container.querySelector(".aurora-ws-offset")).toBeTruthy();
    expect(container.querySelector(".aurora-ws-ports")).toBeNull();
    expect(container.querySelector(".aurora-ws-runtoggle")).toBeNull();
  });

  it("shows a singular 'Run 1 server' button when down, and toggles class/label/icon when up", () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    const scripts = [
      { name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) next dev" }] },
    ];
    seed({
      workspaces: [w],
      activeWs: "w1",
      userScripts: { "/repo": { scripts, onEnter: null } },
      auroraConfigs: { "/repo": auroraRunConfig({ web: {} }) },
    });
    serversUpValue = false;
    const { container } = render(<WorkspaceContextBar />);
    const btn = container.querySelector(".aurora-ws-runtoggle") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("Run servers");
    expect(btn.getAttribute("title")).toBe("Run 1 server (⌘R)");
    expect(btn.textContent).toContain("Run");
    expect(btn.className).not.toContain("aurora-ws-runtoggle--up");
  });

  it("shows a plural 'Stop N servers' button and the --up class when servers are up", () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    const scripts = [
      { name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) next dev" }] },
      { name: "api", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((4000 + AURORA_PORT_OFFSET)) node server.js" }] },
    ];
    seed({
      workspaces: [w],
      activeWs: "w1",
      userScripts: { "/repo": { scripts, onEnter: null } },
      auroraConfigs: { "/repo": auroraRunConfig({ web: {}, api: {} }) },
    });
    serversUpValue = true;
    const { container } = render(<WorkspaceContextBar />);
    const btn = container.querySelector(".aurora-ws-runtoggle") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Stop servers");
    expect(btn.getAttribute("title")).toBe("Stop 2 servers (⌘R)");
    expect(btn.textContent).toContain("Stop");
    expect(btn.className).toContain("aurora-ws-runtoggle--up");
  });

  it("clicking Run calls runServers(ws.id) and does not notify on success", async () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    const scripts = [{ name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) x" }] }];
    seed({
      workspaces: [w],
      activeWs: "w1",
      userScripts: { "/repo": { scripts, onEnter: null } },
      auroraConfigs: { "/repo": auroraRunConfig({ web: {} }) },
    });
    serversUpValue = false;
    const { container } = render(<WorkspaceContextBar />);
    fireEvent.click(container.querySelector(".aurora-ws-runtoggle")!);
    await flush();
    expect(serversCalls).toEqual([{ fn: "run", wsId: "w1" }]);
    expect(useStore.getState().notifLog.length).toBe(0);
  });

  it("notifies 'Run servers failed' with the Error message when runServers rejects", async () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    const scripts = [{ name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) x" }] }];
    seed({
      workspaces: [w],
      activeWs: "w1",
      userScripts: { "/repo": { scripts, onEnter: null } },
      auroraConfigs: { "/repo": auroraRunConfig({ web: {} }) },
    });
    serversUpValue = false;
    runServersImpl = () => Promise.reject(new Error("spawn failed"));
    const { container } = render(<WorkspaceContextBar />);
    fireEvent.click(container.querySelector(".aurora-ws-runtoggle")!);
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif.headline).toBe("Couldn't start servers — Workspace");
    expect(notif.sub).toBe("spawn failed");
    expect(notif.repo).toBe("repo");
  });

  it("notifies 'Stop servers failed' stringifying a non-Error rejection", async () => {
    const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
    const scripts = [{ name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) x" }] }];
    seed({
      workspaces: [w],
      activeWs: "w1",
      userScripts: { "/repo": { scripts, onEnter: null } },
      auroraConfigs: { "/repo": auroraRunConfig({ web: {} }) },
    });
    serversUpValue = true;
    stopServersImpl = () => Promise.reject("kill -9 refused");
    const { container } = render(<WorkspaceContextBar />);
    fireEvent.click(container.querySelector(".aurora-ws-runtoggle")!);
    await flush();
    const notif = useStore.getState().notifLog[0];
    expect(notif.headline).toBe("Couldn't stop servers — Workspace");
    expect(notif.sub).toBe("kill -9 refused");
  });

  // Note: `ws.repoId ?? ""` in the Run/Stop failure notify (WorkspaceRail.tsx:791)
  // is dead code in practice — the Run/Stop button only renders when `servers.length
  // > 0`, which requires port-scripts keyed by a truthy repoId in userScripts, so
  // `ws.repoId` is always truthy whenever that onClick can fire. Rendering the bar
  // with a null repoId is now safe (see the EMPTY_SCRIPTS regression above), but
  // the Run/Stop onClick still can't fire without a truthy repoId, so this
  // fallback stays dead either way.

  // Regression (review finding #5, nit): choosing an entry from the Run menu
  // (the ▾ dropdown, shown when a repo has >1 run script) used to leave the
  // menu open — onToggleOne dispatched run/stop but never cleared
  // runMenuWsId. It must close on selection, like any other menu.
  describe("Run menu (▾ dropdown)", () => {
    function seedTwoScripts() {
      const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
      const scripts = [
        { name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) x" }] },
        { name: "api", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((4000 + AURORA_PORT_OFFSET)) y" }] },
      ];
      seed({
        workspaces: [w],
        activeWs: "w1",
        userScripts: { "/repo": { scripts, onEnter: null } },
        auroraConfigs: { "/repo": auroraRunConfig({ web: {}, api: {} }) },
      });
    }

    it("opens on ▾ click, and closes on selecting an entry (runMenuWsId -> null, menu unmounts)", async () => {
      seedTwoScripts();
      serversUpValue = false;
      runningScriptIdsValue = [];
      const { container } = render(<WorkspaceContextBar />);

      fireEvent.click(container.querySelector(".aurora-ws-runmenu-toggle")!);
      expect(useStore.getState().runMenuWsId).toBe("w1");
      const menu = container.querySelector('[role="menu"]');
      expect(menu).toBeTruthy();

      const items = within(menu as HTMLElement).getAllByRole("menuitem");
      const webItem = items.find((el) => el.textContent?.includes("web"))!;
      fireEvent.click(webItem);
      await flush();

      expect(useStore.getState().runMenuWsId).toBeNull();
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(serversCalls).toEqual([{ fn: "run", wsId: "w1", scriptId: "run:0" }]);
    });

    it("closes the menu even when the underlying run/stop call rejects", async () => {
      seedTwoScripts();
      serversUpValue = false;
      runningScriptIdsValue = [];
      runServersImpl = () => Promise.reject(new Error("boom")); // shared impl backing the mocked runOneRunCommand()
      const { container } = render(<WorkspaceContextBar />);

      fireEvent.click(container.querySelector(".aurora-ws-runmenu-toggle")!);
      const menu = container.querySelector('[role="menu"]');
      const items = within(menu as HTMLElement).getAllByRole("menuitem");
      fireEvent.click(items.find((el) => el.textContent?.includes("api"))!);
      await flush();

      expect(useStore.getState().runMenuWsId).toBeNull();
      expect(container.querySelector('[role="menu"]')).toBeNull();
    });

    it("lists custom scripts under their own group and triggers runCustom (not runServer) on click", async () => {
      const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
      const scripts = [{ name: "web", desc: "", split: false, tasks: [{ dir: ".", cmd: "PORT=$((3000 + AURORA_PORT_OFFSET)) x" }] }];
      seed({
        workspaces: [w],
        activeWs: "w1",
        userScripts: { "/repo": { scripts, onEnter: null } },
        auroraConfigs: { "/repo": auroraRunConfig({ web: {} }, { lint: {}, seed: {} }) },
      });
      serversUpValue = false;
      runningScriptIdsValue = [];
      const { container } = render(<WorkspaceContextBar />);

      // A single run entry alone wouldn't show the ▾ toggle, but custom
      // entries do — the menu is the only door to them.
      const toggle = container.querySelector(".aurora-ws-runmenu-toggle");
      expect(toggle).toBeTruthy();
      fireEvent.click(toggle!);

      const menu = container.querySelector('[role="menu"]')!;
      expect(menu.textContent).toContain("servers");
      expect(menu.textContent).toContain("custom");
      const items = within(menu as HTMLElement).getAllByRole("menuitem");
      expect(items.map((el) => el.textContent)).toEqual(
        expect.arrayContaining([expect.stringContaining("web"), expect.stringContaining("lint"), expect.stringContaining("seed")]),
      );

      fireEvent.click(items.find((el) => el.textContent?.includes("lint"))!);
      await flush();
      expect(useStore.getState().runMenuWsId).toBeNull();
      expect(serversCalls).toEqual([{ fn: "run", wsId: "w1", scriptId: "lint" }]);
    });

    it("shows the ▾ menu (but no bare Run/Stop pill) when a repo has custom scripts and zero run entries", () => {
      const w = makeWorkspace({ id: "w1", repoId: "/repo", env: { AURORA_PORT_OFFSET: "5" } });
      seed({
        workspaces: [w],
        activeWs: "w1",
        userScripts: { "/repo": { scripts: [], onEnter: null } },
        auroraConfigs: { "/repo": auroraRunConfig({}, { seed: {} }) },
      });
      const { container } = render(<WorkspaceContextBar />);
      expect(container.querySelector(".aurora-ws-runtoggle")).toBeNull();
      const toggle = container.querySelector(".aurora-ws-runmenu-toggle");
      expect(toggle).toBeTruthy();
      fireEvent.click(toggle!);
      const menu = container.querySelector('[role="menu"]')!;
      // Only one category present — no redundant "servers"/"custom" group labels.
      expect(menu.textContent).not.toContain("servers");
      expect(within(menu as HTMLElement).getAllByRole("menuitem")).toHaveLength(1);
      expect(menu.textContent).toContain("seed");
    });
  });
});
