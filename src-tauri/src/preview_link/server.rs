//! The loopback HTTP endpoint the Retrans Preview plugin talks to. One thread serves 127.0.0.1 and
//! one serves [::1]; both share the same handler. Every response carries
//! `Access-Control-Allow-Origin: *` so the plugin's sandbox can read it.

use std::io::Read;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tiny_http::{Header, Method, Request, Response};

use crate::preview_link::auth::{self, PairResult, Pairing};
use crate::preview_link::bridge::{Bridge, BridgeError};
use crate::preview_link::lock;
use crate::secrets::SecretStore;

/// The largest request body the endpoint accepts, in bytes.
const MAX_BODY: usize = 5_242_880;

/// How long an idle listener thread waits before re-checking the stop flag.
const RECV_POLL: Duration = Duration::from_secs(1);

/// A running endpoint: the port it bound and the handles that stop its threads.
pub struct Server {
    /// The loopback port the endpoint is listening on.
    pub port: u16,
    /// Set to tell every listener thread to stop.
    stop: Arc<AtomicBool>,
    /// The underlying servers, kept alive until their listener threads have finished.
    listeners: Vec<Arc<tiny_http::Server>>,
    /// One thread per bound address.
    threads: Vec<JoinHandle<()>>,
}

impl Server {
    /// Stops the listener and waits for its threads to finish.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // A thread waiting in recv_timeout only wakes on a request; nudge it so it sees the flag.
        for listener in &self.listeners {
            listener.unblock();
        }
        for thread in self.threads {
            let _ = thread.join();
        }
    }
}

/// Binds the first free port from `ports` on 127.0.0.1 and [::1] and serves the plugin API.
///
/// A port counts as taken only if 127.0.0.1 refuses it; a host that fails to bind [::1] but binds
/// 127.0.0.1 is still a success.
pub fn start(
    store: Arc<dyn SecretStore>,
    bridge: Arc<dyn Bridge>,
    pairing: Arc<Mutex<Option<Pairing>>>,
    version: &str,
    ports: &[u16],
    timeout: Duration,
) -> Result<Server, String> {
    let (port, listener) = bind_v4(ports)?;

    let endpoint = Arc::new(Endpoint {
        store,
        bridge,
        pairing,
        version: version.to_string(),
        port,
        timeout,
    });

    let mut listeners = Vec::new();
    listeners.push(Arc::new(
        tiny_http::Server::from_listener(listener, None)
            .map_err(|error| format!("couldn't serve 127.0.0.1:{port}: {error}"))?,
    ));
    // IPv6 is best effort: a host that cannot bind [::1] still serves 127.0.0.1.
    if let Some(server) = bind_v6(port) {
        listeners.push(Arc::new(server));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::with_capacity(listeners.len());
    for listener in &listeners {
        let listener = listener.clone();
        let endpoint = endpoint.clone();
        let stop = stop.clone();
        threads.push(thread::spawn(move || serve(listener, endpoint, stop)));
    }

    Ok(Server {
        port,
        stop,
        listeners,
        threads,
    })
}

/// Binds 127.0.0.1 on the first port that is free. A failure here means the port is taken.
fn bind_v4(ports: &[u16]) -> Result<(u16, TcpListener), String> {
    for &port in ports {
        if let Ok(listener) = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))) {
            return Ok((port, listener));
        }
    }
    Err("no free port for the live link".to_string())
}

/// Binds [::1] on `port`, returning nothing when this host has no working IPv6 loopback.
fn bind_v6(port: u16) -> Option<tiny_http::Server> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).ok()?;
    tiny_http::Server::from_listener(listener, None).ok()
}

/// Serves one bound address until the stop flag is set.
fn serve(server: Arc<tiny_http::Server>, endpoint: Arc<Endpoint>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match server.recv_timeout(RECV_POLL) {
            Ok(Some(request)) => endpoint.handle(request),
            // The poll interval elapsed, or the server was unblocked to stop; re-check the flag.
            Ok(None) => {}
            Err(error) => {
                log::debug!("preview link listener stopped: {error}");
                break;
            }
        }
    }
}

/// One answer to send back: an HTTP status and the JSON body to send with it.
struct Reply {
    status: u16,
    body: Value,
}

impl Reply {
    /// A reply carrying a JSON body.
    fn json(status: u16, body: Value) -> Self {
        Self { status, body }
    }
}

