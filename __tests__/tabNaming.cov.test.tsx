import { describe, it, expect, beforeEach } from "bun:test";
import { sanitizeLabel, requestTabName, type PaneRun } from "../src/lib/tabNaming";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace } from "../src/state/store";

function makeWorkspace(tabId: number): Workspace {
  return {
    id: "w1",
    repoId: null,
    title: "t",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/tmp",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [{ id: tabId, panes: [], active: 0, split: "h", name: null }],
    active: 0,
    createdAt: 0,
    lastActive: 0,
    serverTabId: null,
  };
}

function enable(tabId: number) {
  useStore.setState(
    {
      apiKeyPresent: true,
      settings: { ...useStore.getState().settings, autoRenameTabs: true },
      workspaces: [makeWorkspace(tabId)],
      activeWs: "w1",
    },
    false,
  );
}

function tabName(): string | null | undefined {
  return useStore.getState().workspaces.find((w) => w.id === "w1")?.tabs[0]?.name;
}

beforeEach(() => {
  tauri.reset();
});

describe("sanitizeLabel", () => {
  it("trims, collapses whitespace and strips quotes", () => {
    expect(sanitizeLabel('  "vite   dev"  ')).toBe("vite dev");
  });

  it("strips control characters (including DEL) into spaces", () => {
    expect(sanitizeLabel("a\x00\x1fb\x7fc")).toBe("a b c");
  });

  it("returns null when nothing usable remains after cleaning", () => {
    expect(sanitizeLabel("   \x00\x01  ")).toBeNull();
  });

  it("truncates to MAX_LABEL (28) characters", () => {
    const long = "x".repeat(50);
    const out = sanitizeLabel(long);
    expect(out).toHaveLength(28);
    expect(out).toBe("x".repeat(28));
  });

  it("passes short clean labels through unchanged", () => {
    expect(sanitizeLabel("jest watch")).toBe("jest watch");
  });
});

describe("requestTabName", () => {
  it("no-ops when no pane has a running command", async () => {
    enable(1);
    await requestTabName(1, [{ command: "   ", output: "" }]);
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
    expect(tabName()).toBeNull();
  });

  it("no-ops when autoRenameTabs is disabled", async () => {
    useStore.setState(
      {
        apiKeyPresent: true,
        settings: { ...useStore.getState().settings, autoRenameTabs: false },
        workspaces: [makeWorkspace(2)],
        activeWs: "w1",
      },
      false,
    );
    await requestTabName(2, [{ command: "vite dev", output: "" }]);
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
  });

  it("no-ops when no API key is present", async () => {
    useStore.setState(
      {
        apiKeyPresent: false,
        settings: { ...useStore.getState().settings, autoRenameTabs: true },
        workspaces: [makeWorkspace(3)],
        activeWs: "w1",
      },
      false,
    );
    await requestTabName(3, [{ command: "vite dev", output: "" }]);
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
  });

  it("applies the sanitized label on success (single pane prompt)", async () => {
    enable(4);
    tauri.invoke({ claude_text: () => '  "vite dev"  ' });
    await requestTabName(4, [{ command: "vite dev", output: "ready in 300ms" }]);
    const call = tauri.lastCall("claude_text");
    expect(call?.args.model).toBe("claude-haiku-4-5-20251001");
    expect(call?.args.maxTokens).toBe(24);
    expect(call?.args.prompt as string).toContain("Command:\nvite dev");
    expect(tabName()).toBe("vite dev");
  });

  it("builds a combined prompt and filters out panes with an empty command", async () => {
    enable(5);
    tauri.invoke({ claude_text: () => "dev + tests" });
    await requestTabName(5, [
      { command: "vite dev", output: "" },
      { command: "  ", output: "" },
      { command: "vitest watch", output: "" },
    ]);
    const call = tauri.lastCall("claude_text");
    const prompt = call?.args.prompt as string;
    expect(prompt).toContain("This tab has 2 split panes running");
    expect(prompt).toContain("Pane 1 command: vite dev");
    expect(prompt).toContain("Pane 2 command: vitest watch");
    expect(tabName()).toBe("dev + tests");
  });

  it("collapsing to a single running pane still uses the single-pane prompt shape", async () => {
    enable(6);
    tauri.invoke({ claude_text: () => "vite dev" });
    const panes: PaneRun[] = [
      { command: "", output: "" },
      { command: "vite dev", output: "" },
    ];
    await requestTabName(6, panes);
    const call = tauri.lastCall("claude_text");
    expect(call?.args.prompt as string).toContain("Command:\nvite dev");
  });

  it("does not re-request for the same (tab, command-set) key twice", async () => {
    enable(7);
    tauri.invoke({ claude_text: () => "label one" });
    await requestTabName(7, [{ command: "vite dev", output: "" }]);
    const after1 = tauri.calls().filter((c) => c.cmd === "claude_text").length;
    await requestTabName(7, [{ command: "vite dev", output: "" }]);
    const after2 = tauri.calls().filter((c) => c.cmd === "claude_text").length;
    expect(after2).toBe(after1);
    expect(after1).toBe(1);
  });

  it("swallows NoKeyError silently and does not retry (keeps the cwd label)", async () => {
    enable(8);
    tauri.invoke({
      claude_text: () => {
        throw new Error("no-key");
      },
    });
    await requestTabName(8, [{ command: "vite dev", output: "" }]);
    expect(tabName()).toBeNull();
    await requestTabName(8, [{ command: "vite dev", output: "" }]);
    expect(tauri.calls().filter((c) => c.cmd === "claude_text").length).toBe(1);
  });

  it("allows a retry after a transient (non no-key) failure", async () => {
    enable(9);
    let attempt = 0;
    tauri.invoke({
      claude_text: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return "vite dev";
      },
    });
    await requestTabName(9, [{ command: "vite dev", output: "" }]);
    expect(attempt).toBe(1);
    expect(tabName()).toBeNull();
    await requestTabName(9, [{ command: "vite dev", output: "" }]);
    expect(attempt).toBe(2);
    expect(tabName()).toBe("vite dev");
  });

  it("does not rename the tab when the model's label sanitizes to nothing", async () => {
    enable(10);
    tauri.invoke({ claude_text: () => "   \x00\x01  " });
    await requestTabName(10, [{ command: "vite dev", output: "" }]);
    expect(tabName()).toBeNull();
  });
});
