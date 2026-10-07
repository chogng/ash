//! Ollama daemon inspection, installed-model discovery, and explicit model pulls.

mod client;
mod error;
mod model;
mod pull;

pub use client::OllamaClient;
pub use error::OllamaError;
pub use model::OllamaModel;
pub use model::OllamaModelDetails;
pub use model::OllamaModelInfo;
pub use model::OllamaStatus;
pub use pull::PullEvent;
pub use pull::PullProgressSink;

#[cfg(test)]
#[path = "ollama_tests.rs"]
mod tests;
