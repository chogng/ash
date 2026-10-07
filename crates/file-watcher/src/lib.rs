//! Shared, multi-subscriber filesystem invalidation hints.
//!
//! Backend events are deliberately coarse. Consumers must rescan and validate
//! their owned state before publishing a new snapshot.

mod channel;
mod matching;
mod registration;
mod state;
mod watcher;

pub use channel::DebouncedWatchReceiver;
pub use channel::Receiver;
pub use channel::ThrottledWatchReceiver;
pub use registration::FileWatcherSubscriber;
pub use registration::WatchRegistration;
pub use watcher::{FileWatcher, FileWatcherBackend};

use std::path::PathBuf;

/// Coalesced invalidation hint delivered to one watcher subscriber.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileWatcherEvent {
    /// The backend observed mutations at these sorted, deduplicated paths.
    PathsChanged { paths: Vec<PathBuf> },
    /// The backend may have lost events; rescan these registered roots.
    RescanRequired { watched_paths: Vec<PathBuf> },
}

/// One path and matching scope requested by a watcher subscriber.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WatchPath {
    /// File or directory to watch.
    pub path: PathBuf,
    /// Whether descendants below `path` should match.
    pub recursive: bool,
}

#[cfg(test)]
#[path = "file_watcher_tests.rs"]
mod tests;
