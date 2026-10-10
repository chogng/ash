use crate::DiagnosticError;
use crate::DiagnosticEvent;
use crate::DiagnosticEventKind;
use crate::DiagnosticPage;
use crate::DiagnosticTrace;
use crate::InferenceContext;
use crate::PayloadKind;
use crate::PayloadRef;
use crate::PayloadStatus;
use crate::RecordingStatus;
use crate::budget::Budget;
use crate::worker::AttemptLease;
use crate::worker::Capture;
use crate::worker::FlushOutcome;
use crate::worker::MAX_TRACKED_CAPTURES;
use crate::worker::Record;
use crate::worker::Worker;
use crate::worker::WorkerHandle;
use ash_protocol::AssistantMessage;
use ash_protocol::ContentDigest;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Opt-in, local-only recording root; read once when the runtime owner is composed.
pub const TRACE_ROOT_ENV: &str = "ASH_ROLLOUT_TRACE_ROOT";
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 128 * 1024 * 1024;
const MAX_PROFILE_BYTES: usize = 512 * 1024 * 1024;
const MAX_CAPTURE_EVENTS: usize = 32_000;
const MAX_CAPTURE_EVENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENT_METADATA_BYTES: usize = 64 * 1024;
const MAX_CACHED_CAPTURES: usize = 4;
const MAX_PARTIAL_TEXT_BYTES: usize = MAX_PAYLOAD_BYTES / 8;
const MAX_PARTIAL_MESSAGES: usize = 128;
// String growth can retain twice the stored text; also reserve message identities and phases.
const PARTIAL_RETAINED_BYTES: usize = MAX_PARTIAL_TEXT_BYTES * 4 + MAX_PARTIAL_MESSAGES * 4096;
const READ_FLUSH_TIMEOUT: Duration = Duration::from_millis(250);

enum OpenMode {
    Existing,
    Create,
}

/// Optional profile-owned recorder. No worker, queue, directory or request copy exists when off.
#[derive(Default)]
pub struct TraceRecorder {
    storage: Arc<RecorderStorage>,
    worker: OnceLock<Result<Worker, String>>,
}

#[derive(Default)]
pub(super) struct RecorderStorage {
    root: Option<PathBuf>,
    writers: Mutex<BTreeMap<SessionId, Arc<Mutex<Writer>>>>,
    stored_bytes: AtomicUsize,
    stored_captures: AtomicUsize,
    inventory: OnceLock<Result<String, String>>,
}

/// Startup configuration and observed storage faults; enabled does not imply complete evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecorderState {
    Disabled,
    Enabled { directory: PathBuf },
    Unavailable { directory: PathBuf, error: String },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    session_id: SessionId,
    capture_id: String,
    dropped_records: u64,
    bytes_written: usize,
    next_payload: u64,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    observed_drops: u64,
}

struct Writer {
    directory: PathBuf,
    manifest: Manifest,
    events: Vec<DiagnosticEvent>,
    event_bytes: usize,
    profile_remaining: usize,
    observed_at: u64,
}

#[derive(Serialize)]
pub(super) struct PartialOutput {
    text: String,
    reasoning: String,
    messages: Vec<AssistantMessage>,
    truncated: bool,
}

pub(super) enum Observation {
    Started {
        context: InferenceContext,
        attempt_id: String,
        request: Option<ModelRequest>,
    },
    Prepared {
        context: InferenceContext,
        attempt_id: String,
        request: Option<ModelRequest>,
    },
    Completed {
        context: InferenceContext,
        attempt_id: String,
        response: Option<ModelResponse>,
    },
    Terminated {
        context: InferenceContext,
        attempt_id: String,
        termination: Termination,
        partial: Option<PartialOutput>,
    },
    Hook {
        thread_id: ash_protocol::ThreadId,
        turn_id: Option<ash_protocol::TurnId>,
        run_id: String,
        evidence: Option<Value>,
    },
    HookProcess {
        thread_id: ash_protocol::ThreadId,
        turn_id: Option<ash_protocol::TurnId>,
        run_id: String,
        evidence: Option<core_api::HookRunEvidence>,
    },
    Accounted {
        context: InferenceContext,
        attempt_id: String,
        receipt: core_api::ModelInvocationReceipt,
    },
}
pub(super) enum Termination {
    Failed(String),
    Cancelled(String),
    Abandoned,
}

