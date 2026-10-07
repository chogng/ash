use crate::FileWatcherEvent;
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

#[derive(Default)]
struct PendingEvent {
    changed_paths: BTreeSet<PathBuf>,
    rescan_paths: BTreeSet<PathBuf>,
}

impl PendingEvent {
    fn add_changed_paths(&mut self, paths: &[PathBuf]) {
        if self.rescan_paths.is_empty() {
            self.changed_paths.extend(paths.iter().cloned());
        }
    }

    fn require_rescan(&mut self, watched_paths: &[PathBuf]) {
        self.changed_paths.clear();
        self.rescan_paths.extend(watched_paths.iter().cloned());
    }

    fn is_empty(&self) -> bool {
        self.changed_paths.is_empty() && self.rescan_paths.is_empty()
    }

    fn take(&mut self) -> Option<FileWatcherEvent> {
        if !self.rescan_paths.is_empty() {
            return Some(FileWatcherEvent::RescanRequired {
                watched_paths: std::mem::take(&mut self.rescan_paths).into_iter().collect(),
            });
        }
        (!self.changed_paths.is_empty()).then(|| FileWatcherEvent::PathsChanged {
            paths: std::mem::take(&mut self.changed_paths)
                .into_iter()
                .collect(),
        })
    }
}

/// Receives coalesced invalidation hints for one subscriber.
pub struct Receiver {
    inner: Arc<ReceiverInner>,
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
    /// Waits for the next hint, returning `None` after its subscriber is gone.
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        loop {
            let notified = self.inner.notify.notified();
            {
                let mut pending = self.inner.pending.lock().await;
                if let Some(event) = pending.take() {
                    return Some(event);
                }
                if self.inner.sender_count.load(Ordering::Acquire) == 0 {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl WatchSender {
    pub(crate) async fn add_changed_paths(&self, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }
        let mut pending = self.inner.pending.lock().await;
        let was_empty = pending.is_empty();
        pending.add_changed_paths(paths);
        if was_empty && !pending.is_empty() {
            self.inner.notify.notify_one();
        }
    }

    pub(crate) async fn require_rescan(&self, watched_paths: &[PathBuf]) {
        if watched_paths.is_empty() {
            return;
        }
        let mut pending = self.inner.pending.lock().await;
        pending.require_rescan(watched_paths);
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
        if self.inner.sender_count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.inner.notify.notify_waiters();
        }
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
        Receiver { inner },
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
    pending: Option<FileWatcherEvent>,
}

impl DebouncedWatchReceiver {
    /// Wraps a raw watcher receiver with trailing-edge batch coalescing.
    pub fn new(rx: Receiver, interval: Duration) -> Self {
        Self {
            rx,
            interval,
            pending: None,
        }
    }

    /// Receives the next debounced hint batch.
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        while self.pending.is_none() {
            self.pending = self.rx.recv().await;
            self.pending.as_ref()?;
        }
        let deadline = Instant::now() + self.interval;
        loop {
            tokio::select! {
                event = self.rx.recv() => match event {
                    Some(event) => merge_event(&mut self.pending, event),
                    None => break,
                },
                _ = sleep_until(deadline) => break,
            }
        }
        self.pending.take()
    }
}

fn merge_event(pending: &mut Option<FileWatcherEvent>, next: FileWatcherEvent) {
    let Some(current) = pending.take() else {
        *pending = Some(next);
        return;
    };
    let merged = match (current, next) {
        (
            FileWatcherEvent::PathsChanged { paths: left },
            FileWatcherEvent::PathsChanged { paths: right },
        ) => FileWatcherEvent::PathsChanged {
            paths: merge_paths(left, right),
        },
        (
            FileWatcherEvent::RescanRequired {
                watched_paths: left,
            },
            FileWatcherEvent::RescanRequired {
                watched_paths: right,
            },
        ) => FileWatcherEvent::RescanRequired {
            watched_paths: merge_paths(left, right),
        },
        (
            FileWatcherEvent::RescanRequired { watched_paths },
            FileWatcherEvent::PathsChanged { .. },
        )
        | (
            FileWatcherEvent::PathsChanged { .. },
            FileWatcherEvent::RescanRequired { watched_paths },
        ) => FileWatcherEvent::RescanRequired { watched_paths },
    };
    *pending = Some(merged);
}

fn merge_paths(left: Vec<PathBuf>, right: Vec<PathBuf>) -> Vec<PathBuf> {
    left.into_iter()
        .chain(right)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
