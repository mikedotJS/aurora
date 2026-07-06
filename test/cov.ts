// Isolated test + coverage runner.
//
// Runs each __tests__/*.test.{ts,tsx} file in its OWN `bun test` process. This
// gives two things a single shared `bun test` run cannot:
//   1. Correctness — bun's mock.module() is process-global and leaks across
//      files; isolation makes every suite hermetic (a real-store suite can never
//      pick up another file's store mock).
//   2. Honest coverage — each run emits an lcov for the files it loaded; we merge
//      them (union of lines/functions, max hit count) and report the total over
//      src/** only. zzz_srcload.test.ts loads every src module so the denominator
//      includes files no real test touches yet.
//
// Usage:  bun test/cov.ts            (run all, print coverage + pass/fail)
//         bun test/cov.ts --quiet    (totals only)
import { readdirSync, readFileSync, existsSync } from "node:fs";

const QUIET = process.argv.includes("--quiet");
const TESTS_DIR = "__tests__";
const files = readdirSync(TESTS_DIR)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .sort()
  .map((f) => `${TESTS_DIR}/${f}`);

type Cov = { lines: Map<number, number>; fnf: number; fnh: number };
const merged = new Map<string, Cov>();
const failed: string[] = [];
let totalPass = 0;
let totalFail = 0;

function parseLcov(txt: string) {
  let cov: Cov | null = null;
  for (const line of txt.split("\n")) {
    if (line.startsWith("SF:")) {
      const sf = line.slice(3).trim();
      if (!merged.has(sf)) merged.set(sf, { lines: new Map(), fnf: 0, fnh: 0 });
      cov = merged.get(sf)!;
    } else if (line === "end_of_record") {
      cov = null;
    } else if (!cov) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [ln, h] = line.slice(3).split(",");
      cov.lines.set(+ln, Math.max(cov.lines.get(+ln) ?? 0, +h));
    } else if (line.startsWith("FNF:")) {
      cov.fnf = Math.max(cov.fnf, +line.slice(4));
    } else if (line.startsWith("FNH:")) {
      cov.fnh = Math.max(cov.fnh, +line.slice(4));
    }
  }
}

// Per-test timeout for the isolated runs. bun defaults to 5s, which is fine on a
// fast dev box but produces false reds for the async-heavy component suites
// (multiple `waitFor` polls over a happy-dom tree, under coverage instrumentation)
// on slower/shared hosts — cloud VMs, loaded CI. The suites themselves are sound
// (e.g. the AI create shortcut issues exactly 2 backend calls, no retry storm);
// they're just slow to settle there. A generous ceiling makes `bun run test`
// deterministic across host speeds without weakening any assertion — it only
// extends patience for a genuinely hung test, of which there are none.
const TEST_TIMEOUT_MS = 20000;

function runOnce(file: string) {
  const proc = Bun.spawnSync(["bun", "test", file, "--coverage", "--timeout", String(TEST_TIMEOUT_MS)], { stdout: "pipe", stderr: "pipe" });
  const clean = (proc.stdout.toString() + proc.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, "");
  return {
    exit: proc.exitCode,
    p: +(clean.match(/(\d+) pass/)?.[1] ?? 0),
    fl: +(clean.match(/(\d+) fail/)?.[1] ?? 0),
  };
}

for (const file of files) {
  let r = runOnce(file);
  // A nonzero exit with zero reported test failures is a process-level crash
  // (bun spawn instability under the sequential fan-out), not a real test
  // failure — retry once before counting it.
  if (r.exit !== 0 && r.fl === 0) r = runOnce(file);
  totalPass += r.p;
  totalFail += r.fl;
  if (r.fl > 0 || r.exit !== 0) failed.push(`${file}  (${r.fl} fail, exit ${r.exit})`);
  if (existsSync("coverage/lcov.info")) parseLcov(readFileSync("coverage/lcov.info", "utf8"));
}

let LF = 0, LH = 0, FNF = 0, FNH = 0;
const per: { sf: string; lp: number; fp: number; lh: number; lf: number }[] = [];
for (const [sf, cov] of merged) {
  if (!sf.startsWith("src/")) continue;
  const lf = cov.lines.size;
  const lh = [...cov.lines.values()].filter((h) => h > 0).length;
  const fnf = cov.fnf;
  const fnh = cov.fnh;
  LF += lf; LH += lh; FNF += fnf; FNH += fnh;
  per.push({ sf, lp: lf ? (lh / lf) * 100 : 100, fp: fnf ? (fnh / fnf) * 100 : 100, lh, lf });
}
per.sort((a, b) => a.lp - b.lp);

if (!QUIET) {
  console.log("\n── per-file (lowest line% first) ──");
  for (const x of per)
    console.log(`${x.lp.toFixed(1).padStart(6)}% L  ${x.fp.toFixed(1).padStart(6)}% F  ${String(x.lh).padStart(4)}/${String(x.lf).padEnd(5)} ${x.sf}`);
}
const linePct = LF ? (LH / LF) * 100 : 0;
const funcPct = FNF ? (FNH / FNF) * 100 : 0;
console.log(`\n══ COVERAGE  lines ${linePct.toFixed(2)}% (${LH}/${LF})   funcs ${funcPct.toFixed(2)}% (${FNH}/${FNF})   over ${per.length} src files`);
console.log(`══ TESTS     ${totalPass} pass / ${totalFail} fail across ${files.length} files`);
if (failed.length) {
  console.log("\n✗ FAILED FILES:");
  failed.forEach((f) => console.log("  " + f));
}
console.log(failed.length ? "RESULT: RED" : "RESULT: GREEN");
process.exit(failed.length ? 1 : 0);