impl TraceRecorder {
    fn worker(&self) -> Option<&WorkerHandle> {
        self.storage.root.as_ref()?;
        self.worker
            .get_or_init(|| Worker::start(self.storage.clone()))
            .as_ref()
            .ok()
            .map(|worker| &worker.handle)
    }
    fn running_worker(&self) -> Option<&WorkerHandle> {
        self.worker
            .get()
            .and_then(|result| result.as_ref().ok())
            .map(|worker| &worker.handle)
    }
    pub fn state(&self) -> RecorderState {
        let Some(directory) = &self.storage.root else {
            return RecorderState::Disabled;
        };
        let error = if let Some(Err(error)) = self.worker.get() {
            Some(error.clone())
        } else if self.running_worker().is_some_and(WorkerHandle::is_closed) {
            Some("diagnostic worker stopped".into())
        } else if let Some(Err(error)) = self.storage.inventory.get() {
            Some(error.clone())
        } else {
            directory
                .ancestors()
                .find(|path| path.exists())
                .and_then(|existing| require_directory(existing).err())
        };
        match error {
            Some(error) => RecorderState::Unavailable {
                directory: directory.clone(),
                error,
            },
            None => RecorderState::Enabled {
                directory: directory.clone(),
            },
        }
    }
    pub fn from_environment() -> Self {
        Self::new(std::env::var_os(TRACE_ROOT_ENV).map(PathBuf::from))
    }
    pub fn new(root: Option<PathBuf>) -> Self {
        Self {
            storage: Arc::new(RecorderStorage {
                root,
                ..Default::default()
            }),
            worker: OnceLock::new(),
        }
    }
    /// Waits only at an explicit diagnostic read/export/shutdown boundary, never a Turn boundary.
    pub fn flush(&self, timeout: Duration) -> FlushOutcome {
        self.running_worker()
            .map_or(FlushOutcome::Complete, |worker| worker.flush(timeout))
    }
    pub fn shutdown(&self, timeout: Duration) -> FlushOutcome {
        self.running_worker()
            .map_or(FlushOutcome::Complete, |worker| worker.stop(timeout))
    }
    /// Retires outstanding handles before asynchronous cleanup. Late callbacks cannot reopen files.
    pub fn remove_session(&self, session_id: &SessionId) {
        if let Some(worker) = self.worker()
            && let Some(capture) = worker.capture(session_id)
        {
            capture.retired.store(true, Ordering::Release);
            capture.cleanup_pending.store(true, Ordering::Release);
        }
    }
    pub fn start_attempt(
        &self,
        context: InferenceContext,
        request: &ModelRequest,
    ) -> ModelAttemptTrace {
        let Some(worker) = self.worker() else {
            return ModelAttemptTrace::disabled();
        };
        let Some(capture) = worker.capture(&context.session_id) else {
            return ModelAttemptTrace::disabled();
        };
        if context.session_id.as_str().len()
            + context.thread_id.as_str().len()
            + context.turn_id.as_str().len()
            + context.model.as_ref().map_or(0, |model| {
                model.provider.as_str().len() + model.model.as_str().len()
            })
            > 2048
        {
            WorkerHandle::lost(&capture);
            return ModelAttemptTrace::disabled();
        }
        let Some(lease) = worker.attempt(&capture, PARTIAL_RETAINED_BYTES) else {
            WorkerHandle::lost(&capture);
            return ModelAttemptTrace::disabled();
        };
        let Ok(attempt_id) = diagnostic_id() else {
            WorkerHandle::lost(&capture);
            return ModelAttemptTrace::disabled();
        };
        let bytes = crate::budget::request_bytes(request, MAX_PAYLOAD_BYTES);
        let Some(reserved) = worker.reserve(bytes.unwrap_or(1024) + 4096) else {
            WorkerHandle::lost(&capture);
            return ModelAttemptTrace::disabled();
        };
        worker.enqueue(
            &capture,
            Observation::Started {
                context: context.clone(),
                attempt_id: attempt_id.clone(),
                request: bytes.map(|_| request.clone()),
            },
            reserved,
        );
        ModelAttemptTrace {
            identity: Some(AttemptIdentity {
                worker: worker.clone(),
                capture,
                context,
                attempt_id,
            }),
            active: Some(ActiveAttempt {
                _lease: lease,
                text: String::new(),
                reasoning: String::new(),
                messages: Vec::new(),
                output_truncated: false,
            }),
            accounted: false,
        }
    }
    /// Records Hook values only after the neutral callback has checked the opt-in policy.
    pub fn record_hook(
        &self,
        session_id: &SessionId,
        thread_id: &ash_protocol::ThreadId,
        turn_id: Option<&ash_protocol::TurnId>,
        run_id: &str,
        evidence: &Value,
    ) {
        let Some(worker) = self.worker() else {
            return;
        };
        let Some(capture) = worker.capture(session_id) else {
            return;
        };
        if thread_id.as_str().len() + turn_id.map_or(0, |id| id.as_str().len()) + run_id.len()
            > 2048
        {
            WorkerHandle::lost(&capture);
            return;
        }
        let mut budget = Budget::new(MAX_PAYLOAD_BYTES);
        let bounded = budget.json(evidence, 0).is_ok();
        let bytes = if bounded { budget.finish() } else { 1024 };
        let Some(reserved) = worker.reserve(bytes + 4096) else {
            WorkerHandle::lost(&capture);
            return;
        };
        worker.enqueue(
            &capture,
            Observation::Hook {
                thread_id: thread_id.clone(),
                turn_id: turn_id.cloned(),
                run_id: run_id.into(),
                evidence: bounded.then(|| evidence.clone()),
            },
            reserved,
        );
    }
    /// Reads small persisted observations. A bounded barrier reports outstanding evidence explicitly.
    pub fn read(
        &self,
        session_id: &SessionId,
        after: u64,
        limit: usize,
    ) -> Result<DiagnosticPage, DiagnosticError> {
        if !(1..=500).contains(&limit) {
            return Err(DiagnosticError::InvalidParameters(
                "diagnostic limit must be 1..500".into(),
            ));
        }
        self.flush(READ_FLUSH_TIMEOUT);
        let capture = self
            .running_worker()
            .and_then(|worker| worker.existing_capture(session_id));
        let pending = capture
            .as_ref()
            .map_or(0, |capture| capture.pending.load(Ordering::Acquire));
        let losses = capture
            .as_ref()
            .map_or(0, |capture| capture.dropped.load(Ordering::Relaxed));
        let unavailable = capture.as_ref().is_some_and(|capture| {
            capture
                .error
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_some()
        }) || self.running_worker().is_some_and(WorkerHandle::is_closed);
        let writer = match self.storage.writer(session_id, OpenMode::Existing) {
            Ok(writer) => writer,
            Err(DiagnosticError::Busy) => {
                return Ok(empty_page(
                    after,
                    RecordingStatus::Incomplete,
                    pending,
                    losses,
                ));
            }
            Err(DiagnosticError::Storage(_)) => {
                return Ok(empty_page(
                    after,
                    RecordingStatus::Unavailable,
                    pending,
                    losses,
                ));
            }
            Err(error) => return Err(error),
        };
        let Some(writer) = writer else {
            if after != 0 && pending == 0 {
                return Err(DiagnosticError::InvalidParameters(
                    "diagnostic cursor exceeds captured events".into(),
                ));
            }
            let status = if self.storage.root.is_none() {
                RecordingStatus::Disabled
            } else if unavailable
                || (capture.is_none()
                    && self
                        .running_worker()
                        .is_some_and(WorkerHandle::captures_full))
            {
                RecordingStatus::Unavailable
            } else if losses > 0 || pending > 0 {
                RecordingStatus::Incomplete
            } else {
                RecordingStatus::Recording
            };
            return Ok(empty_page(after, status, pending, losses));
        };
        let Ok(state) = writer.try_lock() else {
            return Ok(empty_page(
                after,
                RecordingStatus::Incomplete,
                pending,
                losses,
            ));
        };
        let tail = state.events.len() as u64;
        if after > tail {
            return Err(DiagnosticError::InvalidParameters(
                "diagnostic cursor exceeds captured events".into(),
            ));
        }
        let events = state
            .events
            .iter()
            .skip(after as usize)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let cursor = events.last().map_or(after, |event| event.sequence);
        let observed = self
            .storage
            .inventory
            .get()
            .and_then(|value| value.as_ref().ok())
            .is_some_and(|runtime| state.manifest.runtime_id.as_ref() == Some(runtime));
        let dropped = state.manifest.dropped_records
            + losses.saturating_sub(if observed {
                state.manifest.observed_drops
            } else {
                0
            });
        Ok(DiagnosticPage {
            diagnostics: DiagnosticTrace {
                format_version: crate::DIAGNOSTIC_TRACE_FORMAT_VERSION,
                capture_id: Some(state.manifest.capture_id.clone()),
                recording_status: if unavailable {
                    RecordingStatus::Unavailable
                } else if dropped > 0 || pending > 0 {
                    RecordingStatus::Incomplete
                } else {
                    RecordingStatus::Recording
                },
                dropped_records: dropped,
                pending_records: pending,
                events,
                payloads: BTreeMap::new(),
            },
            cursor,
            has_more: cursor < tail,
        })
    }
    /// Capture identity and recorded references authorize immutable bodies; callers supply no paths.
    pub fn read_payload(
        &self,
        session_id: &SessionId,
        capture_id: &str,
        payload_id: &str,
    ) -> Result<Value, DiagnosticError> {
        let writer = self
            .storage
            .writer(session_id, OpenMode::Existing)?
            .ok_or(DiagnosticError::NotFound)?;
        let state = writer.try_lock().map_err(|_| DiagnosticError::Busy)?;
        if state.manifest.capture_id != capture_id {
            return Err(DiagnosticError::CaptureChanged);
        }
        let reference = state
            .events
            .iter()
            .filter_map(|event| event.event.payload())
            .find(|reference| {
                reference.payload_id == payload_id && reference.status == PayloadStatus::Saved
            })
            .ok_or(DiagnosticError::NotFound)?
            .clone();
        let directory = state.directory.clone();
        drop(state);
        require_directory(&directory.join("payloads")).map_err(DiagnosticError::Storage)?;
        let path = directory
            .join("payloads")
            .join(format!("{}.json", reference.payload_id));
        let bytes = read_bounded(&path, MAX_PAYLOAD_BYTES).map_err(DiagnosticError::Storage)?;
        if bytes.len() as u64 != reference.byte_length
            || reference.digest.as_deref() != Some(ContentDigest::sha256(&bytes).as_str())
        {
            return Err(DiagnosticError::Storage(
                "diagnostic payload digest mismatch".into(),
            ));
        }
        serde_json::from_slice(&bytes).map_err(|error| DiagnosticError::Storage(error.to_string()))
    }
}
fn empty_page(
    cursor: u64,
    recording_status: RecordingStatus,
    pending_records: u64,
    dropped_records: u64,
) -> DiagnosticPage {
    DiagnosticPage {
        diagnostics: DiagnosticTrace {
            format_version: crate::DIAGNOSTIC_TRACE_FORMAT_VERSION,
            capture_id: None,
            recording_status,
            dropped_records,
            pending_records,
            events: Vec::new(),
            payloads: BTreeMap::new(),
        },
        cursor,
        has_more: false,
    }
}

