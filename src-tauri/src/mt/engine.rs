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
/// Every layer on the GPU (Metal) on Apple Silicon; CPU everywhere else, Intel Macs included.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const N_GPU_LAYERS: u32 = 999;
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
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

/// The context for a prompt and its token budget, rounded up to 256 and at most `N_CTX`.
pub fn context_size(prompt_tokens: usize, budget: u32) -> u32 {
    let need = prompt_tokens as u32 + budget + 16;
    (need.div_ceil(256) * 256).min(N_CTX)
}

/// Threads for llama.cpp's CPU work: every core the OS offers.
fn cpu_threads() -> i32 {
    std::thread::available_parallelism().map_or(4, |n| n.get() as i32)
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
            #[cfg(target_os = "windows")]
            load_cpu_backends();
            LlamaBackend::init().ok()
        })
        .as_ref()
        .ok_or_else(|| "Couldn't start the inference backend".to_string())
}

/// Windows builds llama.cpp with `dynamic-backends`: the CPU backend is a `ggml-cpu-*.dll` per
/// CPU variant, and nothing runs until one is loaded. Installed builds ship them next to the exe;
/// `cargo test`/`cargo run` fall back to the llama.cpp build dir baked in at compile time.
#[cfg(target_os = "windows")]
fn load_cpu_backends() {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let has_cpu_dll = |dir: &Path| {
        std::fs::read_dir(dir).is_ok_and(|entries| {
            entries.filter_map(Result::ok).any(|e| {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                name.starts_with("ggml-cpu") && name.ends_with(".dll")
            })
        })
    };
    match exe_dir {
        Some(dir) if has_cpu_dll(&dir) => llama_cpp_2::llama_backend::load_backends_from_path(&dir),
        _ => llama_cpp_2::llama_backend::load_backends(),
    }
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

/// Several prompts for one model, decoded together by `mt_generate_many`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManyPrompt {
    pub prompt: String,
    pub max_tokens: u32,
}

pub struct ManyRequest {
    pub req_id: u64,
    pub model_path: String,
    pub prompts: Vec<ManyPrompt>,
    pub add_bos: bool,
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

