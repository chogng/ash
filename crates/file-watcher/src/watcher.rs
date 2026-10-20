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
use crate::state::WatchInterest;
use crate::state::WatchState;
use log::warn;
use notify::Config;
use notify::Event;
use notify::EventKind;
use notify::PollWatcher;
#[cfg(not(target_os = "macos"))]
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify::Watcher;
use notify::event::ModifyKind;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

struct FileWatcherInner {
    watcher: BackendWatcher,
    watched_paths: HashMap<PathBuf, WatchSettings>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WatchSettings {
    mode: RecursiveMode,
    contents: bool,
    polling: bool,
}

impl WatchSettings {
    fn from_counts(counts: PathWatchCounts) -> Option<Self> {
        counts.effective_mode().map(|mode| Self {
            mode,
            contents: counts.contents > 0,
            polling: counts.contents > 0 || counts.metadata > 0,
        })
    }
}

#[derive(PartialEq)]
struct WatchScope {
    path: PathBuf,
    recursive: bool,
    interest: WatchInterest,
}

enum BackendWatcher {
    #[cfg(not(target_os = "macos"))]
    Recommended {
        watcher: RecommendedWatcher,
        added: BTreeMap<PathBuf, RecursiveMode>,
        removed: BTreeSet<PathBuf>,
    },
    #[cfg(target_os = "macos")]
    Isolated {
        watcher: crate::native::NativeWatcher,
        added: BTreeMap<PathBuf, RecursiveMode>,
        removed: BTreeSet<PathBuf>,
        events: mpsc::UnboundedSender<notify::Result<Event>>,
    },
    Polling {
        contents: PollWatcher,
        metadata: PollWatcher,
    },
    #[cfg(test)]
    Recording {
        operations: BackendOperations,
        pending: usize,
        commits: usize,
    },
}

#[cfg(test)]
type BackendOperations = Arc<Mutex<Vec<(PathBuf, Option<RecursiveMode>)>>>;

impl BackendWatcher {
    fn recommended(events: mpsc::UnboundedSender<notify::Result<Event>>) -> notify::Result<Self> {
        #[cfg(target_os = "macos")]
        {
            // Independent domain watchers share the OS service. Do not serialize the same
            // known backend outage into every domain's startup; path errors stay local.
            if !crate::native::backend_available() {
                return Self::polling(events, std::time::Duration::from_millis(200));
            }
            match crate::native::NativeWatcher::new(events.clone()) {
                Ok(watcher) => Ok(Self::Isolated {
                    watcher,
                    added: BTreeMap::new(),
                    removed: BTreeSet::new(),
                    events,
                }),
                Err(error) => {
                    warn!("native file watcher unavailable; using scoped polling: {error}");
                    Self::polling(events, std::time::Duration::from_millis(200))
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(Self::Recommended {
                watcher: notify::recommended_watcher(move |result| {
                    let _ = events.send(result);
                })?,
                added: BTreeMap::new(),
                removed: BTreeSet::new(),
            })
        }
    }

    fn polling(
        events: mpsc::UnboundedSender<notify::Result<Event>>,
        interval: std::time::Duration,
    ) -> notify::Result<Self> {
        let metadata_events = events.clone();
        Ok(Self::Polling {
            contents: PollWatcher::new(
                move |result| {
                    let _ = events.send(result);
                },
                Config::default()
                    .with_compare_contents(true)
                    .with_poll_interval(interval),
            )?,
            // Ancestors only detect removal/recreation. Never hash unrelated siblings.
            metadata: PollWatcher::new(
                move |result| {
                    let _ = metadata_events.send(result);
                },
                Config::default().with_poll_interval(interval),
            )?,
        })
    }

    fn watch(&mut self, path: &Path, settings: WatchSettings) -> notify::Result<()> {
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::Recommended { added, .. } => {
                added.insert(path.to_path_buf(), settings.mode);
                Ok(())
            }
            #[cfg(target_os = "macos")]
            Self::Isolated { added, .. } => {
                added.insert(path.to_path_buf(), settings.mode);
                Ok(())
            }
            Self::Polling { contents, metadata } => {
                if !settings.polling {
                    return Ok(());
                }
                let watcher = if settings.contents {
                    contents
                } else {
                    metadata
                };
                watcher.watch(path, settings.mode)
            }
            #[cfg(test)]
            Self::Recording {
                operations,
                pending,
                ..
            } => {
                *pending += 1;
                operations
                    .lock()
                    .unwrap()
                    .push((path.to_path_buf(), Some(settings.mode)));
                Ok(())
            }
        }
    }

    fn unwatch(&mut self, path: &Path, settings: WatchSettings) -> notify::Result<()> {
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::Recommended { added, removed, .. } => {
                added.remove(path);
                removed.insert(path.to_path_buf());
                Ok(())
            }
            #[cfg(target_os = "macos")]
            Self::Isolated { added, removed, .. } => {
                added.remove(path);
                removed.insert(path.to_path_buf());
                Ok(())
            }
            Self::Polling { contents, metadata } => {
                if !settings.polling {
                    return Ok(());
                }
                let watcher = if settings.contents {
                    contents
                } else {
                    metadata
                };
                watcher.unwatch(path)
            }
            #[cfg(test)]
            Self::Recording {
                operations,
                pending,
                ..
            } => {
                *pending += 1;
                operations.lock().unwrap().push((path.to_path_buf(), None));
                Ok(())
            }
        }
    }

