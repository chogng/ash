use crate::FileWatcherEvent;
use crate::ingress::RESCAN_INTERVAL;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio::time::sleep_until;

const MAX_PENDING_PATHS: usize = 4096;
const MAX_PENDING_BYTES: usize = 1024 * 1024;

/// A byte- and count-bounded set shared by routing and subscriber accumulation.
#[derive(Default)]
pub(crate) struct PathBatch {
    paths: BTreeSet<PathBuf>,
    bytes: usize,
}

impl PathBatch {
    pub(crate) fn insert(&mut self, path: PathBuf) -> bool {
        if self.paths.contains(&path) {
            return true;
        }
        let bytes = path.capacity();
        if self.paths.len() >= MAX_PENDING_PATHS
            || bytes > MAX_PENDING_BYTES.saturating_sub(self.bytes)
        {
            return false;
        }
        self.paths.insert(path);
        self.bytes += bytes;
        true
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    pub(crate) fn into_paths(self) -> Vec<PathBuf> {
        self.paths.into_iter().collect()
    }
}

#[derive(Default)]
enum PendingEvent {
    #[default]
    None,
    Paths(PathBatch),
    Rescan {
        watched_paths: Vec<PathBuf>,
    },
}

impl PendingEvent {
    fn add_changed_paths(&mut self, changes: &[PathBuf], roots: impl FnOnce() -> Vec<PathBuf>) {
        if matches!(self, Self::None) {
            *self = Self::Paths(PathBatch::default());
        }
        if let Self::Paths(paths) = self {
            for path in changes {
                if !paths.insert(path.clone()) {
                    self.require_rescan(roots());
                    return;
                }
            }
        } else {
            // Registration can change while a slow consumer still owes a rescan.
            // Keep a snapshot of the current owned roots, not a history of old roots.
            self.require_rescan(roots());
        }
    }

    fn require_rescan(&mut self, watched_paths: Vec<PathBuf>) {
        *self = Self::Rescan {
            watched_paths: watched_paths
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        };
    }

    fn is_empty(&self) -> bool {
        matches!(self, Self::None)
    }

    fn take(&mut self) -> Option<FileWatcherEvent> {
        match std::mem::take(self) {
            Self::None => None,
            Self::Paths(paths) => Some(FileWatcherEvent::PathsChanged {
                paths: paths.into_paths(),
            }),
            Self::Rescan { watched_paths } => {
                Some(FileWatcherEvent::RescanRequired { watched_paths })
            }
        }
    }
}

/// Receives bounded, coalesced invalidation hints for one subscriber.
pub struct Receiver {
    inner: Arc<ReceiverInner>,
    next_rescan: Option<Instant>,
}

pub(crate) struct WatchSender {
    inner: Arc<ReceiverInner>,
}

struct ReceiverInner {
    pending: Mutex<PendingEvent>,
    notify: Notify,
    sender_count: AtomicUsize,
}

impl Receiver {
    async fn wait_pending(&self) -> bool {
        loop {
            let notified = self.inner.notify.notified();
            {
                let pending = self.inner.pending.lock().await;
                if !pending.is_empty() {
                    return true;
                }
                if self.inner.sender_count.load(Ordering::Acquire) == 0 {
                    return false;
                }
            }
            notified.await;
        }
    }

    /// Waits for the next hint, returning `None` after its subscriber is gone.
    /// Repeated full rescans are coalesced for at least one second; changes after
    /// a delivered hint remain pending so a scan in progress cannot swallow them.
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        while self.wait_pending().await {
            let deadline = {
                let mut pending = self.inner.pending.lock().await;
                if matches!(*pending, PendingEvent::Rescan { .. }) {
                    if let Some(deadline) = self
                        .next_rescan
                        .filter(|deadline| *deadline > Instant::now())
                    {
                        Some(deadline)
                    } else {
                        self.next_rescan = Some(Instant::now() + RESCAN_INTERVAL);
                        return pending.take();
                    }
                } else {
                    return pending.take();
                }
            };
            if let Some(deadline) = deadline {
                sleep_until(deadline).await;
            }
        }
        None
    }
}

impl WatchSender {
    pub(crate) async fn add_changed_paths(
        &self,
        paths: &[PathBuf],
        roots: impl FnOnce() -> Vec<PathBuf>,
    ) {
        if paths.is_empty() {
            return;
        }
        let mut pending = self.inner.pending.lock().await;
        let was_empty = pending.is_empty();
        pending.add_changed_paths(paths, roots);
        if was_empty && !pending.is_empty() {
            self.inner.notify.notify_one();
        }
    }

    pub(crate) async fn require_rescan(&self, watched_paths: &[PathBuf]) {
        if watched_paths.is_empty() {
            return;
        }
        self.inner
            .pending
            .lock()
            .await
            .require_rescan(watched_paths.to_vec());
        self.inner.notify.notify_one();
    }
}

impl Clone for WatchSender {
    fn clone(&self) -> Self {
        self.inner.sender_count.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl Drop for WatchSender {
    fn drop(&mut self) {
        self.inner.sender_count.fetch_sub(1, Ordering::AcqRel);
        self.inner.notify.notify_one();
    }
}

pub(crate) fn watch_channel() -> (WatchSender, Receiver) {
    let inner = Arc::new(ReceiverInner {
        pending: Mutex::new(PendingEvent::default()),
        notify: Notify::new(),
        sender_count: AtomicUsize::new(1),
    });
    (
        WatchSender {
            inner: Arc::clone(&inner),
        },
        Receiver {
            inner,
            next_rescan: None,
        },
    )
}

/// Emits at most one coalesced watcher hint per configured interval.
pub struct ThrottledWatchReceiver {
    rx: Receiver,
    interval: Duration,
    next_allowed: Option<Instant>,
}

impl ThrottledWatchReceiver {
    /// Wraps a raw watcher receiver with leading-edge throttling.
    pub fn new(rx: Receiver, interval: Duration) -> Self {
        Self {
            rx,
            interval,
            next_allowed: None,
        }
    }

    /// Receives the next hint after enforcing the minimum emission interval.
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        if let Some(next_allowed) = self.next_allowed {
            sleep_until(next_allowed).await;
        }
        let event = self.rx.recv().await;
        if event.is_some() {
            self.next_allowed = Some(Instant::now() + self.interval);
        }
        event
    }
}

/// Coalesces watcher hints during a fixed window after the first hint.
pub struct DebouncedWatchReceiver {
    rx: Receiver,
    interval: Duration,
    deadline: Option<Instant>,
}

impl DebouncedWatchReceiver {
    /// Wraps a raw watcher receiver with trailing-edge batch coalescing.
    pub fn new(rx: Receiver, interval: Duration) -> Self {
        Self {
            rx,
            interval,
            deadline: None,
        }
    }

    /// Receives the next debounced hint batch without moving it into a second,
    /// potentially unbounded accumulator. Cancellation preserves the deadline.
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        if self.deadline.is_none() {
            if !self.rx.wait_pending().await {
                return None;
            }
            self.deadline = Some(Instant::now() + self.interval);
        }
        sleep_until(self.deadline.unwrap()).await;
        let event = self.rx.recv().await;
        self.deadline = None;
        event
    }
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