    /// The model at `path`, loading it (and freeing any other) first.
    fn ensure_loaded<'a>(&self, slot: &'a mut Option<Loaded>, path: &str) -> Result<&'a LlamaModel, String> {
        let want = canonical(Path::new(path));
        if slot.as_ref().is_none_or(|l| l.path != want) {
            self.set_slot(slot, None); // free the old model before loading the new one
            let model = load_model(&want)?;
            // After the first load, so it runs before llama.cpp's own exit-time cleanup.
            register_exit_hook();
            self.set_slot(slot, Some(Loaded { path: want, model, last_used: Instant::now() }));
        }
        Ok(&slot.as_ref().expect("model loaded above").model)
    }

    fn generate_locked(&self, slot: &mut Option<Loaded>, req: &GenerateRequest) -> Result<String, String> {
        let model = self.ensure_loaded(slot, &req.model_path)?;
        if self.is_cancelled(req.req_id) {
            return Err(CANCELLED.into());
        }

        let tokens = tokenize(model, &req.prompt, req.add_bos);
        if tokens.is_empty() {
            return Err("Nothing to translate".into());
        }
        let budget = token_budget(tokens.len(), N_CTX, req.max_tokens)?;

        // A context just big enough for this prompt and its reply: a 4096-token one per string is
        // mostly unused memory to allocate and clear. All cores for the CPU path (llama.cpp's own
        // default is 4); the GPU path doesn't use them.
        let n_ctx = context_size(tokens.len(), budget);
        let threads = cpu_threads();
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(n_ctx)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = model
            .new_context(backend()?, ctx_params)
            .map_err(|e| format!("Couldn't start the model: {e}"))?;

        let mut batch = LlamaBatch::new(n_ctx as usize, 1);
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

    /// Blocking: several prompts decoded together, one sequence each, in one context. On a GPU a step
    /// for several sequences costs about as much as for one, so this is much faster than one at a
    /// time. Each prompt gets its own result (an over-long one fails alone); a cancel fails them all.
    pub fn generate_many(&self, req: &ManyRequest) -> Result<Vec<Result<String, String>>, String> {
        if self.is_cancelled(req.req_id) {
            let _ = self.cancel.compare_exchange(req.req_id, NO_REQ, Ordering::SeqCst, Ordering::SeqCst);
            return Err(CANCELLED.into());
        }
        let mut guard = self.loaded.lock().unwrap_or_else(|p| p.into_inner());
        self.running.store(req.req_id, Ordering::SeqCst);
        let result = self.generate_many_locked(&mut guard, req);
        self.running.store(NO_REQ, Ordering::SeqCst);
        self.cancel.store(NO_REQ, Ordering::SeqCst);
        if let Some(loaded) = guard.as_mut() {
            loaded.last_used = Instant::now();
        }
        result
    }

    fn generate_many_locked(&self, slot: &mut Option<Loaded>, req: &ManyRequest) -> Result<Vec<Result<String, String>>, String> {
        let model = self.ensure_loaded(slot, &req.model_path)?;
        if self.is_cancelled(req.req_id) {
            return Err(CANCELLED.into());
        }
        let mut results: Vec<Result<String, String>> = vec![Err(CANCELLED.into()); req.prompts.len()];
        // The prompts that can run: tokenized, with their budget. The others fail on their own.
        struct Seq {
            at: usize,
            tokens: Vec<LlamaToken>,
            budget: u32,
            out: String,
            utf8: Utf8Stream,
            pos: i32,
            /// Index in the current batch of this sequence's last token (where its logits are).
            logit: i32,
            done: bool,
        }
        let mut seqs = Vec::new();
        for (at, p) in req.prompts.iter().enumerate() {
            let tokens = tokenize(model, &p.prompt, req.add_bos);
            if tokens.is_empty() {
                results[at] = Err("Nothing to translate".into());
                continue;
            }
            match token_budget(tokens.len(), N_CTX, p.max_tokens) {
                Ok(budget) => seqs.push(Seq { at, tokens, budget, out: String::new(), utf8: Utf8Stream::default(), pos: 0, logit: 0, done: false }),
                Err(e) => results[at] = Err(e),
            }
        }
        if seqs.is_empty() {
            return Ok(results);
        }
        // One shared (unified) cache for all sequences, sized to what they need together.
        let n_ctx: u32 = seqs.iter().map(|q| context_size(q.tokens.len(), q.budget)).sum();
        let prompt_tokens: usize = seqs.iter().map(|q| q.tokens.len()).sum();
        let threads = cpu_threads();
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(prompt_tokens.max(seqs.len()) as u32)
            .with_n_seq_max(seqs.len() as u32)
            .with_kv_unified(true)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = model
            .new_context(backend()?, ctx_params)
            .map_err(|e| format!("Couldn't start the model: {e}"))?;

        // All prompts in one batch, each in its own sequence; logits only for each one's last token.
        let mut batch = LlamaBatch::new(prompt_tokens.max(seqs.len()), seqs.len() as i32);
        for (s, q) in seqs.iter_mut().enumerate() {
            let last = q.tokens.len() - 1;
            for (i, &t) in q.tokens.iter().enumerate() {
                batch.add(t, i as i32, &[s as i32], i == last).map_err(|e| e.to_string())?;
            }
            q.pos = q.tokens.len() as i32;
            q.logit = batch.n_tokens() - 1;
        }
        ctx.decode(&mut batch).map_err(|e| e.to_string())?;

        let vocab = model.vocab();
        let mut sampler = LlamaSampler::greedy();
        loop {
            if self.is_cancelled(req.req_id) {
                return Err(CANCELLED.into());
            }
            // Next token for every running sequence; finished ones drop out of the batch.
            let mut next = Vec::new();
            for (s, q) in seqs.iter_mut().enumerate() {
                if q.done {
                    continue;
                }
                let token = sampler.sample(&ctx, q.logit);
                let generated = (q.pos - q.tokens.len() as i32) as u32;
                if vocab.is_eog(token) || generated >= q.budget {
                    q.done = true;
                    continue;
                }
                q.utf8.push(&vocab.token_to_piece(token, true, None), &mut q.out);
                if truncate_at_stop(&q.out, &req.stop).is_some() {
                    q.done = true;
                    continue;
                }
                next.push((s, token));
            }
            if next.is_empty() {
                break;
            }
            batch.clear();
            for &(s, token) in &next {
                let q = &mut seqs[s];
                batch.add(token, q.pos, &[s as i32], true).map_err(|e| e.to_string())?;
                q.pos += 1;
                q.logit = batch.n_tokens() - 1;
            }
            ctx.decode(&mut batch).map_err(|e| e.to_string())?;
        }
        for mut q in seqs {
            q.utf8.finish(&mut q.out);
            results[q.at] = Ok(truncate_at_stop(&q.out, &req.stop).unwrap_or(q.out));
        }
        Ok(results)
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

/// The engine whose model must be released before the process exits.
static EXIT_ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();

/// Makes sure `engine`'s model is released before the process exits.
///
/// llama.cpp frees its Metal device in a C++ static destructor and asserts that every GPU
/// buffer was released first; a model still loaded at exit (the app's engine is never dropped)
/// made quitting abort ("quit unexpectedly"). The release runs from an `atexit` handler that is
/// registered after the first model load: exit handlers run in reverse order of registration,
/// and llama.cpp registers its destructor during that load, so ours always runs first.
pub fn unload_at_exit(engine: Arc<Engine>) {
    let _ = EXIT_ENGINE.set(engine);
}

fn register_exit_hook() {
    static REGISTERED: std::sync::Once = std::sync::Once::new();
    unsafe extern "C" {
        fn atexit(cb: extern "C" fn()) -> std::ffi::c_int;
    }
    REGISTERED.call_once(|| {
        // SAFETY: registering a plain `extern "C"` function with the C runtime.
        unsafe {
            atexit(unload_before_exit);
        }
    });
}

extern "C" fn unload_before_exit() {
    let Some(engine) = EXIT_ENGINE.get() else { return };
    engine.cancel_running();
    // A generation stops at its next token once cancelled; don't hang the exit if it doesn't.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(mut guard) = engine.loaded.try_lock() {
            engine.set_slot(&mut guard, None);
            return;
        }
        if Instant::now() > deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Several prompts at once (see `Engine::generate_many`): one result per prompt, in order.
#[tauri::command]
pub async fn mt_generate_many(
    engine: State<'_, Arc<Engine>>,
    req_id: u64,
    model_path: String,
    prompts: Vec<ManyPrompt>,
    add_bos: bool,
    stop: Vec<String>,
) -> Result<Vec<Result<String, String>>, String> {
    let engine = Arc::clone(&engine);
    let req = ManyRequest { req_id, model_path, prompts, add_bos, stop };
    tauri::async_runtime::spawn_blocking(move || engine.generate_many(&req))
        .await
        .map_err(|e| e.to_string())?
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

    /// Engine smoke test (also run by CI on Windows) with the 1.2 MB stories260K model:
    /// RETRANS_SMOKE_MODEL=/path/stories260K-f32.gguf cargo test generates_with_tiny_model -- --ignored
    #[test]
    #[ignore]
    fn generates_with_tiny_model() {
        let path = std::env::var("RETRANS_SMOKE_MODEL").expect("set RETRANS_SMOKE_MODEL");
        let out = Engine::default()
            .generate(&GenerateRequest {
                req_id: 1,
                model_path: path,
                prompt: "Once upon a time".into(),
                add_bos: true,
                max_tokens: 16,
                stop: vec![],
            })
            .expect("generates");
        assert!(!out.is_empty(), "empty output");
    }

    /// Regression: quitting while a model is loaded aborted the app ("quit unexpectedly").
    /// llama.cpp's Metal device is freed by a C++ static destructor at exit, which asserts that
    /// every GPU buffer was already released. The child process loads a model into an engine
    /// that is never dropped (as the app's managed state) and exits; it must exit cleanly.
    /// RETRANS_SMOKE_MODEL=/path/stories260K-f32.gguf cargo test exit_with_loaded_model -- --ignored
    #[test]
    #[ignore]
    fn exit_with_loaded_model_does_not_abort() {
        let model = std::env::var("RETRANS_SMOKE_MODEL").expect("set RETRANS_SMOKE_MODEL");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["mt::engine::tests::exit_child_loads_model_then_exits", "--ignored", "--exact", "--nocapture"])
            .env("RETRANS_EXIT_CHILD", &model)
            .status()
            .expect("spawn child");
        assert!(status.success(), "child exited with {status:?} (abort at exit?)");
    }

    /// Child half of `exit_with_loaded_model_does_not_abort`; does nothing unless spawned by it.
    #[test]
    #[ignore]
    fn exit_child_loads_model_then_exits() {
        let Ok(model) = std::env::var("RETRANS_EXIT_CHILD") else { return };
        let engine = Arc::new(Engine::default());
        unload_at_exit(engine.clone());
        engine
            .generate(&GenerateRequest {
                req_id: 1,
                model_path: model,
                prompt: "Once upon a time".into(),
                add_bos: true,
                max_tokens: 4,
                stop: vec![],
            })
            .expect("generates");
        std::mem::forget(engine); // like the app: the engine lives until the process ends
        std::process::exit(0);
    }

    /// Needs a real model: RETRANS_TEST_MODEL=/path/translategemma-4b-it-Q4_K_M.gguf cargo test -- --ignored
    #[test]
    #[ignore]
    fn translates_english_to_thai_with_real_model() {
        let path = std::env::var("RETRANS_TEST_MODEL").expect("set RETRANS_TEST_MODEL");
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

    /// Speed of the built-in model on typical UI strings (prints ms per string; nothing asserted):
    /// RETRANS_TEST_MODEL=/path/translategemma-4b-it-Q4_K_M.gguf cargo test bench_ui_strings -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_ui_strings() {
        let path = std::env::var("RETRANS_TEST_MODEL").expect("set RETRANS_TEST_MODEL");
        let texts = [
            "Save", "Cancel", "Delete account", "Welcome back, {{name}}!", "Sign in with Google",
            "Your password must be at least 8 characters long.", "Settings", "Log out",
            "Are you sure you want to delete this project? This can't be undone.", "Search…",
            "No results found", "Upload a file", "Profile updated", "Something went wrong. Please try again.",
            "Terms of Service", "Privacy Policy", "Next", "Back", "Invite your team", "You have {{count}} new messages",
        ];
        let prompt = |t: &str| {
            format!(
                "<start_of_turn>user\nYou are a professional English (en) to Thai (th) translator. Your goal is to \
accurately convey the meaning and nuances of the original English text while adhering to Thai grammar, vocabulary, \
and cultural sensitivities.\nProduce only the Thai translation, without any additional explanations or commentary. \
Please translate the following English text into Thai:\n\n\n{t}<end_of_turn>\n<start_of_turn>model\n"
            )
        };
        let engine = Engine::default();
        let run = |id: u64, t: &str| {
            engine
                .generate(&GenerateRequest {
                    req_id: id,
                    model_path: path.clone(),
                    prompt: prompt(t),
                    add_bos: true,
                    max_tokens: (64 + t.len() * 4).min(1024) as u32,
                    stop: vec!["<end_of_turn>".into()],
                })
                .expect("generates")
        };
        run(1, "Hello"); // load the model first: not part of the timing
        let started = Instant::now();
        for (i, t) in texts.iter().enumerate() {
            run(i as u64 + 2, t);
        }
        let ms = started.elapsed().as_millis();
        println!("BENCH {} strings in {ms} ms = {} ms/string", texts.len(), ms / texts.len() as u128);

        // The same strings decoded together, `group` at a time: speed, and whether the text matches.
        let one_by_one: Vec<String> = texts.iter().enumerate().map(|(i, t)| run(100 + i as u64, t)).collect();
        // Similar lengths together: a group runs until its longest string is done.
        let mut order: Vec<usize> = (0..texts.len()).collect();
        order.sort_by_key(|&i| texts[i].len());
        for group in [8usize, 16] {
            let started = Instant::now();
            let mut together = vec![String::new(); texts.len()];
            for (g, idx) in order.chunks(group).enumerate() {
                let chunk: Vec<&str> = idx.iter().map(|&i| texts[i]).collect();
                let out = engine
                    .generate_many(&ManyRequest {
                        req_id: 1000 + g as u64,
                        model_path: path.clone(),
                        prompts: chunk
                            .iter()
                            .map(|t| ManyPrompt { prompt: prompt(t), max_tokens: (64 + t.len() * 4).min(1024) as u32 })
                            .collect(),
                        add_bos: true,
                        stop: vec!["<end_of_turn>".into()],
                    })
                    .expect("generates");
                for (&i, r) in idx.iter().zip(out) {
                    together[i] = r.expect("each generates");
                }
            }
            let ms = started.elapsed().as_millis();
            let same = together.iter().zip(&one_by_one).filter(|(a, b)| a == b).count();
            println!("BENCH together x{group}: {ms} ms = {} ms/string; {same}/{} identical", ms / texts.len() as u128, texts.len());
            for (a, b) in together.iter().zip(&one_by_one).filter(|(a, b)| a != b) {
                println!("  differs: {b:?} vs {a:?}");
            }
        }
    }
}
