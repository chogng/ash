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

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallEndParams {
    pub resource_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
}
