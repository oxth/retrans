//! Model downloads: the only networked code in the app. Streams a pinned Hugging Face file into
//! `<app_data_dir>/models/<file>.part`, resumable across pauses and restarts, then verifies its
//! size and SHA-256 before renaming it to `<file>`.

use super::engine::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug)]
pub enum Outcome {
    Done,
    Paused,
    Cancelled,
}

pub const RUN: u8 = 0;
pub const PAUSE: u8 = 1;
pub const CANCEL: u8 = 2;

const CORRUPTED: &str = "Download corrupted. Try again.";

fn part_path(dir: &Path, file: &str) -> PathBuf {
    dir.join(format!("{file}.part"))
}

async fn corrupted(part: &Path) -> Result<Outcome, String> {
    let _ = tokio::fs::remove_file(part).await;
    Err(CORRUPTED.into())
}

/// Hashes an existing `.part` so a resumed download can still be verified end to end.
async fn hash_existing(part: &Path, hasher: &mut Sha256) -> Result<u64, String> {
    let mut f = match tokio::fs::File::open(part).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.to_string()),
    };
    let mut buf = vec![0u8; 1 << 20];
    let mut len = 0u64;
    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(len);
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
}

/// Awaits `fut` unless `control` leaves RUN first (polled every 100 ms), so a stalled request or
/// stream can still be paused or cancelled. Returns `None` when stopped.
async fn until_stopped<F: std::future::Future>(fut: F, control: &AtomicU8) -> Option<F::Output> {
    if control.load(Ordering::SeqCst) != RUN {
        return None;
    }
    let stopped = async {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if control.load(Ordering::SeqCst) != RUN {
                return;
            }
        }
    };
    tokio::select! {
        out = fut => Some(out),
        () = stopped => None,
    }
}

/// Ends a stopped download: PAUSE keeps the part, CANCEL deletes it.
async fn stop(control: &AtomicU8, part: &Path, out: Option<tokio::fs::File>) -> Result<Outcome, String> {
    if let Some(mut out) = out {
        out.flush().await.map_err(|e| e.to_string())?;
    }
    if control.load(Ordering::SeqCst) == CANCEL {
        let _ = tokio::fs::remove_file(part).await;
        Ok(Outcome::Cancelled)
    } else {
        Ok(Outcome::Paused)
    }
}

/// Downloads `url` into `dir/file`, resuming from `dir/file.part` when present. Setting `control`
/// to PAUSE or CANCEL stops it promptly, even while the request or stream is stalled;
/// `on_progress(received, size)` is called after each chunk.
#[allow(clippy::too_many_arguments)]
pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dir: &Path,
    file: &str,
    sha256: &str,
    size: u64,
    control: &AtomicU8,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<Outcome, String> {
    let part = part_path(dir, file);
    let mut hasher = Sha256::new();
    let mut received = hash_existing(&part, &mut hasher).await?;
    if received > size {
        return corrupted(&part).await;
    }

    let mut req = client.get(url);
    if received > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={received}-"));
    }
    let Some(resp) = until_stopped(req.send(), control).await else {
        return stop(control, &part, None).await;
    };
    let resp = match resp {
        Ok(resp) => resp,
        Err(_) if control.load(Ordering::SeqCst) != RUN => return stop(control, &part, None).await,
        Err(e) => return Err(format!("Download failed: {e}")),
    };
    let status = resp.status().as_u16();
    let mut out = match status {
        206 if received > 0 => tokio::fs::OpenOptions::new().append(true).open(&part).await,
        200 => {
            hasher = Sha256::new();
            received = 0;
            tokio::fs::File::create(&part).await
        }
        416 if received > 0 => return finish(dir, file, &part, received, size, hasher, sha256).await,
        _ => return Err(format!("Download failed: HTTP {status}")),
    }
    .map_err(|e| e.to_string())?;

    let mut stream = resp.bytes_stream();
    loop {
        let Some(next) = until_stopped(stream.next(), control).await else {
            return stop(control, &part, Some(out)).await;
        };
        let Some(chunk) = next else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) if control.load(Ordering::SeqCst) != RUN => return stop(control, &part, Some(out)).await,
            Err(e) => return Err(format!("Download failed: {e}")),
        };
        received += chunk.len() as u64;
        if received > size {
            drop(out);
            return corrupted(&part).await;
        }
        out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        on_progress(received, size);
    }
    out.flush().await.map_err(|e| e.to_string())?;
    drop(out);
    finish(dir, file, &part, received, size, hasher, sha256).await
}

async fn finish(
    dir: &Path,
    file: &str,
    part: &Path,
    received: u64,
    size: u64,
    hasher: Sha256,
    sha256: &str,
) -> Result<Outcome, String> {
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if received != size || !hex.eq_ignore_ascii_case(sha256) {
        return corrupted(part).await;
    }
    tokio::fs::rename(part, dir.join(file)).await.map_err(|e| e.to_string())?;
    Ok(Outcome::Done)
}

