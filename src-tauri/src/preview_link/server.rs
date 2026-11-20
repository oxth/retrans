//! The loopback HTTP endpoint the Retrans Preview plugin talks to. One acceptor thread serves
//! 127.0.0.1 and one serves [::1]; both share the same handler. Every accepted connection is
//! answered on its own short-lived thread, one request per connection, and every response carries
//! `Access-Control-Allow-Origin: *` so the plugin's sandbox can read it.

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::preview_link::auth::{self, PairResult, Pairing};
use crate::preview_link::bridge::{Bridge, BridgeError};
use crate::preview_link::lock;
use crate::secrets::SecretStore;

/// The largest request body the endpoint accepts, in bytes.
const MAX_BODY: u64 = 5_242_880;

/// The largest request head (request line plus headers) the endpoint reads, in bytes.
const HEAD_LIMIT: usize = 16 * 1024;

/// How long a connection may block on a single read or write before it is abandoned.
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// The total time allowed for reading one request.
const CONNECTION_DEADLINE: Duration = Duration::from_secs(10);

/// The most connections served at once. A connection past the cap is dropped, not queued.
const MAX_CONNECTIONS: usize = 32;

/// A running endpoint: the port it bound and the handles that stop its acceptor threads.
pub struct Server {
    /// The loopback port the endpoint is listening on.
    pub port: u16,
    /// Set to tell every acceptor thread to stop.
    stop: Arc<AtomicBool>,
    /// One bound address and one acceptor thread per bound address.
    acceptors: Vec<(SocketAddr, JoinHandle<()>)>,
}

impl Server {
    /// Stops the listeners and waits only for the acceptor threads. Connection threads are never
    /// joined, so a request still sitting in the bridge does not hold up the stop.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // An acceptor parked in `accept` only wakes for a connection; nudge each one awake so it
        // re-checks the stop flag. The nudge connection is dropped by the acceptor.
        for (address, _) in &self.acceptors {
            let _ = TcpStream::connect_timeout(address, Duration::from_millis(200));
        }
        for (_, handle) in self.acceptors {
            let _ = handle.join();
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
    start_with_deadline(
        store,
        bridge,
        pairing,
        version,
        ports,
        timeout,
        CONNECTION_DEADLINE,
    )
}

/// Test seam for choosing a shorter total request-reading deadline.
fn start_with_deadline(
    store: Arc<dyn SecretStore>,
    bridge: Arc<dyn Bridge>,
    pairing: Arc<Mutex<Option<Pairing>>>,
    version: &str,
    ports: &[u16],
    timeout: Duration,
    deadline: Duration,
) -> Result<Server, String> {
    let (port, listener) = bind_v4(ports)?;
    let v4 = listener
        .local_addr()
        .map_err(|error| format!("couldn't read the live link address: {error}"))?;

    let endpoint = Arc::new(Endpoint {
        store,
        bridge,
        pairing,
        version: version.to_string(),
        port,
        timeout,
        deadline,
    });

    let stop = Arc::new(AtomicBool::new(false));
    let connections = Arc::new(AtomicUsize::new(0));

    let mut acceptors = Vec::with_capacity(2);
    acceptors.push(spawn_acceptor(
        v4,
        listener,
        endpoint.clone(),
        stop.clone(),
        connections.clone(),
    ));
    // IPv6 is best effort: a host that cannot bind [::1] still serves 127.0.0.1.
    if let Some((address, listener)) = bind_v6(port) {
        acceptors.push(spawn_acceptor(
            address,
            listener,
            endpoint,
            stop.clone(),
            connections,
        ));
    }

    Ok(Server {
        port,
        stop,
        acceptors,
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
fn bind_v6(port: u16) -> Option<(SocketAddr, TcpListener)> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).ok()?;
    let address = listener.local_addr().ok()?;
    Some((address, listener))
}

/// Starts one acceptor thread for a bound listener, returning its address and its handle.
fn spawn_acceptor(
    address: SocketAddr,
    listener: TcpListener,
    endpoint: Arc<Endpoint>,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
) -> (SocketAddr, JoinHandle<()>) {
    let handle = thread::spawn(move || accept_loop(listener, endpoint, stop, connections));
    (address, handle)
}

/// Decides what an accept failure means: once `stop` is set the loop ends, otherwise the failure
/// is treated as transient, logged and paced so the thread keeps serving instead of spinning.
fn accept_failure(stop: &AtomicBool) -> ControlFlow<(), ()> {
    if stop.load(Ordering::SeqCst) {
        ControlFlow::Break(())
    } else {
        // A transient accept error (a reset from a peer that vanished mid-handshake, say) must not
        // end the listener: pace the retry so it cannot busy-spin and keep accepting.
        log::debug!("preview link: accept failed, retrying");
        thread::sleep(Duration::from_millis(50));
        ControlFlow::Continue(())
    }
}

/// Accepts connections until the stop flag is set, handing each one to a short-lived thread.
///
/// The loop blocks in `accept` (never busy-spins); a stop nudge or a stop flag makes it exit.
fn accept_loop(
    listener: TcpListener,
    endpoint: Arc<Endpoint>,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
) {
    loop {
        let (stream, _peer) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(_) => match accept_failure(&stop) {
                ControlFlow::Break(()) => break,
                ControlFlow::Continue(()) => continue,
            },
        };

        // The request-reading deadline starts at accept, before the connection is handed off.
        let deadline = Instant::now() + endpoint.deadline;

        if stop.load(Ordering::SeqCst) {
            break;
        }

        if stream.set_read_timeout(Some(IO_TIMEOUT)).is_err()
            || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err()
        {
            continue;
        }

        // Over the cap: drop the new connection without answering it.
        if connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            connections.fetch_sub(1, Ordering::SeqCst);
            drop(stream);
            continue;
        }

        let endpoint = endpoint.clone();
        let guard = ConnectionGuard {
            connections: connections.clone(),
        };
        // A spawn failure drops the closure, which drops `guard` and `stream` together: the slot is
        // released and the connection goes unanswered, exactly like a connection past the cap.
        if let Err(error) = thread::Builder::new()
            .name("preview-link".to_string())
            .spawn(move || {
                let _guard = guard;
                endpoint.serve(stream, deadline);
            })
        {
            log::debug!("preview link: couldn't spawn a connection thread: {error}");
        }
    }
}

