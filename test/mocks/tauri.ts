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
};

let handlers: Record<string, InvokeHandler> = {};
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

export const tauri = {
  /** When true, unmocked invoke() commands log a warning (test authoring aid). */
  warnUnmocked: false,
  /** Register per-test invoke handlers (merged over defaults). */
  invoke(map: Record<string, InvokeHandler>) {
    handlers = { ...handlers, ...map };
  },
  /** Reset all per-test state — call in beforeEach. */
  reset() {
    handlers = {};
    calls.length = 0;
    listeners.clear();
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
  return "";
}
export async function writeText(_t: string) {}

// plugin-opener
export async function openUrl(_u: string) {}
export async function openPath(_p: string) {}
export async function revealItemInDir(_p: string) {}

// plugin-updater
export async function check() {
  return null;
}

// plugin-process
export async function relaunch() {}
export async function exit(_code?: number) {}

// plugin-dialog
export async function open(_o?: unknown) {
  return null;
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
