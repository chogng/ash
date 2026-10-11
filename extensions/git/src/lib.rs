//! Product Git capability. Repository state and background work live in this process.

mod configuration;
mod git_runtime;
mod git_service;
mod runtime;
mod updates;

pub use runtime::GitExtension;
