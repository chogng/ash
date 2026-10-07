use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionItemsParams {
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionItemsResult {
    pub items: Vec<extension_items::ExtensionItem>,
}
