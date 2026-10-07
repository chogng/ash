use crate::FileWatcher;
use crate::WatchPath;
use crate::matching::actual_watch_path;
use crate::matching::dedupe_watched_paths;
use crate::state::SubscriberId;
use crate::state::SubscriberWatchKey;
use crate::state::SubscriberWatchRegistration;
use std::sync::Arc;

/// Registration handle for one logical watcher consumer.
pub struct FileWatcherSubscriber {
    pub(crate) id: SubscriberId,
    pub(crate) file_watcher: Arc<FileWatcher>,
}

impl FileWatcherSubscriber {
    /// Registers paths and returns a guard that unregisters them on drop.
    ///
    /// Backend failures are returned so authoritative consumers do not silently keep an inert
    /// registration.
    pub fn register_paths(
        &self,
        watched_paths: Vec<WatchPath>,
    ) -> notify::Result<WatchRegistration> {
        let registrations = dedupe_watched_paths(watched_paths)
            .into_iter()
            .map(|requested| {
                let (actual, matched, fallback) = actual_watch_path(&requested);
                SubscriberWatchRegistration {
                    key: SubscriberWatchKey { requested, matched },
                    actual,
                    fallback,
                }
            })
            .collect::<Vec<_>>();
        self.file_watcher.register_paths(self.id, &registrations)?;

        Ok(WatchRegistration {
            file_watcher: Arc::downgrade(&self.file_watcher),
            subscriber_id: self.id,
            watched_paths: registrations
                .iter()
                .map(|registration| registration.key.clone())
                .collect(),
        })
    }
}

impl Drop for FileWatcherSubscriber {
    fn drop(&mut self) {
        self.file_watcher.remove_subscriber(self.id);
    }
}

/// RAII guard for one set of active path registrations.
#[derive(Default)]
pub struct WatchRegistration {
    file_watcher: std::sync::Weak<FileWatcher>,
    subscriber_id: SubscriberId,
    watched_paths: Vec<SubscriberWatchKey>,
}

impl Drop for WatchRegistration {
    fn drop(&mut self) {
        if let Some(file_watcher) = self.file_watcher.upgrade() {
            file_watcher.unregister_paths(self.subscriber_id, &self.watched_paths);
        }
    }
}