/// Keeps the live connection count accurate, releasing a slot even if the handler panics.
struct ConnectionGuard {
    connections: Arc<AtomicUsize>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.connections.fetch_sub(1, Ordering::SeqCst);
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

/// The reason phrase for a status code.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

/// The shared handler every connection thread runs. It reads the request head, checks the request
/// itself and forwards only `projects`, `bundle` and `results` to the webview.
struct Endpoint {
    store: Arc<dyn SecretStore>,
    bridge: Arc<dyn Bridge>,
    pairing: Arc<Mutex<Option<Pairing>>>,
    version: String,
    port: u16,
    timeout: Duration,
    /// The total time allowed for reading one request before the connection is dropped.
    deadline: Duration,
}

impl Endpoint {
    /// Serves exactly one request on `stream` and lets the connection close when it returns.
    ///
    /// `deadline` bounds reading the request only (head and body); the bridge wait is not covered.
    fn serve(&self, stream: TcpStream, deadline: Instant) {
        let mut reader = BufReader::new(stream);

        let head = match read_head(&mut reader, deadline) {
            HeadRead::Head(head) => head,
            HeadRead::TooLarge => {
                self.respond(
                    &mut reader,
                    Reply::json(431, json!({ "error": "The request head is too large." })),
                );
                return;
            }
            // A client that stalls or leaves before finishing its head gets no answer.
            HeadRead::Closed => return,
        };

        let request = match RequestHead::parse(&head) {
            Some(request) => request,
            None => {
                self.respond(
                    &mut reader,
                    Reply::json(400, json!({ "error": "The request is malformed." })),
                );
                return;
            }
        };

        self.dispatch(&mut reader, request, deadline);
    }

