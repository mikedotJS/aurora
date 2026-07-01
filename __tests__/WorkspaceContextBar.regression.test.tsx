// Regression: the "black screen" crash on a repoId-less lane (the auto boot
// "michaelromain" home lane) as the active workspace.
//
// WorkspaceContextBar's scripts selector returned a fresh `[]` on every render
// when repoId was null (or the repo had no scripts). Zustand's useStore is a
// useSyncExternalStore — a snapshot whose identity changes every call is treated
// as "store changed", so React re-renders → selector runs → new `[]` → re-render
// → "Maximum update depth exceeded" → the whole tree unmounts (black screen).
//
// The fix returns a stable module-level EMPTY_SCRIPTS. This test renders the bar
// with a repoId:null active lane; before the fix it throws, after it does not.
import { describe, it, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { useStore } from "../src/state/store";
import { WorkspaceContextBar } from "../src/components/WorkspaceRail";

afterEach(cleanup);

function homeLane(overrides: Record<string, unknown> = {}) {
  return {
    id: "w-home",
    repoId: null,
    title: "michaelromain",
    issueKey: null,
    branch: null,
    baseBranch: "",
    dir: "/Users/test",
    preset: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    diff: null,
    mr: null,
    pipeline: null,
    env: {},
    createdAt: 0,
    lastActive: 0,
    mounted: true,
    tabs: [],
    active: 0,
    ...overrides,
  };
}

function seed(ws: Record<string, unknown>) {
  useStore.setState(
    { workspaces: [ws], activeWs: "w-home", userScripts: {}, serverStatus: {}, initialized: true } as never,
    false,
  );
}

describe("WorkspaceContextBar — repoId:null lane (black-screen crash regression)", () => {
  it("renders a script-less home lane without an infinite re-render loop", () => {
    seed(homeLane());
    expect(() => render(<WorkspaceContextBar />)).not.toThrow();
  });

  it("renders when the bar is actually shown (offset present) — still stable", () => {
    // env with a port offset makes hasOffset true so the bar renders its body,
    // exercising the selector on the visible path too.
    seed(homeLane({ env: { AURORA_PORT_OFFSET: "10" } }));
    expect(() => render(<WorkspaceContextBar />)).not.toThrow();
  });
});