impl RecorderStorage {
    fn directory(&self, session_id: &SessionId) -> Option<PathBuf> {
        self.root.as_ref().map(|root| {
            let key = ContentDigest::sha256(session_id.as_str().as_bytes());
            root.join(key.as_str().trim_start_matches("sha256:"))
        })
    }
    fn writer(
        &self,
        session_id: &SessionId,
        mode: OpenMode,
    ) -> Result<Option<Arc<Mutex<Writer>>>, DiagnosticError> {
        let Some(directory) = self.directory(session_id) else {
            return Ok(None);
        };
        let mut writers = self.writers.try_lock().map_err(|_| DiagnosticError::Busy)?;
        if let Some(writer) = writers.get(session_id) {
            return Ok(Some(writer.clone()));
        }
        if !directory.exists() && matches!(mode, OpenMode::Existing) {
            return Ok(None);
        }
        let creating = matches!(mode, OpenMode::Create) && !directory.exists();
        if creating && self.stored_captures.load(Ordering::Relaxed) >= MAX_TRACKED_CAPTURES {
            return Err(DiagnosticError::Storage(
                "diagnostic profile capture limit exhausted".into(),
            ));
        }
        let writer = Arc::new(Mutex::new(
            Writer::open(directory, session_id, mode).map_err(DiagnosticError::Storage)?,
        ));
        if creating {
            self.stored_captures.fetch_add(1, Ordering::Relaxed);
        }
        while writers.len() >= MAX_CACHED_CAPTURES {
            let idle = writers
                .iter()
                .find(|(_, writer)| Arc::strong_count(writer) == 1)
                .map(|(id, _)| id.clone());
            let Some(id) = idle else {
                return Err(DiagnosticError::Storage(
                    "diagnostic reader capacity exhausted".into(),
                ));
            };
            writers.remove(&id);
        }
        writers.insert(session_id.clone(), writer.clone());
        Ok(Some(writer))
    }
    fn inventory(&self) -> Result<&String, &String> {
        self.inventory
            .get_or_init(|| {
                let root = self.root.as_ref().ok_or("diagnostic recording disabled")?;
                let bytes = if root.exists() {
                    directory_bytes(root, 0)?
                } else {
                    0
                };
                if bytes > MAX_PROFILE_BYTES {
                    return Err("diagnostic profile capacity exhausted".into());
                }
                let captures = if root.exists() {
                    fs::read_dir(root)
                        .map_err(|error| error.to_string())?
                        .count()
                } else {
                    0
                };
                if captures > MAX_TRACKED_CAPTURES {
                    return Err("diagnostic profile capture limit exhausted".into());
                }
                self.stored_captures.store(captures, Ordering::Relaxed);
                self.stored_bytes
                    .store(bytes + 2 * 1024 * 1024, Ordering::Relaxed);
                diagnostic_id()
            })
            .as_ref()
    }
    pub(super) fn process(&self, record: &Record) {
        let result = (|| -> Result<(), String> {
            let runtime = self.inventory().map_err(Clone::clone)?;
            let remaining =
                MAX_PROFILE_BYTES.saturating_sub(self.stored_bytes.load(Ordering::Relaxed));
            if remaining == 0 {
                return Err("diagnostic profile capacity exhausted".into());
            }
            let writer = self
                .writer(&record.capture.session_id, OpenMode::Create)
                .map_err(|error| error.to_string())?
                .ok_or("diagnostic recording disabled")?;
            let mut writer = writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            writer.profile_remaining = remaining;
            writer.observed_at = record.observed_at;
            writer.observe_losses(&record.capture, runtime);
            let before = writer.manifest.bytes_written;
            match &record.observation {
                Observation::Started {
                    context,
                    attempt_id,
                    request,
                } => {
                    let payload = match request {
                        Some(value) => writer.payload(PayloadKind::CoreRequest, value),
                        None => writer.omitted(PayloadKind::CoreRequest),
                    };
                    writer.append(
                        context,
                        DiagnosticEventKind::ModelAttemptStarted {
                            attempt_id: attempt_id.clone(),
                            purpose: context.purpose.clone(),
                            model: context.model.clone(),
                            source_thread_sequence: context.source_thread_sequence,
                            request_payload: payload,
                        },
                    );
                }
                Observation::Prepared {
                    context,
                    attempt_id,
                    request,
                } => {
                    let payload = match request {
                        Some(value) => writer.payload(PayloadKind::MaterializedRequest, value),
                        None => writer.omitted(PayloadKind::MaterializedRequest),
                    };
                    writer.append(
                        context,
                        DiagnosticEventKind::ModelRequestPrepared {
                            attempt_id: attempt_id.clone(),
                            request_payload: payload,
                        },
                    );
                }
                Observation::Completed {
                    context,
                    attempt_id,
                    response,
                } => {
                    let payload = match response {
                        Some(value) => writer.payload(PayloadKind::ModelResponse, value),
                        None => writer.omitted(PayloadKind::ModelResponse),
                    };
                    writer.append(
                        context,
                        DiagnosticEventKind::ModelAttemptCompleted {
                            attempt_id: attempt_id.clone(),
                            response_payload: payload,
                        },
                    );
                }
                Observation::Terminated {
                    context,
                    attempt_id,
                    termination,
                    partial,
                } => {
                    let payload = partial
                        .as_ref()
                        .map(|partial| writer.payload(PayloadKind::PartialOutput, partial));
                    let event = match termination {
                        Termination::Failed(error) => DiagnosticEventKind::ModelAttemptFailed {
                            attempt_id: attempt_id.clone(),
                            error: error.clone(),
                            partial_output: payload,
                        },
                        Termination::Cancelled(reason) => {
                            DiagnosticEventKind::ModelAttemptCancelled {
                                attempt_id: attempt_id.clone(),
                                reason: reason.clone(),
                                partial_output: payload,
                            }
                        }
                        Termination::Abandoned => DiagnosticEventKind::ModelAttemptAbandoned {
                            attempt_id: attempt_id.clone(),
                            partial_output: payload,
                        },
                    };
                    writer.append(context, event);
                }
                Observation::Hook {
                    thread_id,
                    turn_id,
                    run_id,
                    evidence,
                } => {
                    let payload = match evidence {
                        Some(value) => writer.payload(PayloadKind::HookExecution, value),
                        None => writer.omitted(PayloadKind::HookExecution),
                    };
                    writer.append_event(
                        thread_id,
                        turn_id.as_ref(),
                        DiagnosticEventKind::HookRunRecorded {
                            run_id: run_id.clone(),
                            execution_payload: payload,
                        },
                    );
                }
                Observation::HookProcess {
                    thread_id,
                    turn_id,
                    run_id,
                    evidence,
                } => {
                    let payload = match evidence {
                        Some(evidence) => writer.payload(PayloadKind::HookExecution, &serde_json::json!({
                            "program": evidence.program, "arguments": evidence.arguments, "directory": evidence.directory,
                            "input": evidence.input, "stdout": evidence.stdout, "stderr": evidence.stderr,
                            "exitCode": evidence.exit_code, "stdoutTruncated": evidence.stdout_truncated,
                            "stderrTruncated": evidence.stderr_truncated,
                        })),
                        None => writer.omitted(PayloadKind::HookExecution),
                    };
                    writer.append_event(
                        thread_id,
                        turn_id.as_ref(),
                        DiagnosticEventKind::HookRunRecorded {
                            run_id: run_id.clone(),
                            execution_payload: payload,
                        },
                    );
                }
                Observation::Accounted {
                    context,
                    attempt_id,
                    receipt,
                } => writer.append(
                    context,
                    DiagnosticEventKind::ModelAttemptAccounted {
                        attempt_id: attempt_id.clone(),
                        invocation_id: receipt.invocation_id.clone(),
                        source_thread_sequence: receipt.sequence,
                    },
                ),
            }
            self.stored_bytes.fetch_add(
                writer.manifest.bytes_written.saturating_sub(before),
                Ordering::Relaxed,
            );
            Ok(())
        })();
        let mut error = record
            .capture
            .error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match result {
            Ok(()) => *error = None,
            Err(message) => {
                WorkerHandle::lost(&record.capture);
                *error = Some(message);
            }
        }
    }
    pub(super) fn maintain(&self, capture: &Capture) {
        if capture.cleanup_pending.load(Ordering::Acquire) {
            let Some(directory) = self.directory(&capture.session_id) else {
                return;
            };
            let result = (|| -> Result<(), String> {
                let mut writers = self
                    .writers
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                writers.remove(&capture.session_id);
                let bytes = if directory.exists() {
                    directory_bytes(&directory, 0)?
                } else {
                    0
                };
                if directory.exists() {
                    fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
                    self.stored_captures
                        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |captures| {
                            Some(captures.saturating_sub(1))
                        })
                        .ok();
                }
                self.stored_bytes
                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |stored| {
                        Some(stored.saturating_sub(bytes))
                    })
                    .ok();
                Ok(())
            })();
            match result {
                Ok(()) => {
                    capture.cleanup_pending.store(false, Ordering::Release);
                }
                Err(error) => {
                    *capture
                        .error
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
                }
            }
        } else if !capture.retired.load(Ordering::Acquire)
            && capture.dropped.load(Ordering::Relaxed)
                > capture.persisted_drops.load(Ordering::Relaxed)
            && let Ok(runtime) = self.inventory()
            && let Ok(Some(writer)) = self.writer(&capture.session_id, OpenMode::Create)
        {
            writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .observe_losses(capture, runtime);
        }
    }
}
fn directory_bytes(directory: &Path, depth: usize) -> Result<usize, String> {
    if depth > 2 {
        return Err("invalid diagnostic directory depth".into());
    }
    require_directory(directory)?;
    let mut bytes = 0usize;
    let mut entries = 0usize;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        entries += 1;
        if entries > MAX_CAPTURE_EVENTS + 16 {
            return Err("diagnostic inventory capacity exhausted".into());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        let size = if metadata.is_dir() {
            directory_bytes(&entry.path(), depth + 1)?
        } else if metadata.is_file() {
            metadata.len() as usize
        } else {
            return Err("invalid diagnostic inventory entry".into());
        };
        bytes = bytes.saturating_add(size);
        if bytes > MAX_PROFILE_BYTES {
            return Err("diagnostic profile capacity exhausted".into());
        }
    }
    Ok(bytes)
}

