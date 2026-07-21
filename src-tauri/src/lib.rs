mod claude;
mod git;
mod glab;
mod jira;
mod pty;
mod repoconfig;
mod server;
mod sys;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dev-only: pull `ANTHROPIC_API_KEY` from a gitignored `.env` so `tauri dev`
    // reads the key from there instead of the OS keychain (avoids the repeated
    // keychain-access prompt caused by the ad-hoc-signed debug binary).
    #[cfg(debug_assertions)]
    claude::load_dotenv();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Embedded WebDriver server for e2e (WebdriverIO @wdio/tauri-service) — only
    // compiled in when the `e2e` cargo feature is enabled (see Cargo.toml), so
    // neither the axum/wdio code nor its capability ships in a release build.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    let app = builder
        .manage(pty::PtyManager::default())
        .manage(server::ServerManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_capture_server_pgid,
            pty::pty_server_status,
            pty::pty_foreground_state,
            pty::pty_signal_server,
            server::server_spawn,
            server::server_status,
            server::server_stop,
            server::server_probe,
            sys::list_dir,
            sys::read_text_file,
            sys::write_text_file,
            sys::git_branch,
            sys::git_branches,
            sys::git_switch,
            sys::git_root,
            sys::home_dir,
            sys::path_resolve,
            git::git_repo_info,
            git::worktree_list,
            git::worktree_add,
            git::worktree_remove,
            git::git_status_summary,
            git::git_changed_files,
            git::git_diff_file,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_discard,
            git::git_worktree_safety,
            claude::key_set,
            claude::key_get,
            claude::key_present,
            claude::key_delete,
            claude::ai_key_set,
            claude::ai_key_present,
            claude::ai_key_delete,
            claude::claude_suggest,
            claude::claude_text,
            repoconfig::read_package_field,
            repoconfig::detect_branch_validator,
            repoconfig::validate_branch_name,
            glab::glab_mr_list,
            glab::glab_current_user,
            glab::glab_mr_create,
            glab::glab_mr_note_author,
            jira::jira_set_token,
            jira::jira_token_present,
            jira::jira_clear_token,
            jira::jira_migrate_token,
            jira::jira_validate,
            jira::jira_project_statuses,
            jira::jira_search,
            jira::jira_issue,
            jira::jira_transition,
            jira::jira_add_remote_link,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // `ExitRequested` fires on the last window close (user can cancel via api.prevent_exit).
    // `Exit` fires unconditionally when the process is about to terminate (e.g. ⌘Q).
    // Both are handled so kill_all() is called regardless of which event Tauri emits.
    // kill_all() is idempotent: killpg on an already-dead group returns ESRCH (no-op).
    app.run(|handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                handle.state::<pty::PtyManager>().kill_all();
                handle.state::<server::ServerManager>().kill_all();
            }
            _ => {}
        }
    });
}
