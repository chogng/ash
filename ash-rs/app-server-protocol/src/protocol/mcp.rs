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
    pub state: McpSecretDto,
    pub authorization_code: McpSecretDto,
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
