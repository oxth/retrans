//! ACP (Agent Client Protocol) client: runs a local agent (Claude Code, Codex, Gemini CLI…) over
//! stdio and sends it translation work. The agent can only reply with text:
//! - Retrans advertises no file-system or terminal capability;
//! - every permission request is answered "cancelled";
//! - any fs/terminal request gets "method not found";
//! - the session's working folder is a fresh empty temp folder, never the project.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, Notify, mpsc, oneshot};

const IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRequest {
    pub command: String,
    pub args: Vec<String>,
    pub text: String,
    pub req_id: u64,
}

/// One running agent with one ACP session.
pub struct Agent {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// Where the current turn's text chunks go; None between turns (late chunks are dropped).
    sink: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<String>>>>,
    stderr_tail: Arc<std::sync::Mutex<String>>,
    next_id: AtomicU64,
    /// One turn at a time.
    turn: Mutex<()>,
    last_used: std::sync::Mutex<Instant>,
    pub cwd: PathBuf,
}

/**
 * The PATH of the user's login shell. Apps opened from the Dock/Finder get a minimal PATH, so
 * `npx`, `gemini` and friends wouldn't be found otherwise. Looked up once; None on Windows.
 */
async fn login_path() -> Option<String> {
    static PATH: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
    PATH.get_or_init(|| async {
        if cfg!(windows) {
            return None;
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        // Between markers: an rc file that prints a greeting can't spoil the PATH read.
        let out = tokio::time::timeout(
            Duration::from_secs(3),
            Command::new(shell)
                .args([
                    "-ilc",
                    "printf '__RETRANS_PATH__%s__RETRANS_END__' \"$PATH\"",
                ])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        path_between_markers(&String::from_utf8_lossy(&out.stdout))
    })
    .await
    .clone()
}

fn path_between_markers(out: &str) -> Option<String> {
    let start = out.find("__RETRANS_PATH__")? + "__RETRANS_PATH__".len();
    let end = start + out[start..].find("__RETRANS_END__")?;
    let p = out[start..end].trim();
    (!p.is_empty()).then(|| p.to_string())
}

/// How long an agent gets to answer `initialize` (it may first be downloaded by npx).
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// How long an agent gets to open a session.
const SESSION_TIMEOUT: Duration = Duration::from_secs(60);

fn fresh_cwd() -> std::io::Result<PathBuf> {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "retrans-acp-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

impl Agent {
    /// Starts the agent and initializes the protocol. Each prompt opens its own session.
    pub async fn start(
        command: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<Arc<Agent>, String> {
        Self::start_within(command, args, env, START_TIMEOUT).await
    }

    /// `start`, giving up (and stopping the process) if `initialize` isn't answered within `limit`.
    pub async fn start_within(
        command: &str,
        args: &[String],
        env: &[(String, String)],
        limit: Duration,
    ) -> Result<Arc<Agent>, String> {
        let cwd = fresh_cwd().map_err(|e| e.to_string())?;
        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = login_path().await {
            cmd.env("PATH", path);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Couldn't start {command}: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;

        let pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::default();
        let sink: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<String>>>> = Arc::default();
        let stderr_tail: Arc<std::sync::Mutex<String>> = Arc::default();
        let (to_agent_tx, mut to_agent_rx) = mpsc::unbounded_channel::<Value>();

        // stderr: keep the last bit, for error messages.
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut t = tail.lock().unwrap();
                t.push_str(&String::from_utf8_lossy(&buf[..n]));
                let len = t.chars().count();
                if len > 500 {
                    *t = t.chars().skip(len - 500).collect();
                }
            }
        });

        // stdout: responses to our requests, the agent's requests (refused), and text chunks.
        let (p, s) = (pending.clone(), sink.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(m) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let id = m.get("id").cloned();
                match (m.get("method").and_then(Value::as_str), id) {
                    (None, Some(id)) => {
                        if let Some(tx) = id.as_u64().and_then(|i| p.lock().unwrap().remove(&i)) {
                            let _ = tx.send(m);
                        }
                    }
                    (Some("session/request_permission"), Some(id)) => {
                        let _ = to_agent_tx.send(json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "cancelled" } } }));
                    }
                    (Some(_), Some(id)) => {
                        let _ = to_agent_tx.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Retrans doesn't allow this" } }));
                    }
                    (Some("session/update"), None) => {
                        let u = &m["params"]["update"];
                        if u["sessionUpdate"] == "agent_message_chunk"
                            && u["content"]["type"] == "text"
                            && let Some(text) = u["content"]["text"].as_str()
                            && let Some(tx) = s.lock().unwrap().as_ref()
                        {
                            let _ = tx.send(text.to_string());
                        }
                    }
                    _ => {}
                }
            }
            // The agent is gone: fail whatever still waits.
            p.lock().unwrap().clear();
        });

        let agent = Arc::new(Agent {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            sink,
            stderr_tail,
            next_id: AtomicU64::new(1),
            turn: Mutex::new(()),
            last_used: std::sync::Mutex::new(Instant::now()),
            cwd: cwd.clone(),
        });
        // Replies to the agent's requests go out through the same stdin.
        let a = agent.clone();
        tokio::spawn(async move {
            while let Some(m) = to_agent_rx.recv().await {
                if a.write(&m).await.is_err() {
                    break;
                }
            }
        });

        let init = agent.call(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "Retrans", "version": env!("CARGO_PKG_VERSION") },
            }),
        );
        match tokio::time::timeout(limit, init).await {
            Ok(Ok(_)) => Ok(agent),
            Ok(Err(e)) => {
                agent.kill().await;
                Err(e)
            }
            Err(_) => {
                agent.kill().await;
                Err(format!(
                    "The agent didn't answer — is \"{command}\" an ACP agent?"
                ))
            }
        }
    }

    async fn write(&self, m: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(m).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut w = self.stdin.lock().await;
        w.write_all(&line).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    fn died(&self) -> String {
        let tail = self.stderr_tail.lock().unwrap().trim().to_string();
        if tail.is_empty() {
            "The agent stopped.".into()
        } else {
            format!("The agent stopped: {tail}")
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        let m = rx.await.map_err(|_| self.died())?;
        if let Some(e) = m.get("error") {
            return Err(format!(
                "Agent: {}",
                e["message"].as_str().unwrap_or("error")
            ));
        }
        Ok(m["result"].clone())
    }

    /// One prompt turn in a fresh session (no history carried between batches or projects): the
    /// agent's reply text. `stop` cancels it (session/cancel is sent once a session is open).
    pub async fn prompt(&self, text: &str, stop: Arc<Notify>) -> Result<String, String> {
        let _turn = self.turn.lock().await;
        *self.last_used.lock().unwrap() = Instant::now();
        let opened = tokio::select! {
            r = tokio::time::timeout(SESSION_TIMEOUT, self.call("session/new", json!({ "cwd": self.cwd, "mcpServers": [] }))) => r,
            _ = stop.notified() => return Err("cancelled".to_string()),
        };
        let session = match opened {
            Ok(Ok(s)) => s["sessionId"]
                .as_str()
                .ok_or("The agent didn't open a session")?
                .to_string(),
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("The agent didn't open a session in time.".into()),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        *self.sink.lock().unwrap() = Some(tx);
        let params = json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] });
        let out = tokio::select! {
            r = self.call("session/prompt", params) => r.map(|_| ()),
            _ = stop.notified() => {
                let _ = self.write(&json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } })).await;
                Err("cancelled".to_string())
            }
        };
        *self.sink.lock().unwrap() = None; // late chunks are dropped
        *self.last_used.lock().unwrap() = Instant::now();
        out?;
        let mut reply = String::new();
        while let Ok(t) = rx.try_recv() {
            reply.push_str(&t);
        }
        Ok(reply)
    }

    pub async fn kill(&self) {
        let _ = self.child.lock().await.kill().await;
        let _ = std::fs::remove_dir_all(&self.cwd);
    }
}

