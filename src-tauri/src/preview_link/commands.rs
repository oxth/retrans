//! The Tauri commands the frontend calls to start, stop and pair the live link.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::preview_link::auth::{self, Pairing};
use crate::preview_link::bridge::TauriBridge;
use crate::preview_link::lock;
use crate::preview_link::server::{self, Server};
use crate::secrets::{OsStore, SecretStore};

/// How long a webview request may take before the endpoint answers 504.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The live link's state: the running endpoint (if any), the pending pairing, the bridge to the
/// webview and the store the plugin token lives in.
pub struct LinkState {
    server: Mutex<Option<Server>>,
    pairing: Arc<Mutex<Option<Pairing>>>,
    bridge: Arc<TauriBridge>,
    store: Arc<OsStore>,
    version: String,
}

impl LinkState {
    /// Builds the state for an app handle and the app's version string.
    pub fn new(app: AppHandle, version: String) -> Self {
        Self {
            server: Mutex::new(None),
            pairing: Arc::new(Mutex::new(None)),
            bridge: Arc::new(TauriBridge::new(app)),
            store: Arc::new(OsStore),
            version,
        }
    }

    /// Starts the endpoint if it is not already running, returning its port.
    pub fn start(&self) -> Result<u16, String> {
        let mut running = lock(&self.server);
        if let Some(server) = running.as_ref() {
            return Ok(server.port);
        }

        let server = server::start(
            self.store.clone(),
            self.bridge.clone(),
            self.pairing.clone(),
            &self.version,
            &auth::PORTS,
            REQUEST_TIMEOUT,
        )?;
        let port = server.port;
        *running = Some(server);
        Ok(port)
    }

    /// Stops the endpoint if it is running.
    pub fn stop(&self) {
        let server = lock(&self.server).take();
        if let Some(server) = server {
            server.stop();
        }
    }

    /// What the settings page shows: running, on which port, and whether a plugin is paired.
    pub fn status(&self) -> LinkStatus {
        let port = lock(&self.server).as_ref().map(|server| server.port);
        LinkStatus {
            running: port.is_some(),
            port,
            paired: self.paired(),
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

    /// Starts the link if needed and shows a fresh pairing code.
    pub fn pair_code(&self) -> Result<PairCode, String> {
        self.start()?;

        let pairing = Pairing::new(Instant::now());
        let code = pairing.code().to_string();
        let expires_in_ms = pairing.expires_in(Instant::now()).as_millis() as u64;
        *lock(&self.pairing) = Some(pairing);

        Ok(PairCode {
            code,
            expires_in_ms,
        })
    }

    /// Deletes the plugin token and drops any pairing code that is still waiting to be used.
    pub fn forget(&self) -> Result<(), String> {
        *lock(&self.pairing) = None;
        self.store.delete(auth::TOKEN_ACCOUNT)
    }

    /// Delivers a webview answer to the endpoint request that is waiting for it.
    pub fn reply(&self, id: u64, status: u16, body: serde_json::Value) {
        self.bridge.reply(id, status, body);
    }
}

/// What the frontend asks for: whether the link is running and on which port, and whether a plugin
/// has paired.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// Whether the endpoint is listening.
    pub running: bool,
    /// The port it is listening on, or `None` when it is stopped.
    pub port: Option<u16>,
    /// Whether a plugin token is stored.
    pub paired: bool,
}

/// A pairing code and how long it stays valid.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    /// The six-digit code the user reads into the plugin.
    pub code: String,
    /// The remaining lifetime of the code, in milliseconds.
    pub expires_in_ms: u64,
}

/// Starts the live link and returns the port it listens on. Idempotent.
#[tauri::command]
pub fn preview_link_start(state: State<'_, LinkState>) -> Result<u16, String> {
    state.start()
}

/// Stops the live link.
#[tauri::command]
pub fn preview_link_stop(state: State<'_, LinkState>) {
    state.stop();
}

/// Reports whether the live link is running, on which port, and whether a plugin is paired.
#[tauri::command]
pub fn preview_link_status(state: State<'_, LinkState>) -> LinkStatus {
    state.status()
}

/// Starts the live link if needed and returns a fresh pairing code.
#[tauri::command]
pub fn preview_pair_code(state: State<'_, LinkState>) -> Result<PairCode, String> {
    state.pair_code()
}

/// Forgets the paired plugin by deleting its token.
#[tauri::command]
pub fn preview_forget(state: State<'_, LinkState>) -> Result<(), String> {
    state.forget()
}

/// Delivers a webview answer to the endpoint request that is waiting for it.
#[tauri::command]
pub fn preview_reply(
    state: State<'_, LinkState>,
    id: u64,
    status: u16,
    body: serde_json::Value,
) {
    state.reply(id, status, body);
}

/// Brings the main window to the front, so a designer's results are never applied unseen.
#[tauri::command]
pub fn preview_focus(app: AppHandle) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_status_serializes_as_camel_case() {
        let status = LinkStatus {
            running: true,
            port: Some(47321),
            paired: false,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({ "running": true, "port": 47321, "paired": false })
        );
    }

    #[test]
    fn pair_code_serializes_expiry_as_camel_case() {
        let code = PairCode {
            code: "042917".to_string(),
            expires_in_ms: 300_000,
        };
        assert_eq!(
            serde_json::to_value(code).unwrap(),
            serde_json::json!({ "code": "042917", "expiresInMs": 300000 })
        );
    }
}