/// `file` must match `^[A-Za-z0-9._-]+\.gguf$`.
fn validate_file(file: &str) -> Result<(), String> {
    let ok = file.strip_suffix(".gguf").is_some_and(|stem| {
        !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    });
    if ok { Ok(()) } else { Err(format!("Invalid model file name: {file}")) }
}

pub fn validate_request(url: &str, file: &str) -> Result<(), String> {
    validate_file(file)?;
    if !url.starts_with("https://huggingface.co/") {
        return Err("Models can only be downloaded from https://huggingface.co/".into());
    }
    Ok(())
}

// ---- Tauri commands ----

/// Control flags of running downloads, by catalog id.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicU8>>>);

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct ModelFile {
    file: String,
    size: u64,
    complete: bool,
}

#[derive(Serialize, Clone)]
struct DownloadEvent {
    id: String,
    state: &'static str,
    received: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[tauri::command]
pub fn mt_models_dir(app: AppHandle) -> Result<String, String> {
    Ok(models_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn mt_models_status(app: AppHandle) -> Result<Vec<ModelFile>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(models_dir(&app)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (file, complete) = match name.strip_suffix(".part") {
            Some(f) if f.ends_with(".gguf") => (f.to_string(), false),
            None if name.ends_with(".gguf") => (name, true),
            _ => continue,
        };
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        out.push(ModelFile { file, size, complete });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.complete.cmp(&b.complete)));
    Ok(out)
}

#[tauri::command]
pub fn mt_download_start(
    app: AppHandle,
    state: State<'_, Downloads>,
    id: String,
    url: String,
    file: String,
    sha256: String,
    size: u64,
) -> Result<(), String> {
    validate_request(&url, &file)?;
    let dir = models_dir(&app)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let control = Arc::new(AtomicU8::new(RUN));
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&id) {
            return Err("Already downloading".into());
        }
        map.insert(id.clone(), control.clone());
    }
    tauri::async_runtime::spawn(async move {
        let emit = |state: &'static str, received: u64, message: Option<String>| {
            let ev = DownloadEvent { id: id.clone(), state, received, total: size, message };
            let _ = app.emit("mt-download", ev);
        };
        let mut last_emit: Option<Instant> = None;
        let mut last_received = 0u64;
        let result = download_file(&client, &url, &dir, &file, &sha256, size, &control, |received, _| {
            last_received = received;
            if last_emit.is_none_or(|t| t.elapsed() >= Duration::from_millis(250)) {
                last_emit = Some(Instant::now());
                emit("progress", received, None);
            }
        })
        .await;
        // Unregister before the final event so the UI can restart right away.
        if let Ok(mut map) = app.state::<Downloads>().0.lock() {
            map.remove(&id);
        }
        match result {
            Ok(Outcome::Done) => emit("done", size, None),
            Ok(Outcome::Paused) => {
                let on_disk = std::fs::metadata(part_path(&dir, &file)).map_or(last_received, |m| m.len());
                emit("paused", on_disk, None)
            }
            Ok(Outcome::Cancelled) => emit("cancelled", 0, None),
            Err(message) => emit("error", last_received, Some(message)),
        }
    });
    Ok(())
}

#[tauri::command]
pub fn mt_download_pause(state: State<'_, Downloads>, id: String) -> Result<(), String> {
    if let Some(control) = state.0.lock().map_err(|e| e.to_string())?.get(&id) {
        control.store(PAUSE, Ordering::SeqCst);
    }
    Ok(())
}

/// Stops a running download (its task deletes the `.part`), or deletes a paused/stale `.part`.
#[tauri::command]
pub fn mt_download_cancel(
    app: AppHandle,
    state: State<'_, Downloads>,
    id: String,
    file: String,
) -> Result<(), String> {
    validate_file(&file)?;
    if let Some(control) = state.0.lock().map_err(|e| e.to_string())?.get(&id) {
        control.store(CANCEL, Ordering::SeqCst);
        return Ok(());
    }
    remove_if_exists(&part_path(&models_dir(&app)?, &file))
}

