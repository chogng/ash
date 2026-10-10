use crate::recorder::Observation;
use crate::recorder::RecorderStorage;
use ash_protocol::SessionId;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

pub(super) const MAX_QUEUE_RECORDS: usize = 128;
pub(super) const MAX_RETAINED_BYTES: usize = 32 * 1024 * 1024;
pub(super) const MAX_ACTIVE_ATTEMPTS: usize = 64;
pub(super) const MAX_TRACKED_CAPTURES: usize = 128;

pub(super) struct Capture {
    pub(super) session_id: SessionId,
    pub(super) pending: AtomicU64,
    pub(super) dropped: AtomicU64,
    pub(super) persisted_drops: AtomicU64,
    pub(super) retired: AtomicBool,
    pub(super) cleanup_pending: AtomicBool,
    pub(super) error: Mutex<Option<String>>,
}

struct Shared {
    captures: Mutex<BTreeMap<SessionId, Arc<Capture>>>,
    retained_bytes: AtomicUsize,
    active_attempts: AtomicUsize,
    pending: AtomicU64,
    closed: AtomicBool,
    admission: Mutex<()>,
    progress: Condvar,
    progress_lock: Mutex<()>,
}

pub(super) struct RetainedBytes {
    shared: Arc<Shared>,
    bytes: usize,
}
impl Drop for RetainedBytes {
    fn drop(&mut self) {
        self.shared
            .retained_bytes
            .fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

pub(super) struct AttemptLease {
    shared: Arc<Shared>,
    partial_bytes: Option<RetainedBytes>,
}
impl AttemptLease {
    pub(super) fn take_bytes(&mut self) -> RetainedBytes {
        self.partial_bytes
            .take()
            .expect("attempt owns its partial-output reservation")
    }
}
impl Drop for AttemptLease {
    fn drop(&mut self) {
        self.shared.active_attempts.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(super) struct Record {
    pub(super) capture: Arc<Capture>,
    pub(super) observation: Observation,
    pub(super) observed_at: u64,
    _bytes: RetainedBytes,
}

#[derive(Clone)]
pub(super) struct WorkerHandle {
    sender: mpsc::SyncSender<Record>,
    shared: Arc<Shared>,
}

/// Result of a bounded persistence barrier. Turn completion never waits on this barrier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FlushOutcome {
    Complete,
    TimedOut { pending_records: u64 },
}

pub(super) struct Worker {
    pub(super) handle: WorkerHandle,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    pub(super) fn start(storage: Arc<RecorderStorage>) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel::<Record>(MAX_QUEUE_RECORDS);
        let shared = Arc::new(Shared {
            captures: Mutex::new(BTreeMap::new()),
            retained_bytes: AtomicUsize::new(0),
            active_attempts: AtomicUsize::new(0),
            pending: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            admission: Mutex::new(()),
            progress: Condvar::new(),
            progress_lock: Mutex::new(()),
        });
        let worker_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("ash-trace-recorder".into())
            .spawn(move || {
                let _exit = WorkerExit(worker_shared.clone());
                loop {
                    match receiver.recv_timeout(Duration::from_millis(25)) {
                        Ok(record) => {
                            if !record.capture.retired.load(Ordering::Acquire) {
                                storage.process(&record);
                            }
                            record.capture.pending.fetch_sub(1, Ordering::Release);
                            worker_shared.pending.fetch_sub(1, Ordering::Release);
                            drop(record);
                            let _guard = worker_shared
                                .progress_lock
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            worker_shared.progress.notify_all();
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    let captures = worker_shared
                        .captures
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    for capture in captures {
                        storage.maintain(&capture);
                    }
                    if worker_shared.closed.load(Ordering::Acquire)
                        && worker_shared.pending.load(Ordering::Acquire) == 0
                    {
                        break;
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            handle: WorkerHandle { sender, shared },
            thread: Some(thread),
        })
    }
}

impl WorkerHandle {
    pub(super) fn capture(&self, session_id: &SessionId) -> Option<Arc<Capture>> {
        if self.shared.closed.load(Ordering::Acquire) || session_id.as_str().len() > 4096 {
            return None;
        }
        let mut captures = self
            .shared
            .captures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(capture) = captures.get(session_id) {
            return Some(capture.clone());
        }
        if captures.len() >= MAX_TRACKED_CAPTURES {
            let retired = captures
                .iter()
                .find(|(_, capture)| {
                    capture.retired.load(Ordering::Acquire)
                        && !capture.cleanup_pending.load(Ordering::Acquire)
                        && capture.pending.load(Ordering::Acquire) == 0
                        && Arc::strong_count(capture) == 1
                })
                .map(|(id, _)| id.clone());
            if let Some(id) = retired {
                captures.remove(&id);
            } else {
                return None;
            }
        }
        let capture = Arc::new(Capture {
            session_id: session_id.clone(),
            pending: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            persisted_drops: AtomicU64::new(0),
            retired: AtomicBool::new(false),
            cleanup_pending: AtomicBool::new(false),
            error: Mutex::new(None),
        });
        captures.insert(session_id.clone(), capture.clone());
        Some(capture)
    }
    pub(super) fn existing_capture(&self, session_id: &SessionId) -> Option<Arc<Capture>> {
        self.shared
            .captures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
    }
    pub(super) fn captures_full(&self) -> bool {
        self.shared
            .captures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
            >= MAX_TRACKED_CAPTURES
    }
    pub(super) fn reserve(&self, bytes: usize) -> Option<RetainedBytes> {
        if self.shared.closed.load(Ordering::Acquire) {
            return None;
        }
        self.shared
            .retained_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current
                    .checked_add(bytes)
                    .filter(|total| *total <= MAX_RETAINED_BYTES)
            })
            .ok()?;
        Some(RetainedBytes {
            shared: self.shared.clone(),
            bytes,
        })
    }
    pub(super) fn attempt(&self, capture: &Capture, partial_bytes: usize) -> Option<AttemptLease> {
        if capture.retired.load(Ordering::Acquire) {
            return None;
        }
        self.shared
            .active_attempts
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |active| {
                (active < MAX_ACTIVE_ATTEMPTS).then_some(active + 1)
            })
            .ok()?;
        match self.reserve(partial_bytes) {
            Some(bytes) => Some(AttemptLease {
                shared: self.shared.clone(),
                partial_bytes: Some(bytes),
            }),
            None => {
                self.shared.active_attempts.fetch_sub(1, Ordering::Relaxed);
                None
            }
        }
    }
    pub(super) fn enqueue(
        &self,
        capture: &Arc<Capture>,
        observation: Observation,
        bytes: RetainedBytes,
    ) {
        // Closing and admission share only this short gate; storage never acquires it.
        // Producers discard on contention instead of waiting behind another producer.
        let Ok(_admission) = self.shared.admission.try_lock() else {
            Self::lost(capture);
            return;
        };
        if self.shared.closed.load(Ordering::Acquire) || capture.retired.load(Ordering::Acquire) {
            Self::lost(capture);
            return;
        }
        capture.pending.fetch_add(1, Ordering::Release);
        self.shared.pending.fetch_add(1, Ordering::Release);
        if self
            .sender
            .try_send(Record {
                capture: capture.clone(),
                observation,
                observed_at: crate::recorder::unix_ms(),
                _bytes: bytes,
            })
            .is_err()
        {
            Self::lost(capture);
            capture.pending.fetch_sub(1, Ordering::Release);
            self.shared.pending.fetch_sub(1, Ordering::Release);
        }
    }
    pub(super) fn lost(capture: &Capture) {
        capture.dropped.fetch_add(1, Ordering::Relaxed);
    }
    pub(super) fn flush(&self, timeout: Duration) -> FlushOutcome {
        let deadline = Instant::now() + timeout;
        let mut guard = self
            .shared
            .progress_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            let pending = self.shared.pending.load(Ordering::Acquire);
            if pending == 0 {
                return FlushOutcome::Complete;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return FlushOutcome::TimedOut {
                    pending_records: pending,
                };
            }
            let (next, _) = self
                .shared
                .progress
                .wait_timeout(guard, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard = next;
        }
    }
    pub(super) fn stop(&self, timeout: Duration) -> FlushOutcome {
        {
            let _admission = self
                .shared
                .admission
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.shared.closed.store(true, Ordering::Release);
        }
        self.flush(timeout)
    }
    pub(super) fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.handle.stop(Duration::from_millis(250));
        if let Some(thread) = self.thread.take()
            && thread.is_finished()
        {
            let _ = thread.join();
        }
    }
}

struct WorkerExit(Arc<Shared>);
impl Drop for WorkerExit {
    fn drop(&mut self) {
        self.0.closed.store(true, Ordering::Release);
        let _guard = self
            .0
            .progress_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.0.progress.notify_all();
    }
}
