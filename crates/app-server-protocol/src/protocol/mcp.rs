use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use zeroize::Zeroize;

/// Inbound-only MCP OAuth value that redacts diagnostics and clears its allocation on drop.
#[derive(Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(transparent)]
pub struct McpSecretDto(String);

impl McpSecretDto {
    pub fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0).into_bytes()
    }
}

impl fmt::Debug for McpSecretDto {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("McpSecretDto([REDACTED])")
    }
}

impl Drop for McpSecretDto {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Starts browser authorization for one exact standalone MCP server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthStartParams {
    pub server_id: String,
    pub redirect_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub client_metadata_url: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// Browser navigation values for one process-local standalone MCP OAuth flow.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthStartResult {
    pub flow_id: String,
    pub authorization_url: String,
}

/// Completes one exact standalone MCP OAuth flow with secret callback values.
#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthCompleteParams {
    pub flow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub issuer: Option<String>,
    pub state: McpSecretDto,
    pub authorization_code: McpSecretDto,
}

/// Cancels exactly one browser login; it does not sign out a shared credential.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpOAuthCancelParams {
    pub flow_id: String,
}

/// Selects one standalone MCP server for credential refresh or revocation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthMutationParams {
    pub server_id: String,
}

/// Confirms the standalone MCP server whose OAuth lifecycle operation completed.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthMutationResult {
    pub server_id: String,
}

/// Runtime lifecycle state of one configured MCP server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum McpServerRuntimeStateDto {
    Disabled,
    Disconnected,
    Connected,
    Stale,
    Unavailable { reason: String },
}

/// Process-local lifecycle intent returned by an MCP connect/disconnect command.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum McpServerRuntimeIntentDto {
    Connect,
    Disconnect,
}

/// Applies one process-local MCP lifecycle intent.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRuntimeIntentParams {
    pub server_id: String,
}

/// Result of applying one process-local MCP lifecycle intent.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRuntimeIntentResult {
    pub server_id: String,
    pub intent: McpServerRuntimeIntentDto,
}

/// Redacted runtime projection of one configured MCP server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusDto {
    pub id: String,
    pub display_name: String,
    /// Scheme, host, and port only; absent for stdio servers.
    pub http_origin: Option<String>,
    pub state: McpServerRuntimeStateDto,
    #[ts(type = "number")]
    pub catalog_generation: u64,
    #[ts(type = "number | null")]
    pub connection_generation: Option<u64>,
    #[ts(type = "number")]
    pub tool_count: u64,
}

/// Current MCP connection and catalog status for the local App Server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusResult {
    #[ts(type = "number")]
    pub catalog_generation: u64,
    pub servers: Vec<McpServerStatusDto>,
}

/// Opens the linked resource at one durable Tool Result coordinate, never a client-selected URI.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResourceOpenParams {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    pub item_id: ash_protocol::ItemId,
    pub content_index: usize,
    #[schemars(length(min = 1, max = 256))]
    pub operation_id: String,
}

/// A connection-owned resource handle with the source's validated App sandbox declaration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolResourceOpenResult {
    pub resource_id: String,
    pub mime_type: String,
    pub size: usize,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub app_csp: Option<ash_protocol::McpAppResourceCsp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub encoding: Option<ToolResourceEncoding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resource_metadata: Option<String>,
}

/// The original resource content variant, independent of its server-defined MIME type.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolResourceEncoding {
    Text,
    Binary,
}

/// Reads a resource from the server selected by a canonical MCP App result, never by its URI.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAppResourceOpenParams {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    pub item_id: ash_protocol::ItemId,
    pub content_index: usize,
    #[schemars(length(min = 1, max = 4096))]
    pub uri: String,
    #[schemars(length(min = 1, max = 256))]
    pub operation_id: String,
}

/// Cancels a resource read owned by this connection and execution route.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResourceCancelParams {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    #[schemars(length(min = 1, max = 256))]
    pub operation_id: String,
}

/// One App-originated tool request. The host resolves its server and permissions from the Item.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAppCallParams {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    pub item_id: ash_protocol::ItemId,
    pub content_index: usize,
    #[schemars(length(min = 1, max = 256))]
    pub remote_name: String,
    #[schemars(length(max = 262_144))]
    pub arguments_json: String,
    #[schemars(length(min = 1, max = 256))]
    pub operation_id: String,
}

/// The committed result of the Tool Turn, also delivered through ordinary Thread notifications.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolAppCallResult {
    pub item: ash_protocol::ThreadItem,
}

/// Reads only the App-visible tools from its original server and frozen catalog.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAppListParams {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    pub item_id: ash_protocol::ItemId,
    pub content_index: usize,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolAppListResult {
    pub tools: Vec<serde_json::Value>,
}
