//! Shared monitoring and control contracts for the built-in workflow scheduler.

use crate::ModelUsageSummary;
use crate::ThreadId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SymphonyTaskStatus {
    Pending,
    Starting,
    Running,
    Blocked,
    Retrying,
    Stopping,
    Paused,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SymphonyControl {
    Run,
    Pause,
    Complete,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymphonyWorkflow {
    pub id: String,
    pub path: String,
    pub directory: String,
    pub tracker: String,
    pub enabled: bool,
    pub max_concurrent_agents: u32,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymphonyConversation {
    pub id: String,
    pub workflow_id: String,
    pub identifier: String,
    pub title: String,
    pub status: SymphonyTaskStatus,
    pub thread_id: Option<ThreadId>,
    #[ts(type = "number")]
    pub attempt: u32,
    pub usage: ModelUsageSummary,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymphonySnapshot {
    pub workflows: Vec<SymphonyWorkflow>,
    pub conversations: Vec<SymphonyConversation>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymphonyMessage {
    pub id: String,
    pub role: SymphonyMessageRole,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SymphonyMessageRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymphonyMessages {
    pub conversation: SymphonyConversation,
    pub messages: Vec<SymphonyMessage>,
}