impl Writer {
    fn open(directory: PathBuf, session_id: &SessionId, mode: OpenMode) -> Result<Self, String> {
        if directory.exists()
            && !fs::symlink_metadata(&directory)
                .map_err(|error| error.to_string())?
                .is_dir()
        {
            return Err("invalid diagnostic directory".into());
        }
        let manifest_path = directory.join("manifest.json");
        if manifest_path.exists() {
            require_directory(&directory.join("payloads"))?;
            let mut manifest: Manifest =
                serde_json::from_slice(&read_bounded(&manifest_path, 16 * 1024)?)
                    .map_err(|error| error.to_string())?;
            if manifest.format_version != 1 || &manifest.session_id != session_id {
                return Err("invalid diagnostic manifest".into());
            }
            let bytes = read_bounded(&directory.join("trace.jsonl"), MAX_CAPTURE_EVENT_BYTES)?;
            let mut events = Vec::new();
            for line in bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let event: DiagnosticEvent =
                    serde_json::from_slice(line).map_err(|error| error.to_string())?;
                if event.sequence != events.len() as u64 + 1 || events.len() >= MAX_CAPTURE_EVENTS {
                    return Err("invalid diagnostic event order".into());
                }
                if let Some(reference) = event.event.payload() {
                    validate_payload_id(&reference.payload_id)?;
                }
                events.push(event);
            }
            // A crash can leave payloads committed before manifest counters. Count all files,
            // including orphans, and advance identities so recovered captures never overwrite.
            let mut bytes_written = bytes.len();
            for entry in
                fs::read_dir(directory.join("payloads")).map_err(|error| error.to_string())?
            {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name();
                let id = name
                    .to_str()
                    .and_then(|name| name.strip_suffix(".json"))
                    .ok_or("invalid payload filename")?;
                validate_payload_id(id)?;
                let ordinal: u64 = id
                    .trim_start_matches("payload-")
                    .parse()
                    .map_err(|_| "invalid payload identity")?;
                let metadata = require_file(&entry.path())?;
                if metadata.len() > MAX_PAYLOAD_BYTES as u64 {
                    return Err("payload exceeds recording limit".into());
                }
                bytes_written = bytes_written.saturating_add(metadata.len() as usize);
                manifest.next_payload = manifest
                    .next_payload
                    .max(ordinal.checked_add(1).ok_or("payload identity exhausted")?);
            }
            manifest.bytes_written = bytes_written;
            if bytes_written > MAX_CAPTURE_BYTES {
                return Err("capture exceeds recording limit".into());
            }
            return Ok(Self {
                directory,
                manifest,
                events,
                event_bytes: bytes.len(),
                profile_remaining: MAX_PROFILE_BYTES,
                observed_at: 0,
            });
        }
        if matches!(mode, OpenMode::Existing) || directory.join("trace.jsonl").exists() {
            return Err("diagnostic manifest missing; existing evidence cannot be replaced".into());
        }
        fs::create_dir_all(directory.join("payloads")).map_err(|error| error.to_string())?;
        require_directory(&directory.join("payloads"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
            fs::set_permissions(
                directory.join("payloads"),
                fs::Permissions::from_mode(0o700),
            )
            .map_err(|error| error.to_string())?;
        }
        let state = Self {
            directory,
            manifest: Manifest {
                format_version: 1,
                session_id: session_id.clone(),
                capture_id: diagnostic_id()?,
                dropped_records: 0,
                bytes_written: 0,
                next_payload: 1,
                runtime_id: None,
                observed_drops: 0,
            },
            events: Vec::new(),
            event_bytes: 0,
            profile_remaining: MAX_PROFILE_BYTES,
            observed_at: 0,
        };
        state.save_manifest()?;
        private_write(&state.directory.join("trace.jsonl"), &[])?;
        Ok(state)
    }

