use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CallDeployment {
    Local,
    Server { url: String, administrator: String },
    Invitation { url: String, credential: String },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallStartParams {
    pub resource_id: String,
    pub operation_id: String,
    pub device_id: String,
    pub deployment: CallDeployment,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallResourceParams {
    pub resource_id: String,
}

pub use call::CallControl;
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallControlParams {
    pub resource_id: String,
    pub control: CallControl,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallInviteParams {
    pub resource_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub role: call::CallRole,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallInvitation {
    pub url: String,
    pub credential: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallMemberParams {
    pub resource_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub member_id: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallRoleParams {
    pub resource_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub member_id: String,
    pub role: call::CallRole,
}

pub use call::CallConnection;
pub use call::CallParticipant;
pub use call::CallStatus;
pub use call::ScreenTarget;

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallScreenSource {
    pub target: ScreenTarget,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallScreenSources {
    pub sources: Vec<CallScreenSource>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallScreenFrame {
    pub track_id: String,
    pub participant_id: String,
    pub jpeg: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallScreenFrames {
    #[ts(type = "number")]
    pub media_epoch: u64,
    pub tracks: Vec<String>,
    pub frames: Vec<CallScreenFrame>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallEndParams {
    pub resource_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
}
