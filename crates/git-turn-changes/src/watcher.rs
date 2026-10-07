use crate::{CaptureState, TurnChangeLedger, TurnChangeSet, TurnChangeStore};
use ash_file_watcher::{DebouncedWatchReceiver, FileWatcher, WatchPath};
use ash_protocol::{ThreadId, TurnId};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(75);
const WATCH_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Counts active Tool and Hook write lifecycles so filesystem notifications can identify writes
/// that happened outside an attributed execution window.
#[derive(Clone, Default)]
pub struct WriteLifecycleTracker {
    active: Arc<RwLock<BTreeMap<(ThreadId, TurnId), usize>>>,
    checkpoints: Arc<CheckpointGate>,
}

#[derive(Default)]
struct CheckpointGate {
    threads: std::sync::Mutex<std::collections::BTreeSet<ThreadId>>,
    released: std::sync::Condvar,
}

/// Keeps new write lifecycles out of one Thread until a file checkpoint commits.
pub struct WriteCheckpointLease {
    gate: Arc<CheckpointGate>,
    thread_id: ThreadId,
}

impl Drop for WriteCheckpointLease {
    fn drop(&mut self) {
        self.gate
            .threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.thread_id);
        self.gate.released.notify_all();
    }
}

impl WriteLifecycleTracker {
    pub fn begin(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), String> {
        let mut gate = self
            .checkpoints
            .threads
            .lock()
            .map_err(|_| "checkpoint gate poisoned".to_string())?;
        while gate.contains(thread_id) {
            gate = self
                .checkpoints
                .released
                .wait(gate)
                .map_err(|_| "checkpoint gate poisoned".to_string())?;
        }
        let mut active = self
            .active
            .write()
            .map_err(|_| "write lifecycle lock poisoned".to_string())?;
        let count = active
            .entry((thread_id.clone(), turn_id.clone()))
            .or_insert(0);
        *count = count
            .checked_add(1)
            .ok_or_else(|| "write lifecycle count exhausted".to_string())?;
        Ok(())
    }

    pub fn try_checkpoint(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<WriteCheckpointLease>, String> {
        let mut gate = self
            .checkpoints
            .threads
            .lock()
            .map_err(|_| "checkpoint gate poisoned".to_string())?;
        let active = self
            .active
            .read()
            .map_err(|_| "write lifecycle lock poisoned".to_string())?;
        if gate.contains(thread_id) || active.keys().any(|(thread, _)| thread == thread_id) {
            return Ok(None);
        }
        gate.insert(thread_id.clone());
        Ok(Some(WriteCheckpointLease {
            gate: self.checkpoints.clone(),
            thread_id: thread_id.clone(),
        }))
    }

    pub fn end(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        let mut active = self
            .active
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (thread_id.clone(), turn_id.clone());
        let Some(count) = active.get_mut(&key) else {
            return;
        };
        if *count <= 1 {
            active.remove(&key);
        } else {
            *count -= 1;
        }
    }

    fn count(&self, thread_id: &ThreadId, turn_id: &TurnId) -> usize {
        self.active
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(thread_id.clone(), turn_id.clone()))
            .copied()
            .unwrap_or(0)
    }
}

