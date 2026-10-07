use super::codebase_runtime::CodebaseRuntime;
use super::semantic_index_job::SemanticIndexJobController;
use super::symbol_index_runtime::SymbolIndexRuntime;
use super::update_broker::UpdateBroker;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_file_access::Dir;
use ash_file_watcher::DebouncedWatchReceiver;
use ash_file_watcher::FileWatcher;
use ash_file_watcher::FileWatcherBackend;
use ash_file_watcher::FileWatcherEvent;
use ash_file_watcher::WatchPath;
use ash_protocol::SessionId;
use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;
use std::time::Duration;

const FILE_SYSTEM_WATCH_DEBOUNCE: Duration = Duration::from_millis(75);
const FILE_SYSTEM_WATCH_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const ALIASED_PATH_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Receives projected Directory filesystem invalidations before client publication.
///
/// Implementations must keep the callback bounded because it runs on the watcher thread.
pub(crate) trait DirFileChangeSink: Send + Sync {
    fn files_changed(&self, changed: &FsChanged);
}

pub(crate) trait SessionDirFileChangeSink: Send + Sync {
    fn session_files_changed(
        &self,
        session_id: &SessionId,
        root: &std::path::Path,
        changed: &FsChanged,
    );
}

enum FileSystemWatcherObservers {
    None,
    EnvRuntime {
        codebase: Arc<CodebaseRuntime>,
        symbol_index: Arc<SymbolIndexRuntime>,
        codebase_semantic: Option<Arc<SemanticIndexJobController>>,
        changes: Arc<dyn DirFileChangeSink>,
    },
    SessionDir {
        session_id: SessionId,
        root: PathBuf,
        changes: Arc<dyn SessionDirFileChangeSink>,
    },
}

#[derive(Default)]
enum PendingIndexRefresh {
    #[default]
    None,
    Paths(BTreeSet<PathBuf>),
    Rebuild,
}

impl PendingIndexRefresh {
    fn merge(&mut self, event: FileWatcherEvent) {
        match event {
            FileWatcherEvent::RescanRequired { .. } => *self = Self::Rebuild,
            FileWatcherEvent::PathsChanged { paths } => match self {
                Self::None => *self = Self::Paths(paths.into_iter().collect()),
                Self::Paths(pending) => pending.extend(paths),
                Self::Rebuild => {}
            },
        }
    }

    fn take_event(&mut self) -> Option<FileWatcherEvent> {
        match std::mem::take(self) {
            Self::None => None,
            Self::Paths(paths) => Some(FileWatcherEvent::PathsChanged {
                paths: paths.into_iter().collect(),
            }),
            Self::Rebuild => Some(FileWatcherEvent::RescanRequired {
                watched_paths: Vec::new(),
            }),
        }
    }
}

struct CodebaseRefreshWorker {
    pending: Arc<Mutex<PendingIndexRefresh>>,
    wake: Option<SyncSender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl CodebaseRefreshWorker {
    fn start(
        runtime: Arc<CodebaseRuntime>,
        symbol_index: Arc<SymbolIndexRuntime>,
        semantic: Option<Arc<SemanticIndexJobController>>,
    ) -> Result<Self, String> {
        let pending = Arc::new(Mutex::new(PendingIndexRefresh::None));
        let (wake, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_runtime = Arc::clone(&runtime);
        let worker_pending = Arc::clone(&pending);
        let thread = std::thread::Builder::new()
            .name("ash-codebase-refresh".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    let event = worker_pending
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take_event();
                    if let Some(event) = event {
                        let previous_generation = worker_runtime
                            .index()
                            .snapshot()
                            .map(|snapshot| snapshot.generation)
                            .ok();
                        worker_runtime.apply_watcher_event(&event);
                        let current_generation = worker_runtime
                            .index()
                            .snapshot()
                            .map(|snapshot| snapshot.generation)
                            .ok();
                        if previous_generation != current_generation {
                            if let Err(error) = worker_runtime.index().handoff_matching_overlays() {
                                log::warn!("codebase overlay handoff failed: {error}");
                            }
                            if let Err(error) = symbol_index.reconcile() {
                                log::warn!("symbol-index reconcile failed: {error}");
                            }
                            if let Err(error) = symbol_index.reconcile_overlay() {
                                log::warn!("symbol-index overlay reconcile failed: {error}");
                            }
                            if let Some(semantic) = &semantic {
                                semantic.schedule();
                            }
                        }
                    }
                }
            })
            .map_err(|error| format!("failed to initialize codebase refresh worker: {error}"))?;
        Ok(Self {
            pending,
            wake: Some(wake),
            thread: Some(thread),
        })
    }

