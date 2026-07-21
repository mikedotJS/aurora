// Real-filesystem integration harness for the managed-server-lifecycle
// scripts subsystem (migration -> aurora.json IO -> setup-only create prelude).
//
// WHY THIS SUITE EXISTS: the existing unit suites (auroraConfig.test.ts,
// scriptsMigration.test.ts, create.cov.test.ts) mock the Tauri boundary with
// PERMISSIVE doubles — test/mocks/tauri.ts's `write_text_file` default is
// `() => undefined`, which accepts ANY path, relative or absolute, in or out
// of root. Real bugs shipped past that gate because the doubles asserted what
// the code DID, not what the real Rust backend would actually accept — see
// the two historical bugs documented below, both still guarded here.
//
// This suite replaces the sys.ts boundary with test/fauxBackend.ts — a real
// node:fs-backed double enforcing the SAME absolute-path/containment contract
// as the Rust command — and drives the ACTUAL production functions
// (repoScriptsToAuroraConfig, saveAuroraConfig, loadAuroraConfig, createPrelude)
// against a real temp dir, a real git repo, and a real package.json/
// pnpm-lock.yaml. Nothing here re-implements or mocks away the logic under
// test — that's what makes a regression turn this suite red again.
//
// UPDATED for the corrected scripts model ("1 command → 1 pane, 1 run script
// → multiple commands" — setup/run/custom, no auto-install). `scripts.run` is
// now an ORDERED ARRAY of `RunCommand`, not a Record keyed by script id:
//   - Historical bug 1 (still guarded): saveAuroraConfig passed a RELATIVE
//     path ("aurora.json") to write_text_file — the real command
//     (src-tauri/src/sys.rs:153-168) treats `path` as the full target, which
//     must resolve INSIDE `root`; a bare relative name makes Rust's
//     `Path::parent()` empty, and `create_dir_all("")` fails with ENOENT.
//     Fixed: src/lib/auroraConfig.ts passes the absolute `${repoRoot}/aurora.json`.
//   - Historical bug 2 (superseded by the new model, no longer applicable as
//     originally described): the legacy `onEnter` script used to risk being
//     mapped into `scripts.setup`, which would shadow the auto-inferred
//     install. The new model has NO auto-install to shadow — `onEnter` maps
//     onto the Run Script's command list (test 1 below), and `setup` is
//     simply never populated by migration at all (there is no legacy
//     equivalent). What replaces this guard: `createPrelude` is setup-ONLY
//     now, so this suite instead proves the new anti-regression invariant —
//     a migrated repo's onEnter server command must NEVER leak into the
//     create-time prelude (test 5), since prelude only ever reflects a
//     committed `scripts.setup`.
//   - Every OTHER legacy script (not named by `onEnter`) must land in
//     `scripts.custom`, NOT `scripts.run` — an on-demand script must never
//     auto-launch via Run/⌘R (test 1b).