    fn observe_losses(&mut self, capture: &Capture, runtime: &str) {
        if self.manifest.runtime_id.as_deref() != Some(runtime) {
            self.manifest.runtime_id = Some(runtime.into());
            self.manifest.observed_drops = 0;
        }
        let dropped = capture.dropped.load(Ordering::Relaxed);
        if dropped > self.manifest.observed_drops {
            self.manifest.dropped_records += dropped - self.manifest.observed_drops;
            self.manifest.observed_drops = dropped;
            if self.save_manifest().is_ok() {
                capture.persisted_drops.store(dropped, Ordering::Relaxed);
            }
        }
    }
    fn omitted(&mut self, kind: PayloadKind) -> PayloadRef {
        let payload_id = format!("payload-{}", self.manifest.next_payload);
        self.manifest.next_payload = self.manifest.next_payload.saturating_add(1);
        self.manifest.dropped_records += 1;
        PayloadRef {
            payload_id,
            kind,
            byte_length: 0,
            status: PayloadStatus::Omitted,
            digest: None,
        }
    }

    fn save_manifest(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.manifest).map_err(|error| error.to_string())?;
        let temporary = self.directory.join("manifest.pending");
        private_write(&temporary, &bytes)?;
        fs::rename(temporary, self.directory.join("manifest.json"))
            .map_err(|error| error.to_string())
    }

    fn payload(&mut self, kind: PayloadKind, value: &impl Serialize) -> PayloadRef {
        if self.events.len() >= MAX_CAPTURE_EVENTS
            || self.event_bytes + MAX_EVENT_METADATA_BYTES > MAX_CAPTURE_EVENT_BYTES
        {
            return self.omitted(kind);
        }
        let payload_id = format!("payload-{}", self.manifest.next_payload);
        self.manifest.next_payload = self.manifest.next_payload.saturating_add(1);
        let mut buffer = BoundedBuffer(Vec::new());
        let bytes = serde_json::to_writer(&mut buffer, value)
            .ok()
            .map(|()| buffer.0);
        let mut reference = PayloadRef {
            payload_id,
            kind,
            byte_length: bytes.as_ref().map_or(0, |bytes| bytes.len() as u64),
            status: PayloadStatus::Omitted,
            digest: None,
        };
        if let Some(bytes) = bytes
            && bytes.len() <= MAX_PAYLOAD_BYTES
            && self.manifest.bytes_written + bytes.len() <= MAX_CAPTURE_BYTES
            && bytes.len() <= self.profile_remaining
        {
            let path = self
                .directory
                .join("payloads")
                .join(format!("{}.json", reference.payload_id));
            if require_directory(&self.directory.join("payloads")).is_ok()
                && !path.exists()
                && private_write(&path, &bytes).is_ok()
            {
                reference.status = PayloadStatus::Saved;
                reference.digest = Some(ContentDigest::sha256(&bytes).to_string());
                self.manifest.bytes_written += bytes.len();
                self.profile_remaining = self.profile_remaining.saturating_sub(bytes.len());
                return reference;
            }
        }
        self.manifest.dropped_records += 1;
        reference
    }

    fn append(&mut self, context: &InferenceContext, event: DiagnosticEventKind) {
        self.append_event(&context.thread_id, Some(&context.turn_id), event);
    }

    fn append_event(
        &mut self,
        thread_id: &ash_protocol::ThreadId,
        turn_id: Option<&ash_protocol::TurnId>,
        event: DiagnosticEventKind,
    ) {
        if self.events.len() >= MAX_CAPTURE_EVENTS {
            self.manifest.dropped_records += 1;
            let _ = self.save_manifest();
            return;
        }
        let Ok(event_id) = diagnostic_id() else {
            self.manifest.dropped_records += 1;
            return;
        };
        let event = DiagnosticEvent {
            event_id,
            sequence: self.events.len() as u64 + 1,
            recorded_at: self.observed_at,
            thread_id: thread_id.clone(),
            turn_id: turn_id.cloned(),
            event,
        };
        let recorded = (|| -> Result<(), String> {
            let mut buffer = BoundedBuffer(Vec::new());
            serde_json::to_writer(&mut buffer, &event).map_err(|error| error.to_string())?;
            let bytes = buffer.0;
            if self.manifest.bytes_written + bytes.len() + 1 > MAX_CAPTURE_BYTES
                || bytes.len() > MAX_EVENT_METADATA_BYTES
                || self.event_bytes + bytes.len() + 1 > MAX_CAPTURE_EVENT_BYTES
                || bytes.len() + 1 > self.profile_remaining
            {
                return Err("capture size limit".into());
            }
            require_directory(&self.directory)?;
            let path = self.directory.join("trace.jsonl");
            require_file(&path)?;
            let mut file = OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            file.write_all(&bytes)
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.flush())
                .map_err(|error| error.to_string())?;
            self.manifest.bytes_written += bytes.len() + 1;
            self.event_bytes += bytes.len() + 1;
            self.profile_remaining = self.profile_remaining.saturating_sub(bytes.len() + 1);
            Ok(())
        })();
        if recorded.is_ok() {
            self.events.push(event);
        } else {
            self.manifest.dropped_records += 1;
        }
        if self.save_manifest().is_err() {
            self.manifest.dropped_records += 1;
        }
    }
}

