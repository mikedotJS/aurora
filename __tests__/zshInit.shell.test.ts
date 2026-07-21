// Real-zsh test for Aurora's ZSH_INIT shell-integration line.
//
// This one deliberately drives a REAL zsh instead of asserting on the string: the bug it guards is
// a property of *when* zsh's `precmd`/`preexec` hooks fire relative to the line that installs
// them, which no string assertion or mocked terminal can observe.
//
// The failure it locks down: `ZSH_INIT` used to make zsh emit a `133;D` (command-end) with no
// matching `133;C` (command-start). Terminal.tsx ends the pane's current block on any `133;D`, and
// store.appendOutput drops output once a block stops running — so that stray `D` closed the Setup
// Script's block on workspace create and silently discarded all of `pnpm install`'s output while
// pnpm kept running.
//
// `-f` skips the developer's rc files, so the markers depend only on the init line under test.

import { describe, expect, test } from "bun:test";
import { ZSH_INIT } from "../src/term/zshInit";

/** The pre-fix ZSH_INIT, kept as a control so this harness is provably able to catch the bug. */
const LEGACY_ZSH_INIT =
  "PROMPT='' RPROMPT='' PROMPT_EOL_MARK=''; " +
  "_aurora_pe(){ printf '\\e]133;C\\a'; }; " +
  "_aurora_pc(){ local e=$?; printf '\\e]133;D;%s\\a' \"$e\"; " +
  "printf '\\e]7;file://%s%s\\a' \"${HOST:-localhost}\" \"$PWD\"; }; " +
  "autoload -Uz add-zsh-hook 2>/dev/null && { add-zsh-hook preexec _aurora_pe; add-zsh-hook precmd _aurora_pc; }; " +
  "printf '\\e]7;file://%s%s\\a' \"${HOST:-localhost}\" \"$PWD\"; printf '\\e]1337;AuroraReady\\a'; clear\n";

/**
 * Run `init` in a real interactive zsh, then `command`, and return the OSC 133 markers in emission
 * order — `"C"` for a command-start, `"D:<exit>"` for a command-end.
 */
async function markers(init: string, command = "echo aurora-probe"): Promise<string[]> {
  const proc = Bun.spawn(["zsh", "-i", "-f"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.stdin.write(init);
  proc.stdin.write(`${command}\n`);
  proc.stdin.write("exit\n");
  await proc.stdin.end();

  const out = await new Response(proc.stdout).text();
  await proc.exited;

  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]133;(C|D);?(\d*)/g;
  const found: string[] = [];
  for (let m = re.exec(out); m; m = re.exec(out)) found.push(m[1] === "C" ? "C" : `D:${m[2]}`);
  return found;
}

describe("ZSH_INIT / OSC 133 shell integration (real zsh)", () => {
  test("control: the pre-fix init emits a command-end before any command-start", async () => {
    const found = await markers(LEGACY_ZSH_INIT);
    expect(found.length).toBeGreaterThan(0);
    // The bug: the init line installs `precmd` mid-line, so it fires for the init line itself
    // while `preexec` never did — an unpaired `D` lands before the first real command starts.
    expect(found[0]).toMatch(/^D:/);
  }, 20_000);

  test("never emits a command-end (133;D) before the first command-start (133;C)", async () => {
    const found = await markers(ZSH_INIT);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toBe("C");
    expect(found).toContain("D:0");
  }, 20_000);

  test("still reports a command's real exit code on its command-end marker", async () => {
    const found = await markers(ZSH_INIT, "(exit 7)");
    expect(found[0]).toBe("C");
    expect(found).toContain("D:7");
  }, 20_000);

  test("still ends the block for a command that never starts one (empty line)", async () => {
    // An empty line runs no command, so `preexec` never fires — but `precmd` still does, and
    // Terminal.tsx needs that `D` to close the block it optimistically opened. This is why the fix
    // suppresses exactly the init line's `D` rather than filtering unpaired `D`s on the front end.
    const found = await markers(ZSH_INIT, "");
    expect(found[0]).toBe("D:0");
  }, 20_000);
});