import { describe, it, expect, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import * as fauxBackend from "../test/fauxBackend";
// Bun's mock.module doesn't reliably swap in a raw imported module-namespace
// object (an ES module namespace exotic object) as the factory return value —
// spreading into a plain object is what actually takes effect.
mock.module("../src/lib/sys", () => ({ ...fauxBackend }));

import { repoScriptsToAuroraConfig } from "../src/lib/scriptsMigration";
import { saveAuroraConfig, loadAuroraConfig, commandSpecToShell, AURORA_CONFIG_FILENAME, type AuroraConfig } from "../src/lib/auroraConfig";
import { createPrelude } from "../src/lib/create";
import { writeTextFile } from "../src/lib/sys";
import type { RepoScripts } from "../src/state/store";

const root = mkdtempSync(join(tmpdir(), "aurora-scripts-lifecycle-"));

// A REAL git repo + a REAL package.json/pnpm-lock.yaml — present so this
// fixture still looks like a real JS repo (unused by the create-flow assertions
// below, since installCommand is no longer part of that flow, but keeping a
// realistic fixture rather than a bare empty dir).
execFileSync("git", ["init", "-q"], { cwd: root });
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "odyssey", version: "0.0.0" }));
writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scripts lifecycle — real filesystem integration (managed-server-lifecycle, run/custom split)", () => {
  let migrated: AuroraConfig;

  it("1. migration: the legacy onEnter server script becomes the Run Script's command list", () => {
    // The real odyssey shape: onEnter names the dev-server launcher.
    const legacy: RepoScripts = {
      onEnter: "dev",
      scripts: [
        {
          name: "dev",
          desc: "",
          split: false,
          tasks: [{ dir: "", cmd: "pnpm nx serve api --port $((3000 + AURORA_PORT_OFFSET))" }],
        },
        { name: "lint", desc: "", split: false, tasks: [{ dir: "", cmd: "pnpm lint" }] },
      ],
    };
    const cfg = repoScriptsToAuroraConfig(legacy);
    expect(cfg).not.toBeNull();
    migrated = cfg!;

    expect(migrated.scripts.setup).toBeNull();
    expect(migrated.scripts.run).toEqual([
      { command: "pnpm nx serve api --port $((3000 + AURORA_PORT_OFFSET))", name: "dev" },
    ]);
  });

  it("1b. every OTHER legacy script (not onEnter) becomes a CUSTOM entry, NOT a run entry — never auto-launched", () => {
    expect(migrated.scripts.run.some((r) => r.command === "pnpm lint")).toBe(false);
    expect(migrated.scripts.custom.lint).toMatchObject({ command: "pnpm lint" });
  });

  it("2. saveAuroraConfig writes a REAL aurora.json at <root>/aurora.json (catches the relative-path ENOENT bug)", async () => {
    await saveAuroraConfig(root, migrated);
    const onDisk = join(root, AURORA_CONFIG_FILENAME);
    expect(existsSync(onDisk)).toBe(true);
    const parsed = JSON.parse(readFileSync(onDisk, "utf8"));
    expect(parsed).toEqual(migrated);
    // The written file has an actual scripts.custom key on disk, not just in
    // memory — proves serializeAuroraConfig doesn't drop the new field.
    expect(parsed.scripts.custom.lint.command).toBe("pnpm lint");
  });

  it("3. loadAuroraConfig round-trips the file just written, run/custom intact", async () => {
    const loaded = await loadAuroraConfig(root);
    expect(loaded.error).toBeNull();
    expect(loaded.config).toEqual(migrated);
  });

  it("4. createPrelude is setup-ONLY — with no scripts.setup configured, prelude is undefined (no auto-install anymore)", async () => {
    const loaded = await loadAuroraConfig(root);
    const setup = commandSpecToShell(loaded.config!.scripts.setup);
    expect(setup).toBeNull(); // migration never populates setup
    expect(createPrelude(setup)).toBeUndefined();
  });

  it("5. the migrated onEnter server command NEVER leaks into the create-time prelude (anti-regression, end to end)", async () => {
    const loaded = await loadAuroraConfig(root);
    const setup = commandSpecToShell(loaded.config!.scripts.setup);
    const prelude = createPrelude(setup);
    // Must not be the migrated server command — createPrelude has no fallback
    // to installCommand/run entries anymore, so this can ONLY ever reflect
    // scripts.setup, which migration never populates.
    expect(prelude).toBeUndefined();
  });

  it("6. once the user explicitly configures scripts.setup, createPrelude runs EXACTLY that — real file round-trip", async () => {
    const withSetup: AuroraConfig = {
      ...migrated,
      scripts: { ...migrated.scripts, setup: "pnpm install" },
    };
    await saveAuroraConfig(root, withSetup);
    const loaded = await loadAuroraConfig(root);
    expect(loaded.error).toBeNull();
    const setup = commandSpecToShell(loaded.config!.scripts.setup);
    expect(setup).toBe("pnpm install");
    expect(createPrelude(setup)).toBe("pnpm install");
  });

  it("7. writeTextFile's real contract: a relative path REJECTS, the absolute in-root path resolves", async () => {
    await expect(writeTextFile(root, "aurora.json", "x")).rejects.toThrow();
    await expect(writeTextFile(root, join(root, "aurora.json"), "x")).resolves.toBeUndefined();
  });
});
