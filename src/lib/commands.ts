// Command knowledge for the smart prompt: known commands, typo corrections,
// ghost autocomplete, and the heuristic that decides when a line is natural
// language worth sending to Claude. Ported/extended from the Aurora mockup.

export const KNOWN_COMMANDS = [
  "ls", "pwd", "cd", "cat", "echo", "clear", "cls", "help", "git", "npm", "pnpm",
  "bun", "yarn", "code", "rm", "mkdir", "rmdir", "whoami", "date", "rg", "grep",
  "find", "du", "df", "open", "touch", "export", "claude", "glab", "gh", "cargo",
  "bundle", "make", "python", "python3", "node", "deno", "vim", "nano", "less",
  "more", "top", "htop", "ssh", "curl", "wget", "tar", "zip", "unzip", "mv", "cp",
  "kill", "ps", "which", "man", "history", "source", "sudo", "brew", "docker",
];

const TYPO_FIX: Record<string, string> = {
  gti: "git",
  got: "git",
  gs: "git status",
  sl: "ls",
  claer: "clear",
  clera: "clear",
  nmp: "npm",
  pdw: "pwd",
  pwdd: "pwd",
  "cd..": "cd ..",
  cluade: "claude",
  clade: "claude",
};

/** A typo correction for a bare command word, or `null` if none. */
export function typoFix(word: string): string | null {
  return TYPO_FIX[word] ?? null;
}

// Full-screen / interactive programs that own the terminal. Some (vim, less)
// use the alternate screen and are detected automatically; others (claude,
// REPLs) don't, so we proactively hand the pane to them.
const INTERACTIVE = new Set([
  "claude", "vim", "vi", "nvim", "nano", "emacs", "top", "htop", "btop", "less", "more",
  "man", "ssh", "tmux", "screen", "lazygit", "lazydocker", "fzf", "irb", "ipython", "ipython3",
]);
const REPL = new Set(["python", "python3", "node", "bun", "deno", "psql", "mysql", "redis-cli", "sqlite3", "mongosh", "ruby"]);

// Tools whose given subcommand opens an inline arrow-key / survey prompt WITHOUT
// switching to the alternate screen (so it can't be auto-detected from output) —
// we hand the pane over up front. e.g. `glab auth login`, `gh auth`, `npm init`.
const INTERACTIVE_SUB: Record<string, string[]> = {
  glab: ["auth"], gh: ["auth"],
  npm: ["login", "adduser", "init", "create"], pnpm: ["login", "create"],
  yarn: ["login", "create"], bun: ["create"], npx: ["create"],
  docker: ["login"], gcloud: ["init", "auth"], aws: ["configure", "sso"],
  heroku: ["login"], vercel: ["login"], netlify: ["login"], firebase: ["login"],
  wrangler: ["login"], supabase: ["login"], railway: ["login"],
  fly: ["auth"], flyctl: ["auth"], doctl: ["auth"], op: ["signin"], eas: ["login"],
};

/** Whether running this command should hand the pane over for raw interaction. */
export function isInteractive(command: string): boolean {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const c = parts[0];
  if (!c) return false;
  if (INTERACTIVE.has(c)) return true;
  if (REPL.has(c) && parts.length === 1) return true; // a bare REPL, not `python script.py`
  // tool + interactive subcommand (`glab auth login`, `gh auth`, `npm init`, …)
  const subs = INTERACTIVE_SUB[c];
  if (subs && parts[1] && subs.includes(parts[1])) {
    // `npm init -y` / `--yes` is non-interactive
    if (c === "npm" && parts[1] === "init" && parts.some((p) => p === "-y" || p === "--yes")) return false;
    return true;
  }
  // inline-interactive git porcelain: `git add -p`, `git rebase -i`, `git add -i`
  if (c === "git" && (parts.includes("-p") || parts.includes("--patch") || parts.includes("-i") || parts.includes("--interactive"))) {
    return true;
  }
  return false;
}

const SUBCOMMANDS: Record<string, string[]> = {
  git: ["status", "add", "commit", "checkout", "push", "pull", "log", "diff",
        "reset", "restore", "branch", "stash", "fetch", "merge", "rebase"],
  glab: ["mr", "ci", "issue", "repo", "auth"],
  mr: ["list", "view", "create", "merge"],
  claude: ["auth", "status", "logout", "login"],
  npm: ["run dev", "install", "run build", "test", "ci", "start"],
  bun: ["install", "run dev", "run build", "test", "add"],
  cargo: ["run", "build", "test", "check", "fmt", "clippy"],
};

const FIRST_WORD_CANDIDATES = [
  "ls", "pwd", "cd ", "cat ", "clear", "echo ", "help", "git ", "npm ", "bun ",
  "glab ", "claude ", "code ", "rm ", "mkdir ", "whoami", "date", "rg ", "du ",
  "cargo ", "open ", "touch ",
];

export interface GhostContext {
  dirNames: string[];
  history: string[];
}

/** Inline completion suffix for the current input, or `""`. */
export function ghostFor(input: string, ctx: GhostContext): string {
  if (!input || /\s$/.test(input)) return "";
  const parts = input.split(" ");

  if (parts.length === 1) {
    for (const c of FIRST_WORD_CANDIDATES) {
      if (c.startsWith(input) && c !== input) return c.slice(input.length);
    }
    return historyGhost(input, ctx.history);
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  let candidates: string[] = [];
  if (SUBCOMMANDS[first]) candidates = SUBCOMMANDS[first];
  else if (["cd", "cat", "code", "rm", "open", "touch", "ls", "mv", "cp"].includes(first)) {
    candidates = ctx.dirNames;
  }
  if (last) {
    for (const c of candidates) {
      if (c.startsWith(last) && c !== last) return c.slice(last.length);
    }
  }
  return historyGhost(input, ctx.history);
}

function historyGhost(input: string, history: string[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.startsWith(input) && h !== input) return h.slice(input.length);
  }
  return "";
}

/**
 * Decide whether a line looks like natural language (so we should ask Claude)
 * rather than a real command. Mirrors the mockup's gate: a known command or a
 * known typo is never NL; single tokens are never NL.
 */
export function looksLikeNaturalLanguage(input: string): boolean {
  const t = input.trim();
  if (!t) return false;
  const tokens = t.toLowerCase().split(/\s+/);
  if (KNOWN_COMMANDS.includes(tokens[0])) return false;
  if (typoFix(tokens[0]) !== null) return false;
  if (t.startsWith("./") || t.startsWith("/") || t.startsWith("~")) return false;
  if (tokens.length < 2) return false;
  return true;
}
