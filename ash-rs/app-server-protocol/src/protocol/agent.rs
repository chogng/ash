use crate::JsonSchema;
use crate::TS;
use ash_protocol::AgentId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadParams {
    pub agent_id: AgentId,
}

/// One execution branch belonging to the requested Agent, including archived branches.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub origin: ThreadOrigin,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadResult {
    pub agent_id: AgentId,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    pub threads: Vec<AgentThread>,
}
