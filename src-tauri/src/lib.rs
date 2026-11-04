mod fs_cmds;
mod mt;
mod watch;
mod zip_cmds;

use std::sync::Arc;

use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Window state remembered across launches. Not VISIBLE: the window must always open visible.
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        .manage(watch::WatchState::default())
        .manage(mt::download::Downloads::default())
        .manage(Arc::new(mt::engine::Engine::default()))
        .setup(|app| {
            use tauri::Manager;
            let engine = app.state::<Arc<mt::engine::Engine>>().inner().clone();
            mt::engine::unload_at_exit(engine.clone());
            mt::engine::spawn_idle_unloader(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_cmds::read_text,
            fs_cmds::write_text_atomic,
            fs_cmds::path_exists,
            fs_cmds::list_files,
            fs_cmds::remove_path,
            fs_cmds::mkdirp,
            watch::watch_dir,
            watch::unwatch_dir,
            zip_cmds::zip_write,
            zip_cmds::zip_read,
            mt::download::mt_models_dir,
            mt::download::mt_models_status,
            mt::download::mt_download_start,
            mt::download::mt_download_pause,
            mt::download::mt_download_cancel,
            mt::download::mt_model_delete,
            mt::engine::mt_generate,
            mt::engine::mt_cancel,
            mt::engine::mt_unload
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Also covers quitting through the unsaved-changes prompt, which destroys the window.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let _ = app.save_window_state(WINDOW_STATE_FLAGS);
            }
        });
}

#[cfg(test)]
mod tests {
    /// The data folder (prefs, models, window state, recovery) is named after the identifier
    /// alone, never the version: changing it would orphan every user's settings.
    #[test]
    fn app_identifier_never_changes() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], "com.retrans.app");
    }

    #[test]
    fn window_state_flags_cover_size_position_maximized() {
        use tauri_plugin_window_state::StateFlags;
        assert_eq!(
            super::WINDOW_STATE_FLAGS.bits(),
            (StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED).bits()
        );
    }
}