/// The shared handler every listener thread runs. It checks the request itself and forwards only
/// `projects`, `bundle` and `results` to the webview.
struct Endpoint {
    store: Arc<dyn SecretStore>,
    bridge: Arc<dyn Bridge>,
    pairing: Arc<Mutex<Option<Pairing>>>,
    version: String,
    port: u16,
    timeout: Duration,
}

impl Endpoint {
    /// Checks the host, answers preflights and oversized bodies, then routes the request.
    fn handle(&self, mut request: Request) {
        if !auth::host_allowed(header(&request, "host"), self.port) {
            self.respond(
                request,
                Reply::json(403, json!({ "error": "This endpoint only answers this computer." })),
            );
            return;
        }

        if request.method() == &Method::Options {
            self.respond_preflight(request);
            return;
        }

        if request.body_length().is_some_and(|length| length > MAX_BODY) {
            self.respond(
                request,
                Reply::json(413, json!({ "error": "The request body is too large." })),
            );
            return;
        }

        let reply = self.route(&mut request);
        self.respond(request, reply);
    }

    /// Picks the answer for a request, after the host and preflight checks.
    fn route(&self, request: &mut Request) -> Reply {
        let url = request.url().to_string();
        let (path, _) = url.split_once('?').unwrap_or((url.as_str(), ""));
        let query: Vec<(String, String)> = query_pairs(&url).collect();
        let method = request.method().clone();

        match (method, path) {
            (Method::Get, "/v1/hello") => Reply::json(
                200,
                json!({ "app": "retrans", "version": self.version, "paired": self.paired() }),
            ),
            (Method::Post, "/v1/pair") => self.pair(request),
            (Method::Get, "/v1/projects") => self.projects(request),
            (Method::Get, "/v1/bundle") => self.bundle(request, &query),
            (Method::Post, "/v1/results") => self.results(request, &query),
            _ => Reply::json(404, json!({ "error": "No such endpoint." })),
        }
    }

    /// Whether a plugin token is stored.
    fn paired(&self) -> bool {
        self.store
            .get(auth::TOKEN_ACCOUNT)
            .ok()
            .flatten()
            .is_some_and(|token| !token.is_empty())
    }

    /// Returns a 401 reply unless the request carries the stored token.
    fn check_token(&self, request: &Request) -> Result<(), Reply> {
        let given = auth::bearer(header(request, "authorization"));
        let stored = self.store.get(auth::TOKEN_ACCOUNT).ok().flatten();

        match (given, stored) {
            (Some(given), Some(stored))
                if !stored.is_empty() && auth::token_matches(given, &stored) =>
            {
                Ok(())
            }
            _ => Err(Reply::json(
                401,
                json!({ "error": "Pair this plugin with Retrans first." }),
            )),
        }
    }

    /// Handles `POST /v1/pair`: checks the shown code, stores a fresh token and spends the code.
    fn pair(&self, request: &mut Request) -> Reply {
        let value = match self.json_body(request) {
            Ok(value) => value,
            Err(reply) => return reply,
        };
        let Some(code) = value.get("code").and_then(Value::as_str) else {
            return Reply::json(403, json!({ "error": "That pairing code didn't work." }));
        };

        let accepted = {
            let mut guard = lock(&self.pairing);
            match guard.as_mut() {
                Some(pairing) => match pairing.try_code(code, Instant::now()) {
                    PairResult::Ok => {
                        // One-shot: a code that paired successfully is spent.
                        *guard = None;
                        true
                    }
                    PairResult::Wrong => false,
                    PairResult::Dead => {
                        *guard = None;
                        false
                    }
                },
                None => false,
            }
        };

        if !accepted {
            return Reply::json(403, json!({ "error": "That pairing code didn't work." }));
        }

        let token = auth::new_token();
        if let Err(error) = self.store.set(auth::TOKEN_ACCOUNT, &token) {
            return Reply::json(500, json!({ "error": error }));
        }
        Reply::json(200, json!({ "token": token }))
    }

    /// Handles `GET /v1/projects`.
    fn projects(&self, request: &Request) -> Reply {
        if let Err(reply) = self.check_token(request) {
            return reply;
        }
        self.forward("projects", json!({}), None)
    }

