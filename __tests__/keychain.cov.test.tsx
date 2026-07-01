// Coverage suite for src/lib/keychain.ts — thin invoke() wrappers over the
// Rust keychain commands, plus the pure maskKey helper.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { keySet, keyPresent, keyDelete, aiKeySet, aiKeyDelete, maskKey } from "../src/lib/keychain";

beforeEach(() => {
  tauri.reset();
});

describe("keySet", () => {
  it("invokes key_set with the key arg", async () => {
    tauri.invoke({ key_set: () => undefined });
    await keySet("sk-ant-abc123");
    const call = tauri.lastCall("key_set");
    expect(call?.args).toEqual({ key: "sk-ant-abc123" });
  });
});

describe("keyPresent", () => {
  it("resolves true when the backend reports a stored key", async () => {
    tauri.invoke({ key_present: () => true });
    expect(await keyPresent()).toBe(true);
  });
  it("resolves false when no key is stored", async () => {
    tauri.invoke({ key_present: () => false });
    expect(await keyPresent()).toBe(false);
  });
});

describe("keyDelete", () => {
  it("invokes key_delete", async () => {
    tauri.invoke({ key_delete: () => undefined });
    await keyDelete();
    expect(tauri.lastCall("key_delete")).toBeDefined();
  });
});

describe("aiKeySet", () => {
  it("invokes ai_key_set with id + key", async () => {
    tauri.invoke({ ai_key_set: () => undefined });
    await aiKeySet("acct-1", "sk-xyz");
    expect(tauri.lastCall("ai_key_set")?.args).toEqual({ id: "acct-1", key: "sk-xyz" });
  });
});

describe("aiKeyDelete", () => {
  it("invokes ai_key_delete with id and resolves on success", async () => {
    tauri.invoke({ ai_key_delete: () => undefined });
    await expect(aiKeyDelete("acct-1")).resolves.toBeUndefined();
    expect(tauri.lastCall("ai_key_delete")?.args).toEqual({ id: "acct-1" });
  });

  it("swallows a backend rejection (catch -> undefined)", async () => {
    tauri.invoke({
      ai_key_delete: () => {
        throw new Error("keychain locked");
      },
    });
    await expect(aiKeyDelete("acct-2")).resolves.toBeUndefined();
  });
});

describe("maskKey", () => {
  it("returns empty string for an empty key", () => {
    expect(maskKey("")).toBe("");
  });
  it("masks the middle of a normal key, keeping first 7 and last 4 chars", () => {
    const key = "sk-ant-api03-abcdefgh1a2b";
    expect(maskKey(key)).toBe(`${key.slice(0, 7)}…${key.slice(-4)}`);
    expect(maskKey(key)).toBe("sk-ant-…1a2b");
  });
  it("handles a short key (slices still apply, may overlap)", () => {
    const key = "short";
    expect(maskKey(key)).toBe(`${key.slice(0, 7)}…${key.slice(-4)}`);
  });
});
