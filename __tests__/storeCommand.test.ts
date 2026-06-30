/// <reference types="bun-types" />
/**
 * Unit tests for store command-palette actions — unify-workspace-create OpenSpec change.
 *
 * Tests the actual Zustand store (not a mock), so the assertions reflect the
 * real reducer behaviour. Two bugs this covers:
 *
 *  1. setCommandQuery must preserve repoId (the pinned target) across keystrokes.
 *     Before the fix, typing would re-create the command object without spreading
 *     the prior state, silently dropping repoId.
 *
 *  2. setCommandRepo must preserve query and sel while pinning a new repo target.
 *     Both actions must be no-ops when command is null.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────

mock.module("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(null),
  transformCallback: () => 0,
  convertFileSrc: (s: string) => s,
  Channel: class {},
  PluginListener: class {},
  Resource: class {},
}));
mock.module("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  once: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
  TauriEvent: {},
}));
mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: () => Promise.resolve(""),
  writeText: () => Promise.resolve(),
}));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
mock.module("@tauri-apps/plugin-process", () => ({ exit: () => Promise.resolve() }));
mock.module("@tauri-apps/plugin-updater", () => ({ check: () => Promise.resolve(null) }));
mock.module("@xterm/xterm", () => ({ Terminal: class {} }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class {} }));

// theme.ts calls document.documentElement which is not available in Bun's
// non-browser test env. Mock it to a no-op so store.ts can be imported safely.
mock.module("../src/lib/theme", () => ({
  applyTheme: () => {},
  ACCENTS: {},
  FONT_SIZES: {},
}));

// ── Load the actual store ─────────────────────────────────────────────────────
const { useStore } = (await import("../src/state/store")) as {
  useStore: {
    getState: () => {
      command: { query: string; sel: number; repoId?: string | null } | null;
      openCommand: (repoId?: string | null) => void;
      closeCommand: () => void;
      setCommandQuery: (q: string) => void;
      setCommandRepo: (repoId: string | null) => void;
    };
    setState: (patch: Record<string, unknown>) => void;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reset the command state before each test to avoid cross-test contamination. */
beforeEach(() => {
  useStore.setState({ command: null });
});

function openWith(query: string, repoId: string | null, sel = 0) {
  useStore.setState({ command: { query, sel, repoId } });
}

// ── Tests: setCommandQuery preserves repoId ───────────────────────────────────

describe("setCommandQuery — repoId survives a keystroke", () => {
  it("repoId is preserved after setCommandQuery", () => {
    openWith("", "repo-abc", 0);
    useStore.getState().setCommandQuery("feat");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("repo-abc");
    expect(cmd.query).toBe("feat");
  });

  it("repoId null is preserved (not converted to undefined)", () => {
    openWith("", null, 0);
    useStore.getState().setCommandQuery("foo");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBeNull();
    expect(cmd.query).toBe("foo");
  });

  it("sel is reset to 0 after typing", () => {
    openWith("", "repo-1", 3);
    useStore.getState().setCommandQuery("x");
    expect(useStore.getState().command!.sel).toBe(0);
  });

  it("is a no-op (command stays null) when command is closed", () => {
    // command is null from beforeEach
    useStore.getState().setCommandQuery("anything");
    expect(useStore.getState().command).toBeNull();
  });

  it("multiple keystrokes all preserve repoId", () => {
    openWith("", "pinned-repo", 0);
    useStore.getState().setCommandQuery("f");
    useStore.getState().setCommandQuery("fe");
    useStore.getState().setCommandQuery("feat");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("pinned-repo");
    expect(cmd.query).toBe("feat");
  });
});

// ── Tests: setCommandRepo preserves query/sel ─────────────────────────────────

describe("setCommandRepo — query and sel survive a repo change", () => {
  it("query and sel are preserved after setCommandRepo", () => {
    openWith("my-branch", "repo-1", 2);
    useStore.getState().setCommandRepo("repo-2");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("repo-2");
    expect(cmd.query).toBe("my-branch");
    expect(cmd.sel).toBe(2);
  });

  it("setCommandRepo to null clears the target while keeping query/sel", () => {
    openWith("foo", "repo-1", 1);
    useStore.getState().setCommandRepo(null);
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBeNull();
    expect(cmd.query).toBe("foo");
    expect(cmd.sel).toBe(1);
  });

  it("is a strict no-op when command is null (returns empty patch)", () => {
    // command is null from beforeEach
    useStore.getState().setCommandRepo("repo-xyz");
    // must stay null — not open the palette
    expect(useStore.getState().command).toBeNull();
  });
});

// ── Tests: openCommand → setCommandQuery/setCommandRepo round-trip ────────────

describe("openCommand + command actions — combined round-trip", () => {
  it("openCommand sets repoId; setCommandQuery preserves it", () => {
    useStore.getState().openCommand("the-repo");
    useStore.getState().setCommandQuery("some-branch");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("the-repo");
    expect(cmd.query).toBe("some-branch");
  });

  it("openCommand → setCommandRepo → setCommandQuery preserves the new repoId", () => {
    useStore.getState().openCommand("repo-A");
    useStore.getState().setCommandRepo("repo-B");
    useStore.getState().setCommandQuery("typed");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("repo-B");
    expect(cmd.query).toBe("typed");
  });
});
