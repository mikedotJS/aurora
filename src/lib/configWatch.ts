// Frontend half of the aurora.json file-watch (Rust: src-tauri/src/config_watch.rs).
//
// `ensureAuroraConfigLoaded` caches a repo's aurora.json in the store, so an on-disk edit was
// invisible until relaunch. Here we (1) ask Rust to watch a root's aurora.json the first time we
// load it, and (2) listen for the `aurora:config-changed` event Rust emits on a change, then drop
// the cached entry and re-read — repopulating the store so dependent UI (run menu, scripts editor,
// and the next workspace-create's setup/run/envFiles) reflects the edit with no relaunch.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invalidateAuroraConfig, ensureAuroraConfigLoaded } from "./auroraConfigStore";

/** Roots we've already asked Rust to watch — the invoke is idempotent Rust-side too, but this
 *  avoids firing it on every cache read. */
const watched = new Set<string>();

/** Ask the Rust watcher to start watching `root`'s aurora.json. Idempotent and fire-and-forget: a
 *  watch failure (e.g. the root vanished) must never block config loading. Safe to call outside a
 *  Tauri context (tests) — the invoke is simply a no-op mock there. */
export function requestConfigWatch(root: string | null): void {
  if (!root || watched.has(root)) return;
  watched.add(root);
  void invoke("watch_aurora_config", { root }).catch(() => {
    // Allow a later retry if the first attempt didn't take.
    watched.delete(root);
  });
}

/** Test seam: forget which roots have been watched. */
export function resetConfigWatch(): void {
  watched.clear();
}

/**
 * Apply one config-changed notification: drop the cached config for `root` and re-read it from
 * disk. Exported so the debounce/dedup and the reload are independently testable.
 */
export async function reloadAuroraConfig(root: string): Promise<void> {
  invalidateAuroraConfig(root);
  await ensureAuroraConfigLoaded(root);
}

const DEBOUNCE_MS = 250;

/**
 * Register the single `aurora:config-changed` listener (call once at app start). Coalesces bursts
 * per root — editors write via several syscalls (truncate, write, rename), so Rust may emit a few
 * events for one save — then reloads that root's config. Returns an unlisten fn.
 *
 * `reload` is injectable so tests can drive the debounce without real store IO; it defaults to
 * `reloadAuroraConfig`.
 */
export async function startConfigWatch(
  reload: (root: string) => void | Promise<void> = reloadAuroraConfig,
): Promise<UnlistenFn> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return listen<{ root: string }>("aurora:config-changed", (e) => {
    const root = e.payload.root;
    const existing = timers.get(root);
    if (existing) clearTimeout(existing);
    timers.set(
      root,
      setTimeout(() => {
        timers.delete(root);
        void reload(root);
      }, DEBOUNCE_MS),
    );
  });
}
