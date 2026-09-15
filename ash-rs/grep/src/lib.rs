//! Shared, directory-scoped content search for Codebase, tools, and editor clients.
//! Engines and index processes stay behind the same structured query contract.

mod jobs;
mod ripgrep;
mod service;
mod types;

pub use jobs::Jobs;
pub use service::Service;
pub use types::Backend;
pub use types::CaseSensitivity;
pub use types::Error;
pub use types::Freshness;
pub use types::IndexStatus;
pub use types::JobError;
pub use types::Match;
pub use types::MatchRange;
pub use types::Owner;
pub use types::Page;
pub use types::Pattern;
pub use types::Query;
pub use types::Search;
pub use types::SearchResult;
