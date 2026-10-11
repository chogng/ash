use ash_app_server_protocol::git_provider::GitProviderEvent;
use ash_app_server_protocol::protocol::git::GitIgnoreChanged;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// Coalesces repository hints while the product relay is disconnected or busy.
#[derive(Default)]
pub(crate) struct GitUpdates {
    pending: Mutex<BTreeMap<String, GitProviderEvent>>,
    #[cfg(test)]
    subscribers: Mutex<Vec<test_support::NotificationQueue>>,
}

impl GitUpdates {
    pub(crate) fn publish_git_repositories_changed(&self) {
        self.publish("repositories".into(), GitProviderEvent::RepositoriesChanged);
    }
    pub(crate) fn publish_git_status_changed(&self, status: GitStatusResult) {
        self.publish(
            format!("status:{}", status.repository_id),
            GitProviderEvent::StatusChanged(status),
        );
    }
    pub(crate) fn publish_git_ignore_changed(&self, change: GitIgnoreChanged) {
        self.publish(
            format!("ignore:{}", change.repository_id),
            GitProviderEvent::IgnoreChanged(change),
        );
    }
    fn publish(&self, key: String, event: GitProviderEvent) {
        #[cfg(test)]
        for queue in self.subscribers.lock().expect("test subscribers").iter() {
            queue.publish(&event);
        }
        let mut pending = self.pending.lock().expect("Git events");
        // Overflow is an explicit full domain refresh, not a lost status or ignore hint.
        if pending.len() >= 4096 && !pending.contains_key(&key) {
            pending.clear();
            pending.insert("0-resynchronize".into(), GitProviderEvent::Resynchronize);
        }
        let event = match (&pending.get(&key), event) {
            (
                Some(GitProviderEvent::IgnoreChanged(_)),
                GitProviderEvent::IgnoreChanged(mut change),
            ) => {
                // A replacement must invalidate both sets of paths, including deleted files.
                change.paths.clear();
                GitProviderEvent::IgnoreChanged(change)
            }
            (_, event) => event,
        };
        pending.insert(key, event);
    }
    pub(crate) fn drain(&self) -> Vec<GitProviderEvent> {
        let mut pending = self.pending.lock().expect("Git events");
        let keys = pending.keys().take(32).cloned().collect::<Vec<_>>();
        let mut events = Vec::new();
        let mut bytes = 0;
        for key in keys {
            let size = serde_json::to_vec(&pending[&key])
                .expect("Git event serialization")
                .len();
            if !events.is_empty() && bytes + size > 32 * 1024 * 1024 {
                break;
            }
            bytes += size;
            events.push(pending.remove(&key).expect("queued Git event"));
        }
        events
    }
}

#[cfg(test)]
impl GitUpdates {
    pub(crate) fn register(&self, _: u64, _: bool, queue: &test_support::NotificationQueue) {
        self.subscribers.lock().unwrap().push(queue.clone());
    }
    pub(crate) fn fork_scope(&self) -> Self {
        Self::default()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::GitProviderEvent;
    use serde_json::Value;
    use std::sync::Arc;
    use std::sync::Mutex;

    #[derive(Clone, Default)]
    pub(crate) struct NotificationQueue(Arc<Mutex<Vec<Value>>>);
    impl NotificationQueue {
        pub(crate) fn publish(&self, event: &GitProviderEvent) {
            let value = match event {
                GitProviderEvent::Resynchronize | GitProviderEvent::RepositoriesChanged => {
                    serde_json::json!({"method": "git/repositoriesChanged", "params": {}})
                }
                GitProviderEvent::StatusChanged(status) => {
                    serde_json::json!({"method": "git/statusChanged", "params": {"status": status}})
                }
                GitProviderEvent::IgnoreChanged(change) => {
                    serde_json::json!({"method": "git/ignoreChanged", "params": change})
                }
            };
            self.0.lock().unwrap().push(value);
        }
        pub(crate) fn drain(&self) -> Vec<Value> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
