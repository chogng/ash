use crate::JsonSchema;
use crate::TS;
use ash_protocol::SymphonyControl;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SymphonyConfigureParams {
    pub command_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SymphonySubmitParams {
    pub command_id: String,
    pub workflow_id: String,
    pub title: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SymphonyControlParams {
    pub command_id: String,
    pub id: String,
    pub control: SymphonyControl,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SymphonyEnableParams {
    pub command_id: String,
    pub workflow_id: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SymphonyMessagesParams {
    pub id: String,
}