    /// Runs the checks in order (host, preflight, body framing, route) and answers the request. A
    /// `None` from `route` means the connection deadline passed and nothing is sent.
    fn dispatch(&self, reader: &mut BufReader<TcpStream>, request: RequestHead, deadline: Instant) {
        if !auth::host_allowed(request.header("host"), self.port) {
            self.respond(
                reader,
                Reply::json(403, json!({ "error": "This endpoint only answers this computer." })),
            );
            return;
        }

        if request.method == "OPTIONS" {
            self.respond_preflight(reader);
            return;
        }

        // Only Content-Length bodies are accepted; a chunked request cannot be sized up front.
        if request.header("transfer-encoding").is_some() {
            self.respond(
                reader,
                Reply::json(411, json!({ "error": "Only Content-Length bodies are accepted." })),
            );
            return;
        }

        let declared = match request.header("content-length") {
            Some(value) => match value.trim().parse::<u64>() {
                Ok(length) => length,
                Err(_) => {
                    self.respond(
                        reader,
                        Reply::json(400, json!({ "error": "The Content-Length is not a number." })),
                    );
                    return;
                }
            },
            None => 0,
        };

        // Answer without reading the body: the declared length must never drive an allocation. The
        // client is still sending this body, though, so send our FIN and let the connection wind
        // down as a clean FIN; a bare close would reset the socket and discard the 413 before the
        // client gets to read it.
        if declared > MAX_BODY {
            self.respond(
                reader,
                Reply::json(413, json!({ "error": "The request body is too large." })),
            );
            let buffered = reader.buffer().len() as u64;
            linger(reader.get_mut(), declared.saturating_sub(buffered));
            return;
        }

        // A `None` means the deadline passed while reading the body: drop the connection quietly.
        if let Some(reply) = self.route(reader, &request, declared, deadline) {
            self.respond(reader, reply);
        }
    }

