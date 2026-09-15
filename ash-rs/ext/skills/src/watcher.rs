use crate::SkillCatalogReload;
use crate::SkillRuntime;
use ash_file_watcher::DebouncedWatchReceiver;
use ash_file_watcher::FileWatcher;
use ash_file_watcher::FileWatcherBackend;
use ash_file_watcher::FileWatcherEvent;
use ash_file_watcher::WatchPath;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

const ALIASED_PATH_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct SkillWatcher {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl SkillRuntime {
    pub fn start_watching(self: &Arc<Self>) -> SkillWatcher {
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let (ready, ready_rx) = std::sync::mpsc::channel();
        let runtime = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("ash-skill-watcher".into())
            .spawn(move || watch_skill_sources(runtime, shutdown_rx, ready))
            .ok();
        if thread.is_none() {
            return SkillWatcher::default();
        }
        let _ = ready_rx.recv_timeout(Duration::from_secs(1));
        SkillWatcher {
            shutdown: Some(shutdown),
            thread,
        }
    }
}

impl Drop for SkillWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn watch_skill_sources(
    runtime: std::sync::Weak<SkillRuntime>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
    ready: std::sync::mpsc::Sender<()>,
) {
    let Ok(tokio_runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        return;
    };
    let config_changes = runtime
        .upgrade()
        .and_then(|runtime| runtime.config.config_changes());
    tokio_runtime.block_on(async move {
        let Some(skill_runtime) = runtime.upgrade() else {
            return;
        };
        let mut watched_paths = skill_runtime.watched_paths();
        let backend = watcher_backend(&watched_paths);
        drop(skill_runtime);
        let Ok(file_watcher) = FileWatcher::new_with_backend(backend) else {
            return;
        };
        let file_watcher = Arc::new(file_watcher);
        let (subscriber, receiver) = file_watcher.add_subscriber();
        let Ok(mut registration) = subscriber.register_paths(watch_paths(&watched_paths)) else {
            return;
        };
        let mut receiver = DebouncedWatchReceiver::new(receiver, Duration::from_millis(75));
        let mut config_poll = tokio::time::interval(Duration::from_millis(250));
        let _ = ready.send(());
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = config_poll.tick() => {
                    let Some(skill_runtime) = runtime.upgrade() else {
                        break;
                    };
                    if config_changes
                        .as_ref()
                        .is_some_and(|changes| changes.try_iter().count() > 0)
                    {
                        let _ = skill_runtime.list(SkillCatalogReload::Cached);
                    }
                    refresh_registered_paths(
                        &skill_runtime,
                        &subscriber,
                        &mut registration,
                        &mut watched_paths,
                    );
                }
                event = receiver.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    let Some(skill_runtime) = runtime.upgrade() else {
                        break;
                    };
                    if event_affects_catalog(&skill_runtime, &event) {
                        let _ = skill_runtime.list(SkillCatalogReload::Refresh);
                    }
                    refresh_registered_paths(
                        &skill_runtime,
                        &subscriber,
                        &mut registration,
                        &mut watched_paths,
                    );
                }
            }
        }
        drop(registration);
    });
}

fn refresh_registered_paths(
    runtime: &SkillRuntime,
    subscriber: &ash_file_watcher::FileWatcherSubscriber,
    registration: &mut ash_file_watcher::WatchRegistration,
    watched_paths: &mut Vec<PathBuf>,
) {
    let next_paths = runtime.watched_paths();
    if next_paths != *watched_paths
        && let Ok(next_registration) = subscriber.register_paths(watch_paths(&next_paths))
    {
        *registration = next_registration;
        *watched_paths = next_paths;
        let _ = runtime.list(SkillCatalogReload::Refresh);
    }
}

pub(crate) fn event_affects_catalog(runtime: &SkillRuntime, event: &FileWatcherEvent) -> bool {
    let FileWatcherEvent::PathsChanged { paths } = event else {
        return true;
    };
    let state = runtime
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut catalog_roots = state
        .source_fingerprint
        .iter()
        .map(|source| source.root.clone())
        .collect::<Vec<_>>();
    drop(state);
    if let Some(dir_root) = runtime
        .dir_root
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
    {
        catalog_roots.push(dir_root.join(".ash/skills"));
    }
    paths.iter().any(|changed| {
        catalog_roots
            .iter()
            .any(|root| changed.starts_with(root) || root.starts_with(changed))
    })
}

fn watch_paths(paths: &[PathBuf]) -> Vec<WatchPath> {
    paths
        .iter()
        .map(|path| WatchPath {
            path: path.clone(),
            recursive: path.is_dir(),
        })
        .collect()
}

fn watcher_backend(paths: &[PathBuf]) -> FileWatcherBackend {
    if paths.iter().any(|path| {
        path.canonicalize()
            .map(|canonical| canonical != *path)
            .unwrap_or(false)
    }) {
        FileWatcherBackend::Polling {
            interval: ALIASED_PATH_POLL_INTERVAL,
        }
    } else {
        FileWatcherBackend::Recommended
    }
}