#[tauri::command]
pub fn mt_model_delete(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    file: String,
) -> Result<(), String> {
    validate_file(&file)?;
    let path = models_dir(&app)?.join(&file);
    // Unload first if the engine holds this file: Windows can't delete a memory-mapped file.
    engine.unload_if(&path);
    remove_if_exists(&path)
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};

    const KB: usize = 1024;

    fn body() -> Vec<u8> {
        (0..300 * KB).map(|i| ((i * 31 + i / 7) % 251) as u8).collect()
    }

    fn sha_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Serves `body` on 127.0.0.1. With `honour_range`, a `Range: bytes=N-` request gets 206 (or 416
    /// when N is past the end); otherwise every request gets 200 and the full body. Returns the URL and
    /// the `Range` header of every request seen (empty string when absent).
    fn serve(body: Vec<u8>, honour_range: bool) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x.gguf", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        let body = Arc::new(body);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let (body, seen) = (body.clone(), seen2.clone());
                std::thread::spawn(move || {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => req.extend_from_slice(&buf[..n]),
                        }
                    }
                    let req = String::from_utf8_lossy(&req).to_string();
                    let range = req
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("range").then(|| v.trim().to_string())
                        })
                        .unwrap_or_default();
                    seen.lock().unwrap().push(range.clone());
                    let start = range
                        .strip_prefix("bytes=")
                        .and_then(|r| r.strip_suffix('-'))
                        .and_then(|n| n.parse::<usize>().ok());
                    let len = body.len();
                    let (head, payload): (String, &[u8]) = match start {
                        Some(s) if honour_range && s >= len => (
                            format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                            &[],
                        ),
                        Some(s) if honour_range => (
                            format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {s}-{}/{len}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                len - 1,
                                len - s
                            ),
                            &body[s..],
                        ),
                        _ => (
                            format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"),
                            &body[..],
                        ),
                    };
                    let _ = stream.write_all(head.as_bytes());
                    for chunk in payload.chunks(16 * KB) {
                        if stream.write_all(chunk).is_err() {
                            return;
                        }
                        let _ = stream.flush();
                    }
                });
            }
        });
        (url, seen)
    }

    async fn run(url: &str, dir: &Path, sha: &str, control: &AtomicU8) -> Result<Outcome, String> {
        let client = reqwest::Client::new();
        download_file(&client, url, dir, "x.gguf", sha, body().len() as u64, control, |_, _| {}).await
    }

    #[tokio::test]
    async fn downloads_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _) = serve(body(), true);
        let out = run(&url, dir.path(), &sha_hex(&body()), &AtomicU8::new(RUN)).await;
        assert!(matches!(out, Ok(Outcome::Done)), "{out:?}");
        assert_eq!(std::fs::read(dir.path().join("x.gguf")).unwrap(), body());
        assert!(!dir.path().join("x.gguf.part").exists());
    }

    #[tokio::test]
    async fn resumes_from_part() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.gguf.part"), &body()[..100 * KB]).unwrap();
        let (url, seen) = serve(body(), true);
        let out = run(&url, dir.path(), &sha_hex(&body()), &AtomicU8::new(RUN)).await;
        assert!(matches!(out, Ok(Outcome::Done)), "{out:?}");
        assert_eq!(seen.lock().unwrap().as_slice(), ["bytes=102400-"]);
        assert_eq!(std::fs::read(dir.path().join("x.gguf")).unwrap(), body());
    }

    #[tokio::test]
    async fn restarts_when_range_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.gguf.part"), vec![0xAB; 100 * KB]).unwrap();
        let (url, seen) = serve(body(), false);
        let out = run(&url, dir.path(), &sha_hex(&body()), &AtomicU8::new(RUN)).await;
        assert!(matches!(out, Ok(Outcome::Done)), "{out:?}");
        assert_eq!(seen.lock().unwrap().as_slice(), ["bytes=102400-"]);
        assert_eq!(std::fs::read(dir.path().join("x.gguf")).unwrap(), body());
    }

    #[tokio::test]
    async fn checksum_mismatch_deletes_part() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _) = serve(body(), true);
        let out = run(&url, dir.path(), &sha_hex(b"other"), &AtomicU8::new(RUN)).await;
        assert_eq!(out.err().as_deref(), Some("Download corrupted. Try again."));
        assert!(!dir.path().join("x.gguf").exists());
        assert!(!dir.path().join("x.gguf.part").exists());
    }

    #[tokio::test]
    async fn oversized_body_deletes_part() {
        let dir = tempfile::tempdir().unwrap();
        let mut big = body();
        big.extend_from_slice(&[1; 50 * KB]);
        let (url, _) = serve(big, true);
        let out = run(&url, dir.path(), &sha_hex(&body()), &AtomicU8::new(RUN)).await;
        assert_eq!(out.err().as_deref(), Some("Download corrupted. Try again."));
        assert!(!dir.path().join("x.gguf").exists());
        assert!(!dir.path().join("x.gguf.part").exists());
    }

    #[tokio::test]
    async fn pause_keeps_part_and_cancel_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let (url, _) = serve(body(), true);
        let client = reqwest::Client::new();
        let sha = sha_hex(&body());
        let size = body().len() as u64;

        let control = AtomicU8::new(RUN);
        let out = download_file(&client, &url, dir.path(), "x.gguf", &sha, size, &control, |_, _| {
            control.store(PAUSE, Ordering::SeqCst)
        })
        .await;
        assert!(matches!(out, Ok(Outcome::Paused)), "{out:?}");
        let part = dir.path().join("x.gguf.part");
        assert!(part.exists());
        assert!(std::fs::metadata(&part).unwrap().len() < size);

        let control = AtomicU8::new(RUN);
        let out = download_file(&client, &url, dir.path(), "x.gguf", &sha, size, &control, |_, _| {
            control.store(CANCEL, Ordering::SeqCst)
        })
        .await;
        assert!(matches!(out, Ok(Outcome::Cancelled)), "{out:?}");
        assert!(!part.exists());
        assert!(!dir.path().join("x.gguf").exists());
    }

    #[tokio::test]
    async fn complete_part_with_416_is_verified() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.gguf.part"), body()).unwrap();
        let (url, seen) = serve(body(), true);
        let out = run(&url, dir.path(), &sha_hex(&body()), &AtomicU8::new(RUN)).await;
        assert!(matches!(out, Ok(Outcome::Done)), "{out:?}");
        assert_eq!(seen.lock().unwrap().as_slice(), ["bytes=307200-"]);
        assert_eq!(std::fs::read(dir.path().join("x.gguf")).unwrap(), body());
    }

    #[tokio::test]
    async fn other_status_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x.gguf", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _ = s.read(&mut [0u8; 1024]);
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        let out = run(&url, dir.path(), &sha_hex(&body()), &AtomicU8::new(RUN)).await;
        assert_eq!(out.err().as_deref(), Some("Download failed: HTTP 404"));
    }

    /// Accepts one connection, then stalls for 30 s: after the response head and first 16 KB when
    /// `first_chunk`, or before sending anything at all otherwise.
    fn stalling_server(first_chunk: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x.gguf", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _ = s.read(&mut [0u8; 4096]);
            if first_chunk {
                let len = body().len();
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\n\r\n");
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body()[..16 * KB]);
                let _ = s.flush();
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
        url
    }

    /// Runs a download against a stalling server and sets `flag` from outside after 300 ms; the
    /// download must stop within 2 s.
    async fn stop_stalled(first_chunk: bool, flag: u8) -> (tempfile::TempDir, Result<Outcome, String>) {
        let dir = tempfile::tempdir().unwrap();
        let url = stalling_server(first_chunk);
        let control = AtomicU8::new(RUN);
        let stopper = async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            control.store(flag, Ordering::SeqCst);
        };
        let sha = sha_hex(&body());
        let both = async { tokio::join!(run(&url, dir.path(), &sha, &control), stopper).0 };
        let out = tokio::time::timeout(std::time::Duration::from_secs(2), both)
            .await
            .expect("download did not stop within 2 s");
        (dir, out)
    }

    #[tokio::test]
    async fn pause_interrupts_a_stalled_stream() {
        let (dir, out) = stop_stalled(true, PAUSE).await;
        assert!(matches!(out, Ok(Outcome::Paused)), "{out:?}");
        assert_eq!(std::fs::read(dir.path().join("x.gguf.part")).unwrap(), &body()[..16 * KB]);
    }

    #[tokio::test]
    async fn cancel_interrupts_a_stalled_stream() {
        let (dir, out) = stop_stalled(true, CANCEL).await;
        assert!(matches!(out, Ok(Outcome::Cancelled)), "{out:?}");
        assert!(!dir.path().join("x.gguf.part").exists());
    }

    #[tokio::test]
    async fn cancel_interrupts_a_pending_request() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.gguf.part"), &body()[..100 * KB]).unwrap();
        let url = stalling_server(false);
        let control = AtomicU8::new(RUN);
        let stopper = async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            control.store(CANCEL, Ordering::SeqCst);
        };
        let sha = sha_hex(&body());
        let both = async { tokio::join!(run(&url, dir.path(), &sha, &control), stopper).0 };
        let out = tokio::time::timeout(std::time::Duration::from_secs(2), both)
            .await
            .expect("download did not stop within 2 s");
        assert!(matches!(out, Ok(Outcome::Cancelled)), "{out:?}");
        assert!(!dir.path().join("x.gguf.part").exists());
    }

    #[test]
    fn rejects_bad_names_and_hosts() {
        let ok = "https://huggingface.co/a/b/resolve/c/x.gguf";
        assert!(validate_request(ok, "x.gguf").is_ok());
        assert!(validate_request(ok, "../x.gguf").is_err());
        assert!(validate_request(ok, "x.bin").is_err());
        assert!(validate_request(ok, ".gguf").is_err());
        assert!(validate_request("http://evil.example/x.gguf", "x.gguf").is_err());
        assert!(validate_request("https://huggingface.co.evil.example/x.gguf", "x.gguf").is_err());
    }
}
