use ash_protocol::ModelRef;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Explicit completeness of local diagnostic recording, independent from Turn success.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingStatus {
    Disabled,
    Recording,
    Incomplete,
    Unavailable,
}

/// The execution boundary whose provider-neutral request was observed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InferencePurpose {
    Agent,
    Compaction,
    Tool,
}

/// Request evidence is semantic input to ModelService, never claimed to be transport bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PayloadKind {
    CoreRequest,
    MaterializedRequest,
    ModelResponse,
    PartialOutput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PayloadStatus {
    Saved,
    Omitted,
}

/// Immutable evidence stored outside the small event log and fetched only when requested.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadRef {
    pub payload_id: String,
    pub kind: PayloadKind,
    pub byte_length: u64,
    pub status: PayloadStatus,
    pub digest: Option<String>,
}

/// Facts about one concrete Core-to-model-service attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiagnosticEventKind {
    ModelAttemptStarted {
        attempt_id: String,
        purpose: InferencePurpose,
        model: Option<ModelRef>,
        source_thread_sequence: u64,
        request_payload: PayloadRef,
    },
    ModelRequestPrepared {
        attempt_id: String,
        request_payload: PayloadRef,
    },
    ModelAttemptCompleted {
        attempt_id: String,
        response_payload: PayloadRef,
    },
    ModelAttemptFailed {
        attempt_id: String,
        error: String,
        partial_output: Option<PayloadRef>,
    },
    ModelAttemptCancelled {
        attempt_id: String,
        reason: String,
        partial_output: Option<PayloadRef>,
    },
    ModelAttemptAbandoned {
        attempt_id: String,
        partial_output: Option<PayloadRef>,
    },
}

impl DiagnosticEventKind {
    pub fn attempt_id(&self) -> &str {
        match self {
            Self::ModelAttemptStarted { attempt_id, .. }
            | Self::ModelRequestPrepared { attempt_id, .. }
            | Self::ModelAttemptCompleted { attempt_id, .. }
            | Self::ModelAttemptFailed { attempt_id, .. }
            | Self::ModelAttemptCancelled { attempt_id, .. }
            | Self::ModelAttemptAbandoned { attempt_id, .. } => attempt_id,
        }
    }

    pub fn payload(&self) -> Option<&PayloadRef> {
        match self {
            Self::ModelAttemptStarted {
                request_payload, ..
            }
            | Self::ModelRequestPrepared {
                request_payload, ..
            } => Some(request_payload),
            Self::ModelAttemptCompleted {
                response_payload, ..
            } => Some(response_payload),
            Self::ModelAttemptFailed { partial_output, .. }
            | Self::ModelAttemptCancelled { partial_output, .. }
            | Self::ModelAttemptAbandoned { partial_output, .. } => partial_output.as_ref(),
        }
    }
}

/// Writer order is local to this diagnostic capture; it does not replace Thread sequences.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub event_id: String,
    pub sequence: u64,
    pub recorded_at: u64,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub event: DiagnosticEventKind,
}

/// Diagnostic evidence can accompany an existing version 3 historical artifact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticTrace {
    pub format_version: u32,
    pub capture_id: Option<String>,
    pub recording_status: RecordingStatus,
    pub dropped_records: u64,
    pub events: Vec<DiagnosticEvent>,
    /// Exporters embed fetched payloads here, making an imported capture self-contained.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub payloads: BTreeMap<String, Value>,
}

pub struct DiagnosticPage {
    pub diagnostics: DiagnosticTrace,
    pub cursor: u64,
    pub has_more: bool,
}

/// Invalid read requests are distinct from unavailable or damaged optional evidence.
#[derive(Debug)]
pub enum DiagnosticError {
    InvalidParameters(String),
    NotFound,
    CaptureChanged,
    Storage(String),
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidParameters(message) | Self::Storage(message) => {
                formatter.write_str(message)
            }
            Self::NotFound => formatter.write_str("diagnostic payload not found"),
            Self::CaptureChanged => formatter.write_str("diagnostic capture identity changed"),
        }
    }
}

impl std::error::Error for DiagnosticError {}

/// Stable admission facts for a diagnostic model attempt.
#[derive(Clone, Debug)]
pub struct InferenceContext {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub source_thread_sequence: u64,
    pub model: Option<ModelRef>,
    pub purpose: InferencePurpose,
}
