//! Embedded llama.cpp inference engine.
//!
//! Prompts arrive fully built from the front end (special tokens included as text); this module
//! only tokenizes, generates greedily and stops on end-of-generation, a stop string or the budget.

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::{send_logs_to_tracing, LogOptions};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

const TOO_LONG: &str = "Text is too long to translate";
const LOAD_FAILED: &str = "Couldn't load the model file. Is it a llama.cpp GGUF model?";
const CANCELLED: &str = "cancelled";
const N_CTX: u32 = 4096;
pub const IDLE_UNLOAD_SECS: u64 = 300;
pub const IDLE_CHECK_SECS: u64 = 30;
#[cfg(target_os = "macos")]
const N_GPU_LAYERS: u32 = 999;
#[cfg(not(target_os = "macos"))]
const N_GPU_LAYERS: u32 = 0;
/// Request ids start at 1 on the front end, so 0 means "nothing".
const NO_REQ: u64 = 0;

/// Text before the earliest occurrence of any stop string, or `None` if none occurs.
pub fn truncate_at_stop(text: &str, stop: &[String]) -> Option<String> {
    stop.iter()
        .filter(|s| !s.is_empty())
        .filter_map(|s| text.find(s.as_str()))
        .min()
        .map(|i| text[..i].to_string())
}

/// How many tokens may be generated after a prompt of `prompt_tokens` in a context of `n_ctx`.
pub fn token_budget(prompt_tokens: usize, n_ctx: u32, max_tokens: u32) -> Result<u32, String> {
    if prompt_tokens + 16 > n_ctx as usize {
        return Err(TOO_LONG.into());
    }
    Ok(max_tokens.min(n_ctx - prompt_tokens as u32))
}

/// Incremental UTF-8 decoder: holds back the bytes of a character split across tokens
/// (Thai is 3 bytes per character and tokens often end mid-character).
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    /// Appends `bytes` and moves every complete character into `out`.
    fn push(&mut self, bytes: &[u8], out: &mut String) {
        self.pending.extend_from_slice(bytes);
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // SAFETY-free: the prefix is valid UTF-8 by construction.
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match e.error_len() {
                        // Incomplete trailing character: keep it for the next token.
                        None => {
                            self.pending.drain(..valid);
                            return;
                        }
                        // Genuinely invalid bytes: replace and keep going.
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }

    /// Flushes any leftover bytes (lossily) at the end of generation.
    fn finish(&mut self, out: &mut String) {
        if !self.pending.is_empty() {
            out.push_str(&String::from_utf8_lossy(&self.pending));
            self.pending.clear();
        }
    }
}

fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Option<LlamaBackend>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            send_logs_to_tracing(LogOptions::default().with_logs_enabled(false));
            LlamaBackend::init().ok()
        })
        .as_ref()
        .ok_or_else(|| "Couldn't start the inference backend".to_string())
}

/// Canonical form for comparing model paths; falls back to the path as given.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn load_model(path: &Path) -> Result<LlamaModel, String> {
    let backend = backend()?;
    if !path.is_file() {
        return Err(LOAD_FAILED.into());
    }
    let params = LlamaModelParams::default().with_n_gpu_layers(N_GPU_LAYERS);
    LlamaModel::load_from_file(backend, path, &params).map_err(|_| LOAD_FAILED.to_string())
}

/// Tokenizes with special tokens parsed as special (`<start_of_turn>` → one token).
/// BOS is added exactly when `add_bos` is set, regardless of the model's own preference.
fn tokenize(model: &LlamaModel, text: &str, add_bos: bool) -> Vec<LlamaToken> {
    let vocab = model.vocab();
    let mut tokens = Vec::new();
    if add_bos {
        tokens.push(vocab.bos());
    }
    tokens.extend(vocab.tokenize(text.as_bytes(), false, true));
    tokens
}

struct Loaded {
    path: PathBuf,
    model: LlamaModel,
    last_used: Instant,
}

/// One generation request, as sent by `mt_generate`.
pub struct GenerateRequest {
    pub req_id: u64,
    pub model_path: String,
    pub prompt: String,
    pub add_bos: bool,
    pub max_tokens: u32,
    pub stop: Vec<String>,
}

