//! Capability-bearing Web Search tool extension with an injectable provider backend.

mod backend;
mod extension;
mod model;
mod tool;

pub use backend::JsonWebSearchBackend;
pub use backend::WebSearchBackend;
pub use extension::install;
pub use model::WebSearchError;
pub use model::WebSearchQuery;
pub use model::WebSearchRequest;
pub use model::WebSearchResponse;
pub use model::WebSearchResponseLength;
pub use model::WebSearchResult;
pub use tool::WEB_SEARCH_TOOL_NAME;

#[cfg(test)]
#[path = "web_search_tests.rs"]
mod tests;
