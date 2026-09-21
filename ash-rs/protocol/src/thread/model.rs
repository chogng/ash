use crate::ModelReferenceCostSummary;
use crate::ModelUsageSummary;
use crate::SessionId;
use crate::ThreadGoal;
use crate::ThreadId;
use crate::ThreadStatus;
use crate::Turn;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Canonical readable state for one independently ordered Agent execution branch.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub agent_id: crate::AgentId,
    pub origin: crate::ThreadOrigin,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub parent_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub forked_from_id: Option<ThreadId>,
    pub title: String,
    pub status: ThreadStatus,
    #[ts(type = "number")]
    pub sequence: u64,
    #[serde(default)]
    pub usage: ModelUsageSummary,
    #[serde(default)]
    pub reference_cost: ModelReferenceCostSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub goal: Option<ThreadGoal>,
    #[serde(default)]
    pub advisor: crate::AdvisorSelection,
    pub turns: Vec<Turn>,
}
