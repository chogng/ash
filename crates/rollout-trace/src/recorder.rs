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
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Opt-in, local-only recording root; read once when the runtime owner is composed.
pub const TRACE_ROOT_ENV: &str = "ASH_ROLLOUT_TRACE_ROOT";
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CAPTURE_EVENTS: usize = 32_000;
const MAX_CACHED_CAPTURES: usize = 16;
enum OpenMode {
    Existing,
    Create,
}

/// Owns diagnostic writers. It never participates in business decisions or history replay.
#[derive(Default)]
pub struct TraceRecorder {
    root: Option<PathBuf>,
    writers: Mutex<BTreeMap<SessionId, Arc<Mutex<Writer>>>>,
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
}

struct Writer {
    directory: PathBuf,
    manifest: Manifest,
    events: Vec<DiagnosticEvent>,
}

impl TraceRecorder {
    pub fn from_environment() -> Self {
        Self::new(std::env::var_os(TRACE_ROOT_ENV).map(PathBuf::from))
    }

    /// Explicit roots support product composition and isolated recording without global mutation.
    pub fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            writers: Mutex::new(BTreeMap::new()),
        }
    }

    fn writer(
        &self,
        session_id: &SessionId,
        mode: OpenMode,
    ) -> Result<Option<Arc<Mutex<Writer>>>, DiagnosticError> {
        let Some(root) = &self.root else {
            return Ok(None);
        };
        if root.exists() {
            require_directory(root).map_err(DiagnosticError::Storage)?;
        }
        let mut writers = self
            .writers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(writer) = writers.get(session_id) {
            return Ok(Some(Arc::clone(writer)));
        }
        let key = ContentDigest::sha256(session_id.as_str().as_bytes());
        let directory = root.join(key.as_str().trim_start_matches("sha256:"));
        if !directory.exists() && matches!(mode, OpenMode::Existing) {
            return Ok(None);
        }
        let writer = Arc::new(Mutex::new(
            Writer::open(directory, session_id, mode).map_err(DiagnosticError::Storage)?,
        ));
        // Attempts retain their own handle. Idle captures can reopen later without keeping
        // file descriptors or an unbounded collection of Sessions alive in the runtime.
        while writers.len() >= MAX_CACHED_CAPTURES {
            let idle = writers
                .iter()
                .find(|(_, writer)| Arc::strong_count(writer) == 1)
                .map(|(id, _)| id.clone());
            if let Some(id) = idle {
                writers.remove(&id);
            } else {
                break;
            }
        }
        writers.insert(session_id.clone(), Arc::clone(&writer));
        Ok(Some(writer))
    }

    pub fn start_attempt(
        &self,
        context: InferenceContext,
        request: &ModelRequest,
    ) -> ModelAttemptTrace {
        let writer = self
            .writer(&context.session_id, OpenMode::Create)
            .ok()
            .flatten();
        let Some(writer) = writer else {
            return ModelAttemptTrace::disabled();
        };
        let Ok(attempt_id) = diagnostic_id() else {
            return ModelAttemptTrace::disabled();
        };
        {
            let mut state = writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let payload = state.payload(PayloadKind::CoreRequest, request);
            state.append(
                &context,
                DiagnosticEventKind::ModelAttemptStarted {
                    attempt_id: attempt_id.clone(),
                    purpose: context.purpose.clone(),
                    model: context.model.clone(),
                    source_thread_sequence: context.source_thread_sequence,
                    request_payload: payload,
                },
            );
        }
        ModelAttemptTrace {
            active: Some(ActiveAttempt {
                writer,
                context,
                attempt_id,
                text: String::new(),
                reasoning: String::new(),
                output_truncated: false,
            }),
        }
    }

    /// Reads only small observations. Large request/response values use `read_payload`.
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
        let writer = match self.writer(session_id, OpenMode::Existing) {
            Ok(writer) => writer,
            Err(DiagnosticError::Storage(_)) => {
                return Ok(DiagnosticPage {
                    diagnostics: DiagnosticTrace {
                        format_version: 1,
                        capture_id: None,
                        recording_status: RecordingStatus::Unavailable,
                        dropped_records: 0,
                        events: Vec::new(),
                        payloads: BTreeMap::new(),
                    },
                    cursor: after,
                    has_more: false,
                });
            }
            Err(error) => return Err(error),
        };
        let Some(writer) = writer else {
            if after != 0 {
                return Err(DiagnosticError::InvalidParameters(
                    "diagnostic cursor exceeds captured events".into(),
                ));
            }
            return Ok(DiagnosticPage {
                diagnostics: DiagnosticTrace {
                    format_version: 1,
                    capture_id: None,
                    recording_status: if self.root.is_none() {
                        RecordingStatus::Disabled
                    } else {
                        RecordingStatus::Recording
                    },
                    dropped_records: 0,
                    events: Vec::new(),
                    payloads: BTreeMap::new(),
                },
                cursor: 0,
                has_more: false,
            });
        };
        let state = writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
        Ok(DiagnosticPage {
            diagnostics: DiagnosticTrace {
                format_version: 1,
                capture_id: Some(state.manifest.capture_id.clone()),
                recording_status: if state.manifest.dropped_records == 0 {
                    RecordingStatus::Recording
                } else {
                    RecordingStatus::Incomplete
                },
                dropped_records: state.manifest.dropped_records,
                events,
                payloads: BTreeMap::new(),
            },
            cursor,
            has_more: cursor < tail,
        })
    }

    /// Capture identity and recorded references authorize the payload; callers never supply paths.
    pub fn read_payload(
        &self,
        session_id: &SessionId,
        capture_id: &str,
        payload_id: &str,
    ) -> Result<Value, DiagnosticError> {
        let writer = self
            .writer(session_id, OpenMode::Existing)?
            .ok_or(DiagnosticError::NotFound)?;
        let state = writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
            .ok_or(DiagnosticError::NotFound)?;
        require_directory(&state.directory).map_err(DiagnosticError::Storage)?;
        require_directory(&state.directory.join("payloads")).map_err(DiagnosticError::Storage)?;
        let path = state
            .directory
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
            let bytes = read_bounded(&directory.join("trace.jsonl"), MAX_CAPTURE_BYTES)?;
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
            },
            events: Vec::new(),
        };
        state.save_manifest()?;
        private_write(&state.directory.join("trace.jsonl"), &[])?;
        Ok(state)
    }

    fn save_manifest(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.manifest).map_err(|error| error.to_string())?;
        let temporary = self.directory.join("manifest.pending");
        private_write(&temporary, &bytes)?;
        fs::rename(temporary, self.directory.join("manifest.json"))
            .map_err(|error| error.to_string())
    }

    fn payload(&mut self, kind: PayloadKind, value: &impl Serialize) -> PayloadRef {
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
                return reference;
            }
        }
        self.manifest.dropped_records += 1;
        reference
    }

    fn append(&mut self, context: &InferenceContext, event: DiagnosticEventKind) {
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
            recorded_at: unix_ms(),
            thread_id: context.thread_id.clone(),
            turn_id: context.turn_id.clone(),
            event,
        };
        let recorded = (|| -> Result<(), String> {
            let mut buffer = BoundedBuffer(Vec::new());
            serde_json::to_writer(&mut buffer, &event).map_err(|error| error.to_string())?;
            let bytes = buffer.0;
            if self.manifest.bytes_written + bytes.len() > MAX_CAPTURE_BYTES {
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

/// Terminal guard retains partial output and records abandoned attempts during unwinding.
pub struct ModelAttemptTrace {
    active: Option<ActiveAttempt>,
}
struct ActiveAttempt {
    writer: Arc<Mutex<Writer>>,
    context: InferenceContext,
    attempt_id: String,
    text: String,
    reasoning: String,
    output_truncated: bool,
}
enum AttemptTermination<'a> {
    Failed(&'a str),
    Cancelled(&'a str),
    Abandoned,
}

impl ModelAttemptTrace {
    fn disabled() -> Self {
        Self { active: None }
    }
    pub fn prepared_request(&mut self, request: &ModelRequest) {
        let Some(active) = &self.active else {
            return;
        };
        let mut state = active
            .writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let request_payload = state.payload(PayloadKind::MaterializedRequest, request);
        state.append(
            &active.context,
            DiagnosticEventKind::ModelRequestPrepared {
                attempt_id: active.attempt_id.clone(),
                request_payload,
            },
        );
    }
    pub fn output(&mut self, event: &ModelStreamEvent) {
        let Some(active) = &mut self.active else {
            return;
        };
        let text = match event {
            ModelStreamEvent::TextDelta(text) | ModelStreamEvent::ReasoningDelta(text) => text,
        };
        if active.text.len() + active.reasoning.len() + text.len() > MAX_PAYLOAD_BYTES {
            active.output_truncated = true;
            return;
        }
        match event {
            ModelStreamEvent::TextDelta(text) => active.text.push_str(text),
            ModelStreamEvent::ReasoningDelta(text) => active.reasoning.push_str(text),
        }
    }
    pub fn complete(&mut self, response: &ModelResponse) {
        let Some(active) = self.active.take() else {
            return;
        };
        let mut state = active
            .writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let response_payload = state.payload(PayloadKind::ModelResponse, response);
        state.append(
            &active.context,
            DiagnosticEventKind::ModelAttemptCompleted {
                attempt_id: active.attempt_id,
                response_payload,
            },
        );
    }
    pub fn fail(&mut self, error: &str) {
        self.finish(AttemptTermination::Failed(error));
    }
    pub fn cancel(&mut self, reason: &str) {
        self.finish(AttemptTermination::Cancelled(reason));
    }
    fn finish(&mut self, termination: AttemptTermination<'_>) {
        let Some(active) = self.active.take() else {
            return;
        };
        let mut state = active
            .writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let partial_output = if active.text.is_empty()
            && active.reasoning.is_empty()
            && !active.output_truncated
        {
            None
        } else {
            Some(state.payload(PayloadKind::PartialOutput, &serde_json::json!({ "text": active.text, "reasoning": active.reasoning, "truncated": active.output_truncated })))
        };
        let event = match termination {
            AttemptTermination::Cancelled(reason) => DiagnosticEventKind::ModelAttemptCancelled {
                attempt_id: active.attempt_id,
                reason: reason.into(),
                partial_output,
            },
            AttemptTermination::Failed(error) => DiagnosticEventKind::ModelAttemptFailed {
                attempt_id: active.attempt_id,
                error: error.into(),
                partial_output,
            },
            AttemptTermination::Abandoned => DiagnosticEventKind::ModelAttemptAbandoned {
                attempt_id: active.attempt_id,
                partial_output,
            },
        };
        state.append(&active.context, event);
    }
}
impl Drop for ModelAttemptTrace {
    fn drop(&mut self) {
        self.finish(AttemptTermination::Abandoned);
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
fn unix_ms() -> u64 {
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
