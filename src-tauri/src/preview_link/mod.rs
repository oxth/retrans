//! Live preview from Figma: a loopback HTTP endpoint the Retrans Preview plugin talks to, and the
//! pairing handshake that hands it a token. Nothing here keeps a copy of the project's
//! translations: the plugin asks, the app answers, the plugin renders.

pub mod auth;
pub mod bridge;
pub mod commands;
pub mod server;

use std::sync::{Mutex, MutexGuard};

/// Locks a mutex, recovering the guard if another thread panicked while holding it. The state
/// guarded here is only a queue or an option, so a poisoned lock still holds usable data and must
/// not take the endpoint down.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
