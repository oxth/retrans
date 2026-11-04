use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Active folder watches by root path.
#[derive(Default)]
pub struct WatchState(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

#[derive(Clone, Serialize)]
struct FsChangedPayload {
    root: String,
    paths: Vec<String>,
}

/// Forward-slash form of a path, as the TS side expects.
fn to_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Paths we never report: dependency/VCS folders and our own atomic-write temp files.
pub fn is_ignored(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.contains("/node_modules/") || p.contains("/.git/") || p.ends_with(".retrans-tmp")
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

fn insert_watch(
    map: &mut HashMap<String, Debouncer<RecommendedWatcher>>,
    root: String,
    debouncer: Debouncer<RecommendedWatcher>,
) {
    map.insert(root, debouncer);
}

fn remove_watch(map: &mut HashMap<String, Debouncer<RecommendedWatcher>>, root: &str) -> bool {
    map.remove(root).is_some()
}

#[tauri::command]
pub fn watch_dir(app: AppHandle, state: State<'_, WatchState>, root: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
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
            let _ = app.emit(
                "fs-changed",
                FsChangedPayload {
                    root: watched.clone(),
                    paths,
                },
            );
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    insert_watch(&mut guard, root, debouncer);
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, WatchState>, root: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    remove_watch(&mut guard, &root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{insert_watch, is_ignored, is_ignored_under, remove_watch};
    use notify_debouncer_mini::new_debouncer;
    use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
    use notify_debouncer_mini::{DebounceEventResult, Debouncer};
    use std::collections::HashMap;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn ignores_node_modules_git_and_temp_files() {
        assert!(is_ignored("/p/node_modules/x/en.json"));
        assert!(is_ignored("/p/.git/index"));
        assert!(is_ignored("C:\\p\\.git\\HEAD"));
        assert!(is_ignored("/p/public/locales/en/common.json.retrans-tmp"));
        assert!(!is_ignored("/p/public/locales/en/common.json"));
        assert!(!is_ignored("/p/.gitignore"));
        assert!(!is_ignored("/p/my_node_modules_notes/en.json"));
        assert!(!is_ignored("/p/.retrans/state.json"));
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
        assert!(is_ignored_under("/p", "/p/public/locales/en/common.json.retrans-tmp"));
    }

    fn test_debouncer(path: &std::path::Path) -> Debouncer<RecommendedWatcher> {
        let mut debouncer = new_debouncer(Duration::from_millis(300), |_res: DebounceEventResult| {})
            .expect("debouncer should build");
        debouncer
            .watcher()
            .watch(path, RecursiveMode::Recursive)
            .expect("watch should start");
        debouncer
    }

    #[test]
    fn watch_state_keeps_one_debouncer_per_root() {
        let d1 = tempdir().expect("tempdir should build");
        let d2 = tempdir().expect("tempdir should build");
        let mut map: HashMap<String, Debouncer<RecommendedWatcher>> = HashMap::new();

        insert_watch(&mut map, "/a".to_string(), test_debouncer(d1.path()));
        assert_eq!(map.len(), 1);
        insert_watch(&mut map, "/b".to_string(), test_debouncer(d2.path()));
        assert_eq!(map.len(), 2);

        insert_watch(&mut map, "/a".to_string(), test_debouncer(d1.path()));
        assert_eq!(map.len(), 2);

        assert!(remove_watch(&mut map, "/a"));
        assert_eq!(map.len(), 1);
        assert!(!remove_watch(&mut map, "/a"));
        assert_eq!(map.len(), 1);
        assert!(remove_watch(&mut map, "/b"));
        assert!(map.is_empty());
    }
}
