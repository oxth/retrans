use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_ENTRIES: usize = 5000;
pub const MAX_ENTRY_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
const BAD_ZIP: &str = "This file isn't a Retrans package or project.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZipEntry {
    pub path: String,
    pub text: String,
}

pub fn clean_entry_path(raw: &str) -> Option<String> {
    let p = raw.replace('\\', "/");
    let p = p.strip_prefix("./").unwrap_or(&p);
    if p.is_empty() || p.starts_with('/') || p.ends_with('/') {
        return None;
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return None;
    }
    let mut last = "";
    for (i, seg) in p.split('/').enumerate() {
        if seg == ".." || (seg.is_empty()) {
            return None;
        }
        if i == 0 && seg == "__MACOSX" {
            return None;
        }
        last = seg;
    }
    if last == ".DS_Store" {
        return None;
    }
    Some(p.to_string())
}

fn write_impl(dest: &Path, entries: &[ZipEntry]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".retrans-tmp");
    let tmp = PathBuf::from(tmp);
    let res = (|| -> Result<(), String> {
        let f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for en in entries {
            if clean_entry_path(&en.path).as_deref() != Some(en.path.as_str()) {
                return Err(format!("Unsafe entry path: {}", en.path));
            }
            z.start_file(en.path.as_str(), opts).map_err(|e| e.to_string())?;
            z.write_all(en.text.as_bytes()).map_err(|e| e.to_string())?;
        }
        let f = z.finish().map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        fs::rename(&tmp, dest).map_err(|e| e.to_string())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

fn read_impl(src: &Path) -> Result<Vec<ZipEntry>, String> {
    let bad = || BAD_ZIP.to_string();
    let f = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|_| bad())?;
    if archive.len() > MAX_ENTRIES {
        return Err(bad());
    }
    let mut out = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| bad())?;
        let Ok(name) = entry.name() else { continue };
        let Some(path) = clean_entry_path(&name) else { continue };
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(bad());
        }
        // The header can lie: cap the bytes actually read.
        let mut buf = Vec::new();
        entry.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut buf).map_err(|_| bad())?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            return Err(bad());
        }
        total += buf.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(bad());
        }
        let text = String::from_utf8(buf).map_err(|_| bad())?;
        out.push(ZipEntry { path, text });
    }
    Ok(out)
}

#[tauri::command]
pub fn zip_write(dest: String, entries: Vec<ZipEntry>) -> Result<(), String> {
    write_impl(Path::new(&dest), &entries)
}

#[tauri::command]
pub fn zip_read(src: String) -> Result<Vec<ZipEntry>, String> {
    read_impl(Path::new(&src))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(p: &str, t: &str) -> ZipEntry {
        ZipEntry { path: p.into(), text: t.into() }
    }

    fn raw_zip(path: &Path, files: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (n, b) in files {
            z.start_file(*n, opts).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn round_trips_utf8_entries() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("out.zip");
        let entries = vec![e("a/b.json", "{\"x\":\"ไทย\"}"), e(".retrans/package.json", "{}")];
        write_impl(&p, &entries).unwrap();
        assert_eq!(read_impl(&p).unwrap(), entries);
        let names: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|x| x.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["out.zip"]);
    }

    #[test]
    fn clean_entry_path_rules() {
        assert_eq!(clean_entry_path("./a.json").as_deref(), Some("a.json"));
        assert_eq!(clean_entry_path("a\\b.json").as_deref(), Some("a/b.json"));
        for bad in ["", "../x", "a/../../x", "/etc/x", "C:/x", "C:\\x", "//x", "dir/", "__MACOSX/a.json", "x/.DS_Store"] {
            assert_eq!(clean_entry_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn skips_junk_and_unsafe_entries() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("in.zip");
        raw_zip(&p, &[("../evil.json", b"{}"), ("__MACOSX/._a", b"\xff"), ("ok.json", b"{}")]);
        assert_eq!(read_impl(&p).unwrap(), vec![e("ok.json", "{}")]);
    }

    #[test]
    fn rejects_non_utf8_and_non_zip() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("in.zip");
        raw_zip(&p, &[("a.json", &[0xff, 0xfe])]);
        assert_eq!(read_impl(&p).unwrap_err(), BAD_ZIP);
        std::fs::write(&p, "hello").unwrap();
        assert_eq!(read_impl(&p).unwrap_err(), BAD_ZIP);
    }

    #[test]
    fn rejects_oversized_entry() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("in.zip");
        raw_zip(&p, &[("big.json", &vec![b'a'; MAX_ENTRY_BYTES as usize + 1])]);
        assert_eq!(read_impl(&p).unwrap_err(), BAD_ZIP);
    }
}
