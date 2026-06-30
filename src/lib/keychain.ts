// Thin wrappers over the Rust keychain commands. The key itself never lives in
// JS state beyond the brief moment of entry — we only track presence.

import { invoke } from "@tauri-apps/api/core";

export function keySet(key: string): Promise<void> {
  return invoke("key_set", { key });
}

export function keyPresent(): Promise<boolean> {
  return invoke("key_present");
}

export function keyDelete(): Promise<void> {
  return invoke("key_delete");
}

// ---- additional AI accounts (keyed by account id) ----
export function aiKeySet(id: string, key: string): Promise<void> {
  return invoke("ai_key_set", { id, key });
}
export function aiKeyDelete(id: string): Promise<void> {
  return invoke<void>("ai_key_delete", { id }).catch(() => undefined);
}

/** Masked preview, e.g. `sk-ant-…1a2b`. */
export function maskKey(key: string): string {
  if (!key) return "";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
