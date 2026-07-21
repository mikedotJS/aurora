// Coverage suite for src/lib/ports.ts — pure port-isolation helpers (no Tauri, no store).

import { describe, it, expect } from "bun:test";
import {
  readOffset,
  portScripts,
  serverUnits,
  parseDerivedPorts,
  AURORA_PORT_BASE,
  AURORA_PORT_RANGE_WIDTH,
  offsetRange,
  detectPortCollisions,
  hasCollision,
  type PortScript,
  type WorkspacePortState,
} from "../src/lib/ports";

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

describe("AURORA_PORT_BASE", () => {
  it("is 3000 — the legacy $((3000+AURORA_PORT_OFFSET)) idiom must resolve to exactly AURORA_PORT", () => {
    expect(AURORA_PORT_BASE).toBe(3000);
  });
});

describe("offsetRange", () => {
  it("offset 0 -> [3000,3009] with the default base/width", () => {
    expect(offsetRange(0)).toEqual({ start: 3000, end: 3009 });
  });
  it("offset 20 -> [3020,3029]", () => {
    expect(offsetRange(20)).toEqual({ start: 3020, end: 3029 });
  });
  it("honors a custom base/width", () => {
    expect(offsetRange(10, 4000, 5)).toEqual({ start: 4010, end: 4014 });
  });
});

const wsPorts = (wsId: string, offset: number, boundPorts: number[]): WorkspacePortState => ({
  wsId,
  offset,
  boundPorts,
});

describe("detectPortCollisions", () => {
  it("no collisions when every bound port is inside its own workspace's range", () => {
    const workspaces = [wsPorts("a", 0, [3000, 3005]), wsPorts("b", 10, [3010])];
    expect(detectPortCollisions(workspaces)).toEqual([]);
  });

  // Regression (review finding #2): a bare out-of-range port that NOTHING
  // else contends is normal — a docker/postgres/inspector aux port a solo
  // workspace binds alongside its in-range dev server — and must never be
  // flagged by itself; it used to fire a spurious red "collision" toast on a
  // perfectly healthy `docker compose up`. "outside-range" is now only ever
  // reported alongside a genuine cross-workspace share (see below).
  it("does NOT flag a lone workspace's out-of-range port when nothing else contends it", () => {
    const workspaces = [wsPorts("a", 0, [3000, 8080])];
    expect(detectPortCollisions(workspaces)).toEqual([]);
  });

  it("one workspace binding an in-range dev port + an out-of-range aux port (e.g. Postgres 5432) alone -> no collision", () => {
    const workspaces = [wsPorts("a", 0, [3000, 5432])];
    expect(detectPortCollisions(workspaces)).toEqual([]);
  });

  it("two workspaces genuinely fighting over the same port ARE flagged, even if in-range for neither", () => {
    const workspaces = [wsPorts("a", 0, [5432]), wsPorts("b", 10, [5432])];
    const collisions = detectPortCollisions(workspaces);
    expect(collisions).toContainEqual({ wsId: "a", port: 5432, reason: "shared-with-another-workspace", sharedWith: "b" });
    expect(collisions).toContainEqual({ wsId: "b", port: 5432, reason: "shared-with-another-workspace", sharedWith: "a" });
  });

  it("flags two workspaces sharing the same bound port, symmetrically", () => {
    // 3000 is inside "a"'s own range [3000,3009] but outside "b"'s [3010,3019] —
    // since reserved ranges never overlap by construction, a genuinely SHARED
    // port is necessarily out-of-range for at least one side too; "b" gets
    // both an "outside-range" entry and a "shared" entry here.
    const workspaces = [wsPorts("a", 0, [3000]), wsPorts("b", 10, [3000])];
    const collisions = detectPortCollisions(workspaces);
    expect(collisions).toContainEqual({ wsId: "a", port: 3000, reason: "shared-with-another-workspace", sharedWith: "b" });
    expect(collisions).toContainEqual({ wsId: "b", port: 3000, reason: "shared-with-another-workspace", sharedWith: "a" });
    expect(collisions).toContainEqual({ wsId: "b", port: 3000, reason: "outside-range" });
    expect(collisions.filter((c) => c.wsId === "a")).toHaveLength(1); // a: shared only, 3000 is in its own range
  });

  it("a port that is BOTH out-of-range and shared reports both reasons", () => {
    // "a" reserves [3000,3009] but binds 8080 (out of range); "b" also binds 8080.
    const workspaces = [wsPorts("a", 0, [8080]), wsPorts("b", 10, [8080])];
    const collisions = detectPortCollisions(workspaces);
    expect(collisions).toContainEqual({ wsId: "a", port: 8080, reason: "outside-range" });
    expect(collisions).toContainEqual({ wsId: "a", port: 8080, reason: "shared-with-another-workspace", sharedWith: "b" });
    expect(collisions).toContainEqual({ wsId: "b", port: 8080, reason: "shared-with-another-workspace", sharedWith: "a" });
  });

  it("never fabricates a collision for a lone workspace with no bound ports", () => {
    expect(detectPortCollisions([wsPorts("a", 0, [])])).toEqual([]);
  });

  it("three workspaces sharing one out-of-range port each get a shared + an outside-range entry", () => {
    const workspaces = [wsPorts("a", 0, [9000]), wsPorts("b", 10, [9000]), wsPorts("c", 20, [9000])];
    const collisions = detectPortCollisions(workspaces);
    for (const id of ["a", "b", "c"]) {
      const shared = collisions.find((c) => c.wsId === id && c.reason === "shared-with-another-workspace");
      expect(["a", "b", "c"]).toContain(shared?.sharedWith);
      expect(shared?.sharedWith).not.toBe(id);
      expect(collisions).toContainEqual({ wsId: id, port: 9000, reason: "outside-range" });
    }
    expect(collisions).toHaveLength(6); // 3 shared + 3 outside-range
  });
});

describe("hasCollision", () => {
  it("true when the workspace id appears in the collisions list", () => {
    const collisions = [{ wsId: "a", port: 3000, reason: "outside-range" as const }];
    expect(hasCollision(collisions, "a")).toBe(true);
  });
  it("false when it doesn't", () => {
    const collisions = [{ wsId: "a", port: 3000, reason: "outside-range" as const }];
    expect(hasCollision(collisions, "b")).toBe(false);
  });
  it("false for an empty collisions list", () => {
    expect(hasCollision([], "a")).toBe(false);
  });
});

describe("AURORA_PORT_RANGE_WIDTH", () => {
  it("is 10 — matches create.ts's PORT_STEP", () => {
    expect(AURORA_PORT_RANGE_WIDTH).toBe(10);
  });
});
