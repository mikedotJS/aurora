mod claude;
mod glab;
mod pty;
mod sys;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            sys::list_dir,
            sys::git_branch,
            sys::git_root,
            sys::home_dir,
            claude::key_set,
            claude::key_get,
            claude::key_present,
            claude::key_delete,
            claude::claude_suggest,
            glab::glab_mr_list,
            glab::glab_current_user,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
