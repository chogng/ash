//! Transport-neutral contracts for Ash Code Mode sessions and cells.
//!
//! This crate intentionally contains no runtime, Thread storage, tool scheduler, or V8 types. It
//! is safe to use from the embedded adapter and from the standalone stdio Host alike.

use ash_protocol::ToolName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Read, Write};
use ts_rs::TS;

mod output;
pub use output::limit_output;

/// Bridge from JavaScript to Core's durable tool broker.
///
/// The runtime calls this method on a worker thread and resolves the JavaScript Promise back on
/// the owning V8 thread. Implementations may therefore block for approval or Tool completion
/// without blocking the cell, and independent calls may execute concurrently.
pub trait ToolInvoker: Send + Sync {
    /// Executes one projected ordinary tool call. The implementation owns approval, audit,
    /// cancellation, and durable outcome handling; the runtime only supplies the call payload.
    fn invoke(&self, call: NestedToolCall) -> Result<Value, String>;

    /// Publishes a bounded transient notification without exposing the underlying transport.
    fn notify(&self, _: RuntimeNotification) -> Result<(), String> {
        Ok(())
    }

    /// Cancels all nested calls owned by this invoker.
    fn cancel(&self) {}

    /// Cancels nested calls currently owned by one cell.
    fn cancel_cell(&self, _: &CellId) {}
}

/// Errors returned by a Code Mode session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeError {
    Initialization(String),
    InvalidRequest(String),
    CellNotFound(CellId),
    ChannelClosed,
    Runtime(String),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Initialization(message)
            | Self::InvalidRequest(message)
            | Self::Runtime(message) => formatter.write_str(message),
            Self::CellNotFound(cell_id) => write!(formatter, "Code Mode cell not found: {cell_id}"),
            Self::ChannelClosed => formatter.write_str("Code Mode runtime channel closed"),
        }
    }
}

impl std::error::Error for RuntimeError {}

/// Default amount of time an `exec` or `wait` call observes a live cell.
pub const DEFAULT_EXEC_YIELD_TIME_MS: u64 = 10_000;

/// Version of the standalone stdio Host protocol.
pub const CODE_MODE_PROTOCOL_VERSION: u32 = 3;

/// Maximum payload accepted by the framed stdio Host protocol.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

const MAX_STORE_BYTES: usize = 16 * 1024 * 1024;

/// Validates a complete stored-value payload at the Host boundary.
pub fn validate_values(values: &BTreeMap<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec(values)
        .map_err(|error| error.to_string())?
        .len();
    if bytes > MAX_STORE_BYTES {
        return Err(format!(
            "Code Mode store exceeds the {MAX_STORE_BYTES} byte limit; delete unused keys with store(key, undefined)"
        ));
    }
    Ok(())
}

macro_rules! identifier {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(
            Clone,
            Debug,
            Deserialize,
            Eq,
            Hash,
            JsonSchema,
            Ord,
            PartialEq,
            PartialOrd,
            Serialize,
            TS,
        )]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Creates an identifier after rejecting empty values.
            pub fn new(value: impl Into<String>) -> Result<Self, ProtocolError> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(ProtocolError::InvalidIdentifier {
                        kind: stringify!($name),
                    });
                }
                Ok(Self(value))
            }

            /// Creates an identifier for trusted internal values.
            pub fn from_internal(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            /// Returns the wire representation.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

identifier!(
    CodeModeSessionId,
    "Identifies one Code Mode session owned by one Thread."
);
identifier!(
    CellId,
    "Identifies one running or completed JavaScript cell."
);

/// Protocol errors raised before a request reaches the runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    InvalidIdentifier { kind: &'static str },
    FrameTooLarge { size: usize },
    InvalidFrameLength { length: u32 },
    UnexpectedEof,
    Io(String),
    Json(String),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier { kind } => write!(formatter, "{kind} must not be empty"),
            Self::FrameTooLarge { size } => {
                write!(formatter, "Code Mode frame is too large: {size} bytes")
            }
            Self::InvalidFrameLength { length } => {
                write!(formatter, "invalid Code Mode frame length: {length} bytes")
            }
            Self::UnexpectedEof => {
                formatter.write_str("unexpected EOF while reading Code Mode frame")
            }
            Self::Io(error) | Self::Json(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// Kind of an ordinary tool projected into JavaScript.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CodeModeToolKind {
    #[default]
    Function,
    Freeform,
}

/// One ordinary tool exposed to a Code Mode cell.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnabledTool {
    pub global_name: String,
    pub tool_name: String,
    pub description: String,
    pub kind: CodeModeToolKind,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub input_schema: serde_json::Value,
}

/// Bounded resource policy for one Code Mode session.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodeModeLimits {
    #[serde(default = "default_max_execution_time_ms")]
    pub max_yield_time_ms: u64,
    #[serde(default = "default_max_execution_time_ms")]
    pub max_execution_time_ms: u64,
    #[serde(default = "default_max_heap_bytes")]
    pub max_heap_bytes: usize,
    pub max_output_bytes: usize,
    pub max_nested_calls: usize,
}

fn default_max_execution_time_ms() -> u64 {
    120_000
}

fn default_max_heap_bytes() -> usize {
    64 * 1024 * 1024
}

impl Default for CodeModeLimits {
    fn default() -> Self {
        Self {
            max_yield_time_ms: 120_000,
            max_execution_time_ms: 120_000,
            max_heap_bytes: default_max_heap_bytes(),
            max_output_bytes: 4 * 1024 * 1024,
            max_nested_calls: 128,
        }
    }
}

