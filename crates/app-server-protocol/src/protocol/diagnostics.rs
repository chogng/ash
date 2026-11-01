use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Process logs are collected by the runtime owning the selected Session, including SSH runtimes.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHostDebugLogsParams {
    pub session_id: ash_protocol::SessionId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostDebugLogsResult {
    #[schemars(length(max = 32))]
    pub files: Vec<AgentHostDebugLogFile>,
    pub omitted_files: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostDebugLogFile {
    pub name: String,
    pub truncated: bool,
    pub resource: crate::protocol::resources::ResourceMetadataResult,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackPrepareParams {
    pub endpoint: String,
}

/// Invoked only after the user reviews and authorizes the prepared content and destination.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackUploadParams {
    #[schemars(length(min = 1))]
    pub operation_id: String,
    #[schemars(length(min = 64, max = 64))]
    pub digest: String,
}

/// A configured service dependency. Paths, query strings and credentials never leave the server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkTargetDto {
    pub id: String,
    pub connection: String,
    pub display_name: String,
    pub host: String,
    pub port: u16,
    pub purpose: NetworkPurposeDto,
    pub route: NetworkRouteDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NetworkPurposeDto {
    Model,
    SignIn,
    Usage,
    Service,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum NetworkRouteDto {
    Direct,
    Proxy { host: String, port: u16 },
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkReadResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub http_mode: HttpCompatibilityModeDto,
    pub targets: Vec<NetworkTargetDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NetworkFailureDto {
    Dns,
    Proxy,
    Tls,
    CertificateConfiguration,
    Connect,
    Timeout,
    Policy,
    Configuration,
    Request,
    Authentication,
    AccountChanged,
    AccountOperation,
}

/// HTTP reachability and authenticated account results are separate evidence.
/// An HTTP response (including 401/404) proves reachability, not account eligibility.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum NetworkCheckOutcomeDto {
    Reachable {
        #[serde(rename = "httpStatus")]
        http_status: u16,
    },
    AccountAvailable,
    Failed {
        failure: NetworkFailureDto,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkCheckDto {
    pub connection: String,
    pub target_id: Option<String>,
    pub outcome: NetworkCheckOutcomeDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkDiagnosticsRunResult {
    pub network: NetworkReadResult,
    pub checks: Vec<NetworkCheckDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HttpCompatibilityModeDto {
    Http2,
    Http1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkHttpConfigureParams {
    pub command_id: ash_protocol::CommandId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub http_mode: HttpCompatibilityModeDto,
}

/// A connection-owned diagnostic capture, released on disconnect. One capture per connection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireLogParams {
    pub capture_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireLogReadParams {
    pub capture_id: String,
    #[ts(type = "number")]
    pub after: u64,
    pub limit: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum WireLogDirection {
    ClientToServer,
    ServerToClient,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum WireLogFrameKind {
    Request,
    Notification,
    Response,
}

/// Raw UTF-8 JSON at the transport boundary, excluding the JSONL delimiter.
/// A truncated prefix is evidence only and must never be parsed as a complete envelope.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireLogFrame {
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub direction: WireLogDirection,
    pub kind: WireLogFrameKind,
    /// JSON-encoded identifier preserves string/number identity and the two request directions.
    pub request_id: Option<String>,
    pub method: Option<String>,
    #[ts(type = "number | null")]
    pub request_sequence: Option<u64>,
    #[ts(type = "number | null")]
    pub elapsed_ms: Option<u64>,
    pub is_error: bool,
    pub byte_length: u32,
    pub truncated: bool,
    pub raw: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireLogPage {
    pub capture_id: String,
    pub connection_id: String,
    pub recording: bool,
    pub frames: Vec<WireLogFrame>,
    #[ts(type = "number")]
    pub cursor: u64,
    pub has_more: bool,
    #[ts(type = "number")]
    pub dropped_frames: u64,
}