/// Terminal guard preserves bounded partial output; callbacks enqueue without storage waits.
pub struct ModelAttemptTrace {
    identity: Option<AttemptIdentity>,
    active: Option<ActiveAttempt>,
    accounted: bool,
}
struct AttemptIdentity {
    worker: WorkerHandle,
    capture: Arc<Capture>,
    context: InferenceContext,
    attempt_id: String,
}
struct ActiveAttempt {
    _lease: AttemptLease,
    text: String,
    reasoning: String,
    messages: Vec<AssistantMessage>,
    output_truncated: bool,
}
impl ModelAttemptTrace {
    fn disabled() -> Self {
        Self {
            identity: None,
            active: None,
            accounted: false,
        }
    }
    pub fn prepared_request(&mut self, request: &ModelRequest) {
        let Some(identity) = &self.identity else {
            return;
        };
        if self.active.is_none() {
            return;
        }
        let bytes = crate::budget::request_bytes(request, MAX_PAYLOAD_BYTES);
        let Some(reserved) = identity.worker.reserve(bytes.unwrap_or(1024) + 4096) else {
            WorkerHandle::lost(&identity.capture);
            return;
        };
        identity.worker.enqueue(
            &identity.capture,
            Observation::Prepared {
                context: identity.context.clone(),
                attempt_id: identity.attempt_id.clone(),
                request: bytes.map(|_| request.clone()),
            },
            reserved,
        );
    }
    pub fn output(&mut self, event: &ModelStreamEvent) {
        let Some(active) = &mut self.active else {
            return;
        };
        let addition = match event {
            ModelStreamEvent::TextDelta(text)
            | ModelStreamEvent::ReasoningDelta(text)
            | ModelStreamEvent::MessageDelta { text, .. } => text.len(),
            ModelStreamEvent::MessageStarted { id, phase } => {
                id.len() + phase.as_ref().map_or(0, |phase| phase.as_str().len())
            }
            ModelStreamEvent::MessageCompleted(message) => message.text.len(),
        };
        let structured_bytes: usize = active
            .messages
            .iter()
            .map(|message| message.text.len())
            .sum();
        let replaced_bytes = match event {
            ModelStreamEvent::MessageCompleted(message) => active
                .messages
                .iter()
                .find(|stored| stored.id == message.id)
                .map_or(0, |stored| stored.text.len()),
            _ => 0,
        };
        if active.text.len() + active.reasoning.len() + addition > MAX_PARTIAL_TEXT_BYTES
            || structured_bytes - replaced_bytes + addition > MAX_PARTIAL_TEXT_BYTES
        {
            active.output_truncated = true;
            return;
        }
        let message = match event {
            ModelStreamEvent::MessageStarted { id, phase } => Some((id, phase.clone(), None)),
            ModelStreamEvent::MessageDelta { id, text } => Some((id, None, Some(text.as_str()))),
            ModelStreamEvent::MessageCompleted(message) => {
                Some((&message.id, message.phase.clone(), None))
            }
            ModelStreamEvent::TextDelta(_) | ModelStreamEvent::ReasoningDelta(_) => None,
        };
        if let Some((id, phase, delta)) = message {
            let index = active.messages.iter().position(|message| &message.id == id);
            if id.len() > 1024
                || phase
                    .as_ref()
                    .is_some_and(|phase| phase.as_str().len() > 1024)
                || (index.is_none() && active.messages.len() >= MAX_PARTIAL_MESSAGES)
            {
                active.output_truncated = true;
                return;
            }
            let index = index.unwrap_or_else(|| {
                active.messages.push(AssistantMessage {
                    id: id.clone(),
                    text: String::new(),
                    phase: None,
                });
                active.messages.len() - 1
            });
            let stored = &mut active.messages[index];
            if !matches!(event, ModelStreamEvent::MessageDelta { .. }) {
                stored.phase = phase;
            }
            if let Some(delta) = delta {
                stored.text.push_str(delta);
            } else if let ModelStreamEvent::MessageCompleted(message) = event {
                stored.text = message.text.clone();
            }
        }
        match event {
            ModelStreamEvent::TextDelta(text) | ModelStreamEvent::MessageDelta { text, .. } => {
                active.text.push_str(text)
            }
            ModelStreamEvent::ReasoningDelta(text) => active.reasoning.push_str(text),
            ModelStreamEvent::MessageStarted { .. } | ModelStreamEvent::MessageCompleted(_) => {}
        }
    }
    pub fn complete(&mut self, response: &ModelResponse) {
        if self.active.take().is_none() {
            return;
        }
        let Some(identity) = &self.identity else {
            return;
        };
        let bytes = crate::budget::response_bytes(response, MAX_PAYLOAD_BYTES);
        let Some(reserved) = identity.worker.reserve(bytes.unwrap_or(1024) + 4096) else {
            WorkerHandle::lost(&identity.capture);
            return;
        };
        identity.worker.enqueue(
            &identity.capture,
            Observation::Completed {
                context: identity.context.clone(),
                attempt_id: identity.attempt_id.clone(),
                response: bytes.map(|_| response.clone()),
            },
            reserved,
        );
    }
    pub fn fail(&mut self, error: &str) {
        self.finish(Termination::Failed(bounded_message(error)));
    }
    pub fn cancel(&mut self, reason: &str) {
        self.finish(Termination::Cancelled(bounded_message(reason)));
    }
    fn finish(&mut self, termination: Termination) {
        let Some(mut active) = self.active.take() else {
            return;
        };
        let Some(identity) = &self.identity else {
            return;
        };
        let reserved = active._lease.take_bytes();
        let partial = if active.text.is_empty()
            && active.reasoning.is_empty()
            && active.messages.is_empty()
            && !active.output_truncated
        {
            None
        } else {
            Some(PartialOutput {
                text: active.text,
                reasoning: active.reasoning,
                messages: active.messages,
                truncated: active.output_truncated,
            })
        };
        identity.worker.enqueue(
            &identity.capture,
            Observation::Terminated {
                context: identity.context.clone(),
                attempt_id: identity.attempt_id.clone(),
                termination,
                partial,
            },
            reserved,
        );
    }
    pub fn accounted(&mut self, receipt: &core_api::ModelInvocationReceipt) {
        if self.accounted {
            return;
        }
        let Some(identity) = &self.identity else {
            return;
        };
        self.accounted = true;
        let Some(reserved) = identity.worker.reserve(4096) else {
            WorkerHandle::lost(&identity.capture);
            return;
        };
        identity.worker.enqueue(
            &identity.capture,
            Observation::Accounted {
                context: identity.context.clone(),
                attempt_id: identity.attempt_id.clone(),
                receipt: receipt.clone(),
            },
            reserved,
        );
    }
}
impl Drop for ModelAttemptTrace {
    fn drop(&mut self) {
        self.finish(Termination::Abandoned);
    }
}
fn bounded_message(value: &str) -> String {
    let mut end = value.len().min(4096);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}

