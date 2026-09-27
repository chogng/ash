//! Provider backend business APIs with caller-owned authentication.

#[path = "bigmodel/client.rs"]
pub mod bigmodel;
pub mod chatgpt;
pub mod kimi;
mod client;
mod coding_plan;
pub mod supergrok;
#[path = "zai/client.rs"]
pub mod zai;

pub use client::RequestError;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod transport_tests;

#[cfg(test)]
mod coding_plan_tests;
