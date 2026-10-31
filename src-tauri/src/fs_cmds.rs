use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
}

impl From<io::Error> for FsError {
    fn from(e: io::Error) -> Self {
        let code = if e.kind() == io::ErrorKind::NotFound { "NotFound" } else { "Io" };
        FsError { code, message: e.to_string() }
    }
}

type Result<T> = std::result::Result<T, FsError>;

#[tauri::command]
pub fn read_text(path: String) -> Result<String> {
    Ok(fs::read_to_string(path)?)
}

pub fn write_atomic(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".paratrans-tmp");
    let tmp = PathBuf::from(tmp);
    let res = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.flush()?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

#[tauri::command]
pub fn write_text_atomic(path: String, content: String) -> Result<()> {
    Ok(write_atomic(Path::new(&path), &content)?)
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn walk(dir: &Path, rel: &str, depth: u32, max: u32, out: &mut Vec<String>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let ft = entry.file_type()?;
        if ft.is_dir() {
            if depth < max {
                walk(&entry.path(), &r, depth + 1, max, out)?;
            }
        } else if ft.is_file() {
            out.push(r);
        }
    }
    Ok(())
}

pub fn list_files_impl(root: &Path, max_depth: u32) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    walk(root, "", 1, max_depth, &mut out)?;
    out.sort();
    Ok(out)
}

#[tauri::command]
pub fn list_files(root: String, max_depth: u32) -> Result<Vec<String>> {
    Ok(list_files_impl(Path::new(&root), max_depth)?)
}

/// Removes a single file. Directories are refused: every caller removes one locale or journal file.
#[tauri::command]
pub fn remove_path(path: String) -> Result<()> {
    let p = Path::new(&path);
    if p.is_dir() {
        return Err(FsError { code: "Io", message: format!("refusing to remove a directory: {path}") });
    }
    Ok(fs::remove_file(p)?)
}

#[tauri::command]
pub fn mkdirp(path: String) -> Result<()> {
    Ok(fs::create_dir_all(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = std::env::temp_dir().join(format!("paratrans-test-{}", std::process::id()));
        let file = dir.join("sub").join("a.json");
        write_atomic(&file, "one").unwrap();
        write_atomic(&file, "two").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "two");
        assert!(!dir.join("sub").join("a.json.paratrans-tmp").exists());
        assert_eq!(list_files_impl(&dir, 1).unwrap(), Vec::<String>::new());
        assert_eq!(list_files_impl(&dir, 2).unwrap(), vec!["sub/a.json"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_path_refuses_directories() {
        let dir = std::env::temp_dir().join(format!("paratrans-rm-{}", std::process::id()));
        let file = dir.join("a.json");
        write_atomic(&file, "x").unwrap();
        let err = remove_path(dir.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err.code, "Io");
        assert!(err.message.contains("refusing to remove a directory"));
        assert!(file.exists());
        remove_path(file.to_string_lossy().into_owned()).unwrap();
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
