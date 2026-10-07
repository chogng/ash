use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;

use ash_async_utils::CancellationSource;
use ash_codebase::CodebaseSemanticError;
use ash_codebase::CodebaseSemanticMetric;
use ash_codebase::CodebaseSemanticMetricsSink;
use ash_codebase::CodebaseSemanticProgressSink;
use ash_codebase::CodebaseSemanticService;
use ash_codebase::CodebaseSemanticSyncPhase;
use ash_codebase::CodebaseSemanticSyncProgress;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SemanticIndexJobState {
    Idle,
    Syncing,
    Ready,
    Stale,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SemanticIndexJobSnapshot {
    pub state: SemanticIndexJobState,
    pub operation_id: Option<u64>,
    pub target_generation: u64,
    pub published_generation: Option<u64>,
    pub phase: Option<CodebaseSemanticSyncPhase>,
    pub total_chunk_count: usize,
    pub processed_chunk_count: usize,
    pub reused_embedding_count: usize,
    pub embedded_chunk_count: usize,
    pub completed_batch_count: usize,
    pub total_batch_count: usize,
    pub retry_count: usize,
    pub last_error_code: Option<&'static str>,
}

struct ActiveOperation {
    operation_id: u64,
    cancellation: CancellationSource,
}

struct SemanticIndexJobInner {
    service: Arc<CodebaseSemanticService>,
    state: RwLock<SemanticIndexJobSnapshot>,
    active: Mutex<Option<ActiveOperation>>,
    pending: AtomicBool,
    suppressed: AtomicBool,
    next_operation_id: AtomicU64,
}

/// Bridges content-free semantic measurements into the App Server diagnostics stream.
pub(super) struct AppServerSemanticIndexMetrics;

impl CodebaseSemanticMetricsSink for AppServerSemanticIndexMetrics {
    fn record(&self, metric: CodebaseSemanticMetric) {
        match metric {
            CodebaseSemanticMetric::SyncCompleted {
                chunk_count,
                reused_count,
                embedded_count,
                retry_count,
                elapsed_millis,
            } => log::debug!(
                target: "ash_codebase",
                "sync completed: chunks={chunk_count} reused={reused_count} embedded={embedded_count} retries={retry_count} elapsed_ms={elapsed_millis}"
            ),
            CodebaseSemanticMetric::SyncCancelled { processed_count } => log::debug!(
                target: "ash_codebase",
                "sync cancelled: processed={processed_count}"
            ),
            CodebaseSemanticMetric::SyncFailed => log::debug!(
                target: "ash_codebase",
                "sync failed"
            ),
            CodebaseSemanticMetric::QueryCompleted {
                candidate_count,
                retry_count,
                elapsed_millis,
            } => log::debug!(
                target: "ash_codebase",
                "query completed: candidates={candidate_count} retries={retry_count} elapsed_ms={elapsed_millis}"
            ),
            CodebaseSemanticMetric::QueryDegraded => log::debug!(
                target: "ash_codebase",
                "query degraded"
            ),
        }
    }
}

/// Owns the background lifecycle of the active directory's semantic index.
pub(super) struct SemanticIndexJobController {
    inner: Arc<SemanticIndexJobInner>,
    control: Mutex<()>,
    wake: Mutex<Option<SyncSender<()>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl SemanticIndexJobController {
    pub(super) fn start(service: Arc<CodebaseSemanticService>) -> Result<Arc<Self>, String> {
        let target_generation = service.lexical_generation().unwrap_or(0);
        let published_generation = service.published_generation().unwrap_or(None);
        let initial_state = match published_generation {
            Some(generation) if generation == target_generation && generation > 0 => {
                SemanticIndexJobState::Ready
            }
            Some(_) => SemanticIndexJobState::Stale,
            None => SemanticIndexJobState::Idle,
        };
        let inner = Arc::new(SemanticIndexJobInner {
            service,
            state: RwLock::new(SemanticIndexJobSnapshot {
                state: initial_state,
                operation_id: None,
                target_generation,
                published_generation,
                phase: None,
                total_chunk_count: 0,
                processed_chunk_count: 0,
                reused_embedding_count: 0,
                embedded_chunk_count: 0,
                completed_batch_count: 0,
                total_batch_count: 0,
                retry_count: 0,
                last_error_code: None,
            }),
            active: Mutex::new(None),
            pending: AtomicBool::new(false),
            suppressed: AtomicBool::new(false),
            next_operation_id: AtomicU64::new(1),
        });
        let (wake, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_inner = Arc::clone(&inner);
        let thread = std::thread::Builder::new()
            .name("ash-semantic-index".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    while worker_inner.pending.swap(false, Ordering::AcqRel) {
                        worker_inner.run_once();
                    }
                }
            })
            .map_err(|error| format!("failed to initialize semantic index worker: {error}"))?;
        Ok(Arc::new(Self {
            inner,
            control: Mutex::new(()),
            wake: Mutex::new(Some(wake)),
            thread: Mutex::new(Some(thread)),
        }))
    }

    /// Coalesces refreshes and cancels an obsolete in-flight generation.
    pub(super) fn schedule(&self) {
        let _control = self
            .control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.inner.suppressed.store(false, Ordering::Release);
        self.inner.pending.store(true, Ordering::Release);
        self.cancel_active();
        {
            let mut state = self
                .inner
                .state
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.target_generation = self.inner.service.lexical_generation().unwrap_or(0);
            if state.state != SemanticIndexJobState::Syncing {
                state.state = SemanticIndexJobState::Stale;
            }
            state.last_error_code = None;
        }
        let wake = self
            .wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(wake) = wake.as_ref() {
            match wake.try_send(()) {
                Ok(()) | Err(std::sync::mpsc::TrySendError::Full(())) => {}
                Err(std::sync::mpsc::TrySendError::Disconnected(())) => {
                    log::warn!("semantic index worker stopped unexpectedly");
                }
            }
        }
    }

    pub(super) fn snapshot(&self) -> SemanticIndexJobSnapshot {
        self.inner
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn cancel_active(&self) {
        if let Some(active) = self
            .inner
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            active.cancellation.cancel();
        }
    }
}

impl Drop for SemanticIndexJobController {
    fn drop(&mut self) {
        self.inner.suppressed.store(true, Ordering::Release);
        self.inner.pending.store(false, Ordering::Release);
        self.cancel_active();
        self.wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = thread.join();
        }
    }
}

