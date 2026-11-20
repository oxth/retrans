//! Live preview from Figma: a loopback HTTP endpoint the Retrans Preview plugin talks to, and the
//! pairing handshake that hands it a token. Nothing here keeps a copy of the project's
//! translations: the plugin asks, the app answers, the plugin renders.

// These helpers are defined before the endpoint consumes them.
#![allow(dead_code)]

pub mod auth;
