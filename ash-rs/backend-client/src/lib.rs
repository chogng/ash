//! Provider backend business APIs with caller-owned authentication.

pub mod chatgpt;
mod client;
pub mod supergrok;

pub use client::RequestError;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod transport_tests;