    fn schedule(&self, event: FileWatcherEvent) {
        // Cancellation is owned by the semantic job; the lexical worker publishes the next exact
        // generation before asking it to resume.
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .merge(event);
        if let Some(wake) = &self.wake {
            match wake.try_send(()) {
                Ok(()) | Err(std::sync::mpsc::TrySendError::Full(())) => {}
                Err(std::sync::mpsc::TrySendError::Disconnected(())) => {
                    log::warn!("codebase refresh worker stopped unexpectedly");
                }
            }
        }
    }
}

impl Drop for CodebaseRefreshWorker {
    fn drop(&mut self) {
        self.wake.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub(super) struct FileSystemWatcher {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl FileSystemWatcher {
    pub(super) fn start(
        dir: Dir,
        updates: Arc<UpdateBroker>,
    ) -> Result<Self, FileSystemWatcherError> {
        Self::start_inner(dir, updates, None, FileSystemWatcherObservers::None)
    }

    pub(super) fn start_for_dir(
        dir: Dir,
        updates: Arc<UpdateBroker>,
        dir_id: String,
    ) -> Result<Self, FileSystemWatcherError> {
        Self::start_inner(dir, updates, Some(dir_id), FileSystemWatcherObservers::None)
    }

    pub(super) fn start_with_observers(
        dir: Dir,
        updates: Arc<UpdateBroker>,
        codebase: Arc<CodebaseRuntime>,
        symbol_index: Arc<SymbolIndexRuntime>,
        codebase_semantic: Option<Arc<SemanticIndexJobController>>,
        changes: Arc<dyn DirFileChangeSink>,
    ) -> Result<Self, FileSystemWatcherError> {
        Self::start_inner(
            dir,
            updates,
            None,
            FileSystemWatcherObservers::EnvRuntime {
                codebase,
                symbol_index,
                codebase_semantic,
                changes,
            },
        )
    }

    pub(super) fn start_for_session_directory(
        dir: Dir,
        updates: Arc<UpdateBroker>,
        session_id: SessionId,
        changes: Arc<dyn SessionDirFileChangeSink>,
    ) -> Result<Self, FileSystemWatcherError> {
        let root = dir.canonical_path().to_path_buf();
        Self::start_inner(
            dir,
            updates,
            None,
            FileSystemWatcherObservers::SessionDir {
                session_id,
                root,
                changes,
            },
        )
    }

    fn start_inner(
        dir: Dir,
        updates: Arc<UpdateBroker>,
        dir_id: Option<String>,
        observers: FileSystemWatcherObservers,
    ) -> Result<Self, FileSystemWatcherError> {
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let (startup, startup_rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("ash-file-system-watcher".into())
            .spawn(move || watch_dir(dir, updates, dir_id, observers, shutdown_rx, startup))
            .map_err(|error| FileSystemWatcherError(error.to_string()))?;
        match startup_rx.recv_timeout(FILE_SYSTEM_WATCH_STARTUP_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = shutdown.send(());
                let _ = thread.join();
                return Err(FileSystemWatcherError(error));
            }
            Err(error) => {
                let _ = shutdown.send(());
                let _ = thread.join();
                return Err(FileSystemWatcherError(format!(
                    "filesystem watcher did not become ready: {error}"
                )));
            }
        }
        Ok(Self {
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileSystemWatcherError(String);

impl fmt::Display for FileSystemWatcherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for FileSystemWatcherError {}

impl Drop for FileSystemWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn watch_dir(
    dir: Dir,
    updates: Arc<UpdateBroker>,
    dir_id: Option<String>,
    observers: FileSystemWatcherObservers,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
    startup: std::sync::mpsc::SyncSender<Result<(), String>>,
) {
    let (codebase, symbol_index, codebase_semantic, changes, session_changes) = match observers {
        FileSystemWatcherObservers::None => (None, None, None, None, None),
        FileSystemWatcherObservers::EnvRuntime {
            codebase,
            symbol_index,
            codebase_semantic,
            changes,
        } => (
            Some(codebase),
            Some(symbol_index),
            codebase_semantic,
            Some(changes),
            None,
        ),
        FileSystemWatcherObservers::SessionDir {
            session_id,
            root,
            changes,
        } => (None, None, None, None, Some((session_id, root, changes))),
    };
    let Ok(tokio_runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        let _ = startup.send(Err("failed to initialize filesystem watcher runtime".into()));
        return;
    };
    tokio_runtime.block_on(async move {
        let file_watcher = match FileWatcher::new_with_backend(watcher_backend(&dir)) {
            Ok(file_watcher) => file_watcher,
            Err(error) => {
                let _ = startup.send(Err(format!(
                    "failed to initialize filesystem watcher backend: {error}"
                )));
                return;
            }
        };
        let file_watcher = Arc::new(file_watcher);
        let (subscriber, receiver) = file_watcher.add_subscriber();
        let registration = subscriber.register_paths(vec![
            WatchPath {
                path: dir.requested_path().to_path_buf(),
                recursive: true,
            },
            WatchPath {
                path: dir.canonical_path().to_path_buf(),
                recursive: true,
            },
        ]);
        let _registration = match registration {
            Ok(registration) => registration,
            Err(error) => {
                let _ = startup.send(Err(format!(
                    "failed to register filesystem watcher root: {error}"
                )));
                return;
            }
        };
        let codebase_worker = match (codebase, symbol_index) {
            (Some(codebase), Some(symbol_index)) => {
                match CodebaseRefreshWorker::start(codebase, symbol_index, codebase_semantic) {
                    Ok(worker) => Some(worker),
                    Err(error) => {
                        let _ = startup.send(Err(error));
                        return;
                    }
                }
            }
            (None, None) => None,
            _ => {
                let _ = startup.send(Err(
                    "codebase and symbol-index watcher observers must be installed together".into(),
                ));
                return;
            }
        };
        if startup.send(Ok(())).is_err() {
            return;
        }
        if let Some(changes) = &changes {
            changes.files_changed(&FsChanged::RescanRequired {
                dir_id: dir_id.clone(),
            });
        }
        if let Some((session_id, root, changes)) = &session_changes {
            changes.session_files_changed(
                session_id,
                root,
                &FsChanged::RescanRequired { dir_id: None },
            );
        }
        if let Some(codebase_worker) = &codebase_worker {
            codebase_worker.schedule(FileWatcherEvent::RescanRequired {
                watched_paths: vec![dir.canonical_path().to_path_buf()],
            });
        }
        let mut receiver = DebouncedWatchReceiver::new(receiver, FILE_SYSTEM_WATCH_DEBOUNCE);
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                event = receiver.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    if let Some(codebase_worker) = &codebase_worker {
                        codebase_worker.schedule(event.clone());
                    }
                    if let Some(changed) = project_event(&dir, dir_id.as_deref(), event) {
                        if let Some(changes) = &changes {
                            changes.files_changed(&changed);
                        }
                        if let Some((session_id, root, changes)) = &session_changes {
                            changes.session_files_changed(session_id, root, &changed);
                        } else {
                            updates.publish_fs_changed(changed);
                        }
                    }
                }
            }
        }
    });
}

fn watcher_backend(dir: &Dir) -> FileWatcherBackend {
    #[cfg(test)]
    {
        // The App Server suite opens many independent environment runtimes concurrently. Polling
        // preserves real invalidation behavior without exhausting platform watcher handles.
        let _ = dir;
        FileWatcherBackend::Polling {
            interval: ALIASED_PATH_POLL_INTERVAL,
        }
    }
    #[cfg(not(test))]
    if dir.requested_path() == dir.canonical_path() {
        FileWatcherBackend::Recommended
    } else {
        FileWatcherBackend::Polling {
            interval: ALIASED_PATH_POLL_INTERVAL,
        }
    }
}

fn project_event(dir: &Dir, dir_id: Option<&str>, event: FileWatcherEvent) -> Option<FsChanged> {
    match event {
        FileWatcherEvent::PathsChanged { paths } => {
            let mut paths = paths
                .into_iter()
                .filter_map(|path| dir.project_observed_path(path))
                .collect::<Vec<_>>();
            paths.sort();
            paths.dedup();
            (!paths.is_empty()).then_some(FsChanged::PathsChanged {
                dir_id: dir_id.map(str::to_owned),
                paths,
            })
        }
        FileWatcherEvent::RescanRequired { .. } => Some(FsChanged::RescanRequired {
            dir_id: dir_id.map(str::to_owned),
        }),
    }
}

#[cfg(test)]
#[path = "fs_watcher_tests.rs"]
mod tests;
