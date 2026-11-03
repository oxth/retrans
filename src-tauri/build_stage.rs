//! llama.cpp DLL staging for the Windows bundle. Used by build.rs and tested by
//! tests/stage_dlls.rs, so it only touches the file system it is given.
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The VC++ runtime DLLs llama.cpp's DLLs (built with /MD) import; shipped next to retrans.exe so
/// a clean Windows machine needs no VC++ redistributable.
pub const VC_CRT_DLLS: [&str; 3] = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

#[derive(Debug, Default)]
pub struct SyncReport {
    /// DLLs found in the source dirs.
    pub found: usize,
    /// DLLs copied because they were missing or differed (size or mtime).
    pub copied: usize,
    /// Stale `.dll` files removed from `dest`.
    pub removed: usize,
}

fn is_dll(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dll")) && p.is_file()
}

/// Mirror every `.dll` in `sources`, plus the `extra` files, into `dest`: copy one only when it is
/// missing or its size or mtime differs (the copy gets the source's mtime), and delete `.dll`
/// files neither has. Other files in `dest` are left alone. Missing source dirs are skipped.
pub fn sync_dlls(sources: &[&Path], extra: &[PathBuf], dest: &Path) -> io::Result<SyncReport> {
    fs::create_dir_all(dest)?;
    let mut report = SyncReport::default();
    let mut wanted = HashSet::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in sources {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        files.extend(entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| is_dll(p)));
    }
    files.extend(extra.iter().cloned());
    for path in files {
        let name = path.file_name().unwrap().to_owned();
        report.found += 1;
        let target = dest.join(&name);
        wanted.insert(name.to_string_lossy().to_lowercase());
        let src = fs::metadata(&path)?;
        let same = fs::metadata(&target)
            .ok()
            .is_some_and(|d| d.len() == src.len() && d.modified().ok() == src.modified().ok());
        if same {
            continue;
        }
        fs::copy(&path, &target)?;
        fs::File::options().write(true).open(&target)?.set_modified(src.modified()?)?;
        report.copied += 1;
    }
    for path in fs::read_dir(dest)?.filter_map(|e| e.ok().map(|e| e.path())) {
        let name = path.file_name().unwrap().to_string_lossy().to_lowercase();
        if is_dll(&path) && !wanted.contains(&name) {
            fs::remove_file(&path)?;
            report.removed += 1;
        }
    }
    Ok(report)
}

fn has_crt(dir: &Path) -> bool {
    VC_CRT_DLLS.iter().all(|n| dir.join(n).is_file())
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect()
}

fn version_key(p: &Path) -> Vec<u64> {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    name.split('.').map(|s| s.parse().unwrap_or(0)).collect()
}

/// `<redist>/x64/Microsoft.VC14*.CRT` holding all of VC_CRT_DLLS (`<redist>` is one MSVC version's
/// redist folder, as in `%VCToolsRedistDir%`).
fn crt_in_redist(redist: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = subdirs(&redist.join("x64"))
        .into_iter()
        .filter(|d| {
            let n = d.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
            n.starts_with("microsoft.vc14") && n.ends_with(".crt") && has_crt(d)
        })
        .collect();
    dirs.sort();
    dirs.pop()
}

/// Newest `<vc>/Redist/MSVC/<version>` with a complete CRT folder (`<vc>` is `%VCINSTALLDIR%`).
fn crt_in_vc(vc: &Path) -> Option<PathBuf> {
    let mut versions = subdirs(&vc.join("Redist").join("MSVC"));
    versions.sort_by_key(|v| version_key(v));
    versions.iter().rev().find_map(|v| crt_in_redist(v))
}

/// Where to take the VC++ runtime DLLs from, in order: `%VCToolsRedistDir%`, `%VCINSTALLDIR%`,
/// the Visual Studio install (vswhere's installationPath), then System32 as a last resort.
pub fn find_vc_crt(
    vc_tools_redist_dir: Option<PathBuf>,
    vc_install_dir: Option<PathBuf>,
    vs_install_dir: Option<PathBuf>,
    system32: Option<PathBuf>,
) -> Option<PathBuf> {
    vc_tools_redist_dir
        .and_then(|d| crt_in_redist(&d))
        .or_else(|| vc_install_dir.and_then(|d| crt_in_vc(&d)))
        .or_else(|| vs_install_dir.and_then(|d| crt_in_vc(&d.join("VC"))))
        .or_else(|| system32.filter(|d| has_crt(d)))
}