    /// Handles `GET /v1/bundle`, which needs a project and a locale.
    fn bundle(&self, request: &Request, query: &[(String, String)]) -> Reply {
        if let Err(reply) = self.check_token(request) {
            return reply;
        }
        let Some(project) = query_value(query, "project") else {
            return Reply::json(400, json!({ "error": "project is required" }));
        };
        let Some(locale) = query_value(query, "locale") else {
            return Reply::json(400, json!({ "error": "locale is required" }));
        };

        let mut params = Map::new();
        params.insert("project".to_string(), json!(project));
        params.insert("locale".to_string(), json!(locale));
        if query_value(query, "includeReviewed").as_deref() == Some("true") {
            params.insert("includeReviewed".to_string(), json!("true"));
        }
        self.forward("bundle", Value::Object(params), None)
    }

    /// Handles `POST /v1/results`, which needs a project and a JSON body.
    fn results(&self, request: &mut Request, query: &[(String, String)]) -> Reply {
        if let Err(reply) = self.check_token(request) {
            return reply;
        }
        let Some(project) = query_value(query, "project") else {
            return Reply::json(400, json!({ "error": "project is required" }));
        };
        let body = match self.json_body(request) {
            Ok(body) => body,
            Err(reply) => return reply,
        };
        self.forward("results", json!({ "project": project }), Some(body))
    }

    /// Asks the webview and turns a timeout into a 504.
    fn forward(&self, kind: &str, params: Value, body: Option<Value>) -> Reply {
        match self.bridge.ask(kind, params, body, self.timeout) {
            Ok((status, body)) => Reply::json(status, body),
            Err(BridgeError::Timeout) => Reply::json(
                504,
                json!({ "error": "Retrans didn't answer in time." }),
            ),
        }
    }

    /// Reads and parses the request body as JSON, capping the size even when it was not declared.
    fn json_body(&self, request: &mut Request) -> Result<Value, Reply> {
        let mut bytes = Vec::new();
        let mut reader = request.as_reader().take((MAX_BODY + 1) as u64);
        if reader.read_to_end(&mut bytes).is_err() {
            return Err(Reply::json(
                400,
                json!({ "error": "Couldn't read the request body." }),
            ));
        }
        if bytes.len() > MAX_BODY {
            return Err(Reply::json(
                413,
                json!({ "error": "The request body is too large." }),
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| Reply::json(400, json!({ "error": "The request body is not valid JSON." })))
    }

    /// Sends a JSON reply with the CORS header every response carries.
    fn respond(&self, request: Request, reply: Reply) {
        let response = Response::from_string(reply.body.to_string())
            .with_status_code(reply.status)
            .with_header(header_line("Content-Type: application/json"))
            .with_header(header_line("Access-Control-Allow-Origin: *"));
        if let Err(error) = request.respond(response) {
            log::debug!("preview link: couldn't answer a request: {error}");
        }
    }

    /// Answers a CORS preflight so the plugin's sandbox is allowed to reach the endpoint.
    fn respond_preflight(&self, request: Request) {
        let response = Response::empty(204)
            .with_header(header_line("Access-Control-Allow-Origin: *"))
            .with_header(header_line("Access-Control-Allow-Methods: GET, POST"))
            .with_header(header_line("Access-Control-Allow-Headers: Authorization, Content-Type"))
            .with_header(header_line("Access-Control-Allow-Private-Network: true"));
        if let Err(error) = request.respond(response) {
            log::debug!("preview link: couldn't answer a preflight: {error}");
        }
    }
}

/// Reads the first request header with the given name.
fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|candidate| candidate.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|found| found.value.as_str())
}

/// Builds a response header from a static line such as `Content-Type: application/json`.
fn header_line(line: &str) -> Header {
    line.parse::<Header>()
        .expect("a response header line is always valid ASCII")
}

/// The `key=value` pairs in a URL's query string, percent-decoded.
fn query_pairs(url: &str) -> impl Iterator<Item = (String, String)> + '_ {
    url.split_once('?')
        .map(|(_, query)| query)
        .unwrap_or("")
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
}

/// The first value stored for `key`, if the query carries it.
fn query_value(query: &[(String, String)], key: &str) -> Option<String> {
    query
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}

