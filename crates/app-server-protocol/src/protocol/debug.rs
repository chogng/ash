use crate::JsonSchema;
use crate::TS;
pub use ash_debug_contract::DebugBreakpointBinding;
pub use ash_debug_contract::DebugBreakpointIntent;
pub use ash_debug_contract::DebugBreakpointLocation;
pub use ash_debug_contract::DebugBreakpointUnsupported;
pub use ash_debug_contract::DebugBreakpointsSnapshot;
pub use ash_debug_contract::DebugDataAccess;
pub use ash_debug_contract::DebugInspection;
pub use ash_debug_contract::DebugInspectionResult;
pub use ash_debug_contract::DebugInspectionValue;
pub use ash_debug_contract::DebugScopeVariables;
pub use ash_debug_contract::DebugSourceAddress;
pub use ash_debug_contract::DebugWatchValue;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

/// Connection endpoint for a directory-bound Debug Adapter Protocol peer.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum DebugAdapterConnectionDto {
    /// IO supplied by the calling client's admitted inline implementation.
    Client,
    Server {
        #[schemars(range(min = 1, max = 65535))]
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[schemars(length(min = 1, max = 256))]
        host: Option<String>,
    },
    NamedPipe {
        #[schemars(length(min = 1, max = 32768))]
        path: PathBuf,
    },
}

/// Starts one connection-owned executable or connects to a DAP server.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    #[schemars(length(min = 1, max = 4096))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub program: Option<String>,
    #[schemars(length(max = 128))]
    pub arguments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connection: Option<DebugAdapterConnectionDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub env: Option<HashMap<String, Option<String>>>,
}

/// Opaque identity allocated for one adapter process.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterStartResult {
    pub session_id: String,
}

/// Replies to one outstanding reverse request through its Rust DAP client.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterSendParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "unknown")]
    pub message: Value,
}

/// Reads a bounded batch of adapter messages after a transport sequence.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "number")]
    pub after_sequence: u64,
    #[schemars(range(min = 1, max = 128))]
    pub max_messages: usize,
}

/// One ordered adapter message retained by the App Server.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterMessageDto {
    #[ts(type = "number")]
    pub sequence: u64,
    pub direction: DebugMessageDirectionDto,
    #[ts(type = "unknown")]
    pub message: Value,
}

/// Bounded adapter output and process state.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterReadResult {
    #[ts(type = "number")]
    pub breakpoint_revision: u64,
    pub session: DebugSessionSnapshotDto,
    pub messages: Vec<DebugAdapterMessageDto>,
    #[ts(type = "number")]
    pub next_sequence: u64,
    pub output_gap: bool,
    pub stderr: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub protocol_error: Option<String>,
}

/// Terminates and releases one connection-owned adapter process.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugAdapterCloseParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugMessageDirectionDto {
    Incoming,
    Outgoing,
}

/// Allocates and sends a request through the Rust DAP client's sequence space.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSessionRequestParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[schemars(length(min = 1, max = 256))]
    pub command: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_arguments"
    )]
    #[ts(optional, type = "unknown")]
    pub arguments: Option<Value>,
}

fn deserialize_arguments<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSessionRequestResult {
    #[ts(type = "number")]
    pub request_id: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSessionResponseParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "number")]
    pub request_id: u64,
}

/// Completion is consumed once; observations are read independently for trackers.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "state", deny_unknown_fields)]
pub enum DebugSessionResponseResult {
    Pending,
    Complete {
        #[ts(type = "unknown")]
        response: Value,
    },
    Failed {
        message: String,
    },
}

/// An inline implementation feeds only its bound session's next input page.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSessionInputParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[schemars(length(max = 128))]
    #[ts(type = "unknown[]")]
    pub messages: Vec<Value>,
    pub output_gap: bool,
    pub stderr: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub protocol_error: Option<String>,
}

#[cfg(test)]
#[path = "debug_tests.rs"]
mod tests;

/// Starts the backend initialization state machine once. Client host capabilities
/// describe the already-bound renderer; launch arguments are never replayed.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSessionInitializeParams {
    #[schemars(length(min = 1, max = 256))]
    pub public_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[schemars(length(min = 1, max = 256))]
    pub adapter_id: String,
    pub request: DebugLaunchRequestDto,
    #[ts(type = "Record<string, unknown>")]
    pub arguments: serde_json::Map<String, Value>,
    pub run_in_terminal: bool,
    pub start_debugging: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugLaunchRequestDto {
    Launch,
    Attach,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugExecutionStateDto {
    Starting,
    Running,
    Stopped,
    Terminated,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DebugInitializationPhaseDto {
    Uninitialized,
    Initializing,
    AwaitingInitialized,
    Configuring,
    Launching,
    Active,
    Ended,
}

/// Monotonic read-only runtime model. UI focus and selected frames stay local.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionSnapshotDto {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub execution_revision: u64,
    #[ts(type = "number")]
    pub inspection_revision: u64,
    pub state: DebugExecutionStateDto,
    pub phase: DebugInitializationPhaseDto,
    pub reason: Option<String>,
    #[ts(type = "number | null")]
    pub stopped_thread_id: Option<i64>,
    pub capabilities: DebugSessionCapabilitiesDto,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionCapabilitiesDto {
    pub supports_restart: bool,
    pub supports_terminate: bool,
    pub supports_set_variable: bool,
    pub supports_conditional_breakpoints: bool,
    pub supports_hit_conditional_breakpoints: bool,
    pub supports_log_points: bool,
    pub supports_function_breakpoints: bool,
    pub supports_data_breakpoints: bool,
    pub supports_instruction_breakpoints: bool,
    pub supports_disassemble_request: bool,
    pub supports_stepping_granularity: bool,
    pub exception_breakpoint_filters: Vec<DebugExceptionFilterDto>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DebugExceptionFilterDto {
    pub filter: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub default: bool,
}

/// Completes the client's current breakpoint submission. Rust selects supported
/// exception filters/defaults before sending configurationDone exactly once.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugSessionConfigureParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[schemars(length(max = 128))]
    pub exception_filters: Vec<String>,
}

/// Replaces this session's runtime intent using a monotonically increasing client
/// edit version. Rust serializes DAP replacements and owns all protocol bindings.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugBreakpointsSetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "number")]
    pub version: u64,
    #[schemars(length(max = 512))]
    pub intents: Vec<DebugBreakpointIntent>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugInspectionStartParams {
    #[ts(type = "number")]
    pub inspection_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    pub query: DebugInspection,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum DebugInspectionStartResult {
    Started {
        #[ts(type = "number")]
        inspection_id: u64,
    },
    Invalidated,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugInspectionReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir_id: Option<String>,
    pub session_id: String,
    #[ts(type = "number")]
    pub inspection_id: u64,
}
