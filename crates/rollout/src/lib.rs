//! Composition boundary for one local authoritative Thread event-history repository.
//!
//! This crate owns no event format or domain reducer. It opens the typed storage adapters as one
//! repository and recovers every durable Thread before callers use the controller.

mod error;
mod lease;
mod repository;

pub use error::LocalStateError;
pub use repository::LocalStateRepository;

#[cfg(test)]
#[path = "repository_tests.rs"]
mod tests;
