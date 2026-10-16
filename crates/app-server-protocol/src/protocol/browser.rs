//! Client-hosted browser operations requested by App Server.

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Applies this browser host's current user preference without granting another connection access.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserConfigureParams {
    pub enabled: bool,
    pub cdp_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BrowserCdpOperationDto {
    Command {
        #[schemars(length(min = 1, max = 256))]
        method: String,
        params: serde_json::Map<String, serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        session_id: Option<String>,
    },
    ReadEvents {},
    Close {},
}

/// Replaces the audience of a user page on this connection; an empty audience revokes access.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSharingSetParams {
    #[schemars(length(min = 1, max = 256))]
    pub target_id: String,
    #[schemars(length(max = 32))]
    pub thread_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateParams {
    /// The durable Thread owning this request; a transport connection is not an agent identity.
    #[schemars(length(min = 1))]
    pub thread_id: String,
    #[schemars(length(min = 1, max = 8192))]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub network_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateResult {
    #[schemars(length(min = 1))]
    pub target_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObserveParams {
    #[schemars(length(min = 1))]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub network_token: Option<String>,
    #[schemars(length(min = 1))]
    pub target_id: String,
    pub include_accessibility_tree: bool,
    pub include_dom_snapshot: bool,
    pub include_screenshot: bool,
}

/// One bounded binary payload returned by a client host before App Server resource registration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBinaryPayload {
    #[schemars(length(min = 1))]
    pub mime_type: String,
    pub data_base64: String,
    pub decoded_length: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObserveResult {
    #[schemars(length(min = 1))]
    pub target_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accessibility_tree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dom_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub screenshot: Option<BrowserBinaryPayload>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementTargetDto {
    #[schemars(length(min = 1))]
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserTextInputTargetDto {
    Element { target: BrowserElementTargetDto },
    FocusedElement,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserPerformActionDto {
    Cdp {
        target_id: String,
        operation: BrowserCdpOperationDto,
    },
    Navigate {
        target_id: String,
        url: String,
    },
    Click {
        target_id: String,
        target: BrowserElementTargetDto,
    },
    Hover {
        target_id: String,
        target: BrowserElementTargetDto,
    },
    Drag {
        target_id: String,
        source: BrowserElementTargetDto,
        destination: BrowserElementTargetDto,
    },
    HandleDialog {
        target_id: String,
        accept: bool,
        prompt_text: Option<String>,
    },
    RunPlaywright {
        target_id: String,
        #[schemars(length(min = 1, max = 32768))]
        code: String,
    },
    TypeText {
        target_id: String,
        target: BrowserTextInputTargetDto,
        text: String,
    },
    Scroll {
        target_id: String,
        delta_x: f64,
        delta_y: f64,
    },
    GoBack {
        target_id: String,
    },
    Reload {
        target_id: String,
    },
}

impl BrowserPerformActionDto {
    pub fn target_id(&self) -> &str {
        match self {
            Self::Cdp { target_id, .. }
            | Self::Navigate { target_id, .. }
            | Self::Click { target_id, .. }
            | Self::Hover { target_id, .. }
            | Self::Drag { target_id, .. }
            | Self::HandleDialog { target_id, .. }
            | Self::RunPlaywright { target_id, .. }
            | Self::TypeText { target_id, .. }
            | Self::Scroll { target_id, .. }
            | Self::GoBack { target_id }
            | Self::Reload { target_id } => target_id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPerformParams {
    #[schemars(length(min = 1))]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub network_token: Option<String>,
    pub action: BrowserPerformActionDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPerformResult {
    /// Main-created page identity, published to the backend ownership table before use by tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_target_id: Option<String>,
    /// Releases backend ownership for pages closed through the protocol connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(length(max = 256))]
    pub closed_target_ids: Option<Vec<String>>,
    #[schemars(length(max = 1048576))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output: Option<String>,
    #[schemars(length(min = 1))]
    pub target_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCloseParams {
    #[schemars(length(min = 1))]
    pub thread_id: String,
    #[schemars(length(min = 1))]
    pub target_id: String,
}

/// Authorizes one observed Chromium request against the live tool authority on this connection.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserNetworkAuthorizeParams {
    #[schemars(length(min = 1, max = 256))]
    pub network_token: String,
    #[schemars(length(min = 1, max = 8192))]
    pub url: String,
    #[schemars(length(min = 1, max = 32))]
    pub method: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkAuthorizeResult {
    pub allowed: bool,
}

/// Current page metadata for the requesting Thread; this is not a global browser catalog.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserListParams {
    #[schemars(length(min = 1))]
    pub thread_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageSummary {
    #[schemars(length(min = 1))]
    pub target_id: String,
    #[schemars(length(max = 8192))]
    pub url: String,
    #[schemars(length(max = 8192))]
    pub title: String,
    pub loading: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserListResult {
    #[schemars(length(max = 256))]
    pub pages: Vec<BrowserPageSummary>,
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;
