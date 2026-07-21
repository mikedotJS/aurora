// Configurable Tauri mock shared by all tests. The setup preload wires these
// implementations into the real module specifiers via mock.module(); tests
// import { tauri } from here to steer invoke results / emit events per-test.

type InvokeHandler = (args: Record<string, unknown>) => unknown;

// Sensible defaults so a component effect calling invoke() never explodes even
// if a test didn't stub that specific command. Tests override via tauri.invoke().
const DEFAULTS: Record<string, InvokeHandler> = {
  home_dir: () => "/Users/test",
  path_resolve: (a) => (a.path as string) ?? "/",
  list_dir: () => [],
  read_text_file: () => "",
  read_package_field: () => null,
  // git
  git_repo_info: () => null,
  git_root: () => null,
  git_status_summary: () => null,
  git_branch: () => null,
  git_branches: () => [],
  git_changed_files: () => [],
  git_diff_file: () => "",
  git_stage: () => undefined,
  git_stage_all: () => undefined,
  git_unstage: () => undefined,
  git_discard: () => undefined,
  git_switch: () => undefined,
  // keychain / keys
  key_present: () => false,
  key_set: () => undefined,
  key_delete: () => undefined,
  ai_key_set: () => undefined,
  ai_key_delete: () => undefined,
  // jira
  jira_token_present: () => false,
  jira_set_token: () => undefined,
  jira_clear_token: () => undefined,
  jira_migrate_token: () => undefined,
  jira_validate: () => false,
  jira_issue: () => null,
  jira_search: () => [],
  jira_project_statuses: () => [],
  jira_transition: () => undefined,
  jira_add_remote_link: () => undefined,
  // gitlab
  glab_current_user: () => null,
  glab_mr_list: () => [],
  glab_mr_create: () => "",
  // claude / ai
  claude_suggest: () => "",
  claude_text: () => "",
  // branch naming
  detect_branch_validator: () => null,
  validate_branch_name: () => ({ valid: true }),
  // worktree
  worktree_add: () => undefined,
  worktree_list: () => [],
  worktree_remove: () => undefined,
  // pty
  pty_spawn: () => "pty-test-1",
  pty_write: () => undefined,
  pty_resize: () => undefined,
  pty_kill: () => undefined,
  pty_server_status: () => "unknown",
  pty_capture_server_pgid: () => undefined,
  pty_foreground_state: () => ({ running: false, pgid: null }),
  pty_signal_server: () => false,
  // managed-server-lifecycle
  write_text_file: () => undefined,
  server_spawn: () => ({ pid: 1, pgid: 1, ptyId: "srv-test" }),
  server_status: () => ({ state: "running" }),
  server_stop: () => undefined,
  server_probe: () => [],
};

let handlers: Record<string, InvokeHandler> = {};
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

// Direct (non-invoke) plugin exports that a handful of suites need to steer
// per-test — e.g. plugin-dialog's open() result, plugin-updater's check(),
// plugin-process's relaunch(), plugin-clipboard-manager's readText()/writeText().
// These default to the same fixed behavior the preload always had; tests that
// need a specific value/throw call the matching tauri.setX() instead of
// re-registering their own mock.module() (which would leak process-wide).
let overrides: {
  open?: (opts?: unknown) => unknown;
  check?: () => unknown;
  relaunch?: () => unknown;
  readText?: () => unknown;
  writeText?: (text: string) => unknown;
} = {};

export const tauri = {
  /** When true, unmocked invoke() commands log a warning (test authoring aid). */
  warnUnmocked: false,
  /** Register per-test invoke handlers (merged over defaults). */
  invoke(map: Record<string, InvokeHandler>) {
    handlers = { ...handlers, ...map };
  },
  /** Override @tauri-apps/plugin-dialog's open() (folder/file picker). */
  setOpen(fn: (opts?: unknown) => unknown) {
    overrides.open = fn;
  },
  /** Override @tauri-apps/plugin-updater's check(). */
  setCheck(fn: () => unknown) {
    overrides.check = fn;
  },
  /** Override @tauri-apps/plugin-process's relaunch(). */
  setRelaunch(fn: () => unknown) {
    overrides.relaunch = fn;
  },
  /** Override @tauri-apps/plugin-clipboard-manager's readText(). */
  setReadText(fn: () => unknown) {
    overrides.readText = fn;
  },
  /** Override @tauri-apps/plugin-clipboard-manager's writeText(text). */
  setWriteText(fn: (text: string) => unknown) {
    overrides.writeText = fn;
  },
  /** Reset all per-test state — call in beforeEach. */
  reset() {
    handlers = {};
    calls.length = 0;
    listeners.clear();
    overrides = {};
  },
  /** Inspect what the code invoked. */
  calls: () => calls.slice(),
  lastCall: (cmd?: string) =>
    [...calls].reverse().find((c) => !cmd || c.cmd === cmd),
  /** Push a Tauri event to code that called listen(name, cb). */
  emit(name: string, payload: unknown) {
    listeners.get(name)?.forEach((cb) => cb({ payload }));
  },
};

// ---- The mocked module implementations ----

export async function invoke(cmd: string, args: Record<string, unknown> = {}) {
  calls.push({ cmd, args });
  const h = handlers[cmd] ?? DEFAULTS[cmd];
  if (!h) {
    // Unknown command: undefined, but make it visible during test authoring.
    if (tauri.warnUnmocked) console.warn(`[tauriMock] unmocked invoke("${cmd}")`);
    return undefined;
  }
  return h(args);
}

export async function listen(name: string, cb: (e: { payload: unknown }) => void) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(cb);
  return () => listeners.get(name)?.delete(cb);
}

export function getCurrentWindow() {
  return {
    close: async () => {},
    minimize: async () => {},
    setFullscreen: async (_v: boolean) => {},
    isFullscreen: async () => false,
    toggleMaximize: async () => {},
    listen: async () => () => {},
    onResized: async () => () => {},
    setFocus: async () => {},
  };
}

// plugin-clipboard-manager
export async function readText() {
  return overrides.readText ? overrides.readText() : "";
}
export async function writeText(t: string) {
  if (overrides.writeText) await overrides.writeText(t);
}

// plugin-opener
export async function openUrl(_u: string) {}
export async function openPath(_p: string) {}
export async function revealItemInDir(_p: string) {}

// plugin-updater
export async function check() {
  return overrides.check ? overrides.check() : null;
}

// plugin-process
export async function relaunch() {
  if (overrides.relaunch) await overrides.relaunch();
}
export async function exit(_code?: number) {}

// plugin-dialog
export async function open(o?: unknown) {
  return overrides.open ? overrides.open(o) : null;
}
export async function save(_o?: unknown) {
  return null;
}
export async function ask(_m: string) {
  return true;
}
export async function confirm(_m: string) {
  return true;
}
export async function message(_m: string) {}
