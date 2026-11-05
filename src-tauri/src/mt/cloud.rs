//! Cloud translation providers: OpenAI (ChatGPT), Claude (Anthropic) and any OpenAI-compatible
//! API (OpenRouter, Groq, DeepSeek, Ollama, LM Studio…). Keys are read here from the credential
//! store and never reach the frontend. 429/5xx are retried with backoff; requests can be cancelled.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::State;
use tokio::sync::Notify;

use crate::secrets::{KEY_MESSAGE, SecretError, SecretStore, Secrets, secret_get};

const RETRIES: u32 = 3;
const OPENAI_BASE: &str = "https://api.openai.com/v1";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    OpenAi,
    Anthropic,
}

#[derive(Debug)]
pub struct Endpoint {
    kind: Kind,
    base: String,
    key: Option<String>,
    label: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRequest {
    pub provider: String,
    pub base_url: Option<String>,
    pub model: String,
    pub system: String,
    pub user: String,
    pub req_id: u64,
}

/// Requests in flight, by id, so they can be cancelled.
#[derive(Default)]
pub struct CloudCalls(Mutex<HashMap<u64, Arc<Notify>>>);

fn trim_base(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

/// Where to send, and with which key. `base_url` is only used for "compatible": OpenAI and Claude
/// keys always go to their own hosts, whatever the frontend passes.
pub fn endpoint(
    store: &dyn SecretStore,
    provider: &str,
    base_url: Option<&str>,
) -> Result<Endpoint, String> {
    endpoint_with(store, provider, base_url, None)
}

/// `endpoint`, with the OpenAI/Claude host replaced (tests only, pointing at a fake server).
pub(crate) fn endpoint_with(
    store: &dyn SecretStore,
    provider: &str,
    base_url: Option<&str>,
    fixed_base: Option<&str>,
) -> Result<Endpoint, String> {
    let need = |account: &str| match secret_get(store, account) {
        Ok(k) => Ok(Some(k)),
        Err(_) => Err(KEY_MESSAGE.to_string()),
    };
    match provider {
        "openai" => Ok(Endpoint {
            kind: Kind::OpenAi,
            base: trim_base(fixed_base.unwrap_or(OPENAI_BASE)),
            key: need("openai")?,
            label: "OpenAI",
        }),
        "anthropic" => Ok(Endpoint {
            kind: Kind::Anthropic,
            base: trim_base(fixed_base.unwrap_or(ANTHROPIC_BASE)),
            key: need("anthropic")?,
            label: "Claude",
        }),
        "compatible" => {
            let base = trim_base(base_url.ok_or("Set the API base URL first.")?);
            // A local server (Ollama, LM Studio) needs no key.
            let key = match secret_get(store, &format!("compatible:{base}")) {
                Ok(k) => Some(k),
                Err(SecretError::Missing) => None,
                Err(SecretError::Denied(_)) => return Err(KEY_MESSAGE.to_string()),
            };
            Ok(Endpoint {
                kind: Kind::OpenAi,
                base,
                key,
                label: "OpenAI-compatible",
            })
        }
        other => Err(format!("Unknown provider \"{other}\"")),
    }
}

fn request(
    client: &reqwest::Client,
    ep: &Endpoint,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    let mut r = client.request(method, format!("{}{path}", ep.base));
    match (ep.kind, &ep.key) {
        (Kind::OpenAi, Some(k)) => r = r.bearer_auth(k),
        (Kind::Anthropic, Some(k)) => {
            r = r
                .header("x-api-key", k)
                .header("anthropic-version", "2023-06-01")
        }
        _ => {}
    }
    r
}

/// The provider's own error message, if its body has one.
fn error_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let m = v
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| v.get("message").and_then(Value::as_str));
    match m {
        Some(m) => m.to_string(),
        None => body.chars().take(300).collect(),
    }
}