/// Running agents by command line, and turns in flight by request id.
#[derive(Default)]
pub struct AcpAgents {
    agents: Mutex<HashMap<String, Arc<Agent>>>,
    turns: std::sync::Mutex<HashMap<u64, Arc<Notify>>>,
}

impl AcpAgents {
    async fn get(
        &self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<Arc<Agent>, String> {
        let key = format!("{command}\0{}", args.join("\0"));
        let mut agents = self.agents.lock().await;
        // Agents idle for a while are stopped.
        let idle: Vec<String> = agents
            .iter()
            .filter(|(k, a)| **k != key && a.last_used.lock().unwrap().elapsed() > IDLE)
            .map(|(k, _)| k.clone())
            .collect();
        for k in idle {
            if let Some(a) = agents.remove(&k) {
                a.kill().await;
            }
        }
        if let Some(a) = agents.get(&key) {
            if a.child
                .lock()
                .await
                .try_wait()
                .map(|s| s.is_none())
                .unwrap_or(false)
            {
                return Ok(a.clone());
            }
            agents.remove(&key);
        }
        // Start outside the lock: a slow or silent agent must not block other agents or quitting.
        drop(agents);
        let a = Agent::start(command, args, env).await?;
        let mut agents = self.agents.lock().await;
        if let Some(existing) = agents.get(&key) {
            a.kill().await; // another turn started the same agent meanwhile
            return Ok(existing.clone());
        }
        agents.insert(key, a.clone());
        Ok(a)
    }

    /// One turn with the agent for `command args`, started if needed. `stop` also cancels a start.
    pub async fn prompt_with(
        &self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        text: &str,
        stop: Arc<Notify>,
    ) -> Result<String, String> {
        let agent = tokio::select! {
            a = self.get(command, args, env) => a?,
            _ = stop.notified() => return Err("cancelled".to_string()),
        };
        agent.prompt(text, stop).await
    }

    pub async fn stop_all(&self) {
        for (_, a) in self.agents.lock().await.drain() {
            a.kill().await;
        }
    }
}

#[tauri::command]
pub async fn mt_acp_prompt(
    agents: State<'_, AcpAgents>,
    req: AcpRequest,
) -> Result<String, String> {
    // Registered before the agent starts, so Cancel works while it's starting too.
    let stop = Arc::new(Notify::new());
    agents
        .turns
        .lock()
        .unwrap()
        .insert(req.req_id, stop.clone());
    let out = agents
        .prompt_with(&req.command, &req.args, &[], &req.text, stop)
        .await;
    agents.turns.lock().unwrap().remove(&req.req_id);
    out
}

#[tauri::command]
pub fn mt_acp_cancel(agents: State<'_, AcpAgents>, req_id: u64) {
    if let Some(n) = agents.turns.lock().unwrap().get(&req_id) {
        n.notify_one();
    }
}

#[tauri::command]
pub async fn mt_acp_stop(agents: State<'_, AcpAgents>) -> Result<(), String> {
    agents.stop_all().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake() -> Option<(String, Vec<String>)> {
        let node = which("node")?;
        let script =
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-acp.mjs").to_string();
        Some((node, vec![script]))
    }

    fn which(bin: &str) -> Option<String> {
        let out = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(bin)
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .to_string();
        (!s.is_empty()).then_some(s)
    }

    fn log_of(path: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    async fn start(extra: &[(&str, &str)]) -> Option<(Arc<Agent>, tempfile::TempDir)> {
        let Some((node, args)) = fake() else {
            eprintln!("node not found: skipping ACP test");
            return None;
        };
        let dir = tempfile::tempdir().unwrap();
        let mut env = vec![(
            "FAKE_ACP_LOG".to_string(),
            dir.path().join("log.jsonl").to_string_lossy().to_string(),
        )];
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        Some((Agent::start(&node, &args, &env).await.unwrap(), dir))
    }

    #[tokio::test]
    async fn full_turn_returns_agent_text() {
        let Some((a, _d)) = start(&[]).await else {
            return;
        };
        assert_eq!(
            a.prompt("translate this", Arc::new(Notify::new())).await,
            Ok("Hello world".into())
        );
        a.kill().await;
    }

    #[tokio::test]
    async fn permission_requests_are_refused_and_fs_requests_error() {
        let Some((a, d)) = start(&[]).await else {
            return;
        };
        a.prompt("x", Arc::new(Notify::new())).await.unwrap();
        let log = log_of(&d.path().join("log.jsonl"));
        let reply = |id: u64| {
            log.iter()
                .find(|m| m["id"] == id && m.get("method").is_none())
                .cloned()
                .unwrap()
        };
        assert_eq!(reply(100)["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(reply(101)["error"]["code"], -32601);
        a.kill().await;
    }

    #[tokio::test]
    async fn initialize_advertises_no_fs_or_terminal() {
        let Some((a, d)) = start(&[]).await else {
            return;
        };
        let log = log_of(&d.path().join("log.jsonl"));
        let init = log.iter().find(|m| m["method"] == "initialize").unwrap();
        assert_eq!(
            init["params"]["clientCapabilities"],
            json!({ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false })
        );
        a.kill().await;
    }

    #[tokio::test]
    async fn session_cwd_is_an_empty_temp_dir_not_the_project() {
        let Some((a, d)) = start(&[]).await else {
            return;
        };
        a.prompt("x", Arc::new(Notify::new())).await.unwrap(); // sessions open per turn
        let log = log_of(&d.path().join("log.jsonl"));
        let new = log.iter().find(|m| m["method"] == "session/new").unwrap();
        let cwd = PathBuf::from(new["params"]["cwd"].as_str().unwrap());
        assert!(cwd.starts_with(std::env::temp_dir()), "{cwd:?}");
        assert_eq!(std::fs::read_dir(&cwd).unwrap().count(), 0);
        assert_eq!(new["params"]["mcpServers"], json!([]));
        a.kill().await;
        assert!(!cwd.exists());
    }

    #[tokio::test]
    async fn cancel_sends_session_cancel_and_drops_late_chunks() {
        let Some((a, d)) = start(&[("FAKE_ACP_SLOW", "1")]).await else {
            return;
        };
        let stop = Arc::new(Notify::new());
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            s2.notify_one();
        });
        assert_eq!(a.prompt("x", stop).await, Err("cancelled".into()));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            log_of(&d.path().join("log.jsonl"))
                .iter()
                .any(|m| m["method"] == "session/cancel")
        );
        a.kill().await;
    }

    #[tokio::test]
    async fn agent_exit_mid_turn_is_an_error_with_its_stderr_tail() {
        let Some((a, _d)) = start(&[("FAKE_ACP_DIE", "1")]).await else {
            return;
        };
        let err = a.prompt("x", Arc::new(Notify::new())).await.unwrap_err();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let err = if err.contains("out of tokens") {
            err
        } else {
            a.died()
        };
        assert!(err.contains("out of tokens"), "{err}");
    }

    #[tokio::test]
    async fn a_silent_agent_times_out_instead_of_hanging() {
        let Some((node, args)) = fake() else { return };
        let env = vec![("FAKE_ACP_SILENT".to_string(), "1".to_string())];
        let started = std::time::Instant::now();
        let err = Agent::start_within(&node, &args, &env, Duration::from_millis(400))
            .await
            .err()
            .unwrap();
        assert!(err.contains("didn't answer"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn a_cancel_during_agent_start_is_not_lost() {
        let Some((node, args)) = fake() else { return };
        let agents = AcpAgents::default();
        let stop = Arc::new(Notify::new());
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            s2.notify_one();
        });
        let env = vec![("FAKE_ACP_SILENT".to_string(), "1".to_string())];
        let started = std::time::Instant::now();
        let out = agents.prompt_with(&node, &args, &env, "x", stop).await;
        assert_eq!(out, Err("cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(3));
        // Quitting isn't blocked by the half-started agent.
        tokio::time::timeout(Duration::from_secs(3), agents.stop_all())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn each_prompt_opens_a_new_session() {
        let Some((a, d)) = start(&[]).await else {
            return;
        };
        a.prompt("one", Arc::new(Notify::new())).await.unwrap();
        a.prompt("two", Arc::new(Notify::new())).await.unwrap();
        let news = log_of(&d.path().join("log.jsonl"))
            .iter()
            .filter(|m| m["method"] == "session/new")
            .count();
        assert_eq!(news, 2);
        a.kill().await;
    }

    #[test]
    fn login_path_is_read_between_markers() {
        assert_eq!(
            path_between_markers(
                "Welcome!\n__RETRANS_PATH__/opt/homebrew/bin:/usr/bin__RETRANS_END__\nbye"
            ),
            Some("/opt/homebrew/bin:/usr/bin".into())
        );
        assert_eq!(path_between_markers("no markers here"), None);
    }
}