    /// Picks the answer for a request, after the host, preflight and size checks.
    ///
    /// Returns `None` when reading the body ran past the connection deadline, which the caller
    /// answers by closing the connection without a reply.
    fn route(
        &self,
        reader: &mut BufReader<TcpStream>,
        request: &RequestHead,
        declared: u64,
        deadline: Instant,
    ) -> Option<Reply> {
        let url = request.target.as_str();
        let (path, _) = url.split_once('?').unwrap_or((url, ""));
        let query: Vec<(String, String)> = query_pairs(url).collect();

        let reply = match (request.method.as_str(), path) {
            ("GET", "/v1/hello") => Reply::json(
                200,
                json!({ "app": "retrans", "version": self.version, "paired": self.paired() }),
            ),
            ("POST", "/v1/pair") => return self.pair(reader, request, declared, deadline),
            ("GET", "/v1/projects") => self.projects(request),
            ("GET", "/v1/bundle") => self.bundle(request, &query),
            ("POST", "/v1/results") => {
                return self.results(reader, request, &query, declared, deadline)
            }
            _ => Reply::json(404, json!({ "error": "No such endpoint." })),
        };
        Some(reply)
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
    fn check_token(&self, request: &RequestHead) -> Result<(), Reply> {
        let given = auth::bearer(request.header("authorization"));
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
    ///
    /// Returns `None` when the connection deadline passed while reading the body.
    fn pair(
        &self,
        reader: &mut BufReader<TcpStream>,
        request: &RequestHead,
        declared: u64,
        deadline: Instant,
    ) -> Option<Reply> {
        // A web page in the user's browser can reach localhost too. The plugin's window has no
        // origin ("null"), and a page can't send JSON here without a preflight, so both checks keep
        // pages from spending the code's tries. They run before the code is looked at.
        if request.header("origin").is_some_and(|origin| origin != "null") {
            return Some(Reply::json(
                403,
                json!({ "error": "Pairing only works from the Retrans Preview plugin." }),
            ));
        }
        let is_json = request.header("content-type").is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
        if !is_json {
            return Some(Reply::json(
                415,
                json!({ "error": "Send the pairing code as JSON." }),
            ));
        }
        let value = match self.json_body(reader, declared, deadline) {
            Ok(value) => value,
            Err(BodyRead::Rejected(reply)) => return Some(reply),
            Err(BodyRead::Expired) => return None,
        };
        let Some(code) = value.get("code").and_then(Value::as_str) else {
            return Some(Reply::json(
                403,
                json!({ "error": "That pairing code didn't work." }),
            ));
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
            return Some(Reply::json(
                403,
                json!({ "error": "That pairing code didn't work." }),
            ));
        }

        let token = auth::new_token();
        if let Err(error) = self.store.set(auth::TOKEN_ACCOUNT, &token) {
            return Some(Reply::json(500, json!({ "error": error })));
        }
        Some(Reply::json(200, json!({ "token": token })))
    }

    /// Handles `GET /v1/projects`.
    fn projects(&self, request: &RequestHead) -> Reply {
        if let Err(reply) = self.check_token(request) {
            return reply;
        }
        self.forward("projects", json!({}), None)
    }

    /// Handles `GET /v1/bundle`, which needs a project and a locale.
    fn bundle(&self, request: &RequestHead, query: &[(String, String)]) -> Reply {
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
    ///
    /// Returns `None` when the connection deadline passed while reading the body.
    fn results(
        &self,
        reader: &mut BufReader<TcpStream>,
        request: &RequestHead,
        query: &[(String, String)],
        declared: u64,
        deadline: Instant,
    ) -> Option<Reply> {
        if let Err(reply) = self.check_token(request) {
            return Some(reply);
        }
        let Some(project) = query_value(query, "project") else {
            return Some(Reply::json(400, json!({ "error": "project is required" })));
        };
        let body = match self.json_body(reader, declared, deadline) {
            Ok(body) => body,
            Err(BodyRead::Rejected(reply)) => return Some(reply),
            Err(BodyRead::Expired) => return None,
        };
        Some(self.forward("results", json!({ "project": project }), Some(body)))
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

    /// Reads the declared body, growing the buffer by the bytes that actually arrive (never by the
    /// declared length) and giving up as a 400 when the body is short of its declaration.
    ///
    /// The connection deadline is re-checked on every chunk: once it passes, reading stops with
    /// [`BodyRead::Expired`] so the caller closes the connection without a reply.
    fn json_body(
        &self,
        reader: &mut BufReader<TcpStream>,
        declared: u64,
        deadline: Instant,
    ) -> Result<Value, BodyRead> {
        let mut bytes = Vec::new();
        while (bytes.len() as u64) < declared {
            if !arm_read_timeout(reader.get_mut(), deadline) {
                return Err(BodyRead::Expired);
            }

            let chunk = match reader.fill_buf() {
                Ok(chunk) => chunk,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                // A read that ran out its (deadline-narrowed) timeout means the peer went quiet.
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Err(BodyRead::Expired);
                }
                Err(_) => return Err(BodyRead::Rejected(short_body())),
            };

            if chunk.is_empty() {
                return Err(BodyRead::Rejected(short_body()));
            }

            let want = chunk.len().min((declared - bytes.len() as u64) as usize);
            bytes.extend_from_slice(&chunk[..want]);
            reader.consume(want);
        }

        serde_json::from_slice(&bytes).map_err(|_| {
            BodyRead::Rejected(Reply::json(
                400,
                json!({ "error": "The request body is not valid JSON." }),
            ))
        })
    }

    /// Sends a JSON reply with the CORS header every response carries, then the connection closes.
    fn respond(&self, reader: &mut BufReader<TcpStream>, reply: Reply) {
        let body = reply.body.to_string();
        let mut response = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            reply.status,
            reason(reply.status),
            body.len()
        );
        response.push_str(&body);
        write_out(reader.get_mut(), response.as_bytes());
    }

    /// Answers a CORS preflight so the plugin's sandbox is allowed to reach the endpoint. A 204
    /// carries no body, so it sends neither `Content-Type` nor `Content-Length`.
    fn respond_preflight(&self, reader: &mut BufReader<TcpStream>) {
        const RESPONSE: &str = "HTTP/1.1 204 No Content\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, POST\r\n\
            Access-Control-Allow-Headers: Authorization, Content-Type\r\n\
            Access-Control-Allow-Private-Network: true\r\n\
            Connection: close\r\n\r\n";
        write_out(reader.get_mut(), RESPONSE.as_bytes());
    }
}

/// Writes a complete response, logging a failure. The caller closes the connection afterwards.
fn write_out(stream: &mut TcpStream, bytes: &[u8]) {
    if stream.write_all(bytes).is_err() {
        log::debug!("preview link: couldn't answer a request");
    }
    let _ = stream.flush();
}

/// Why reading a request body stopped before the caller could answer.
enum BodyRead {
    /// The connection deadline passed mid-read; the caller closes without a reply.
    Expired,
    /// The body could not be read to its declaration; the caller sends this reply.
    Rejected(Reply),
}

/// The 400 for a body that could not be read to its declared length.
fn short_body() -> Reply {
    Reply::json(400, json!({ "error": "Couldn't read the request body." }))
}

/// Winds a rejected request down without a reset: sends our FIN, then consumes up to `remaining`
/// bytes of the incoming body into a fixed buffer. Everything is bounded by the socket's read
/// timeout, so a peer that stops sending is abandoned rather than waited on, and the buffer is
/// reused rather than allocated from the declared length.
fn linger(stream: &mut TcpStream, mut remaining: u64) {
    let _ = stream.shutdown(Shutdown::Write);

    // A trickling peer must not hold a thread: stop after IO_TIMEOUT overall or MAX_BODY bytes.
    let deadline = Instant::now() + IO_TIMEOUT;
    remaining = remaining.min(MAX_BODY);
    let mut sink = [0u8; 8 * 1024];
    while remaining > 0 && Instant::now() < deadline {
        let want = remaining.min(sink.len() as u64) as usize;
        match stream.read(&mut sink[..want]) {
            Ok(0) | Err(_) => break,
            Ok(read) => remaining -= read as u64,
        }
    }
}

/// What reading a request head produced.
enum HeadRead {
    /// The head, up to but not including the terminating CRLFCRLF.
    Head(Vec<u8>),
    /// The head grew past `HEAD_LIMIT` without a terminator.
    TooLarge,
    /// The peer went away or stalled before the head was complete; there is nothing to answer.
    Closed,
}

/// Reads a request head byte by byte until CRLFCRLF, bounded by `HEAD_LIMIT` and `deadline`.
///
/// A read timeout, EOF, or a `deadline` that passes before the terminator is a `Closed` head,
/// which is answered by silence; bytes the buffered reader has already pulled in beyond the head
/// stay available for the body.
fn read_head(reader: &mut BufReader<TcpStream>, deadline: Instant) -> HeadRead {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        if !arm_read_timeout(reader.get_mut(), deadline) {
            return HeadRead::Closed;
        }
        match reader.read(&mut byte) {
            Ok(0) => return HeadRead::Closed,
            Ok(_) => {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    head.truncate(head.len() - 4);
                    return HeadRead::Head(head);
                }
                if head.len() > HEAD_LIMIT {
                    return HeadRead::TooLarge;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return HeadRead::Closed,
        }
    }
}

/// Arms `stream` for the next read, narrowing the socket's read timeout to whichever is shorter,
/// `IO_TIMEOUT` or the time left before `deadline`. Returns `false` once the deadline has passed,
/// telling the caller to stop reading and let the connection close.
fn arm_read_timeout(stream: &TcpStream, deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let _ = stream.set_read_timeout(Some(remaining.min(IO_TIMEOUT)));
    true
}

/// A parsed request line and header list. Header names are kept as written and matched
/// case-insensitively.
struct RequestHead {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl RequestHead {
    /// Parses a request head, returning `None` when the request line or a header is malformed.
    fn parse(head: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(head).ok()?;
        let mut lines = text.split("\r\n");

        let mut parts = lines.next()?.split(' ');
        let method = parts.next()?;
        let target = parts.next()?;
        let version = parts.next()?;
        if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/") {
            return None;
        }

        let mut headers = Vec::new();
        for line in lines {
            let (name, value) = line.split_once(':')?;
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }

        Some(Self {
            method: method.to_string(),
            target: target.to_string(),
            headers,
        })
    }

    /// The first value of a header, matched case-insensitively.
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(field, _)| field.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
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
    use std::io::{self, Read, Write};
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

        parse(raw)
    }

    /// Parses a raw HTTP reply into its status, lowercased headers and body.
    fn parse(raw: Vec<u8>) -> Response {
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

    /// Opens a fresh connection, writes `request` and returns the socket still open and idle.
    ///
    /// The returned socket lets a test model a client that has announced a body (or sent a partial
    /// one) and then gone quiet without closing, which is exactly what must not take the endpoint
    /// down or hold up other clients.
    fn hold_open(port: u16, request: &[u8]) -> TcpStream {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .expect("write timeout");
        stream.write_all(request).expect("write the request");
        stream.flush().expect("flush");
        stream
    }

    /// Sends `request` on a fresh connection and returns the reply status, failing the test when
    /// nothing has arrived within `timeout`.
    ///
    /// The timeout is the point of these tests: a healthy endpoint answers promptly even while
    /// another client is misbehaving, so a client-side read timeout is a server failure.
    fn status_within(port: u16, request: &[u8], timeout: Duration) -> u16 {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .set_read_timeout(Some(timeout))
            .expect("read timeout");

        let _ = stream.write_all(request);

        let mut raw = Vec::new();
        match stream.read_to_end(&mut raw) {
            Ok(_) => parse(raw).status,
            Err(error) => panic!("no reply within {timeout:?}: {error}"),
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

    /// A pairing server on `port` with a fresh code; returns the server, its store and the code.
    fn pairing_server(port: u16) -> (Server, Arc<MemStore>, String) {
        let store = Arc::new(MemStore::default());
        let pairing = Arc::new(Mutex::new(Some(Pairing::new(Instant::now()))));
        let code = pairing.lock().unwrap().as_ref().unwrap().code().to_string();
        let server = start(
            store.clone(),
            Arc::new(FakeBridge::default()),
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
        )
        .unwrap();
        (server, store, code)
    }

    /// A raw `POST /v1/pair` with the given extra header lines.
    fn pair_request(port: u16, code: &str, extra: &str) -> Vec<u8> {
        let body = json!({ "code": code }).to_string();
        format!(
            "POST /v1/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{extra}Content-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn a_website_cannot_try_pairing_codes() {
        let port = 47412;
        let (server, store, code) = pairing_server(port);
        for _ in 0..6 {
            let response = send(port, &pair_request(port, "000000", "Origin: https://evil.example\r\nContent-Type: application/json\r\n"));
            assert_eq!(response.status, 403);
        }
        // The page's attempts didn't count against the code: the plugin can still pair with it.
        let response = send(port, &pair_request(port, &code, "Origin: null\r\nContent-Type: application/json\r\n"));
        assert_eq!(response.status, 200);
        assert!(store.get(auth::TOKEN_ACCOUNT).unwrap().is_some());
        server.stop();
    }

    #[test]
    fn pairing_needs_a_json_request() {
        let port = 47413;
        let (server, _store, code) = pairing_server(port);
        for _ in 0..6 {
            let response = send(port, &pair_request(port, "000000", "Content-Type: text/plain\r\n"));
            assert_eq!(response.status, 415);
        }
        let response = send(port, &pair_request(port, &code, "Content-Type: application/json; charset=utf-8\r\n"));
        assert_eq!(response.status, 200);
        server.stop();
    }

    #[test]
    fn status_lines_name_the_status() {
        assert_eq!(reason(202), "Accepted");
        assert_eq!(reason(415), "Unsupported Media Type");
        assert_eq!(reason(422), "Unprocessable Entity");
        assert_eq!(reason(500), "Internal Server Error");
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

    /// A request may declare a body length far beyond the cap and then send nothing. The listener
    /// answers it and stays up: a fresh `hello` must still be served promptly. The declared length
    /// is deliberately enormous so that any code path that materialises a buffer of that size (or
    /// drains that many bytes on teardown) aborts the whole test process rather than failing
    /// quietly.
    #[test]
    fn huge_declared_length_without_body_does_not_kill_the_server() {
        let port = 47400;
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
        let host = format!("127.0.0.1:{port}");

        // Announce a body far larger than the cap, send none of it and keep the socket open.
        let _offender = hold_open(
            port,
            &build(
                "POST",
                "/v1/results?project=x",
                &host,
                Some("tok"),
                99_999_999_999_999,
                &[],
            ),
        );

        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(3),
        );
        assert_eq!(
            status, 200,
            "a huge declared length must not take the server down"
        );

        server.stop();
    }

    /// The same oversized-body scenario on the unauthenticated `projects` path (no stored token, so
    /// the request would otherwise be answered 401). The endpoint must stay up regardless.
    #[test]
    fn a_huge_declared_length_on_the_unauthenticated_projects_path_does_not_kill_the_server() {
        let port = 47401;
        let store = Arc::new(MemStore::default());
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
        let host = format!("127.0.0.1:{port}");

        let _offender = hold_open(
            port,
            &build("GET", "/v1/projects", &host, None, 1_000_000_000, &[]),
        );

        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(3),
        );
        assert_eq!(
            status, 200,
            "an unauthenticated request with a huge declared length must not take the server down"
        );

        server.stop();
    }

    /// The oversized-body scenario on the authenticated `projects` path. A valid token must not
    /// change the outcome: the endpoint stays up.
    #[test]
    fn a_huge_declared_length_on_the_authenticated_projects_path_does_not_kill_the_server() {
        let port = 47402;
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
        let host = format!("127.0.0.1:{port}");

        let _offender = hold_open(
            port,
            &build("GET", "/v1/projects", &host, Some("tok"), 1_000_000_000, &[]),
        );

        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(3),
        );
        assert_eq!(
            status, 200,
            "an authenticated request with a huge declared length must not take the server down"
        );

        server.stop();
    }

    /// One client announces a body, sends part of it and then stalls with the socket open. A second
    /// client's `hello` must still be answered within the client's own read timeout: a single
    /// straggler must not hold up everyone else.
    #[test]
    fn a_stalled_body_does_not_block_other_requests() {
        let port = 47403;
        let store = Arc::new(MemStore::default());
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
        let host = format!("127.0.0.1:{port}");

        // Client A: a 100-byte body of which only five bytes arrive, then silence, socket held.
        let _stalled = hold_open(port, &build("POST", "/v1/pair", &host, None, 100, &[b'{'; 5]));

        // Client B: a fresh connection that must be served promptly.
        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(3),
        );
        assert_eq!(status, 200, "a stalled body must not block another request");

        server.stop();
    }

    /// The same straggler as above, with a body larger than the request head, so the endpoint reads
    /// it on that connection's own thread while the peer stalls. A body the endpoint must consume
    /// must not hold up another client either.
    #[test]
    fn a_stalled_body_that_reaches_the_endpoint_does_not_block_other_requests() {
        let port = 47405;
        let store = Arc::new(MemStore::default());
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
        let host = format!("127.0.0.1:{port}");

        // Client A: a 4 KiB body of which only five bytes arrive, then silence, socket held.
        let _stalled = hold_open(port, &build("POST", "/v1/pair", &host, None, 4096, &[b'{'; 5]));

        // Client B: a fresh connection that must be served promptly.
        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(3),
        );
        assert_eq!(status, 200, "a stalled body must not block another request");

        server.stop();
    }

    /// `stop()` must return promptly even while a request is sitting in the bridge. Here the fake
    /// bridge sleeps for three seconds, so a `stop()` that waited for the in-flight request would
    /// take at least that long.
    #[test]
    fn stop_does_not_wait_for_an_in_flight_request() {
        let port = 47404;
        let store = Arc::new(MemStore::default());
        store.set(auth::TOKEN_ACCOUNT, "tok").unwrap();
        let bridge = Arc::new(FakeBridge {
            sleep: Duration::from_secs(3),
            ..FakeBridge::default()
        });
        let pairing = Arc::new(Mutex::new(None));
        let server = start(
            store,
            bridge.clone(),
            pairing,
            "test",
            &[port],
            Duration::from_secs(10),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");

        // Start a request that will be parked in the (slow) bridge.
        let request = build("GET", "/v1/projects", &host, Some("tok"), 0, &[]);
        let client = thread::spawn(move || {
            let _ = send(port, &request);
        });

        // Wait until the request has actually reached the bridge before calling stop().
        let deadline = Instant::now() + Duration::from_secs(2);
        while bridge.calls() == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(bridge.calls() >= 1, "the request never reached the bridge");

        let started = Instant::now();
        server.stop();
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(1),
            "stop() waited for an in-flight request: {elapsed:?}"
        );

        let _ = client.join();
    }

    #[test]
    fn accept_errors_are_retried_until_stop_is_set() {
        let stop = AtomicBool::new(false);
        let mut source = [
            Err(io::Error::from(io::ErrorKind::ConnectionAborted)),
            Err(io::Error::from(io::ErrorKind::ConnectionAborted)),
            Ok(()),
            Err(io::Error::from(io::ErrorKind::ConnectionAborted)),
        ]
        .into_iter();
        let mut errors = 0;
        let mut accepted = 0;

        loop {
            match source.next().expect("the fake accept source was exhausted") {
                Ok(()) => {
                    accepted += 1;
                    stop.store(true, Ordering::SeqCst);
                }
                Err(error) => {
                    assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);
                    errors += 1;
                    if let ControlFlow::Break(()) = accept_failure(&stop) {
                        break;
                    }
                }
            }
        }

        assert_eq!(errors, 3, "errors before stop must not end the accept loop");
        assert_eq!(accepted, 1, "the loop must reach an accepted connection");
    }

