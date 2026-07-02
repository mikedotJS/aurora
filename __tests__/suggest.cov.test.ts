// Line-coverage suite for src/ai/suggest.ts — NL → shell command bridge to the
// Rust claude_suggest / claude_text commands.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { claudeSuggest, claudeText, NoKeyError, type Suggestion } from "../src/ai/suggest";

beforeEach(() => {
  tauri.reset();
});

describe("claudeSuggest", () => {
  it("returns the parsed suggestion on success", async () => {
    const sugg: Suggestion = { command: "ls -la", note: "list files" };
    tauri.invoke({ claude_suggest: () => sugg });
    const r = await claudeSuggest("list files", "/repo", "claude-sonnet-4-6");
    expect(r).toEqual(sugg);
    expect(tauri.lastCall("claude_suggest")?.args).toEqual({
      prompt: "list files",
      cwd: "/repo",
      model: "claude-sonnet-4-6",
    });
  });

  it("forwards an optional context string to claude_suggest", async () => {
    const sugg: Suggestion = { command: "pnpm build", note: "build it" };
    tauri.invoke({ claude_suggest: () => sugg });
    const r = await claudeSuggest("build it", "/repo", "claude-sonnet-4-6", "Toolchain: package manager: pnpm");
    expect(r).toEqual(sugg);
    expect(tauri.lastCall("claude_suggest")?.args).toEqual({
      prompt: "build it",
      cwd: "/repo",
      model: "claude-sonnet-4-6",
      context: "Toolchain: package manager: pnpm",
    });
  });

  it("omits context (undefined) when the caller doesn't pass one", async () => {
    tauri.invoke({ claude_suggest: () => ({ command: "ls", note: "ok" }) });
    await claudeSuggest("list files", "/repo", "m");
    expect(tauri.lastCall("claude_suggest")?.args.context).toBeUndefined();
  });

  it("throws NoKeyError when the backend reports no-key", async () => {
    tauri.invoke({
      claude_suggest: () => {
        throw new Error("no-key");
      },
    });
    await expect(claudeSuggest("list files", "/repo", "m")).rejects.toBeInstanceOf(NoKeyError);
  });

  it("throws a plain Error with the backend message otherwise", async () => {
    tauri.invoke({
      claude_suggest: () => {
        throw new Error("rate limited");
      },
    });
    try {
      await claudeSuggest("list files", "/repo", "m");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(NoKeyError);
      expect(String(e)).toContain("rate limited");
    }
  });
});

describe("claudeText", () => {
  it("returns the raw assistant text on success", async () => {
    tauri.invoke({ claude_text: () => "feat/my-branch" });
    const r = await claudeText("system prompt", "user msg", "claude-sonnet-4-6", 50);
    expect(r).toBe("feat/my-branch");
    expect(tauri.lastCall("claude_text")?.args).toEqual({
      system: "system prompt",
      prompt: "user msg",
      model: "claude-sonnet-4-6",
      maxTokens: 50,
    });
  });

  it("works without maxTokens (optional arg)", async () => {
    tauri.invoke({ claude_text: () => "ok" });
    const r = await claudeText("sys", "msg", "m");
    expect(r).toBe("ok");
    expect(tauri.lastCall("claude_text")?.args.maxTokens).toBeUndefined();
  });

  it("throws NoKeyError when the backend reports no-key", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("no-key");
      },
    });
    await expect(claudeText("sys", "msg", "m")).rejects.toBeInstanceOf(NoKeyError);
  });

  it("throws a plain Error with the backend message otherwise", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("server error");
      },
    });
    try {
      await claudeText("sys", "msg", "m");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(NoKeyError);
      expect(String(e)).toContain("server error");
    }
  });
});

describe("NoKeyError", () => {
  it("carries the 'no-key' message and name", () => {
    const e = new NoKeyError();
    expect(e.message).toBe("no-key");
    expect(e.name).toBe("NoKeyError");
    expect(e).toBeInstanceOf(Error);
  });
});
