//! The checks the loopback endpoint makes before it answers anyone: is the request coming from
//! this machine, does it carry the token, and does it know the pairing code the user is reading
//! off the app's screen.

use std::net::IpAddr;
use std::time::{Duration, Instant};

/// Ports reserved for the local Figma Preview link endpoint.
pub const PORTS: [u16; 5] = [47321, 47322, 47323, 47324, 47325];

/// The keychain account used to store the plugin token.
pub const TOKEN_ACCOUNT: &str = "figma-plugin-token";

/// Returns whether `host` is a loopback host using `port`.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else {
        return false;
    };

    let (name, host_port) = if let Some(host) = host.strip_prefix('[') {
        let Some((name, suffix)) = host.split_once(']') else {
            return false;
        };
        let Some(host_port) = suffix.strip_prefix(':') else {
            return false;
        };
        (name, host_port)
    } else {
        let Some((name, host_port)) = host.rsplit_once(':') else {
            return false;
        };
        if name.contains(':') {
            return false;
        }
        (name, host_port)
    };

    if host_port.parse::<u16>() != Ok(port) {
        return false;
    }

    name.eq_ignore_ascii_case("localhost")
        || name
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// Extracts a non-empty bearer token from an authorization header.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let header = header?;
    let (scheme, token) = header.split_once(char::is_whitespace)?;

    if scheme.eq_ignore_ascii_case("Bearer") {
        let token = token.trim();
        (!token.is_empty()).then_some(token)
    } else {
        None
    }
}

/// Compares two tokens without returning early on content or length differences.
pub fn token_matches(given: &str, stored: &str) -> bool {
    let given = given.as_bytes();
    let stored = stored.as_bytes();
    let length = given.len().max(stored.len());
    let mut difference = given.len() ^ stored.len();

    for index in 0..length {
        let given_byte = given.get(index).copied().unwrap_or_default();
        let stored_byte = stored.get(index).copied().unwrap_or_default();
        difference |= usize::from(given_byte ^ stored_byte);
    }

    difference == 0
}

/// Generates a random 32-byte token as 64 lowercase hexadecimal characters.
pub fn new_token() -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("operating system random source unavailable");

    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    token
}

const PAIRING_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_PAIRING_TRIES: u8 = 5;

/// A short-lived, attempt-limited pairing code.
pub struct Pairing {
    code: String,
    created: Instant,
    tries: u8,
}

impl Pairing {
    /// Creates a pairing with a random six-digit code.
    pub fn new(now: Instant) -> Self {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).expect("operating system random source unavailable");
        let number = u32::from_ne_bytes(bytes) % 1_000_000;

        Self {
            code: format!("{number:06}"),
            created: now,
            tries: 0,
        }
    }

    /// Returns the six-digit pairing code.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Returns the remaining lifetime, saturating at zero after expiration.
    pub fn expires_in(&self, now: Instant) -> Duration {
        PAIRING_LIFETIME.saturating_sub(now.saturating_duration_since(self.created))
    }

    /// Checks a pairing code, expiring the pairing after five wrong attempts.
    pub fn try_code(&mut self, code: &str, now: Instant) -> PairResult {
        if self.expires_in(now).is_zero() || self.tries >= MAX_PAIRING_TRIES {
            return PairResult::Dead;
        }

        self.tries += 1;
        if token_matches(code, &self.code) {
            PairResult::Ok
        } else if self.tries >= MAX_PAIRING_TRIES {
            PairResult::Dead
        } else {
            PairResult::Wrong
        }
    }
}

/// The result of attempting to use a pairing code.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PairResult {
    /// The code matched.
    Ok,
    /// The code did not match, but more attempts remain.
    Wrong,
    /// The pairing expired or reached its attempt limit.
    Dead,
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::{Duration, Instant};

    #[test]
    fn ports_and_account_are_stable() {
        assert_eq!(PORTS, [47321, 47322, 47323, 47324, 47325]);
        assert_eq!(TOKEN_ACCOUNT, "figma-plugin-token");
    }

    #[test]
    fn host_allowed_only_accepts_loopback_on_the_port() {
        assert!(host_allowed(Some("localhost:47321"), 47321));
        assert!(host_allowed(Some("127.0.0.1:47321"), 47321));
        assert!(host_allowed(Some("[::1]:47321"), 47321));
        assert!(!host_allowed(Some("localhost:47322"), 47321));
        assert!(!host_allowed(Some("evil.com:47321"), 47321));
        assert!(!host_allowed(Some("localhost"), 47321));
        assert!(!host_allowed(None, 47321));
    }

    #[test]
    fn bearer_reads_the_token_case_insensitively() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Bearer  abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic x")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn token_matches_only_the_same_token() {
        assert!(token_matches("ab", "ab"));
        assert!(!token_matches("ab", "ac"));
        assert!(!token_matches("a", "ab"));
    }

    #[test]
    fn new_token_is_64_lowercase_hex_digits_and_random() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64, "the plugin stores this verbatim");
        assert!(
            a.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
            "not lowercase hex: {a}"
        );
        assert_ne!(a, b, "two calls must not agree");
    }

    #[test]
    fn pairing_code_is_six_digits_and_matches_until_it_expires() {
        let t = Instant::now();
        let mut p = Pairing::new(t);
        assert_eq!(p.code().len(), 6);
        assert!(p.code().chars().all(|c| c.is_ascii_digit()));
        let code = p.code().to_string();
        assert_eq!(p.try_code(&code, t), PairResult::Ok);

        let mut late = Pairing::new(t);
        let code = late.code().to_string();
        assert_eq!(late.try_code(&code, t + Duration::from_secs(301)), PairResult::Dead);
    }

    #[test]
    fn pairing_expires_five_minutes_after_creation() {
        let t = Instant::now();
        let p = Pairing::new(t);
        assert_eq!(p.expires_in(t), Duration::from_secs(300));
        assert_eq!(p.expires_in(t + Duration::from_secs(300)), Duration::ZERO);
        assert_eq!(p.expires_in(t + Duration::from_secs(400)), Duration::ZERO);
    }

    #[test]
    fn five_wrong_tries_kill_the_pairing() {
        let t = Instant::now();
        let mut p = Pairing::new(t);
        let actual = p.code().to_string();
        let wrong = if actual == "000000" { "000001" } else { "000000" };
        for _ in 0..4 {
            assert_eq!(p.try_code(wrong, t), PairResult::Wrong);
        }
        assert_eq!(p.try_code(wrong, t), PairResult::Dead);
        assert_eq!(
            p.try_code(&actual, t),
            PairResult::Dead,
            "the right code on a dead pairing stays dead"
        );
    }
}
