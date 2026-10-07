use crate::WatchPath;
use crate::channel::Receiver;
use crate::channel::WatchSender;
use crate::channel::watch_channel;
use crate::matching::actual_watch_path;
use crate::matching::changed_path_for_event;
use crate::registration::FileWatcherSubscriber;
use crate::state::PathWatchCounts;
use crate::state::SubscriberId;
use crate::state::SubscriberState;
use crate::state::SubscriberWatchKey;
use crate::state::SubscriberWatchRegistration;
use crate::state::WatchState;
use log::warn;
use notify::Config;
use notify::Event;
use notify::EventKind;
use notify::PollWatcher;
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify::Watcher;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

struct FileWatcherInner {
    watcher: BackendWatcher,
    watched_paths: HashMap<PathBuf, RecursiveMode>,
}

enum BackendWatcher {
    Recommended(RecommendedWatcher),
    Polling(PollWatcher),
}

impl BackendWatcher {
    fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        match self {
            Self::Recommended(watcher) => watcher.watch(path, mode),
            Self::Polling(watcher) => watcher.watch(path, mode),
        }
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        match self {
            Self::Recommended(watcher) => watcher.unwatch(path),
            Self::Polling(watcher) => watcher.unwatch(path),
        }
    }
}

/// Selects the OS notification backend for one watcher instance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileWatcherBackend {
    /// Uses the platform-recommended native backend.
    Recommended,
    /// Uses metadata polling for paths whose lexical namespace is incompatible with the native
    /// backend, such as macOS `/var` versus `/private/var`.
    Polling { interval: std::time::Duration },
}

/// Ref-counted, multi-subscriber filesystem invalidation watcher.
pub struct FileWatcher {
    inner: Option<Arc<Mutex<FileWatcherInner>>>,
    state: Arc<RwLock<WatchState>>,
}

impl FileWatcher {
    /// Creates a live OS watcher and attaches its event loop to the current
    /// Tokio runtime.
    pub fn new() -> notify::Result<Self> {
        Self::new_with_backend(FileWatcherBackend::Recommended)
    }

    /// Creates a live watcher using one explicit backend strategy.
    pub fn new_with_backend(backend: FileWatcherBackend) -> notify::Result<Self> {
        Handle::try_current().map_err(|_| {
            notify::Error::generic("ash-file-watcher requires a current Tokio runtime")
        })?;
        let (raw_tx, raw_rx) = mpsc::unbounded_channel();
        let watcher = match backend {
            FileWatcherBackend::Recommended => {
                BackendWatcher::Recommended(notify::recommended_watcher(move |result| {
                    let _ = raw_tx.send(result);
                })?)
            }
            FileWatcherBackend::Polling { interval } => BackendWatcher::Polling(PollWatcher::new(
                move |result| {
                    let _ = raw_tx.send(result);
                },
                Config::default()
                    .with_compare_contents(true)
                    .with_poll_interval(interval),
            )?),
        };
        let file_watcher = Self {
            inner: Some(Arc::new(Mutex::new(FileWatcherInner {
                watcher,
                watched_paths: HashMap::new(),
            }))),
            state: Arc::new(RwLock::new(WatchState::default())),
        };
        file_watcher.spawn_event_loop(raw_rx);
        Ok(file_watcher)
    }

    /// Creates an inert watcher suitable for optional-runtime fallback.
    pub fn noop() -> Self {
        Self {
            inner: None,
            state: Arc::new(RwLock::new(WatchState::default())),
        }
    }

    /// Adds an isolated subscriber and its dedicated event receiver.
    pub fn add_subscriber(self: &Arc<Self>) -> (FileWatcherSubscriber, Receiver) {
        let (tx, rx) = watch_channel();
        let mut state = self.write_state();
        let subscriber_id = state.next_subscriber_id;
        state.next_subscriber_id = state
            .next_subscriber_id
            .checked_add(1)
            .expect("file watcher subscriber id exhausted");
        state.subscribers.insert(
            subscriber_id,
            SubscriberState {
                watched_paths: HashMap::new(),
                tx,
            },
        );
        (
            FileWatcherSubscriber {
                id: subscriber_id,
                file_watcher: Arc::clone(self),
            },
            rx,
        )
    }

