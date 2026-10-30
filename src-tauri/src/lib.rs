mod fs_cmds;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(watch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            fs_cmds::read_text,
            fs_cmds::write_text_atomic,
            fs_cmds::path_exists,
            fs_cmds::list_files,
            fs_cmds::remove_path,
            fs_cmds::mkdirp,
            watch::watch_dir,
            watch::unwatch_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
