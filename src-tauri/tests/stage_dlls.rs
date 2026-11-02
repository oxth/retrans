//! Tests for the llama.cpp DLL staging that build.rs runs on Windows (pure file logic, any OS).
#[path = "../build_stage.rs"]
mod build_stage;

use build_stage::sync_dlls;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("retrans-stage-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn write(p: &Path, s: &str) {
    fs::write(p, s).unwrap();
}

fn mtime(p: &Path) -> SystemTime {
    fs::metadata(p).unwrap().modified().unwrap()
}

#[test]
fn copies_new_skips_unchanged_updates_changed_and_drops_stale() {
    let root = tmp("sync");
    let (bin, backends, dest) = (root.join("bin"), root.join("backends"), root.join("llama-dlls"));
    for d in [&bin, &backends, &dest] {
        fs::create_dir_all(d).unwrap();
    }
    write(&bin.join("llama.dll"), "llama");
    write(&bin.join("ggml.dll"), "ggml");
    write(&bin.join("notes.txt"), "not a dll");
    write(&backends.join("ggml-cpu-haswell.dll"), "cpu");
    write(&dest.join("ggml-cpu-old.dll"), "stale");
    write(&dest.join("keep.txt"), "not ours");

    let r = sync_dlls(&[&bin, &backends], &dest).unwrap();
    assert_eq!(r.found, 3);
    assert_eq!(r.copied, 3);
    assert_eq!(r.removed, 1);
    assert!(!dest.join("ggml-cpu-old.dll").exists());
    assert!(!dest.join("notes.txt").exists());
    assert!(dest.join("keep.txt").exists());
    assert_eq!(fs::read_to_string(dest.join("ggml-cpu-haswell.dll")).unwrap(), "cpu");
    assert_eq!(mtime(&dest.join("llama.dll")), mtime(&bin.join("llama.dll")));

    // Nothing changed: nothing copied, the staged files are left alone.
    let before = mtime(&dest.join("llama.dll"));
    let r = sync_dlls(&[&bin, &backends], &dest).unwrap();
    assert_eq!((r.found, r.copied, r.removed), (3, 0, 0));
    assert_eq!(mtime(&dest.join("llama.dll")), before);

    // A rebuilt DLL (same size, newer mtime) and a resized one are both re-copied.
    write(&bin.join("ggml.dll"), "GGML");
    let f = fs::File::options().write(true).open(bin.join("ggml.dll")).unwrap();
    f.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
    write(&backends.join("ggml-cpu-haswell.dll"), "cpu-v2");
    let r = sync_dlls(&[&bin, &backends], &dest).unwrap();
    assert_eq!((r.copied, r.removed), (2, 0));
    assert_eq!(fs::read_to_string(dest.join("ggml.dll")).unwrap(), "GGML");
    assert_eq!(fs::read_to_string(dest.join("ggml-cpu-haswell.dll")).unwrap(), "cpu-v2");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn missing_source_dirs_count_nothing() {
    let root = tmp("missing");
    let r = sync_dlls(&[&root.join("nope")], &root.join("dest")).unwrap();
    assert_eq!((r.found, r.copied, r.removed), (0, 0, 0));
    assert!(root.join("dest").is_dir());
    fs::remove_dir_all(&root).unwrap();
}