async fn send_with_retries(
    req: impl Fn() -> reqwest::RequestBuilder,
    label: &str,
    backoff: impl Fn(u32) -> Duration,
) -> Result<String, String> {
    let mut attempt = 0;
    loop {
        let res = req().send().await.map_err(|e| format!("{label}: {e}"))?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let body = res.text().await.map_err(|e| format!("{label}: {e}"))?;
        match status {
            200..=299 => return Ok(body),
            401 | 403 => return Err("The API key was rejected.".into()),
            429 | 500..=599 if attempt < RETRIES => {
                let wait = if retry_after.is_some() {
                    retry_wait(retry_after, attempt)
                } else {
                    backoff(attempt)
                };
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
            // Out of credit is a 429 too: show the provider's own words when it gives some.
            429 => {
                let m = error_message(&body);
                return Err(if m.trim().is_empty() || m.trim() == "{}" {
                    "Rate limited — try again in a minute.".into()
                } else {
                    format!("Rate limited — try again in a minute. {label}: {m}")
                });
            }
            _ => return Err(format!("{label}: {}", error_message(&body))),
        }
    }
}

/// The longest a provider's Retry-After may make a run wait.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// How long to wait before retry `attempt`: the provider's Retry-After (capped), else 1, 2, 4 s.
fn retry_wait(retry_after: Option<Duration>, attempt: u32) -> Duration {
    retry_after.map_or_else(|| default_backoff(attempt), |d| d.min(MAX_WAIT))
}

fn default_backoff(attempt: u32) -> Duration {
    Duration::from_secs(1 << attempt)
}

/// One chat turn: the reply text.
pub async fn chat(
    client: &reqwest::Client,
    ep: &Endpoint,
    model: &str,
    system: &str,
    user: &str,
    backoff: impl Fn(u32) -> Duration,
) -> Result<String, String> {
    let body = match ep.kind {
        Kind::OpenAi => json!({
            "model": model, "temperature": 0,
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
        }),
        Kind::Anthropic => json!({
            "model": model, "system": system, "max_tokens": 8192,
            "messages": [{ "role": "user", "content": user }],
        }),
    };
    let path = if ep.kind == Kind::Anthropic {
        "/v1/messages"
    } else {
        "/chat/completions"
    };
    let text = send_with_retries(
        || request(client, ep, reqwest::Method::POST, path).json(&body),
        ep.label,
        backoff,
    )
    .await?;
    let v: Value =
        serde_json::from_str(&text).map_err(|_| format!("{}: unexpected reply", ep.label))?;
    let out = match ep.kind {
        Kind::OpenAi => v
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        Kind::Anthropic => v.get("content").and_then(Value::as_array).map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<String>()
        }),
    };
    out.ok_or_else(|| format!("{}: unexpected reply", ep.label))
}