    /// Sends bytes one at a time until the server closes the connection or the observation window
    /// expires. A read timeout keeps the test from blocking between trickled bytes.
    fn trickle_until_closed(mut stream: TcpStream, bytes: &[u8], window: Duration) -> bool {
        stream
            .set_read_timeout(Some(Duration::from_millis(40)))
            .expect("read timeout");
        let deadline = Instant::now() + window;

        for byte in bytes {
            if Instant::now() >= deadline {
                break;
            }
            if stream.write_all(std::slice::from_ref(byte)).is_err() {
                return true;
            }

            let mut response = [0u8; 1];
            match stream.read(&mut response) {
                Ok(0) => return true,
                Ok(_) => return true,
                Err(error)
                    if !matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return true;
                }
                Err(_) => {}
            }
            thread::sleep(Duration::from_millis(200));
        }

        false
    }

    #[test]
    fn a_trickling_request_head_expires_without_blocking_new_requests() {
        let port = 47410;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(None));
        let server = start_with_deadline(
            store,
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
            Duration::from_millis(600),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");
        let body = json!({ "code": "000000" }).to_string();
        let request = build(
            "POST",
            "/v1/pair",
            &host,
            None,
            body.len(),
            body.as_bytes(),
        );
        let client = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let closed = trickle_until_closed(client, &request, Duration::from_secs(2));
        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(1),
        );