#[derive(Default)]
pub struct Engine {
    /// Held for the whole of a generation, so only one request runs at a time.
    loaded: Mutex<Option<Loaded>>,
    /// Last id passed to `mt_cancel`; a generation stops when this equals its own id.
    cancel: AtomicU64,
    /// Id of the generation currently running (or `NO_REQ`).
    running: AtomicU64,
    /// Path of the loaded model, readable without waiting for a running generation.
    current: Mutex<Option<PathBuf>>,
}

impl Engine {
    pub fn cancel(&self, req_id: u64) {
        self.cancel.store(req_id, Ordering::SeqCst);
    }

    fn current_path(&self) -> Option<PathBuf> {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Replaces the loaded model; caller holds the `loaded` lock (passed in as `slot`).
    fn set_slot(&self, slot: &mut Option<Loaded>, value: Option<Loaded>) {
        *slot = None; // drop (unmap) the old model before anything else
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = value.as_ref().map(|l| l.path.clone());
        *slot = value;
    }

    fn is_cancelled(&self, req_id: u64) -> bool {
        self.cancel.load(Ordering::SeqCst) == req_id
    }

    /// Blocking: loads the model if needed and generates. Call from `spawn_blocking`.
    pub fn generate(&self, req: &GenerateRequest) -> Result<String, String> {
        if self.is_cancelled(req.req_id) {
            // Consume the cancel so a later request reusing this id (e.g. after a webview
            // reload restarts the front-end counter) isn't cancelled by it.
            let _ = self.cancel.compare_exchange(req.req_id, NO_REQ, Ordering::SeqCst, Ordering::SeqCst);
            return Err(CANCELLED.into());
        }
        let mut guard = self.loaded.lock().unwrap_or_else(|p| p.into_inner());
        self.running.store(req.req_id, Ordering::SeqCst);
        let result = self.generate_locked(&mut guard, req);
        self.running.store(NO_REQ, Ordering::SeqCst);
        // Generation over: clear any cancel id (ours, or a stale one sent after a request
        // finished) so it can't hit a reused id later.
        self.cancel.store(NO_REQ, Ordering::SeqCst);
        if let Some(loaded) = guard.as_mut() {
            loaded.last_used = Instant::now();
        }
        result
    }

    fn generate_locked(&self, slot: &mut Option<Loaded>, req: &GenerateRequest) -> Result<String, String> {
        let want = canonical(Path::new(&req.model_path));
        if slot.as_ref().is_none_or(|l| l.path != want) {
            self.set_slot(slot, None); // free the old model before loading the new one
            let model = load_model(&want)?;
            self.set_slot(slot, Some(Loaded { path: want, model, last_used: Instant::now() }));
        }
        let model = &slot.as_ref().expect("model loaded above").model;
        if self.is_cancelled(req.req_id) {
            return Err(CANCELLED.into());
        }

        let tokens = tokenize(model, &req.prompt, req.add_bos);
        if tokens.is_empty() {
            return Err("Nothing to translate".into());
        }
        let budget = token_budget(tokens.len(), N_CTX, req.max_tokens)?;

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_batch(N_CTX);
        let mut ctx = model
            .new_context(backend()?, ctx_params)
            .map_err(|e| format!("Couldn't start the model: {e}"))?;

        let mut batch = LlamaBatch::new(N_CTX as usize, 1);
        let last = tokens.len() - 1;
        for (i, &t) in tokens.iter().enumerate() {
            batch.add(t, i as i32, &[0], i == last).map_err(|e| e.to_string())?;
        }
        ctx.decode(&mut batch).map_err(|e| e.to_string())?;

        let vocab = model.vocab();
        let mut sampler = LlamaSampler::greedy();
        let mut utf8 = Utf8Stream::default();
        let mut out = String::new();
        let start = tokens.len() as i32;
        for pos in (start..).take(budget as usize) {
            if self.is_cancelled(req.req_id) {
                return Err(CANCELLED.into());
            }
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if vocab.is_eog(token) {
                break;
            }
            utf8.push(&vocab.token_to_piece(token, true, None), &mut out);
            if let Some(cut) = truncate_at_stop(&out, &req.stop) {
                return Ok(cut);
            }
            batch.clear();
            batch.add(token, pos, &[0], true).map_err(|e| e.to_string())?;
            ctx.decode(&mut batch).map_err(|e| e.to_string())?;
        }
        utf8.finish(&mut out);
        Ok(truncate_at_stop(&out, &req.stop).unwrap_or(out))
    }

    /// Asks the in-flight generation (if any) to stop, so a following lock is quick.
    fn cancel_running(&self) {
        let running = self.running.load(Ordering::SeqCst);
        if running != NO_REQ {
            self.cancel(running);
        }
    }

    /// Drops the loaded model (waits for an in-flight generation, which is cancelled first).
    pub fn unload(&self) {
        self.cancel_running();
        let mut guard = self.loaded.lock().unwrap_or_else(|p| p.into_inner());
        self.set_slot(&mut guard, None);
    }

    /// Drops the model only if it was loaded from `path` (needed before deleting the file:
    /// Windows can't delete a memory-mapped file). A generation using that file is cancelled.
    pub fn unload_if(&self, path: &Path) {
        let target = canonical(path);
        if self.current_path().as_ref() != Some(&target) {
            return; // not holding this file; don't disturb an unrelated generation
        }
        self.cancel_running();
        let mut guard = self.loaded.lock().unwrap_or_else(|p| p.into_inner());
        if guard.as_ref().is_some_and(|l| l.path == target) {
            self.set_slot(&mut guard, None);
        }
    }

    /// Drops the model if it has been idle longer than `max_idle`. Never waits on a running
    /// generation.
    pub fn unload_if_idle(&self, max_idle: Duration) {
        if let Ok(mut guard) = self.loaded.try_lock()
            && guard.as_ref().is_some_and(|l| l.last_used.elapsed() > max_idle)
        {
            self.set_slot(&mut guard, None);
        }
    }
}

/// Starts the background thread that unloads an idle model.
pub fn spawn_idle_unloader(engine: Arc<Engine>) {
    std::thread::Builder::new()
        .name("mt-idle-unload".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(IDLE_CHECK_SECS));
            engine.unload_if_idle(Duration::from_secs(IDLE_UNLOAD_SECS));
        })
        .expect("spawn idle unload thread");
}

