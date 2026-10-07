//! Shared call contracts, independent of execution and storage.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CallRole {
    Owner,
    Speaker,
    Listener,
    Agent,
}

impl CallRole {
    pub fn can_publish_audio(self) -> bool {
        self != Self::Listener
    }
    pub fn can_share_screen(self) -> bool {
        matches!(self, Self::Owner | Self::Speaker)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum MediaState {
    Preparing,
    Ready,
    Rotating { previous_room: String },
    Closing,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallMember {
    pub id: String,
    pub role: CallRole,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallSnapshot {
    pub id: String,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub media_epoch: u64,
    pub media_room: String,
    pub media_state: MediaState,
    pub members: Vec<CallMember>,
}

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
    ShareScreen {
        target: ScreenTarget,
    },
    StopScreenShare,
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
#[serde(
    tag = "type",
    content = "id",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ScreenTarget {
    Display(String),
    Window(String),
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
    pub screen_sharing: bool,
    pub error: Option<String>,
}
