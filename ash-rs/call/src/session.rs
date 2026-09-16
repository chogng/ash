use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CallControl {
    Mute,
    Unmute,
    Deafen,
    Undeafen,
    SelectDevice {
        operation_id: String,
        #[ts(type = "number")]
        revision: u64,
    },
    Volume {
        track_id: String,
        volume: f32,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CallConnection {
    Connecting,
    Connected,
    Reconnecting,
    Ended,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallParticipant {
    pub id: String,
    pub tracks: Vec<String>,
    pub muted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallStatus {
    pub resource_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    pub connection: CallConnection,
    pub call: crate::CallSnapshot,
    pub member_id: String,
    pub participants: Vec<CallParticipant>,
    pub muted: bool,
    pub deafened: bool,
    pub microphone_allowed: bool,
    pub error: Option<String>,
}