impl SemanticIndexJobInner {
    fn run_once(self: &Arc<Self>) {
        let operation_id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationSource::new();
        let target_generation = self.service.lexical_generation().unwrap_or(0);
        let published_generation = self.service.published_generation().unwrap_or(None);
        *self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ActiveOperation {
            operation_id,
            cancellation: cancellation.clone(),
        });
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = SemanticIndexJobSnapshot {
            state: SemanticIndexJobState::Syncing,
            operation_id: Some(operation_id),
            target_generation,
            published_generation,
            phase: Some(CodebaseSemanticSyncPhase::Preparing),
            total_chunk_count: 0,
            processed_chunk_count: 0,
            reused_embedding_count: 0,
            embedded_chunk_count: 0,
            completed_batch_count: 0,
            total_batch_count: 0,
            retry_count: 0,
            last_error_code: None,
        };
        if self.suppressed.load(Ordering::Acquire) {
            cancellation.cancel();
        }

        let progress = OperationProgressSink {
            operation_id,
            inner: Arc::clone(self),
        };
        let result = self
            .service
            .sync_with_control(&cancellation.token(), Some(&progress));
        let published_generation = self.service.published_generation().unwrap_or(None);
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.operation_id == Some(operation_id) {
            state.published_generation = published_generation;
            state.phase = result
                .as_ref()
                .ok()
                .map(|_| CodebaseSemanticSyncPhase::Complete);
            match result {
                Ok(result) => {
                    state.state = SemanticIndexJobState::Ready;
                    state.target_generation = result.generation;
                    state.processed_chunk_count = result.indexed_chunk_count;
                    state.total_chunk_count = result.indexed_chunk_count;
                    state.reused_embedding_count = result.reused_embedding_count;
                    state.retry_count = result.retry_count;
                    state.last_error_code = None;
                }
                Err(CodebaseSemanticError::Cancelled) => {
                    state.state = SemanticIndexJobState::Cancelled;
                    state.last_error_code = Some("cancelled");
                }
                Err(error) => {
                    state.state = SemanticIndexJobState::Failed;
                    state.last_error_code = Some(error_code(&error));
                    log::warn!("semantic codebase sync failed: {error}");
                }
            }
        }
        drop(state);
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active
            .as_ref()
            .is_some_and(|active| active.operation_id == operation_id)
        {
            *active = None;
        }
    }
}

struct OperationProgressSink {
    operation_id: u64,
    inner: Arc<SemanticIndexJobInner>,
}

impl CodebaseSemanticProgressSink for OperationProgressSink {
    fn report(&self, progress: &CodebaseSemanticSyncProgress) {
        let mut state = self
            .inner
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.operation_id != Some(self.operation_id) {
            return;
        }
        state.target_generation = progress.generation;
        state.phase = Some(progress.phase);
        state.total_chunk_count = progress.total_chunk_count;
        state.processed_chunk_count = progress.processed_chunk_count;
        state.reused_embedding_count = progress.reused_embedding_count;
        state.embedded_chunk_count = progress.embedded_chunk_count;
        state.completed_batch_count = progress.completed_batch_count;
        state.total_batch_count = progress.total_batch_count;
        state.retry_count = progress.retry_count;
    }
}

fn error_code(error: &CodebaseSemanticError) -> &'static str {
    match error {
        CodebaseSemanticError::InvalidInput(_) => "invalidInput",
        CodebaseSemanticError::IndexNotReady => "indexNotReady",
        CodebaseSemanticError::Cancelled => "cancelled",
        CodebaseSemanticError::InvalidModelResponse(_) => "invalidModelResponse",
        CodebaseSemanticError::LocalIndex(_) => "localIndexFailed",
        CodebaseSemanticError::Model(_) => "modelInvocationFailed",
        CodebaseSemanticError::VectorStore(_) => "vectorStoreFailed",
    }
}
