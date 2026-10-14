//! Connection-owned speech media controls; canonical transcripts and task execution stay in Core.
use crate::{JsonSchema, TS};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceTaskLabels {
    pub queued: String,
    pub running: String,
    pub waiting: String,
    pub completed: String,
    pub failed: String,
    pub stopped: String,
    pub rejected: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceStartParams {
    pub resource_id: String,
    pub operation_id: String,
    pub device_id: String,
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    pub connection_id: ash_protocol::ModelConnectionId,
    pub model_id: Option<ash_protocol::ModelId>,
    pub voice: Option<String>,
    pub locale: String,
    /// Client NLS text spoken only after the original Core task reaches the corresponding state.
    pub task_labels: VoiceTaskLabels,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceResourceParams {
    pub resource_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceControlParams {
    pub resource_id: String,
    #[ts(type = "number")]
    pub media_epoch: u64,
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceRejectDelegationParams {
    pub resource_id: String,
    #[ts(type = "number")]
    pub media_epoch: u64,
    pub delegation_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum VoiceConnectionState {
    Connecting,
    Connected,
    Stopping,
    Ended,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub resource_id: String,
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    #[ts(type = "number")]
    pub media_epoch: u64,
    #[ts(type = "number")]
    pub sequence: u64,
    pub state: VoiceConnectionState,
    #[ts(type = "number")]
    pub usage_milliseconds: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDelegationRequest {
    pub resource_id: String,
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    #[ts(type = "number")]
    pub media_epoch: u64,
    pub delegation_id: String,
    /// Identifies the normal Core submission; it grants no execution authority.
    pub command_id: ash_protocol::CommandId,
    pub transcript: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelChoice {
    pub model_id: ash_protocol::ModelId,
    pub default_voice: String,
    pub voices: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConnectionChoice {
    pub connection_id: ash_protocol::ModelConnectionId,
    pub name: String,
    pub default_model: ash_protocol::ModelId,
    pub models: Vec<VoiceModelChoice>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOptions {
    pub connections: Vec<VoiceConnectionChoice>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceStartCancelParams {
    pub operation_id: String,
}
