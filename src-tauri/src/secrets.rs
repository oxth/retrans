//! API keys in the OS credential store (macOS Keychain, Windows Credential Manager). The frontend
//! can set, check and delete a key, but never read one: only Rust code reads keys, to call a provider.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;
use tauri::State;

pub const SERVICE: &str = "com.retrans.app";
pub const KEY_MESSAGE: &str = "Couldn't read the API key — re-enter it in Settings.";

#[derive(Debug, PartialEq)]
pub enum SecretError {
    Missing,
    Denied(String),
}

pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The real store: keyring picks the platform's credential store.
pub struct OsStore;

impl SecretStore for OsStore {
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        e.set_password(value).map_err(|e| e.to_string())
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let e = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// In memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemStore(Mutex<HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemStore {
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// Managed state: the store the commands and providers use.
pub struct Secrets(pub Box<dyn SecretStore>);

impl Default for Secrets {
    fn default() -> Self {
        Secrets(Box::new(OsStore))
    }
}

/// A key for a provider call. Not a command: keys never go to the frontend.
pub(crate) fn secret_get(store: &dyn SecretStore, account: &str) -> Result<String, SecretError> {
    match store.get(account) {
        Ok(Some(v)) if !v.is_empty() => Ok(v),
        Ok(_) => Err(SecretError::Missing),
        Err(e) => Err(SecretError::Denied(e)),
    }
}

#[tauri::command]
pub fn secret_set(state: State<'_, Secrets>, account: String, value: String) -> Result<(), String> {
    state.0.set(&account, &value)
}

#[tauri::command]
pub fn secret_has(state: State<'_, Secrets>, account: String) -> Result<bool, String> {
    Ok(state.0.get(&account)?.is_some_and(|v| !v.is_empty()))
}

#[tauri::command]
pub fn secret_delete(state: State<'_, Secrets>, account: String) -> Result<(), String> {
    state.0.delete(&account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_has_then_delete() {
        let s = MemStore::default();
        s.set("openai", "sk-test").unwrap();
        assert_eq!(secret_get(&s, "openai"), Ok("sk-test".into()));
        s.delete("openai").unwrap();
        assert_eq!(secret_get(&s, "openai"), Err(SecretError::Missing));
    }

    #[test]
    fn get_missing_is_missing() {
        assert_eq!(
            secret_get(&MemStore::default(), "anthropic"),
            Err(SecretError::Missing)
        );
    }

    #[test]
    fn a_failing_store_is_denied() {
        struct Broken;
        impl SecretStore for Broken {
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Err("no".into())
            }
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                Err("user canceled".into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Err("no".into())
            }
        }
        assert_eq!(
            secret_get(&Broken, "openai"),
            Err(SecretError::Denied("user canceled".into()))
        );
    }

    #[test]
    fn no_command_returns_the_secret() {
        let lib = include_str!("lib.rs");
        assert!(
            !lib.contains("secret_get"),
            "a key must never be readable from the frontend"
        );
        assert!(
            lib.contains("secrets::secret_set")
                && lib.contains("secrets::secret_has")
                && lib.contains("secrets::secret_delete")
        );
    }
}
