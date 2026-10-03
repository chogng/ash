use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ApprovalEnvironmentScope {
    Directory {
        root: String,
    },
    Thread {
        #[serde(rename = "threadId")]
        #[ts(rename = "threadId")]
        thread_id: ash_protocol::ThreadId,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalEnvironmentReadResult {
    pub root: String,
    pub profile: guardian_environment::EnvironmentProfile,
    pub scan_options: guardian_environment::ScanOptions,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalEnvironmentScanResult {
    pub root: String,
    pub draft: guardian_environment::EnvironmentDraft,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub history: Option<guardian_environment::HistoryCoverage>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalEnvironmentReadParams {
    pub scope: ApprovalEnvironmentScope,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalEnvironmentScanParams {
    pub scope: ApprovalEnvironmentScope,
    pub operation_id: String,
    pub options: guardian_environment::ScanOptions,
    #[ts(optional = nullable)]
    pub model: Option<ash_protocol::ModelRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalEnvironmentSaveParams {
    pub scope: ApprovalEnvironmentScope,
    pub command_id: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[ts(optional = nullable)]
    pub draft_id: Option<String>,
    pub entries: Vec<guardian_environment::EntryInput>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalEnvironmentCancelParams {
    pub operation_id: String,
}
