// Bridges to the Rust filesystem/git helpers.

import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export function homeDir(): Promise<string> {
  return invoke("home_dir");
}

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path }).catch(() => []);
}

export function gitBranch(cwd: string): Promise<string | null> {
  return invoke<string | null>("git_branch", { cwd }).catch(() => null);
}

export function gitRoot(cwd: string): Promise<string | null> {
  return invoke<string | null>("git_root", { cwd }).catch(() => null);
}

/** Collapse `$HOME` to `~` for display. */
export function shortenCwd(cwd: string, home: string): string {
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

/** Optimistically resolve a `cd <arg>` target to an absolute path. */
export function resolveCd(cwd: string, arg: string | undefined, home: string): string {
  if (!arg || arg === "~") return home;
  if (arg.startsWith("~/")) return home + arg.slice(1);
  if (arg === "~") return home;
  if (arg.startsWith("/")) return arg.replace(/\/+$/, "") || "/";
  const base = cwd.split("/").filter(Boolean);
  for (const seg of arg.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return "/" + base.join("/");
}
