use crate::WatchPath;
use crate::channel::WatchSender;
use notify::RecursiveMode;
use std::collections::HashMap;
use std::path::PathBuf;

pub(crate) type SubscriberId = u64;

#[derive(Default)]
pub(crate) struct WatchState {
    pub(crate) next_subscriber_id: SubscriberId,
    pub(crate) path_ref_counts: HashMap<PathBuf, PathWatchCounts>,
    pub(crate) subscribers: HashMap<SubscriberId, SubscriberState>,
}

pub(crate) struct SubscriberState {
    pub(crate) watched_paths: HashMap<SubscriberWatchKey, SubscriberWatchState>,
    pub(crate) tx: WatchSender,
}

/// Stable subscriber-visible and backend-matching identity.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct SubscriberWatchKey {
    pub(crate) requested: WatchPath,
    pub(crate) matched: WatchPath,
}

pub(crate) struct SubscriberWatchState {
    pub(crate) actual: WatchPath,
    pub(crate) count: usize,
    pub(crate) last_exists: bool,
    pub(crate) fallback: bool,
}

#[derive(Clone)]
pub(crate) struct SubscriberWatchRegistration {
    pub(crate) key: SubscriberWatchKey,
    pub(crate) actual: WatchPath,
    pub(crate) fallback: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct PathWatchCounts {
    pub(crate) non_recursive: usize,
    pub(crate) recursive: usize,
}

impl PathWatchCounts {
    pub(crate) fn increment(&mut self, recursive: bool, amount: usize) {
        if recursive {
            self.recursive += amount;
        } else {
            self.non_recursive += amount;
        }
    }

    pub(crate) fn decrement(&mut self, recursive: bool, amount: usize) {
        if recursive {
            self.recursive = self.recursive.saturating_sub(amount);
        } else {
            self.non_recursive = self.non_recursive.saturating_sub(amount);
        }
    }

    pub(crate) fn effective_mode(self) -> Option<RecursiveMode> {
        if self.recursive > 0 {
            Some(RecursiveMode::Recursive)
        } else if self.non_recursive > 0 {
            Some(RecursiveMode::NonRecursive)
        } else {
            None
        }
    }

    pub(crate) fn is_empty(self) -> bool {
        self.non_recursive == 0 && self.recursive == 0
    }
}
