//! llama.cpp DLL staging for the Windows bundle. Used by build.rs and tested by
//! tests/stage_dlls.rs, so it only touches the file system it is given.
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

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

/// Mirror every `.dll` in `sources` into `dest`: copy one only when it is missing or its size or
/// mtime differs (the copy gets the source's mtime), and delete `.dll` files no source has.
/// Other files in `dest` are left alone. Missing source dirs are skipped.
pub fn sync_dlls(sources: &[&Path], dest: &Path) -> io::Result<SyncReport> {
    fs::create_dir_all(dest)?;
    let mut report = SyncReport::default();
    let mut wanted = HashSet::new();
    for dir in sources {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
            if !is_dll(&path) {
                continue;
            }
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
