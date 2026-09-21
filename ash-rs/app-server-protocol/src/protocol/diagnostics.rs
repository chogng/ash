use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackPrepareParams {
    pub endpoint: String,
}

/// Invoked only after the user reviews and authorizes the prepared content and destination.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackUploadParams {
    #[schemars(length(min = 1))]
    pub operation_id: String,
    #[schemars(length(min = 64, max = 64))]
    pub digest: String,
}