impl core_api::ExecutionDiagnostics for TraceRecorder {
    fn start_attempt(
        &self,
        context: core_api::InferenceContext,
        request: &ModelRequest,
    ) -> Option<Box<dyn core_api::ModelAttemptObserver>> {
        self.storage.root.as_ref()?;
        let context = InferenceContext {
            session_id: context.session_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            source_thread_sequence: context.source_thread_sequence,
            model: context.model,
            purpose: match context.purpose {
                core_api::InferencePurpose::Agent => crate::InferencePurpose::Agent,
                core_api::InferencePurpose::Compaction => crate::InferencePurpose::Compaction,
                core_api::InferencePurpose::Tool => crate::InferencePurpose::Tool,
            },
        };
        let attempt = TraceRecorder::start_attempt(self, context, request);
        attempt.identity.as_ref()?;
        Some(Box::new(attempt))
    }
    fn record_hook(
        &self,
        session_id: &SessionId,
        thread_id: &ash_protocol::ThreadId,
        turn_id: Option<&ash_protocol::TurnId>,
        run_id: &str,
        evidence: &core_api::HookRunEvidence,
    ) {
        let Some(worker) = self.worker() else {
            return;
        };
        let Some(capture) = worker.capture(session_id) else {
            return;
        };
        if thread_id.as_str().len() + turn_id.map_or(0, |id| id.as_str().len()) + run_id.len()
            > 2048
        {
            WorkerHandle::lost(&capture);
            return;
        }
        let mut budget = Budget::new(MAX_PAYLOAD_BYTES);
        let bounded = (|| {
            budget.string(&evidence.program)?;
            budget.add(evidence.directory.as_os_str().len())?;
            for argument in &evidence.arguments {
                budget.string(argument)?;
            }
            for value in [&evidence.input, &evidence.stdout, &evidence.stderr] {
                budget.string(value)?;
            }
            Ok::<(), ()>(())
        })()
        .is_ok();
        let bytes = if bounded { budget.finish() } else { 1024 };
        let Some(reserved) = worker.reserve(bytes + 4096) else {
            WorkerHandle::lost(&capture);
            return;
        };
        worker.enqueue(
            &capture,
            Observation::HookProcess {
                thread_id: thread_id.clone(),
                turn_id: turn_id.cloned(),
                run_id: run_id.into(),
                evidence: bounded.then(|| evidence.clone()),
            },
            reserved,
        );
    }
}
impl core_api::ModelAttemptObserver for ModelAttemptTrace {
    fn prepared_request(&mut self, request: &ModelRequest) {
        ModelAttemptTrace::prepared_request(self, request);
    }
    fn output(&mut self, event: &ModelStreamEvent) {
        ModelAttemptTrace::output(self, event);
    }
    fn complete(&mut self, response: &ModelResponse) {
        ModelAttemptTrace::complete(self, response);
    }
    fn fail(&mut self, error: &str) {
        ModelAttemptTrace::fail(self, error);
    }
    fn cancel(&mut self, reason: &str) {
        ModelAttemptTrace::cancel(self, reason);
    }
    fn accounted(&mut self, receipt: &core_api::ModelInvocationReceipt) {
        ModelAttemptTrace::accounted(self, receipt);
    }
}
fn validate_payload_id(id: &str) -> Result<(), String> {
    let ordinal = id
        .strip_prefix("payload-")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or("invalid diagnostic payload identity")?;
    if id != format!("payload-{ordinal}") {
        return Err("invalid diagnostic payload identity".into());
    }
    Ok(())
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("invalid diagnostic file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|error| error.to_string())
}
fn require_directory(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        Ok(())
    } else {
        Err("invalid diagnostic directory".into())
    }
}
fn require_file(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_file() {
        Ok(metadata)
    } else {
        Err("invalid diagnostic file".into())
    }
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    if require_file(path)?.len() > limit as u64 {
        return Err("diagnostic file exceeds recording limit".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("diagnostic file exceeds recording limit".into());
    }
    Ok(bytes)
}
struct BoundedBuffer(Vec<u8>);
impl Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_PAYLOAD_BYTES {
            return Err(std::io::Error::other(
                "diagnostic payload exceeds recording limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().try_into().unwrap_or(u64::MAX)
        })
}

fn diagnostic_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
#[path = "recorder_tests.rs"]
mod tests;