    fn flush(&mut self, watched_paths: &HashMap<PathBuf, WatchSettings>) -> notify::Result<()> {
        // The desired scopes include content-vs-ancestor ownership. Restore all of them
        // after a failed native transaction, including scopes registered in older batches.
        #[cfg(target_os = "macos")]
        if let Self::Isolated {
            watcher,
            added,
            removed,
            events,
        } = self
        {
            let result = if watcher.is_alive() && added.is_empty() && removed.is_empty() {
                Ok(())
            } else {
                watcher.apply(added, removed)
            };
            added.clear();
            removed.clear();
            if let Err(error) = result {
                warn!("native file watcher failed; restoring scoped polling: {error}");
                let events = events.clone();
                let mut replacement =
                    Self::polling(events.clone(), std::time::Duration::from_millis(200))?;
                for (path, settings) in watched_paths {
                    replacement.watch(path, *settings)?;
                }
                *self = replacement;
                // Covers mutations between native failure and the polling baseline.
                let _ = events.send(Ok(
                    Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan)
                ));
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = watched_paths;
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::Recommended {
                watcher,
                added,
                removed,
            } => {
                if added.is_empty() && removed.is_empty() {
                    return Ok(());
                }
                // Commit each logical root-set update once, including RAII teardown.
                let mut changes = watcher.paths_mut();
                let mut failure = None;
                for path in std::mem::take(removed) {
                    if let Err(error) = changes.remove(&path)
                        && !matches!(error.kind, notify::ErrorKind::WatchNotFound)
                    {
                        failure.get_or_insert(error);
                    }
                }
                for (path, mode) in std::mem::take(added) {
                    if let Err(error) = changes.add(&path, mode) {
                        failure.get_or_insert(error);
                    }
                }
                // A paths_mut guard must always be committed, even after one path fails.
                let result = changes.commit();
                failure.map_or(result, Err)
            }
            #[cfg(target_os = "macos")]
            Self::Isolated { .. } => unreachable!("isolated backend handled above"),
            Self::Polling { .. } => Ok(()),
            #[cfg(test)]
            Self::Recording {
                pending, commits, ..
            } => {
                if *pending != 0 {
                    *commits += 1;
                    *pending = 0;
                }
                Ok(())
            }
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
    watch_parents: bool,
}

impl FileWatcher {
    #[cfg(test)]
    pub(crate) fn recording_for_test(operations: BackendOperations) -> Self {
        Self {
            inner: Some(Arc::new(Mutex::new(FileWatcherInner {
                watcher: BackendWatcher::Recording {
                    operations,
                    pending: 0,
                    commits: 0,
                },
                watched_paths: HashMap::new(),
            }))),
            state: Arc::new(RwLock::new(WatchState::default())),
            watch_parents: true,
        }
    }

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
            FileWatcherBackend::Recommended => BackendWatcher::recommended(raw_tx)?,
            FileWatcherBackend::Polling { interval } => BackendWatcher::polling(raw_tx, interval)?,
        };
        let file_watcher = Self {
            inner: Some(Arc::new(Mutex::new(FileWatcherInner {
                watcher,
                watched_paths: HashMap::new(),
            }))),
            state: Arc::new(RwLock::new(WatchState::default())),
            // Polling rescans the target path itself after inode replacement. Only OS
            // handles need a persistent parent watch to notice removal and recreation.
            watch_parents: matches!(backend, FileWatcherBackend::Recommended),
        };
        file_watcher.spawn_event_loop(raw_rx);
        Ok(file_watcher)
    }

