//! Client-hosted browser operations requested by App Server.

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateParams {
    #[schemars(length(min = 1, max = 8192))]
    pub url: String,
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
    Navigate {
        target_id: String,
        url: String,
    },
    Click {
        target_id: String,
        target: BrowserElementTargetDto,
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
            Self::Navigate { target_id, .. }
            | Self::Click { target_id, .. }
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
    pub action: BrowserPerformActionDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPerformResult {
    #[schemars(length(min = 1))]
    pub target_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCloseParams {
    #[schemars(length(min = 1))]
    pub target_id: String,
}
