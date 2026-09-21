use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use zeroize::Zeroize;

/// Non-secret account identity projected by the Connector authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccountDto {
    pub id: String,
    pub display_name: String,
}

/// Current connection lifecycle projected without credential references or values.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectorConnectionStateDto {
    Disconnected,
    Connecting,
    Connected {
        account: ConnectorAccountDto,
    },
    Unavailable {
        reason: String,
    },
    ReauthorizationRequired {
        account: ConnectorAccountDto,
        previous_definition: String,
    },
}

/// Mutation the current Connector state authorizations a client to offer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorAvailableActionDto {
    ConnectApiToken,
    ConnectOAuth,
    Disconnect,
    ReauthorizeApiToken,
    ReauthorizeOAuth,
    RefreshOAuth,
    RevokeOAuth,
}

/// OAuth interaction methods configured for one exact Connector.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorOAuthMethodDto {
    Browser,
    Device,
}

/// One runtime-free Connector catalog entry and its account-state projection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDto {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub runtime_server_id: String,
    pub definition_digest: String,
    #[ts(type = "number")]
    pub connection_generation: u64,
    pub state: ConnectorConnectionStateDto,
    pub available_actions: Vec<ConnectorAvailableActionDto>,
    pub oauth_methods: Vec<ConnectorOAuthMethodDto>,
    pub credential_cleanup_pending: bool,
}

/// Exact non-secret projection of the durable Connector authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorListResult {
    #[ts(type = "number")]
    pub generation: u64,
    pub connectors: Vec<ConnectorDto>,
}

/// Inbound-only API token that redacts diagnostics and clears its allocation on drop.
#[derive(Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(transparent)]
pub struct ConnectorSecretDto(String);

impl ConnectorSecretDto {
    pub fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0).into_bytes()
    }
}

impl fmt::Debug for ConnectorSecretDto {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConnectorSecretDto([REDACTED])")
    }
}

impl Drop for ConnectorSecretDto {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Retry-safe API-token authorization request.
#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorApiTokenConnectParams {
    pub command_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub expected_generation: u64,
    pub connector_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub connection_generation: u64,
    pub account_id: String,
    pub account_display_name: String,
    pub api_token: ConnectorSecretDto,
}

/// Starts one browser OAuth attempt bound to an exact Connector generation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOAuthStartParams {
    pub command_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub expected_generation: u64,
    pub connector_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub connection_generation: u64,
    pub redirect_uri: String,
}

/// Browser navigation values for one in-memory OAuth attempt.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOAuthStartResult {
    pub flow_id: String,
    pub authorization_url: String,
}

/// Starts one device OAuth attempt bound to an exact Connector generation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDeviceOAuthStartParams {
    pub command_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub expected_generation: u64,
    pub connector_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub connection_generation: u64,
}

/// User-facing code and polling schedule for an in-memory device authorization.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDeviceOAuthStartResult {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    #[ts(type = "number")]
    pub expires_in_seconds: u64,
    #[ts(type = "number")]
    pub poll_interval_seconds: u64,
}

/// Polls one exact in-memory device OAuth flow.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDeviceOAuthPollParams {
    pub flow_id: String,
}

/// Device flow status; clients must respect `retryAfterSeconds` before polling again.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectorDeviceOAuthPollResult {
    Pending {
        #[ts(type = "number")]
        retry_after_seconds: u64,
    },
    Connected {
        command: ConnectorCommandResultDto,
    },
}

/// Inbound-only OAuth callback whose security values are cleared on drop.
#[derive(Debug, Deserialize, Eq, JsonSchema, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOAuthCompleteParams {
    pub flow_id: String,
    pub state: ConnectorSecretDto,
    pub authorization_code: ConnectorSecretDto,
}

/// Cancels one exact in-memory browser OAuth attempt.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOAuthCancelParams {
    pub flow_id: String,
}

/// Retry-safe readiness revocation request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDisconnectParams {
    pub command_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub expected_generation: u64,
    pub connector_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOAuthRefreshParams {
    pub connector_id: String,
}

/// Requests retry of one durable post-disconnect secret deletion.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCredentialCleanupParams {
    pub connector_id: String,
}

/// Whether a retry-safe mutation committed or replayed its exact receipt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorCommandDispositionDto {
    Updated,
    Replayed,
}

/// Result of connecting one account.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCommandResultDto {
    #[ts(type = "number")]
    pub generation: u64,
    pub disposition: ConnectorCommandDispositionDto,
}

/// Best-effort cleanup status after authoritative readiness revocation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorCredentialCleanupDto {
    Deleted,
    AlreadyAbsent,
    RetryRequired,
}

/// Disconnect result keeps revocation success distinct from credential cleanup retries.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDisconnectResultDto {
    pub command: ConnectorCommandResultDto,
    pub credential_cleanup: ConnectorCredentialCleanupDto,
}

/// Notification emitted after a committed Connector authority generation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsChanged {
    #[ts(type = "number")]
    pub generation: u64,
}
