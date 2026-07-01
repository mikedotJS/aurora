// Coverage suite for src/lib/ports.ts — pure port-isolation helpers (no Tauri, no store).

import { describe, it, expect } from "bun:test";
import { readOffset, portScripts, serverUnits, parseDerivedPorts, type PortScript } from "../src/lib/ports";

describe("readOffset", () => {
  it("returns NaN when the env map is undefined", () => {
    expect(Number.isNaN(readOffset(undefined))).toBe(true);
  });
  it("returns NaN when AURORA_PORT_OFFSET is absent", () => {
    expect(Number.isNaN(readOffset({ OTHER: "1" }))).toBe(true);
  });
  it("parses a valid integer offset", () => {
    expect(readOffset({ AURORA_PORT_OFFSET: "100" })).toBe(100);
  });
  it("parses a negative offset", () => {
    expect(readOffset({ AURORA_PORT_OFFSET: "-10" })).toBe(-10);
  });
  it("returns NaN for a malformed (non-numeric) value", () => {
    expect(Number.isNaN(readOffset({ AURORA_PORT_OFFSET: "abc" }))).toBe(true);
  });
});

const portTask = (n: number) => ({ dir: "", cmd: `PORT=$((${n} + AURORA_PORT_OFFSET)) vite` });
const plainTask = { dir: "", cmd: "echo hi" };

describe("portScripts", () => {
  it("filters to scripts with at least one port-matching task", () => {
    const scripts: PortScript[] = [
      { name: "web", tasks: [portTask(3000)] },
      { name: "lint", tasks: [plainTask] },
    ];
    expect(portScripts(scripts).map((s) => s.name)).toEqual(["web"]);
  });
  it("returns [] when no script matches the pattern", () => {
    const scripts: PortScript[] = [{ name: "lint", tasks: [plainTask] }];
    expect(portScripts(scripts)).toEqual([]);
  });
  it("a script binding two ports still appears once (one entry per script)", () => {
    const scripts: PortScript[] = [{ name: "web", tasks: [portTask(3000), portTask(3001)] }];
    expect(portScripts(scripts).length).toBe(1);
  });
  it("matches even when only one of several tasks is a port task", () => {
    const scripts: PortScript[] = [{ name: "mixed", tasks: [plainTask, portTask(4000)] }];
    expect(portScripts(scripts).map((s) => s.name)).toEqual(["mixed"]);
  });
});

describe("serverUnits", () => {
  it("non-split script -> one unit with taskIndex null", () => {
    const scripts: PortScript[] = [{ name: "web", tasks: [portTask(3000), portTask(3001)] }];
    expect(serverUnits(scripts)).toEqual([{ name: "web", taskIndex: null }]);
  });

  it("split script with >=2 non-empty tasks -> one unit per task", () => {
    const scripts: PortScript[] = [
      { name: "web", split: true, tasks: [portTask(3000), portTask(3001)] },
    ];
    expect(serverUnits(scripts)).toEqual([
      { name: "web", taskIndex: 0 },
      { name: "web", taskIndex: 1 },
    ]);
  });

  it("split script with exactly 1 non-empty task -> single chained unit (taskIndex null)", () => {
    const scripts: PortScript[] = [
      { name: "web", split: true, tasks: [portTask(3000), { dir: "", cmd: "" }] },
    ];
    expect(serverUnits(scripts)).toEqual([{ name: "web", taskIndex: null }]);
  });

  it("filters out empty-command tasks before counting for the split decision", () => {
    const scripts: PortScript[] = [
      {
        name: "web",
        split: true,
        tasks: [portTask(3000), { dir: "", cmd: "   " }, portTask(3001)],
      },
    ];
    // Only 2 non-empty tasks survive the trim filter -> split into 2 units.
    expect(serverUnits(scripts)).toEqual([
      { name: "web", taskIndex: 0 },
      { name: "web", taskIndex: 1 },
    ]);
  });

  it("expands multiple port-scripts in order", () => {
    const scripts: PortScript[] = [
      { name: "api", tasks: [portTask(4000)] },
      { name: "lint", tasks: [plainTask] },
      { name: "web", split: true, tasks: [portTask(3000), portTask(3001)] },
    ];
    expect(serverUnits(scripts)).toEqual([
      { name: "api", taskIndex: null },
      { name: "web", taskIndex: 0 },
      { name: "web", taskIndex: 1 },
    ]);
  });

  it("returns [] when there are no port-scripts", () => {
    expect(serverUnits([{ name: "lint", tasks: [plainTask] }])).toEqual([]);
  });
});

describe("parseDerivedPorts", () => {
  it("extracts a single labeled port with the offset applied", () => {
    const scripts: PortScript[] = [{ name: "web", tasks: [portTask(3000)] }];
    expect(parseDerivedPorts(scripts, 100)).toEqual([{ label: "web", port: 3100 }]);
  });

  it("extracts multiple distinct ports across scripts", () => {
    const scripts: PortScript[] = [
      { name: "web", tasks: [portTask(3000)] },
      { name: "api", tasks: [portTask(4000)] },
    ];
    expect(parseDerivedPorts(scripts, 0)).toEqual([
      { label: "web", port: 3000 },
      { label: "api", port: 4000 },
    ]);
  });

  it("returns [] for scripts with no $((...)) pattern (never fabricates a port)", () => {
    const scripts: PortScript[] = [{ name: "lint", tasks: [plainTask] }];
    expect(parseDerivedPorts(scripts, 10)).toEqual([]);
  });

  it("dedupes a repeated concrete port (same base port across tasks)", () => {
    const scripts: PortScript[] = [
      { name: "web", tasks: [portTask(3000), portTask(3000)] },
    ];
    expect(parseDerivedPorts(scripts, 0)).toEqual([{ label: "web", port: 3000 }]);
  });

  it("finds multiple distinct ports within a single task command", () => {
    const scripts: PortScript[] = [
      {
        name: "web",
        tasks: [{ dir: "", cmd: "vite --port $((3000 + AURORA_PORT_OFFSET)) --hmr-port $((3001 + AURORA_PORT_OFFSET))" }],
      },
    ];
    expect(parseDerivedPorts(scripts, 5)).toEqual([
      { label: "web", port: 3005 },
      { label: "web", port: 3006 },
    ]);
  });

  it("applies a negative offset", () => {
    const scripts: PortScript[] = [{ name: "web", tasks: [portTask(3000)] }];
    expect(parseDerivedPorts(scripts, -100)).toEqual([{ label: "web", port: 2900 }]);
  });
});
