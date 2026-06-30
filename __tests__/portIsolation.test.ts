/// <reference types="bun-types" />
/**
 * Tests for Task 3.3 — workspace-port-isolation.
 *
 * Covers:
 *  - parseScripts (aiScripts.ts): commands containing `$((N + AURORA_PORT_OFFSET))`
 *    pass through unchanged — no sanitizer strips the arithmetic or the flag.
 *  - parseDerivedPorts (src/lib/ports.ts): extracts concrete port (base + offset)
 *    and label from script commands.
 *    · single-server case
 *    · multi-server case (two distinct base ports → two labeled entries)
 *    · commands without `$((…))` → empty result (no fabrication)
 *    · duplicate concrete port is deduplicated (seen-set guard)
 *
 * Mock strategy:
 *  - parseDerivedPorts: imported from src/lib/ports.ts (pure, zero deps) — NO mock needed.
 *  - parseScripts: imported from src/lib/aiScripts.ts which transitively loads Tauri packages
 *    (via sys.ts, suggest.ts, scripts.ts) and store (via scripts.ts → theme). Only those
 *    leaf packages are stubbed — lib/* and state/store use their real implementations.
 */

// ── parseDerivedPorts: pure module — static import, no mock needed ────────────
import { parseDerivedPorts } from "../src/lib/ports.ts";

import { mock, describe, it, expect } from "bun:test";

// ── Leaf stubs for the aiScripts import chain — do NOT mock lib/* or state/store ─
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
// theme.ts calls document.documentElement inside applyTheme(); stub to avoid
// DOM access during store initialisation (aiScripts → scripts → store → theme).
mock.module("../src/lib/theme", () => ({
  applyTheme: () => {},
  ACCENTS: {},
  FONT_SIZES: {},
}));

// ── parseScripts: dynamic import so Tauri stubs above are already registered ──
const { parseScripts } = (await import("../src/lib/aiScripts.ts")) as {
  parseScripts: (text: string) => {
    name: string;
    desc: string;
    split: boolean;
    tasks: { dir: string; cmd: string }[];
  }[];
};

// ═══════════════════════════════════════════════════════════════════════════════
// parseScripts — passthrough of $((…)) syntax
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseScripts — $((N + AURORA_PORT_OFFSET)) passthrough", () => {
  it("preserves $((3333 + AURORA_PORT_OFFSET)) in a task cmd unchanged", () => {
    const input = JSON.stringify([
      {
        name: "dev",
        desc: "run the api server",
        split: false,
        tasks: [{ dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" }],
      },
    ]);
    const scripts = parseScripts(input);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].tasks[0].cmd).toBe("nx serve api --port $((3333 + AURORA_PORT_OFFSET))");
  });

  it("preserves $((5173 + AURORA_PORT_OFFSET)) — vite default", () => {
    const input = JSON.stringify([
      {
        name: "dev",
        desc: "vite dev server",
        split: false,
        tasks: [{ dir: "", cmd: "vite --port $((5173 + AURORA_PORT_OFFSET))" }],
      },
    ]);
    const scripts = parseScripts(input);
    expect(scripts[0].tasks[0].cmd).toBe("vite --port $((5173 + AURORA_PORT_OFFSET))");
  });

  it("preserves multi-task split script with multiple $((…)) forms", () => {
    const input = JSON.stringify([
      {
        name: "start",
        desc: "api + web",
        split: true,
        tasks: [
          { dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" },
          { dir: "", cmd: "nx serve web --port $((4200 + AURORA_PORT_OFFSET))" },
        ],
      },
    ]);
    const scripts = parseScripts(input);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].split).toBe(true);
    expect(scripts[0].tasks[0].cmd).toBe("nx serve api --port $((3333 + AURORA_PORT_OFFSET))");
    expect(scripts[0].tasks[1].cmd).toBe("nx serve web --port $((4200 + AURORA_PORT_OFFSET))");
  });

  it("also preserves plain commands without $((…)) — no mutation either way", () => {
    const input = JSON.stringify([
      { name: "test", desc: "run tests", split: false, tasks: [{ dir: "", cmd: "bun test" }] },
    ]);
    const scripts = parseScripts(input);
    expect(scripts[0].tasks[0].cmd).toBe("bun test");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseDerivedPorts — port extraction (imported from ports.ts, no mock needed)
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseDerivedPorts — single-server", () => {
  it("extracts base + offset for a single nx serve command (offset=10)", () => {
    const scripts = [
      { name: "dev", tasks: [{ dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" }] },
    ];
    const result = parseDerivedPorts(scripts, 10);
    expect(result).toEqual([{ label: "dev", port: 3343 }]);
  });

  it("offset=0 → port equals the base (default workspace)", () => {
    const scripts = [
      { name: "serve", tasks: [{ dir: "", cmd: "next dev --port $((3000 + AURORA_PORT_OFFSET))" }] },
    ];
    const result = parseDerivedPorts(scripts, 0);
    expect(result).toEqual([{ label: "serve", port: 3000 }]);
  });

  it("offset=20 → port is base+20", () => {
    const scripts = [
      { name: "vite", tasks: [{ dir: "", cmd: "vite --port $((5173 + AURORA_PORT_OFFSET))" }] },
    ];
    const result = parseDerivedPorts(scripts, 20);
    expect(result).toEqual([{ label: "vite", port: 5193 }]);
  });
});

describe("parseDerivedPorts — multi-server", () => {
  it("two scripts with different base ports → two labeled entries in order", () => {
    const scripts = [
      { name: "api", tasks: [{ dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" }] },
      { name: "web", tasks: [{ dir: "", cmd: "nx serve web --port $((4200 + AURORA_PORT_OFFSET))" }] },
    ];
    const result = parseDerivedPorts(scripts, 10);
    expect(result).toEqual([
      { label: "api", port: 3343 },
      { label: "web", port: 4210 },
    ]);
  });

  it("split script: two tasks in one script → two ports, both labelled with script name", () => {
    const scripts = [
      {
        name: "start",
        tasks: [
          { dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" },
          { dir: "", cmd: "nx serve web --port $((4200 + AURORA_PORT_OFFSET))" },
        ],
      },
    ];
    const result = parseDerivedPorts(scripts, 0);
    expect(result).toEqual([
      { label: "start", port: 3333 },
      { label: "start", port: 4200 },
    ]);
  });
});

describe("parseDerivedPorts — no $((…)) → empty (no fabrication)", () => {
  it("plain command without offset expression → empty array", () => {
    const scripts = [{ name: "dev", tasks: [{ dir: "", cmd: "npm run dev" }] }];
    const result = parseDerivedPorts(scripts, 10);
    expect(result).toEqual([]);
  });

  it("fixed port number (not the offset pattern) → not extracted", () => {
    const scripts = [{ name: "serve", tasks: [{ dir: "", cmd: "next dev --port 3000" }] }];
    const result = parseDerivedPorts(scripts, 10);
    expect(result).toEqual([]);
  });

  it("empty scripts array → empty result", () => {
    expect(parseDerivedPorts([], 5)).toEqual([]);
  });
});

describe("parseDerivedPorts — deduplication", () => {
  it("same computed port from two scripts is deduplicated; first label wins", () => {
    const scripts = [
      { name: "dev1", tasks: [{ dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" }] },
      { name: "dev2", tasks: [{ dir: "", cmd: "nx serve api --port $((3333 + AURORA_PORT_OFFSET))" }] },
    ];
    const result = parseDerivedPorts(scripts, 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ label: "dev1", port: 3333 });
  });
});