    pub(crate) fn register_paths(
        &self,
        subscriber_id: SubscriberId,
        registrations: &[SubscriberWatchRegistration],
    ) -> notify::Result<()> {
        let mut state = self.write_state();
        let mut inner_guard = None;
        let mut registered = Vec::new();
        for registration in registrations {
            let actual = {
                let Some(subscriber) = state.subscribers.get_mut(&subscriber_id) else {
                    return Ok(());
                };
                match subscriber.watched_paths.entry(registration.key.clone()) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        entry.get_mut().count += 1;
                        entry.get().actual.clone()
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(crate::state::SubscriberWatchState {
                            actual: registration.actual.clone(),
                            count: 1,
                            last_exists: registration.key.matched.path.exists(),
                            fallback: registration.fallback,
                        });
                        registration.actual.clone()
                    }
                }
            };
            let counts = state
                .path_ref_counts
                .entry(actual.path.clone())
                .or_default();
            let previous_mode = counts.effective_mode();
            counts.increment(actual.recursive, 1);
            let next_mode = counts.effective_mode();
            if previous_mode != next_mode {
                if let Err(error) =
                    self.reconfigure_watch(&actual.path, next_mode, &mut inner_guard)
                {
                    registered.push(registration.key.clone());
                    drop(inner_guard);
                    drop(state);
                    self.unregister_paths(subscriber_id, &registered);
                    return Err(error);
                }
            }
            registered.push(registration.key.clone());
        }
        Ok(())
    }

    pub(crate) fn unregister_paths(
        &self,
        subscriber_id: SubscriberId,
        watched_paths: &[SubscriberWatchKey],
    ) {
        let mut state = self.write_state();
        let mut inner_guard = None;
        for key in watched_paths {
            let actual = {
                let Some(subscriber) = state.subscribers.get_mut(&subscriber_id) else {
                    return;
                };
                let Some(watch) = subscriber.watched_paths.get_mut(key) else {
                    continue;
                };
                let actual = watch.actual.clone();
                watch.count = watch.count.saturating_sub(1);
                if watch.count == 0 {
                    subscriber.watched_paths.remove(key);
                }
                actual
            };
            Self::decrement_actual_watch(
                &mut state.path_ref_counts,
                &actual,
                1,
                self.inner.as_ref(),
                &mut inner_guard,
            );
        }
    }

    pub(crate) fn remove_subscriber(&self, subscriber_id: SubscriberId) {
        let mut state = self.write_state();
        let Some(subscriber) = state.subscribers.remove(&subscriber_id) else {
            return;
        };
        let mut inner_guard = None;
        for watch in subscriber.watched_paths.into_values() {
            Self::decrement_actual_watch(
                &mut state.path_ref_counts,
                &watch.actual,
                watch.count,
                self.inner.as_ref(),
                &mut inner_guard,
            );
        }
    }

    fn decrement_actual_watch<'a>(
        counts_by_path: &mut HashMap<PathBuf, PathWatchCounts>,
        actual: &WatchPath,
        amount: usize,
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) {
        let Some(counts) = counts_by_path.get_mut(&actual.path) else {
            return;
        };
        let previous_mode = counts.effective_mode();
        counts.decrement(actual.recursive, amount);
        let next_mode = counts.effective_mode();
        if counts.is_empty() {
            counts_by_path.remove(&actual.path);
        }
        if previous_mode != next_mode {
            if let Err(error) =
                Self::reconfigure_watch_inner(inner, &actual.path, next_mode, inner_guard)
            {
                warn!(
                    "failed to reconfigure watch for {} during unregister: {error}",
                    actual.path.display()
                );
            }
        }
    }

    fn reconfigure_watch<'a>(
        &'a self,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) -> notify::Result<()> {
        Self::reconfigure_watch_inner(self.inner.as_ref(), path, next_mode, inner_guard)
    }

    fn reconfigure_watch_inner<'a>(
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) -> notify::Result<()> {
        let Some(inner) = inner else {
            return Ok(());
        };
        if inner_guard.is_none() {
            *inner_guard = Some(
                inner
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            );
        }
        let Some(inner) = inner_guard.as_mut() else {
            return Ok(());
        };
        let existing_mode = inner.watched_paths.get(path).copied();
        if existing_mode == next_mode {
            return Ok(());
        }
        if existing_mode.is_some() {
            if let Err(error) = inner.watcher.unwatch(path) {
                warn!("failed to unwatch {}: {error}", path.display());
            }
            inner.watched_paths.remove(path);
        }
        let Some(next_mode) = next_mode else {
            return Ok(());
        };
        if !path.exists() {
            return Ok(());
        }
        inner.watcher.watch(path, next_mode)?;
        inner.watched_paths.insert(path.to_path_buf(), next_mode);
        Ok(())
    }

    fn apply_actual_watch_move<'a>(
        counts_by_path: &mut HashMap<PathBuf, PathWatchCounts>,
        old_actual: WatchPath,
        new_actual: WatchPath,
        count: usize,
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) {
        if old_actual == new_actual {
            return;
        }
        Self::decrement_actual_watch(counts_by_path, &old_actual, count, inner, inner_guard);
        let counts = counts_by_path.entry(new_actual.path.clone()).or_default();
        let previous_mode = counts.effective_mode();
        counts.increment(new_actual.recursive, count);
        let next_mode = counts.effective_mode();
        if previous_mode != next_mode {
            if let Err(error) =
                Self::reconfigure_watch_inner(inner, &new_actual.path, next_mode, inner_guard)
            {
                warn!(
                    "failed to move watch to {}: {error}",
                    new_actual.path.display()
                );
            }
        }
    }

    fn spawn_event_loop(&self, mut raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>) {
        let Ok(handle) = Handle::try_current() else {
            warn!("file watcher event loop skipped: no Tokio runtime available");
            return;
        };
        let state = Arc::clone(&self.state);
        let inner = self.inner.as_ref().map(Arc::downgrade);
        handle.spawn(async move {
            while let Some(result) = raw_rx.recv().await {
                match result {
                    Ok(event) if event.need_rescan() => {
                        Self::require_rescan(&state).await;
                    }
                    Ok(event) if is_mutating_event(&event) && !event.paths.is_empty() => {
                        let inner = inner.as_ref().and_then(std::sync::Weak::upgrade);
                        Self::notify_subscribers(&state, inner.as_ref(), &event.paths).await;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        warn!("file watcher backend error: {error}");
                        Self::require_rescan(&state).await;
                    }
                }
            }
        });
    }

    async fn notify_subscribers(
        state: &RwLock<WatchState>,
        inner: Option<&Arc<Mutex<FileWatcherInner>>>,
        event_paths: &[PathBuf],
    ) {
        let subscribers = {
            let mut state = state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut moves = Vec::new();
            let mut subscribers = Vec::new();
            for subscriber in state.subscribers.values_mut() {
                let mut changed_paths = Vec::new();
                for event_path in event_paths {
                    for (key, watch) in &mut subscriber.watched_paths {
                        if let Some(path) = changed_path_for_event(key, watch, event_path) {
                            changed_paths.push(path);
                        }
                        let (new_actual, _, fallback) = actual_watch_path(&key.requested);
                        watch.fallback |= fallback;
                        if watch.actual != new_actual {
                            let old_actual = watch.actual.clone();
                            let count = watch.count;
                            watch.actual = new_actual.clone();
                            moves.push((old_actual, new_actual, count));
                        }
                    }
                }
                if !changed_paths.is_empty() {
                    subscribers.push((subscriber.tx.clone(), changed_paths));
                }
            }
            let mut inner_guard = None;
            for (old_actual, new_actual, count) in moves {
                Self::apply_actual_watch_move(
                    &mut state.path_ref_counts,
                    old_actual,
                    new_actual,
                    count,
                    inner,
                    &mut inner_guard,
                );
            }
            subscribers
        };
        for (sender, changed_paths) in subscribers {
            sender.add_changed_paths(&changed_paths).await;
        }
    }

    async fn require_rescan(state: &RwLock<WatchState>) {
        let subscribers: Vec<(WatchSender, Vec<PathBuf>)> = {
            let state = state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .subscribers
                .values()
                .map(|subscriber| {
                    (
                        subscriber.tx.clone(),
                        subscriber
                            .watched_paths
                            .keys()
                            .map(|key| key.requested.path.clone())
                            .collect(),
                    )
                })
                .collect()
        };
        for (sender, watched_paths) in subscribers {
            sender.require_rescan(&watched_paths).await;
        }
    }

    fn write_state(&self) -> std::sync::RwLockWriteGuard<'_, WatchState> {
        self.state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) async fn send_paths_for_test(&self, paths: Vec<PathBuf>) {
        Self::notify_subscribers(&self.state, self.inner.as_ref(), &paths).await;
    }

    #[cfg(test)]
    pub(crate) fn spawn_event_loop_for_test(
        &self,
        raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>,
    ) {
        self.spawn_event_loop(raw_rx);
    }

    #[cfg(test)]
    pub(crate) fn watch_counts_for_test(&self, path: &Path) -> Option<(usize, usize)> {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .path_ref_counts
            .get(path)
            .map(|counts| (counts.non_recursive, counts.recursive))
    }

    #[cfg(test)]
    pub(crate) fn backend_mode_for_test(&self, path: &Path) -> Option<RecursiveMode> {
        self.inner.as_ref().and_then(|inner| {
            inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .watched_paths
                .get(path)
                .copied()
        })
    }
}

fn is_mutating_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}
