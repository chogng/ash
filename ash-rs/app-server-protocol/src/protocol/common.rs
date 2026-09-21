//! Stable leaf values that may cross the RPC boundary.

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

pub use ash_protocol::CommandId;
pub use ash_protocol::ItemId;
pub use ash_protocol::RequestId;
pub use ash_protocol::SessionId;
pub use ash_protocol::StreamInstanceId;
pub use ash_protocol::ThreadId;
pub use ash_protocol::ToolCallId;
pub use ash_protocol::ToolName;
pub use ash_protocol::TurnId;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct SchemaHash(pub String);

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    #[schemars(length(min = 1))]
    pub name: String,
    #[schemars(length(min = 1))]
    pub version: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    #[ts(optional)]
    pub notifications: Option<bool>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub agent_interactions: Option<AgentInteractionCapability>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub browser: Option<BrowserCapability>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub dir_permissions_host: Option<DirPermissionsHostCapability>,
}

/// Agent interaction kinds that one client connection can present and resolve.
///
/// App Server uses this declaration only for ephemeral owner selection. It never persists the
/// connection capability in Session or Thread state, and clients must still subscribe to the
/// target Thread before they can become an interaction owner.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentInteractionCapability {
    pub version: u32,
    pub kinds: Vec<ash_protocol::AgentInteractionKind>,
    /// Exact client-hosted dynamic tool names this connection can execute.
    ///
    /// This is ephemeral routing authority, not an executable registration. App Server still
    /// accepts and validates definitions through its composition root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dynamic_tools: Option<Vec<ash_protocol::ToolName>>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapability {
    pub version: u32,
    pub observe: bool,
    pub input: bool,
}

/// Declares that this connection may manage explicit directory permissions.
///
/// This is an authority boundary for host-only protocol operations. Renderer or extension
/// connections must not declare it merely because they can display an approval prompt.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirPermissionsHostCapability {
    pub version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[cfg(any(test, feature = "export"))]
impl TS for EmptyParams {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        "Record<string, never>".into()
    }

    fn inline(_: &ts_rs::Config) -> String {
        "Record<string, never>".into()
    }
}
