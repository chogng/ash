//! Reviewable feedback bytes shared by the protocol and upload service.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFeedback {
    pub digest: String,
    pub endpoint: String,
    /// Exact JSON bytes the user reviews and authorizes for this destination.
    pub content: String,
}
