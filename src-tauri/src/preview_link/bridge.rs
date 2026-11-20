//! The bridge from the loopback listener to the webview: a request becomes a `preview-request`
//! event, the webview answers with the `preview_reply` command, and a reply that arrives after its
//! waiter has given up is dropped instead of delivered.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use super::lock;

/// Asks the webview for an answer to a listener request. `TauriBridge` is the real one; tests
/// substitute a bridge that returns canned answers.
pub trait Bridge: Send + Sync {
    /// Emits the request to the webview and blocks until it answers or `timeout` elapses.
    fn ask(
        &self,
        kind: &str,
        params: serde_json::Value,
        body: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<(u16, serde_json::Value), BridgeError>;
}

/// Why a bridge call gave up.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BridgeError {
    /// The webview did not answer before the timeout.
    Timeout,
}

/// The replies still being awaited, keyed by request id. A reply for an id that is not (or no
/// longer) awaited is ignored, so a late answer never panics and never reaches the wrong request.
#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<(u16, Value)>>>,
}

impl Pending {
    /// An empty set of pending replies.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a new request; returns its id and the channel the reply will arrive on.
    pub fn insert(&self) -> (u64, mpsc::Receiver<(u16, Value)>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, replies) = mpsc::channel();
        lock(&self.waiting).insert(id, sender);
        (id, replies)
    }

    /// Delivers a reply. An unknown or already-abandoned id is ignored.
    pub fn reply(&self, id: u64, status: u16, body: Value) {
        // Removing the sender first means a second reply for the same id finds nothing to send to.
        if let Some(sender) = lock(&self.waiting).remove(&id) {
            // The waiter may have given up already; a send with no receiver is expected then.
            let _ = sender.send((status, body));
        }
    }

    /// Forgets a request that timed out, so a later reply for it is ignored.
    pub fn remove(&self, id: u64) {
        lock(&self.waiting).remove(&id);
    }
}

/// The real bridge: holds the app handle, emits `preview-request` events and waits for the matching
/// `preview_reply`.
pub struct TauriBridge {
    app: AppHandle,
    pending: Pending,
}

impl TauriBridge {
    /// Wraps an app handle so the listener can reach the webview.
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Pending::new(),
        }
    }

    /// Delivers a webview reply to the request that is waiting for it. Unknown or late ids are
    /// ignored.
    pub fn reply(&self, id: u64, status: u16, body: Value) {
        self.pending.reply(id, status, body);
    }
}

impl Bridge for TauriBridge {
    fn ask(
        &self,
        kind: &str,
        params: serde_json::Value,
        body: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<(u16, serde_json::Value), BridgeError> {
        let (id, replies) = self.pending.insert();

        let mut event = Map::new();
        event.insert("id".to_string(), json!(id));
        event.insert("kind".to_string(), json!(kind));
        event.insert("params".to_string(), params);
        if let Some(body) = body {
            event.insert("body".to_string(), body);
        }

        if let Err(error) = self.app.emit("preview-request", Value::Object(event)) {
            // No webview means no answer will ever come; don't leave the request registered.
            log::error!("preview link: couldn't reach the webview: {error}");
            self.pending.remove(id);
            return Err(BridgeError::Timeout);
        }

        match replies.recv_timeout(timeout) {
            Ok(reply) => Ok(reply),
            Err(_) => {
                // Give up on this id so a reply that arrives after the timeout is ignored.
                self.pending.remove(id);
                Err(BridgeError::Timeout)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn a_reply_reaches_the_waiter() {
        let pending = Pending::new();
        let (id, replies) = pending.insert();
        pending.reply(id, 201, json!({ "ok": true }));
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(1)).unwrap(),
            (201, json!({ "ok": true }))
        );
    }

    #[test]
    fn a_late_reply_for_an_abandoned_request_is_ignored() {
        let pending = Pending::new();
        let (id, replies) = pending.insert();

        // No reply in time: the waiter gives up and drops the entry.
        assert!(replies.recv_timeout(Duration::from_millis(50)).is_err());
        pending.remove(id);

        // The reply that arrives now must not panic and must not resurrect the request.
        pending.reply(id, 200, json!({ "late": true }));
        assert!(replies.recv_timeout(Duration::from_millis(50)).is_err());
    }

    #[test]
    fn a_reply_for_an_unknown_id_is_a_no_op() {
        let pending = Pending::new();
        pending.reply(4242, 200, json!({}));
    }
}
