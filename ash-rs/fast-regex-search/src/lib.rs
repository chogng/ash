//! Local trigram acceleration for exact directory text and regular-expression search.

#![deny(unsafe_code)]

mod binary_codec;
mod dir_files;
mod disk_index;
mod file_stamp;
mod index;
mod path_codec;
mod query;
mod storage;
mod trigram;
mod types;
mod worker;

pub use index::FastRegexSearch;
pub use types::FastRegexCaseSensitivity;
pub use types::FastRegexError;
pub use types::FastRegexMatch;
pub use types::FastRegexPattern;
pub use types::FastRegexQuery;
pub use types::FastRegexRange;
pub use types::FastRegexSearchLimits;
pub use types::FastRegexSearchResult;
pub use types::FastRegexSearchSnapshot;
pub use types::FastRegexSearchStatistics;
pub use types::FastRegexSearchStorage;
pub use types::FastRegexUpdateOutcome;
pub use worker::FastRegexWorkerClient;
pub use worker::FastRegexWorkerCommand;
pub use worker::serve_worker_from_environment;
