// Natural-language → shell command via the Rust `claude_suggest` command.

import { invoke } from "@tauri-apps/api/core";

export interface Suggestion {
  command: string;
  note: string;
  /** Set in the UI layer when the card should route to key entry rather than run. */
  needsKey?: boolean;
}

export class NoKeyError extends Error {
  constructor() {
    super("no-key");
    this.name = "NoKeyError";
  }
}

/**
 * Ask Claude to translate `prompt` into a command. Throws {@link NoKeyError}
 * when no API key is stored, or a plain Error with the backend message
 * otherwise.
 */
export async function claudeSuggest(
  prompt: string,
  cwd: string,
  model: string,
): Promise<Suggestion> {
  try {
    return await invoke<Suggestion>("claude_suggest", { prompt, cwd, model });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("no-key")) throw new NoKeyError();
    throw new Error(msg, { cause: e });
  }
}