    /// Creates an inert watcher suitable for optional-runtime fallback.
    pub fn noop() -> Self {
        Self {
            inner: None,
            state: Arc::new(RwLock::new(WatchState::default())),
            watch_parents: true,
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
                            #[cfg(target_os = "macos")]
                            root_identity: crate::matching::root_identity(
                                &registration.key.requested.path,
                            ),
                        });
                        registration.actual.clone()
                    }
                }
            };
            let scopes = Self::watch_scopes(&registration.key, &actual, self.watch_parents);
            // Acquire every physical scope before configuring the backend so rollback
            // cannot consume a parent lease belonging to a different registration.
            for scope in &scopes {
                state
                    .path_ref_counts
                    .entry(scope.path.clone())
                    .or_default()
                    .increment(scope.recursive, scope.interest, 1);
            }
            registered.push(registration.key.clone());
            for scope in scopes {
                let next_mode = WatchSettings::from_counts(state.path_ref_counts[&scope.path]);
                if let Err(error) = self.reconfigure_watch(&scope.path, next_mode, &mut inner_guard)
                {
                    drop(inner_guard);
                    drop(state);
                    self.unregister_paths(subscriber_id, &registered);
                    return Err(error);
                }
            }
        }
        if let Err(error) = Self::flush_backend(&mut inner_guard) {
            drop(inner_guard);
            drop(state);
            self.unregister_paths(subscriber_id, &registered);
            return Err(error);
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
            for scope in Self::watch_scopes(key, &actual, self.watch_parents) {
                Self::decrement_actual_watch(
                    &mut state.path_ref_counts,
                    &scope,
                    1,
                    self.inner.as_ref(),
                    &mut inner_guard,
                );
            }
        }
        if let Err(error) = Self::flush_backend(&mut inner_guard) {
            warn!("failed to unregister file watcher roots: {error}");
        }
    }

    pub(crate) fn remove_subscriber(&self, subscriber_id: SubscriberId) {
        let mut state = self.write_state();
        let Some(subscriber) = state.subscribers.remove(&subscriber_id) else {
            return;
        };
        let mut inner_guard = None;
        for (key, watch) in subscriber.watched_paths {
            for scope in Self::watch_scopes(&key, &watch.actual, self.watch_parents) {
                Self::decrement_actual_watch(
                    &mut state.path_ref_counts,
                    &scope,
                    watch.count,
                    self.inner.as_ref(),
                    &mut inner_guard,
                );
            }
        }
        if let Err(error) = Self::flush_backend(&mut inner_guard) {
            warn!("failed to remove file watcher subscriber: {error}");
        }
    }

    fn flush_backend(
        inner: &mut Option<std::sync::MutexGuard<'_, FileWatcherInner>>,
    ) -> notify::Result<()> {
        match inner {
            Some(inner) => {
                let inner = &mut **inner;
                inner.watcher.flush(&inner.watched_paths)
            }
            None => Ok(()),
        }
    }

    fn watch_scopes(
        key: &SubscriberWatchKey,
        actual: &WatchPath,
        watch_parents: bool,
    ) -> Vec<WatchScope> {
        let mut scopes = vec![WatchScope {
            path: actual.path.clone(),
            recursive: actual.recursive,
            interest: if actual.path == key.requested.path {
                WatchInterest::Contents
            } else {
                WatchInterest::Metadata
            },
        }];
        // An OS directory watch can disappear silently with its inode. Its immediate
        // parent observes removal/recreation; subscriber matching still hides siblings.
        if watch_parents
            && let Some(parent) = key
                .requested
                .path
                .parent()
                .filter(|parent| *parent != actual.path)
        {
            scopes.push(WatchScope {
                path: parent.to_path_buf(),
                recursive: false,
                interest: WatchInterest::NativeParent,
            });
        }
        scopes
    }

    fn decrement_actual_watch<'a>(
        counts_by_path: &mut HashMap<PathBuf, PathWatchCounts>,
        actual: &WatchScope,
        amount: usize,
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) {
        let Some(counts) = counts_by_path.get_mut(&actual.path) else {
            return;
        };
        let previous_mode = WatchSettings::from_counts(*counts);
        counts.decrement(actual.recursive, actual.interest, amount);
        let next_mode = WatchSettings::from_counts(*counts);
        if counts.is_empty() {
            counts_by_path.remove(&actual.path);
        }
        if previous_mode != next_mode {
            if let Err(error) =
                Self::reconfigure_watch_inner(inner, &actual.path, next_mode, false, inner_guard)
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
        next_mode: Option<WatchSettings>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) -> notify::Result<()> {
        Self::reconfigure_watch_inner(self.inner.as_ref(), path, next_mode, false, inner_guard)
    }

    fn reconfigure_watch_inner<'a>(
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        path: &Path,
        next_mode: Option<WatchSettings>,
        force: bool,
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
        if existing_mode == next_mode && !force {
            return Ok(());
        }
        if let Some(existing_mode) = existing_mode {
            if let Err(error) = inner.watcher.unwatch(path, existing_mode) {
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
        key: &SubscriberWatchKey,
        old_actual: WatchPath,
        new_actual: WatchPath,
        count: usize,
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
        watch_parents: bool,
    ) {
        if old_actual == new_actual {
            return;
        }
        let old_scopes = Self::watch_scopes(key, &old_actual, watch_parents);
        let new_scopes = Self::watch_scopes(key, &new_actual, watch_parents);
        for scope in old_scopes
            .iter()
            .filter(|scope| !new_scopes.contains(scope))
        {
            Self::decrement_actual_watch(counts_by_path, scope, count, inner, inner_guard);
        }
        for scope in &new_scopes {
            if !old_scopes.contains(scope) {
                counts_by_path
                    .entry(scope.path.clone())
                    .or_default()
                    .increment(scope.recursive, scope.interest, count);
            }
            let next_mode = WatchSettings::from_counts(counts_by_path[&scope.path]);
            // A counted parent may have been missing when registered. Ensure it is
            // attached now even when its effective mode has not changed.
            if let Err(error) =
                Self::reconfigure_watch_inner(inner, &scope.path, next_mode, false, inner_guard)
            {
                warn!("failed to move watch to {}: {error}", scope.path.display());
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
        let watch_parents = self.watch_parents;
        handle.spawn(async move {
            while let Some(result) = raw_rx.recv().await {
                match result {
                    Ok(event) if event.need_rescan() => {
                        Self::require_rescan(&state).await;
                    }
                    Ok(event) if is_mutating_event(&event) && !event.paths.is_empty() => {
                        let inner = inner.as_ref().and_then(std::sync::Weak::upgrade);
                        Self::notify_subscribers(&state, inner.as_ref(), &event, watch_parents)
                            .await;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        warn!("file watcher backend error: {error}");
                        // A helper can exit while no registration is in flight. Reconcile
                        // before rescan delivery so future edits have a live backend too.
                        if let Some(inner) = inner.as_ref().and_then(std::sync::Weak::upgrade) {
                            let _state = state
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let mut inner = inner
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let inner = &mut *inner;
                            if let Err(error) = inner.watcher.flush(&inner.watched_paths) {
                                warn!("failed to recover file watcher backend: {error}");
                            }
                        }
                        Self::require_rescan(&state).await;
                    }
                }
            }
        });
    }

    async fn notify_subscribers(
        state: &RwLock<WatchState>,
        inner: Option<&Arc<Mutex<FileWatcherInner>>>,
        event: &Event,
        watch_parents: bool,
    ) {
        let subscribers = {
            let mut state = state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut moves = Vec::new();
            let mut replaced_roots = HashSet::new();
            let mut subscribers = Vec::new();
            for subscriber in state.subscribers.values_mut() {
                let mut changed_paths = Vec::new();
                for event_path in &event.paths {
                    for (key, watch) in &mut subscriber.watched_paths {
                        #[cfg(target_os = "macos")]
                        let identity = watch.root_identity;
                        if let Some(path) = changed_path_for_event(key, watch, event_path) {
                            changed_paths.push(path);
                        }
                        #[cfg(target_os = "macos")]
                        if identity != watch.root_identity {
                            changed_paths.push(key.requested.path.clone());
                            replaced_roots.insert(watch.actual.path.clone());
                        }
                        let (new_actual, _, fallback) = actual_watch_path(&key.requested);
                        watch.fallback |= fallback;
                        if watch.actual != new_actual {
                            let old_actual = watch.actual.clone();
                            let count = watch.count;
                            watch.actual = new_actual.clone();
                            moves.push((key.clone(), old_actual, new_actual, count));
                        } else if may_replace_root(event.kind)
                            && (event_path == &key.requested.path
                                || event_path == &key.matched.path)
                        {
                            // A remove/create or rename pair may be processed only after
                            // the replacement exists. Path equality cannot prove that
                            // an OS handle still refers to the current directory.
                            replaced_roots.insert(new_actual.path);
                        }
                    }
                }
                if !changed_paths.is_empty() {
                    subscribers.push((subscriber.tx.clone(), changed_paths));
                }
            }
            let mut inner_guard = None;
            for (key, old_actual, new_actual, count) in moves {
                Self::apply_actual_watch_move(
                    &mut state.path_ref_counts,
                    &key,
                    old_actual,
                    new_actual,
                    count,
                    inner,
                    &mut inner_guard,
                    watch_parents,
                );
            }
            for path in replaced_roots {
                let next_mode = state
                    .path_ref_counts
                    .get(&path)
                    .and_then(|counts| WatchSettings::from_counts(*counts));
                if let Err(error) =
                    Self::reconfigure_watch_inner(inner, &path, next_mode, true, &mut inner_guard)
                {
                    warn!(
                        "failed to rebind replaced watch root {}: {error}",
                        path.display()
                    );
                }
            }
            if let Err(error) = Self::flush_backend(&mut inner_guard) {
                warn!("failed to reconcile file watcher roots: {error}");
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
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.paths = paths;
        Self::notify_subscribers(&self.state, self.inner.as_ref(), &event, self.watch_parents)
            .await;
    }

    #[cfg(test)]
    pub(crate) fn backend_commits_for_test(&self) -> usize {
        let inner = self.inner.as_ref().unwrap().lock().unwrap();
        match &inner.watcher {
            BackendWatcher::Recording { commits, .. } => *commits,
            _ => panic!("requires a recording backend"),
        }
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
                .map(|settings| settings.mode)
        })
    }

    #[cfg(test)]
    pub(crate) fn backend_contents_for_test(&self, path: &Path) -> Option<bool> {
        self.inner.as_ref().and_then(|inner| {
            inner
                .lock()
                .unwrap()
                .watched_paths
                .get(path)
                .map(|settings| settings.contents)
        })
    }
}

fn is_mutating_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn may_replace_root(kind: EventKind) -> bool {
    // Content and metadata updates do not invalidate the OS handle's inode. Rebinding on
    // these routine events restarts macOS's entire FSEventStream for every file write.
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(_) | ModifyKind::Any | ModifyKind::Other)
    )
}

#[cfg(all(test, target_os = "macos"))]
#[path = "watcher_native_tests.rs"]
mod native_tests;
