use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// The single active folder watch; `watch_dir` replaces it, `unwatch_dir` drops it.
#[derive(Default)]
pub struct WatchState(Mutex<Option<Debouncer<RecommendedWatcher>>>);

/// Forward-slash form of a path, as the TS side expects.
fn to_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Paths we never report: dependency/VCS folders and our own atomic-write temp files.
pub fn is_ignored(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.contains("/node_modules/") || p.contains("/.git/") || p.ends_with(".paratrans-tmp")
}

/// Build-output folders (as path segments below the watched root) that are never locale files.
const IGNORED_SEGMENTS: [&str; 4] = [".next", "dist", "build", "target"];

/// `is_ignored`, plus build-output folders. Segments are checked relative to `root`, so a project
/// that itself lives under e.g. `~/build/` is still watched.
pub fn is_ignored_under(root: &str, path: &str) -> bool {
    if is_ignored(path) {
        return true;
    }
    let root = root.replace('\\', "/");
    let root = root.trim_end_matches('/');
    let p = path.replace('\\', "/");
    let rel = p.strip_prefix(root).unwrap_or(&p);
    rel.split('/').any(|seg| IGNORED_SEGMENTS.contains(&seg))
}

#[tauri::command]
pub fn watch_dir(app: AppHandle, state: State<'_, WatchState>, root: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // stop the previous watch first
    let watched = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<String> = events
            .iter()
            .map(|e| to_slash(&e.path))
            .filter(|p| !is_ignored_under(&watched, p))
            .collect();
        paths.sort();
        paths.dedup();
        if !paths.is_empty() {
            let _ = app.emit("fs-changed", paths);
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *guard = Some(debouncer);
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, WatchState>) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_ignored, is_ignored_under};

    #[test]
    fn ignores_node_modules_git_and_temp_files() {
        assert!(is_ignored("/p/node_modules/x/en.json"));
        assert!(is_ignored("/p/.git/index"));
        assert!(is_ignored("C:\\p\\.git\\HEAD"));
        assert!(is_ignored("/p/public/locales/en/common.json.paratrans-tmp"));
        assert!(!is_ignored("/p/public/locales/en/common.json"));
        assert!(!is_ignored("/p/.gitignore"));
        assert!(!is_ignored("/p/my_node_modules_notes/en.json"));
        assert!(!is_ignored("/p/.paratrans/state.json"));
    }

    #[test]
    fn ignores_build_output_segments_relative_to_root() {
        assert!(is_ignored_under("/p", "/p/.next/cache/a.json"));
        assert!(is_ignored_under("/p", "/p/dist/en.json"));
        assert!(is_ignored_under("/p", "/p/build/x"));
        assert!(is_ignored_under("/p", "/p/src-tauri/target/debug/x.json"));
        assert!(is_ignored_under("C:\\p", "C:\\p\\target\\x"));
        assert!(!is_ignored_under("/p", "/p/public/locales/en/build.json"));
        assert!(!is_ignored_under("/p", "/p/distance/en.json"));
        // the project itself may live under a folder named build/dist/target
        assert!(!is_ignored_under("/home/me/build/p", "/home/me/build/p/public/locales/en/common.json"));
        assert!(is_ignored_under("/p", "/p/node_modules/x/en.json"));
        assert!(is_ignored_under("/p", "/p/public/locales/en/common.json.paratrans-tmp"));
    }
}
