//! Media engine for the separately launched LiveKit client executable.

#![cfg(feature = "host")]

pub mod backend;
mod codec;
mod rtc;
mod transport;

#[cfg(test)]
mod video_tests;