/// The provider's model ids, sorted.
pub async fn models(client: &reqwest::Client, ep: &Endpoint) -> Result<Vec<String>, String> {
    let path = if ep.kind == Kind::Anthropic {
        "/v1/models"
    } else {
        "/models"
    };
    let text = send_with_retries(
        || request(client, ep, reqwest::Method::GET, path),
        ep.label,
        default_backoff,
    )
    .await?;
    let v: Value =
        serde_json::from_str(&text).map_err(|_| format!("{}: unexpected reply", ep.label))?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mt_cloud_chat(
    secrets: State<'_, Secrets>,
    calls: State<'_, CloudCalls>,
    req: CloudRequest,
) -> Result<String, String> {
    let ep = endpoint(secrets.0.as_ref(), &req.provider, req.base_url.as_deref())?;
    let stop = Arc::new(Notify::new());
    calls
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(req.req_id, stop.clone());
    let c = client()?;
    let out = tokio::select! {
        r = chat(&c, &ep, &req.model, &req.system, &req.user, default_backoff) => r,
        _ = stop.notified() => Err("cancelled".to_string()),
    };
    if let Ok(mut m) = calls.0.lock() {
        m.remove(&req.req_id);
    }
    out
}

#[tauri::command]
pub fn mt_cloud_cancel(calls: State<'_, CloudCalls>, req_id: u64) -> Result<(), String> {
    if let Some(n) = calls.0.lock().map_err(|e| e.to_string())?.get(&req_id) {
        n.notify_one();
    }
    Ok(())
}

#[tauri::command]
pub async fn mt_cloud_models(
    secrets: State<'_, Secrets>,
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let ep = endpoint(secrets.0.as_ref(), &provider, base_url.as_deref())?;
    models(&client()?, &ep).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A canned reply: status, extra header lines, body, delay before answering.
    struct Reply(u16, &'static str, String, u64);

    /// Serves `replies` in order (one per connection); returns the base URL and the raw requests seen.
    fn serve(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut s, _)) = listener.accept() else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(h) = text.find("\r\n\r\n") {
                        let len = text[..h]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= h + 4 + len {
                            break;
                        }
                    }
                }
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf).to_string());
                std::thread::sleep(Duration::from_millis(reply.3));
                let head = format!(
                    "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{}connection: close\r\n\r\n",
                    reply.0,
                    reply.2.len(),
                    reply.1
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(reply.2.as_bytes());
            }
        });
        (base, seen)
    }

    fn store_with(pairs: &[(&str, &str)]) -> MemStore {
        let s = MemStore::default();
        for (a, v) in pairs {
            s.set(a, v).unwrap();
        }
        s
    }

    const NO_WAIT: fn(u32) -> Duration = |_| Duration::ZERO;

    #[tokio::test]
    async fn openai_style_request_and_reply() {
        let (base, seen) = serve(vec![Reply(
            200,
            "",
            r#"{"choices":[{"message":{"content":"สวัสดี"}}]}"#.into(),
            0,
        )]);
        let ep = endpoint_with(
            &store_with(&[("openai", "sk-1")]),
            "openai",
            None,
            Some(&base),
        )
        .unwrap();
        let out = chat(
            &reqwest::Client::new(),
            &ep,
            "gpt-x",
            "sys",
            "hello",
            NO_WAIT,
        )
        .await;
        assert_eq!(out, Ok("สวัสดี".into()));
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /chat/completions"), "{req}");
        assert!(
            req.to_ascii_lowercase()
                .contains("authorization: bearer sk-1")
        );
        let body: Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], "gpt-x");
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "sys" })
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "hello" })
        );
    }

    #[tokio::test]
    async fn anthropic_style_request_and_reply() {
        let (base, seen) = serve(vec![Reply(
            200,
            "",
            r#"{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}"#.into(),
            0,
        )]);
        let ep = endpoint_with(
            &store_with(&[("anthropic", "ak-1")]),
            "anthropic",
            None,
            Some(&base),
        )
        .unwrap();
        let out = chat(
            &reqwest::Client::new(),
            &ep,
            "claude-x",
            "sys",
            "hello",
            NO_WAIT,
        )
        .await;
        assert_eq!(out, Ok("ab".into()));
        let req = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(req.starts_with("post /v1/messages"), "{req}");
        assert!(req.contains("x-api-key: ak-1") && req.contains("anthropic-version: 2023-06-01"));
        assert!(!req.contains("authorization:"));
        let raw = seen.lock().unwrap()[0].clone();
        let body: Value = serde_json::from_str(&raw[raw.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["system"], "sys");
        assert_eq!(body["max_tokens"], 8192);
    }

    #[tokio::test]
    async fn compatible_without_key_sends_no_auth() {
        let (base, seen) = serve(vec![Reply(
            200,
            "",
            r#"{"choices":[{"message":{"content":"ok"}}]}"#.into(),
            0,
        )]);
        let ep = endpoint(
            &MemStore::default(),
            "compatible",
            Some(&format!("{base}/")),
        )
        .unwrap();
        assert_eq!(
            chat(&reqwest::Client::new(), &ep, "llama", "s", "u", NO_WAIT).await,
            Ok("ok".into())
        );
        assert!(
            !seen.lock().unwrap()[0]
                .to_ascii_lowercase()
                .contains("authorization:")
        );
    }

    #[tokio::test]
    async fn retries_429_then_succeeds() {
        let (base, seen) = serve(vec![
            Reply(
                429,
                "retry-after: 0\r\n",
                r#"{"error":{"message":"slow down"}}"#.into(),
                0,
            ),
            Reply(503, "", "{}".into(), 0),
            Reply(
                200,
                "",
                r#"{"choices":[{"message":{"content":"done"}}]}"#.into(),
                0,
            ),
        ]);
        let ep =
            endpoint_with(&store_with(&[("openai", "k")]), "openai", None, Some(&base)).unwrap();
        assert_eq!(
            chat(&reqwest::Client::new(), &ep, "m", "s", "u", NO_WAIT).await,
            Ok("done".into())
        );
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn rate_limited_after_retries() {
        let replies = (0..4).map(|_| Reply(429, "", "{}".into(), 0)).collect();
        let (base, _) = serve(replies);
        let ep =
            endpoint_with(&store_with(&[("openai", "k")]), "openai", None, Some(&base)).unwrap();
        assert_eq!(
            chat(&reqwest::Client::new(), &ep, "m", "s", "u", NO_WAIT).await,
            Err("Rate limited — try again in a minute.".into())
        );
    }

    #[tokio::test]
    async fn key_rejected_and_provider_errors() {
        let (base, _) = serve(vec![
            Reply(401, "", "{}".into(), 0),
            Reply(
                400,
                "",
                r#"{"error":{"message":"model not found"}}"#.into(),
                0,
            ),
        ]);
        let ep = endpoint_with(
            &store_with(&[("anthropic", "k")]),
            "anthropic",
            None,
            Some(&base),
        )
        .unwrap();
        let c = reqwest::Client::new();
        assert_eq!(
            chat(&c, &ep, "m", "s", "u", NO_WAIT).await,
            Err("The API key was rejected.".into())
        );
        assert_eq!(
            chat(&c, &ep, "m", "s", "u", NO_WAIT).await,
            Err("Claude: model not found".into())
        );
    }

    #[test]
    fn missing_key_gives_the_re_enter_message() {
        assert_eq!(
            endpoint(&MemStore::default(), "openai", None).unwrap_err(),
            KEY_MESSAGE
        );
        assert_eq!(
            endpoint(&MemStore::default(), "anthropic", None).unwrap_err(),
            KEY_MESSAGE
        );
    }

    #[tokio::test]
    async fn cancel_aborts_the_http_request() {
        let (base, _) = serve(vec![Reply(
            200,
            "",
            r#"{"choices":[{"message":{"content":"late"}}]}"#.into(),
            3000,
        )]);
        let ep =
            endpoint_with(&store_with(&[("openai", "k")]), "openai", None, Some(&base)).unwrap();
        let stop = Arc::new(Notify::new());
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            s2.notify_one();
        });
        let c = reqwest::Client::new();
        let started = std::time::Instant::now();
        let out = tokio::select! {
            r = chat(&c, &ep, "m", "s", "u", NO_WAIT) => r,
            _ = stop.notified() => Err("cancelled".to_string()),
        };
        assert_eq!(out, Err("cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn models_list_sorted() {
        let (base, seen) = serve(vec![Reply(
            200,
            "",
            r#"{"data":[{"id":"z-model"},{"id":"a-model"}]}"#.into(),
            0,
        )]);
        let ep =
            endpoint_with(&store_with(&[("openai", "k")]), "openai", None, Some(&base)).unwrap();
        assert_eq!(
            models(&reqwest::Client::new(), &ep).await,
            Ok(vec!["a-model".into(), "z-model".into()])
        );
        assert!(seen.lock().unwrap()[0].starts_with("GET /models"));
    }

    #[test]
    fn openai_and_anthropic_ignore_a_base_url_from_the_frontend() {
        let store = store_with(&[("openai", "k"), ("anthropic", "k")]);
        assert_eq!(
            endpoint(&store, "openai", Some("https://evil.example"))
                .unwrap()
                .base,
            OPENAI_BASE
        );
        assert_eq!(
            endpoint(&store, "anthropic", Some("https://evil.example"))
                .unwrap()
                .base,
            ANTHROPIC_BASE
        );
    }

    #[tokio::test]
    async fn final_429_keeps_the_provider_message() {
        let replies = (0..4)
            .map(|_| {
                Reply(
                    429,
                    "",
                    r#"{"error":{"message":"You exceeded your current quota"}}"#.into(),
                    0,
                )
            })
            .collect();
        let (base, _) = serve(replies);
        let ep =
            endpoint_with(&store_with(&[("openai", "k")]), "openai", None, Some(&base)).unwrap();
        let err = chat(&reqwest::Client::new(), &ep, "m", "s", "u", NO_WAIT)
            .await
            .unwrap_err();
        assert!(err.contains("You exceeded your current quota"), "{err}");
    }

    #[test]
    fn retry_after_is_capped() {
        assert_eq!(
            retry_wait(Some(Duration::from_secs(3600)), 0),
            Duration::from_secs(30)
        );
        assert_eq!(retry_wait(None, 2), Duration::from_secs(4));
    }
}