/// Request to start one JavaScript cell.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub session_id: CodeModeSessionId,
    pub tool_call_id: String,
    pub source: String,
    pub enabled_tools: Vec<EnabledTool>,
    #[serde(default = "default_exec_yield_time_ms")]
    pub yield_time_ms: u64,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
}

fn default_exec_yield_time_ms() -> u64 {
    DEFAULT_EXEC_YIELD_TIME_MS
}

/// Explicit wait action used after decoding Codex-compatible wire arguments.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WaitAction {
    Poll,
    Terminate,
}

/// Request to observe or terminate one cell.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WaitRequest {
    pub cell_id: CellId,
    #[serde(default = "default_exec_yield_time_ms")]
    pub yield_time_ms: u64,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub terminate: bool,
}

impl WaitRequest {
    /// Converts the compatibility boolean into a named internal action.
    pub fn action(&self) -> WaitAction {
        if self.terminate {
            WaitAction::Terminate
        } else {
            WaitAction::Poll
        }
    }
}

/// Text or image produced by a cell.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OutputItem {
    Text {
        text: String,
    },
    Image {
        image_url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

/// Final state recorded for one cell.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CellOutcome {
    Completed,
    Terminated,
    Failed,
    Unknown,
}

/// Current observable phase of one cell.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    Running,
    Yielded,
    Completed,
    Terminated,
    Failed,
    Unknown,
}

/// Runtime response returned by `exec`, `wait`, or `terminate`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RuntimeResponse {
    Running {
        cell_id: CellId,
        content_items: Vec<OutputItem>,
    },
    Yielded {
        cell_id: CellId,
        content_items: Vec<OutputItem>,
    },
    Terminated {
        cell_id: CellId,
        content_items: Vec<OutputItem>,
    },
    Result {
        cell_id: CellId,
        content_items: Vec<OutputItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_text: Option<String>,
    },
    Unknown {
        cell_id: CellId,
        content_items: Vec<OutputItem>,
        reason: String,
    },
}

/// Result of observing a cell that may already have disappeared after restart.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WaitOutcome {
    LiveCell { response: RuntimeResponse },
    MissingCell { cell_id: CellId },
}

/// Handle returned immediately after a cell is created.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartedCell {
    pub cell_id: CellId,
}

/// A nested ordinary Tool request emitted by the runtime.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NestedToolCall {
    pub cell_id: CellId,
    pub parent_tool_call_id: String,
    pub runtime_tool_call_id: String,
    pub global_name: String,
    pub tool_name: ToolName,
    pub kind: CodeModeToolKind,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
}

/// A notification emitted by `notify`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeNotification {
    pub cell_id: CellId,
    pub tool_call_id: String,
    pub text: String,
}

/// Transport envelope. Requests and their replies carry the same connection-local ID;
/// asynchronous events and tool completions carry no request ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFrame<T> {
    pub request_id: Option<u64>,
    pub message: T,
}

/// Messages sent from a standalone client to the Code Mode Host.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientToHost {
    Hello {
        protocol_version: u32,
    },
    OpenSession {
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        #[serde(default)]
        #[ts(type = "Record<string, unknown>")]
        stored_values: BTreeMap<String, serde_json::Value>,
    },
    CloseSession {
        session_id: CodeModeSessionId,
    },
    Execute(ExecuteRequest),
    Wait(WaitRequest),
    Terminate {
        cell_id: CellId,
    },
    CompleteToolCall {
        cell_id: CellId,
        runtime_tool_call_id: String,
        #[ts(type = "unknown")]
        result: serde_json::Value,
        #[serde(default)]
        error_text: Option<String>,
    },
}

/// Messages sent by a standalone Code Mode Host.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostToClient {
    Hello {
        protocol_version: u32,
        max_frame_bytes: usize,
    },
    SessionOpened {
        session_id: CodeModeSessionId,
    },
    SessionClosed {
        session_id: CodeModeSessionId,
    },
    StartedCell(StartedCell),
    ToolCall(NestedToolCall),
    Notification(RuntimeNotification),
    StoreSnapshot {
        session_id: CodeModeSessionId,
        #[ts(type = "Record<string, unknown>")]
        values: BTreeMap<String, serde_json::Value>,
    },
    Response {
        response: RuntimeResponse,
    },
    MissingCell {
        cell_id: CellId,
    },
    /// Cancels outstanding callbacks immediately, independently of cell observation.
    CancelCellTools {
        cell_id: CellId,
    },
    CellClosed {
        cell_id: CellId,
        outcome: CellOutcome,
    },
    Error {
        message: String,
    },
}

/// Writes one little-endian length-prefixed JSON frame.
pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), ProtocolError> {
    let payload =
        serde_json::to_vec(value).map_err(|error| ProtocolError::Json(error.to_string()))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            size: payload.len(),
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::FrameTooLarge {
        size: payload.len(),
    })?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

/// Reads one little-endian length-prefixed JSON frame.
pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, ProtocolError> {
    let mut length_bytes = [0; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(ProtocolError::UnexpectedEof);
        }
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_le_bytes(length_bytes);
    let length_usize =
        usize::try_from(length).map_err(|_| ProtocolError::InvalidFrameLength { length })?;
    if length_usize > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge { size: length_usize });
    }
    let mut payload = vec![0; length_usize];
    reader.read_exact(&mut payload).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            ProtocolError::UnexpectedEof
        } else {
            ProtocolError::Io(error.to_string())
        }
    })?;
    serde_json::from_slice(&payload).map_err(|error| ProtocolError::Json(error.to_string()))
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