        server.stop();

        assert!(closed, "the trickling request head was not closed by its deadline");
        assert_eq!(status, 200);
    }

    #[test]
    fn a_trickling_request_body_expires_without_blocking_new_requests() {
        let port = 47411;
        let store = Arc::new(MemStore::default());
        let bridge = Arc::new(FakeBridge::default());
        let pairing = Arc::new(Mutex::new(None));
        let server = start_with_deadline(
            store,
            bridge,
            pairing,
            "test",
            &[port],
            Duration::from_secs(5),
            Duration::from_millis(600),
        )
        .unwrap();
        let host = format!("127.0.0.1:{port}");
        let body = json!("x".repeat(4_094)).to_string();
        assert_eq!(body.len(), 4_096);
        let request = build("POST", "/v1/pair", &host, None, 4_096, &[]);
        let mut client = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        client
            .set_write_timeout(Some(Duration::from_secs(1)))
            .expect("write timeout");
        let head_end = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("request head");
        client
            .write_all(&request[..head_end + 4])
            .expect("write request head");
        let closed = trickle_until_closed(client, body.as_bytes(), Duration::from_secs(2));
        let status = status_within(
            port,
            &build("GET", "/v1/hello", &host, None, 0, &[]),
            Duration::from_secs(1),
        );

        server.stop();

        assert!(closed, "the trickling request body was not closed by its deadline");
        assert_eq!(status, 200);
    }
}
