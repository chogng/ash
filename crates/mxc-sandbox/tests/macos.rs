//! Real Seatbelt process tests; helpers run in this same test executable.
#![cfg(target_os = "macos")]
#![deny(unsafe_code)]

#[path = "macos/fcntl.rs"]
mod fcntl;
#[path = "macos/launchers.rs"]
mod launchers;
#[path = "macos/support.rs"]
mod support;