/// Watches the managed Git worktree for one Thread and refreshes its open ChangeSets.
pub struct GitTurnChangeWatcher {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl GitTurnChangeWatcher {
    pub fn start(
        thread_id: ThreadId,
        roots: Vec<PathBuf>,
        ledger: TurnChangeLedger,
        store: Arc<dyn TurnChangeStore>,
        write_lifecycles: WriteLifecycleTracker,
        publish: Arc<dyn Fn(&[TurnChangeSet]) + Send + Sync>,
    ) -> Result<Self, String> {
        if roots.is_empty() {
            return Err("Git Turn change watcher requires at least one worktree root".into());
        }
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let (startup, startup_rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("git-turn-change-watcher".into())
            .spawn(move || {
                watch_thread(
                    thread_id,
                    roots,
                    ledger,
                    store,
                    write_lifecycles,
                    publish,
                    shutdown_rx,
                    startup,
                )
            })
            .map_err(|error| format!("failed to start Git Turn change watcher: {error}"))?;
        match startup_rx.recv_timeout(WATCH_STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                shutdown: Some(shutdown),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = shutdown.send(());
                let _ = thread.join();
                Err(error)
            }
            Err(error) => {
                let _ = shutdown.send(());
                let _ = thread.join();
                Err(format!(
                    "Git Turn change watcher did not become ready: {error}"
                ))
            }
        }
    }
}

impl Drop for GitTurnChangeWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn watch_thread(
    thread_id: ThreadId,
    roots: Vec<PathBuf>,
    ledger: TurnChangeLedger,
    store: Arc<dyn TurnChangeStore>,
    write_lifecycles: WriteLifecycleTracker,
    publish: Arc<dyn Fn(&[TurnChangeSet]) + Send + Sync>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
    startup: std::sync::mpsc::SyncSender<Result<(), String>>,
) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        let _ = startup.send(Err(
            "failed to initialize Git Turn change watcher runtime".into()
        ));
        return;
    };
    runtime.block_on(async move {
        let watcher = match FileWatcher::new() {
            Ok(watcher) => Arc::new(watcher),
            Err(error) => {
                let _ = startup.send(Err(format!(
                    "failed to initialize Git Turn change watcher backend: {error}"
                )));
                return;
            }
        };
        let (subscriber, receiver) = watcher.add_subscriber();
        let paths = roots
            .into_iter()
            .map(|path| WatchPath {
                path,
                recursive: true,
            })
            .collect();
        let _registration = match subscriber.register_paths(paths) {
            Ok(registration) => registration,
            Err(error) => {
                let _ = startup.send(Err(format!(
                    "failed to register managed Git worktree watcher: {error}"
                )));
                return;
            }
        };
        if startup.send(Ok(())).is_err() {
            return;
        }
        let mut receiver = DebouncedWatchReceiver::new(receiver, WATCH_DEBOUNCE);
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                event = receiver.recv() => {
                    if event.is_none() {
                        break;
                    }
                    refresh_thread(
                        &thread_id,
                        &ledger,
                        store.as_ref(),
                        &write_lifecycles,
                        publish.as_ref(),
                    );
                }
            }
        }
    });
}

fn refresh_thread(
    thread_id: &ThreadId,
    ledger: &TurnChangeLedger,
    store: &dyn TurnChangeStore,
    write_lifecycles: &WriteLifecycleTracker,
    publish: &(dyn Fn(&[TurnChangeSet]) + Send + Sync),
) {
    let records = match store.list_for_thread(thread_id) {
        Ok(records) => records,
        Err(error) => {
            log::warn!("Git Turn change watcher could not read ledger: {error}");
            return;
        }
    };
    let mut turns = records
        .iter()
        .filter(|record| record.capture_state == CaptureState::Open)
        .map(|record| (record.session_id.clone(), record.turn_id.clone()))
        .collect::<Vec<_>>();
    turns.sort();
    turns.dedup();
    for (session_id, turn_id) in turns {
        let active_count = write_lifecycles.count(thread_id, &turn_id);
        let refreshed =
            match ledger.refresh_turn(session_id.clone(), thread_id.clone(), turn_id.clone()) {
                Ok(records) => records,
                Err(error) => {
                    log::warn!("Git Turn change watcher refresh failed: {error}");
                    continue;
                }
            };
        publish(&refreshed);
        if active_count > 0 {
            continue;
        }
        let unexplained = refreshed.iter().any(|record| {
            !record.attribution_incomplete
                && record
                    .files
                    .iter()
                    .flat_map(|file| [Some(&file.path), file.previous_path.as_ref()])
                    .flatten()
                    .any(|path| !record.write_paths.contains(path))
        });
        if unexplained {
            match ledger.record_ambiguous_write(
                session_id,
                thread_id.clone(),
                turn_id,
                "filesystem write observed outside a known Tool or Hook lifecycle".into(),
            ) {
                Ok(records) => publish(&records),
                Err(error) => {
                    log::warn!("Git Turn change watcher attribution failed: {error}")
                }
            }
        }
    }
}
