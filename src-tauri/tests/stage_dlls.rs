//! Tests for the llama.cpp DLL staging that build.rs runs on Windows (pure file logic, any OS).
#[path = "../build_stage.rs"]
mod build_stage;

use build_stage::{find_vc_crt, sync_dlls, VC_CRT_DLLS};
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

    let r = sync_dlls(&[&bin, &backends], &[], &dest).unwrap();
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
    let r = sync_dlls(&[&bin, &backends], &[], &dest).unwrap();
    assert_eq!((r.found, r.copied, r.removed), (3, 0, 0));
    assert_eq!(mtime(&dest.join("llama.dll")), before);

    // A rebuilt DLL (same size, newer mtime) and a resized one are both re-copied.
    write(&bin.join("ggml.dll"), "GGML");
    let f = fs::File::options().write(true).open(bin.join("ggml.dll")).unwrap();
    f.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
    write(&backends.join("ggml-cpu-haswell.dll"), "cpu-v2");
    let r = sync_dlls(&[&bin, &backends], &[], &dest).unwrap();
    assert_eq!((r.copied, r.removed), (2, 0));
    assert_eq!(fs::read_to_string(dest.join("ggml.dll")).unwrap(), "GGML");
    assert_eq!(fs::read_to_string(dest.join("ggml-cpu-haswell.dll")).unwrap(), "cpu-v2");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn missing_source_dirs_count_nothing() {
    let root = tmp("missing");
    let r = sync_dlls(&[&root.join("nope")], &[], &root.join("dest")).unwrap();
    assert_eq!((r.found, r.copied, r.removed), (0, 0, 0));
    assert!(root.join("dest").is_dir());
    fs::remove_dir_all(&root).unwrap();
}

fn crt(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    for n in VC_CRT_DLLS {
        write(&dir.join(n), n);
    }
    dir.to_path_buf()
}

#[test]
fn extra_files_are_staged_and_not_treated_as_stale() {
    let root = tmp("extra");
    let (bin, dest) = (root.join("bin"), root.join("dest"));
    fs::create_dir_all(&bin).unwrap();
    write(&bin.join("llama.dll"), "llama");
    let c = crt(&root.join("crt"));
    let extra: Vec<PathBuf> = VC_CRT_DLLS.iter().map(|n| c.join(n)).collect();
    let r = sync_dlls(&[&bin], &extra, &dest).unwrap();
    assert_eq!((r.found, r.copied, r.removed), (4, 4, 0));
    let r = sync_dlls(&[&bin], &extra, &dest).unwrap();
    assert_eq!((r.found, r.copied, r.removed), (4, 0, 0));
    assert_eq!(fs::read_to_string(dest.join("vcruntime140_1.dll")).unwrap(), "vcruntime140_1.dll");
    // Dropping the extras makes them stale.
    let r = sync_dlls(&[&bin], &[], &dest).unwrap();
    assert_eq!(r.removed, 3);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn finds_the_vc_runtime_in_order_redist_dir_vs_install_system32() {
    let root = tmp("crt");
    let none: Option<PathBuf> = None;
    assert_eq!(find_vc_crt(none.clone(), none.clone(), none.clone(), none.clone()), None);

    // System32 (last resort) only when it has all three.
    let sys = root.join("System32");
    fs::create_dir_all(&sys).unwrap();
    write(&sys.join("msvcp140.dll"), "x");
    assert_eq!(find_vc_crt(none.clone(), none.clone(), none.clone(), Some(sys.clone())), None);
    crt(&sys);
    assert_eq!(find_vc_crt(none.clone(), none.clone(), none.clone(), Some(sys.clone())), Some(sys.clone()));

    // A VS install: <install>/VC/Redist/MSVC/<ver>/x64/Microsoft.VC14x.CRT, newest version wins;
    // non-CRT siblings (OpenMP) and incomplete folders are skipped.
    let vs = root.join("VS");
    let msvc = vs.join("VC/Redist/MSVC");
    crt(&msvc.join("14.38.33135/x64/Microsoft.VC143.CRT"));
    let newest = crt(&msvc.join("14.40.33807/x64/Microsoft.VC143.CRT"));
    fs::create_dir_all(msvc.join("14.40.33807/x64/Microsoft.VC143.OpenMP")).unwrap();
    fs::create_dir_all(msvc.join("14.50.1/x64/Microsoft.VC145.CRT")).unwrap(); // empty
    assert_eq!(find_vc_crt(none.clone(), none.clone(), Some(vs.clone()), Some(sys.clone())), Some(newest.clone()));
    // VCINSTALLDIR points at <install>/VC.
    assert_eq!(find_vc_crt(none.clone(), Some(vs.join("VC")), none.clone(), Some(sys.clone())), Some(newest.clone()));

    // VCToolsRedistDir (one version's folder) wins over everything else.
    let pinned = msvc.join("14.38.33135");
    assert_eq!(
        find_vc_crt(Some(pinned.clone()), Some(vs.join("VC")), Some(vs), Some(sys)),
        Some(pinned.join("x64/Microsoft.VC143.CRT"))
    );
    fs::remove_dir_all(&root).unwrap();
}