#[tauri::command]
pub async fn mt_generate(
    engine: State<'_, Arc<Engine>>,
    req_id: u64,
    model_path: String,
    prompt: String,
    add_bos: bool,
    max_tokens: u32,
    stop: Vec<String>,
) -> Result<String, String> {
    let engine = Arc::clone(&engine);
    let req = GenerateRequest { req_id, model_path, prompt, add_bos, max_tokens, stop };
    tauri::async_runtime::spawn_blocking(move || engine.generate(&req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mt_cancel(engine: State<'_, Arc<Engine>>, req_id: u64) {
    engine.cancel(req_id);
}

#[tauri::command]
pub async fn mt_unload(engine: State<'_, Arc<Engine>>) -> Result<(), String> {
    let engine = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || engine.unload())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_at_first_stop_string() {
        assert_eq!(truncate_at_stop("สวัสดี<end_of_turn>x", &["<end_of_turn>".into()]), Some("สวัสดี".into()));
        assert_eq!(truncate_at_stop("hello", &["<|im_end|>".into()]), None);
    }

    #[test]
    fn budget_limits() {
        assert_eq!(token_budget(100, 4096, 1024), Ok(1024));
        assert_eq!(token_budget(4000, 4096, 1024), Ok(96));
        assert_eq!(token_budget(4085, 4096, 1024), Err("Text is too long to translate".into()));
    }

    #[test]
    fn utf8_stream_buffers_split_characters() {
        let bytes = "สวัสดี".as_bytes(); // 3 bytes per Thai character
        let mut stream = Utf8Stream::default();
        let mut out = String::new();
        stream.push(&bytes[..4], &mut out);
        assert_eq!(out, "ส"); // the 4th byte waits for the rest of its character
        stream.push(&bytes[4..], &mut out);
        stream.finish(&mut out);
        assert_eq!(out, "สวัสดี");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes() {
        let mut stream = Utf8Stream::default();
        let mut out = String::new();
        stream.push(b"a\xFFb", &mut out);
        assert_eq!(out, "a\u{FFFD}b");
    }

    #[test]
    fn non_gguf_file_reports_load_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("junk.gguf");
        std::fs::write(&path, b"definitely not a model").unwrap();
        let engine = Engine::default();
        let req = GenerateRequest {
            req_id: 1,
            model_path: path.to_string_lossy().into_owned(),
            prompt: "hi".into(),
            add_bos: true,
            max_tokens: 8,
            stop: vec![],
        };
        assert_eq!(engine.generate(&req), Err(LOAD_FAILED.into()));
        let missing = GenerateRequest { model_path: dir.path().join("nope.gguf").to_string_lossy().into_owned(), ..req };
        assert_eq!(engine.generate(&missing), Err(LOAD_FAILED.into()));
    }

    #[test]
    fn cancel_before_start_only_matches_own_id() {
        let engine = Engine::default();
        let req = GenerateRequest {
            req_id: 5,
            model_path: "/nonexistent/model.gguf".into(),
            prompt: "hi".into(),
            add_bos: true,
            max_tokens: 8,
            stop: vec![],
        };
        engine.cancel(4);
        assert_eq!(engine.generate(&req), Err(LOAD_FAILED.into())); // not cancelled: other id
        engine.cancel(5);
        assert_eq!(engine.generate(&req), Err(CANCELLED.into()));
    }

    #[test]
    fn cancel_is_cleared_when_a_generation_finishes() {
        let engine = Engine::default();
        let req = |req_id| GenerateRequest {
            req_id,
            model_path: "/nonexistent/model.gguf".into(),
            prompt: "hi".into(),
            add_bos: true,
            max_tokens: 8,
            stop: vec![],
        };
        engine.cancel(5);
        assert_eq!(engine.generate(&req(5)), Err(CANCELLED.into()));
        assert_eq!(engine.cancel.load(Ordering::SeqCst), NO_REQ);
        assert_eq!(engine.generate(&req(5)), Err(LOAD_FAILED.into())); // reused id runs
        engine.cancel(9); // stale: sent after request 9 already finished
        assert_eq!(engine.generate(&req(1)), Err(LOAD_FAILED.into()));
        assert_eq!(engine.cancel.load(Ordering::SeqCst), NO_REQ);
        assert_eq!(engine.generate(&req(9)), Err(LOAD_FAILED.into()));
    }

    /// Needs a real model: PARATRANS_TEST_MODEL=/path/translategemma-4b-it-Q4_K_M.gguf cargo test -- --ignored
    #[test]
    #[ignore]
    fn translates_english_to_thai_with_real_model() {
        let path = std::env::var("PARATRANS_TEST_MODEL").expect("set PARATRANS_TEST_MODEL");
        // Same prompt as the TS TranslateGemma template (src/mt/prompt.ts) for "Welcome back" en→th.
        let prompt = "<start_of_turn>user\nYou are a professional English (en) to Thai (th) translator. \
Your goal is to accurately convey the meaning and nuances of the original English text while adhering to \
Thai grammar, vocabulary, and cultural sensitivities.\nProduce only the Thai translation, without any \
additional explanations or commentary. Please translate the following English text into Thai:\n\n\n\
Welcome back<end_of_turn>\n<start_of_turn>model\n";

        let model = load_model(Path::new(&path)).expect("model loads");
        assert_eq!(tokenize(&model, "<start_of_turn>", false).len(), 1);
        drop(model);

        let engine = Engine::default();
        let out = engine
            .generate(&GenerateRequest {
                req_id: 1,
                model_path: path,
                prompt: prompt.into(),
                add_bos: true,
                max_tokens: 64,
                stop: vec!["<end_of_turn>".into()],
            })
            .expect("generates");
        assert!(!out.trim().is_empty());
        assert!(out.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c)), "no Thai in {out:?}");
    }
}
