use crate::ApprovalMode;
use crate::ModelContextUsage;
use crate::ModelRef;
use crate::ModelUsageSummary;
use crate::PendingInteraction;
use crate::PlanUpdate;
use crate::StableTurnError;
use crate::ThreadItem;
use crate::ToolMode;
use crate::ToolProfileSnapshot;
use crate::TurnId;
use crate::TurnInstructions;
use crate::TurnKind;
use crate::TurnStatus;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Canonical readable state for one user-intent-driven Agent execution.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub turn_id: TurnId,
    pub status: TurnStatus,
    #[serde(default)]
    pub kind: TurnKind,
    /// Exact instructions frozen when this Turn was accepted.
    ///
    /// Historical Turns written before instruction snapshots were introduced omit this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub instructions: Option<TurnInstructions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub advisor: Option<crate::AdvisorConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub tool_profile: Option<ToolProfileSnapshot>,
    #[serde(default)]
    pub tool_mode: ToolMode,
    #[serde(default)]
    pub approval_mode: ApprovalMode,
    #[serde(default)]
    pub usage: ModelUsageSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub context_usage: Option<ModelContextUsage>,
    pub items: Vec<ThreadItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub plan: Option<PlanUpdate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub pending_interaction: Option<PendingInteraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub error: Option<StableTurnError>,
}
