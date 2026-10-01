use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationResourceParams {
    #[schemars(length(min = 1, max = 128))]
    pub resource_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationStartParams {
    #[schemars(length(min = 1, max = 128))]
    pub resource_id: String,
    pub backend: DictationBackend,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DictationBackend {
    Local {
        model_id: String,
    },
    Cloud {
        provider: DictationCloudProvider,
        model_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DictationCloudProvider {
    OpenAi,
    Xai,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationTranscript {
    pub resource_id: String,
    pub text: String,
    pub is_final: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationEnded {
    pub resource_id: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationStopResult {
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationModelParams {
    #[schemars(length(min = 1, max = 128))]
    pub model_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationModelStatus {
    pub model_id: String,
    /// Installed package availability does not imply an active loaded recognizer.
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationModelStartParams {
    #[schemars(length(min = 1, max = 128))]
    pub resource_id: String,
    #[schemars(length(min = 1, max = 128))]
    pub model_id: String,
    pub operation: DictationModelOperation,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DictationModelOperation {
    Prepare,
    Import { source_directory: String },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DictationModelStage {
    Checking,
    Downloading {
        file: String,
        #[ts(type = "number")]
        downloaded_bytes: u64,
    },
    Loading,
    Ready,
    Cancelled,
    Failed {
        error: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationModelProgress {
    pub resource_id: String,
    pub model_id: String,
    pub stage: DictationModelStage,
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