/// Decodes `%XX` escapes and `+` as a space, the way a query string carries them.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                match (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        decoded.push((high << 4) | low);
                        index += 3;
                    }
                    _ => {
                        decoded.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The value of a single hexadecimal digit.
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::time::Instant;

    use serde_json::{Value, json};

    use crate::preview_link::auth::{self, Pairing};
    use crate::preview_link::bridge::BridgeError;
    use crate::secrets::MemStore;

    /// A bridge that answers with a canned status and body, counts its calls, and can be made slow.
    #[derive(Default)]
    struct FakeBridge {
        calls: Mutex<Vec<(String, Value, Option<Value>)>>,
        answer: Option<(u16, Value)>,
        sleep: Duration,
    }

    impl FakeBridge {
        /// Answers every request with `status` and `body`.
        fn answer(status: u16, body: Value) -> Self {
            Self {
                answer: Some((status, body)),
                ..Self::default()
            }
        }

        /// How many times the bridge was asked.
        fn calls(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    impl Bridge for FakeBridge {
        fn ask(
            &self,
            kind: &str,
            params: Value,
            body: Option<Value>,
            _timeout: Duration,
        ) -> Result<(u16, Value), BridgeError> {
            self.calls
                .lock()
                .unwrap()
                .push((kind.to_string(), params, body));

            if !self.sleep.is_zero() {
                std::thread::sleep(self.sleep);
            }

            match &self.answer {
                Some((status, body)) => Ok((*status, body.clone())),
                // A bridge that gave up answers with a timeout.
                None => Err(BridgeError::Timeout),
            }
        }
    }

    /// A parsed response: status line, lowercased header names and raw body.
    struct Response {
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    impl Response {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).map(String::as_str)
        }

        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).expect("a JSON body")
        }
    }

    /// Sends one HTTP/1.1 request over a fresh connection and reads the reply until close.
    fn send(port: u16, request: &[u8]) -> Response {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");

        // A server that rejects an oversized body may close before reading it all; ignore the
        // write error and read whatever it answered.
        let _ = stream.write_all(request);

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("read the response");
        let _ = stream.shutdown(Shutdown::Both);

        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("header terminator");
        let head = String::from_utf8_lossy(&raw[..split]);
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("status line");
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();

        Response {
            status,
            headers,
            body: raw[split + 4..].to_vec(),
        }
    }

    /// Builds a raw request. `declared` lets a test lie about the body length.
    fn build(
        method: &str,
        path: &str,
        host: &str,
        token: Option<&str>,
        declared: usize,
        body: &[u8],
    ) -> Vec<u8> {
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
        if let Some(token) = token {
            head.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        head.push_str(&format!("Content-Length: {declared}\r\n"));
        if !body.is_empty() {
            head.push_str("Content-Type: application/json\r\n");
        }
        head.push_str("\r\n");

        let mut request = head.into_bytes();
        request.extend_from_slice(body);
        request
    }

    #[test]
    fn hello_reports_the_version_and_pairing_and_preflight_is_open() {
        let port = 47391;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store.clone(),
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");

        let response = send(port, &build("GET", "/v1/hello", &host, None, 0, &[]));
        assert_eq!(response.status, 200);
        assert_eq!(
            response.json(),
            json!({ "app": "retrans", "version": "test", "paired": false })
        );

        store.set(auth::TOKEN_ACCOUNT, "tok").unwrap();
        let response = send(port, &build("GET", "/v1/hello", &host, None, 0, &[]));
        assert_eq!(response.status, 200);
        assert_eq!(response.json()["paired"], json!(true));

        let response = send(port, &build("OPTIONS", "/v1/bundle", &host, None, 0, &[]));
        assert_eq!(response.status, 204);
        assert_eq!(response.header("access-control-allow-origin"), Some("*"));
        assert_eq!(
            response.header("access-control-allow-methods"),
            Some("GET, POST")
        );
        assert_eq!(
            response.header("access-control-allow-headers"),
            Some("Authorization, Content-Type")
        );
        assert_eq!(
            response.header("access-control-allow-private-network"),
            Some("true")
        );

        server.stop();
    }

    #[test]
    fn a_foreign_host_is_rejected_before_the_bridge() {
        let port = 47392;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store,
            bridge.clone(),
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();

        let response = send(
            port,
            &build("GET", "/v1/projects", &format!("evil.com:{port}"), None, 0, &[]),
        );
        assert_eq!(response.status, 403);
        assert_eq!(bridge.calls(), 0, "a rejected host never reaches the bridge");

        server.stop();
    }

    #[test]
    fn requests_need_the_stored_token() {
        let port = 47393;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::answer(200, json!({ "projects": [1, 2] })));
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store.clone(),
            bridge.clone(),
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");

        let response = send(port, &build("GET", "/v1/projects", &host, None, 0, &[]));
        assert_eq!(response.status, 401);
        assert_eq!(response.header("access-control-allow-origin"), Some("*"));

        let response = send(port, &build("GET", "/v1/projects", &host, Some("wrong"), 0, &[]));
        assert_eq!(response.status, 401);
        assert_eq!(bridge.calls(), 0, "an unauthenticated request stays local");

        store.set(auth::TOKEN_ACCOUNT, "right").unwrap();
        let response = send(port, &build("GET", "/v1/projects", &host, Some("right"), 0, &[]));
        assert_eq!(response.status, 200);
        assert_eq!(response.json(), json!({ "projects": [1, 2] }));
        assert_eq!(response.header("access-control-allow-origin"), Some("*"));
        assert_eq!(bridge.calls(), 1);

        server.stop();
    }

    #[test]
    fn pairing_with_the_shown_code_stores_the_token() {
        let port = 47394;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(Some(Pairing::new(Instant::now()))));
        let code = pairing
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .code()
            .to_string();
        let server = start(
            store.clone(),
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");

        let wrong = if code == "000000" { "000001" } else { "000000" };
        let wrong_body = json!({ "code": wrong }).to_string();
        let response = send(
            port,
            &build(
                "POST",
                "/v1/pair",
                &host,
                None,
                wrong_body.len(),
                wrong_body.as_bytes(),
            ),
        );
        assert_eq!(response.status, 403);

        let body = json!({ "code": code }).to_string();
        let response = send(
            port,
            &build("POST", "/v1/pair", &host, None, body.len(), body.as_bytes()),
        );
        assert_eq!(response.status, 200);
        let token = response.json()["token"]
            .as_str()
            .expect("a token in the reply")
            .to_string();
        assert_eq!(
            store.get(auth::TOKEN_ACCOUNT).unwrap().as_deref(),
            Some(token.as_str())
        );

        server.stop();
    }

    #[test]
    fn a_pairing_code_can_only_be_used_once() {
        let port = 47395;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(Some(Pairing::new(Instant::now()))));
        let code = pairing
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .code()
            .to_string();
        let server = start(
            store,
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");
        let body = json!({ "code": code }).to_string();

        let response = send(
            port,
            &build("POST", "/v1/pair", &host, None, body.len(), body.as_bytes()),
        );
        assert_eq!(response.status, 200);

        let response = send(
            port,
            &build("POST", "/v1/pair", &host, None, body.len(), body.as_bytes()),
        );
        assert_eq!(response.status, 403, "a consumed pairing stays consumed");

        server.stop();
    }

    #[test]
    fn an_oversized_body_is_rejected() {
        let port = 47396;
        let store = Arc::new(MemStore::default());
        store.set(auth::TOKEN_ACCOUNT, "tok").unwrap();
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store,
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();

        let body = vec![b'x'; 5_242_881];
        let response = send(
            port,
            &build(
                "POST",
                "/v1/results?project=p",
                &format!("127.0.0.1:{port}"),
                Some("tok"),
                body.len(),
                &body,
            ),
        );
        assert_eq!(response.status, 413);

        server.stop();
    }

    #[test]
    fn a_slow_bridge_answers_504() {
        let port = 47397;
        let store = Arc::new(MemStore::default());
        store.set(auth::TOKEN_ACCOUNT, "tok").unwrap();
        let bridge = Arc::new(FakeBridge {
            sleep: Duration::from_millis(500),
            ..FakeBridge::default()
        });
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store,
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_millis(200),
        )
        .unwrap();

        let response = send(
            port,
            &build(
                "GET",
                "/v1/projects",
                &format!("127.0.0.1:{port}"),
                Some("tok"),
                0,
                &[],
            ),
        );
        assert_eq!(response.status, 504);
        assert_eq!(
            response.json(),
            json!({ "error": "Retrans didn't answer in time." })
        );

        server.stop();
    }

    #[test]
    fn a_busy_first_port_moves_to_the_next() {
        let occupied = TcpListener::bind("127.0.0.1:47398").expect("occupy the first candidate");
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store,
            bridge,
            pairing,
            "test",
            &[47398, 47399],
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(server.port, 47399, "a port taken on 127.0.0.1 is skipped");

        drop(occupied);
        server.stop();
    }
}
