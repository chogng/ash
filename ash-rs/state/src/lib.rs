//! Profile-local database runtime, durable state adapters, and rebuildable index leases.

mod assets;
pub use assets::SqliteAssetStore;
mod dir_index;
mod issue_cache;
mod message_history;
pub use issue_cache::CachedIssuePage;
pub use issue_cache::IssueCacheKey;
pub use issue_cache::SqliteIssueCache;
pub use message_history::SqliteMessageHistory;
mod sqlite;
mod sqlite_runtime;

pub use dir_index::{ClearOutcome, DirIndexKind, DirIndexLease, StateRuntime};
pub use sqlite::{
    HistoryImport,
    SqliteEnvironmentStore, SqliteMemoryStore, SqliteProjectStore, SqliteTeamStore, SqliteThreadStore,
    SqliteTurnChangeStore, TurnChangeCommandOutcome,
};
pub use sqlite_runtime::{SqliteDurability, open_in_memory_database, open_sqlite_database};

#[cfg(test)]
#[path = "sqlite_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "graph_tests.rs"]
mod graph_tests;
#[cfg(test)]
#[path = "history_tests.rs"]
mod history_tests;

#[cfg(test)]
#[path = "project_store_tests.rs"]
mod project_store_tests;

#[cfg(test)]
#[path = "memory_store_tests.rs"]
mod memory_store_tests;
