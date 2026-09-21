use crate::ActionApprovalResponse;
use crate::ApprovalMode;
use crate::DynamicToolResponse;
use crate::FrozenSkillActivation;
use crate::ModelRef;
use crate::RequestId;
use crate::RequestUserInputResponse;
use crate::ToolMode;
use crate::ToolProfileSnapshot;
use crate::TurnId;
use crate::TurnInstructions;
use crate::TurnKind;
use crate::UserInput;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadCommand {
    StartTurn {
        #[serde(default)]
        kind: TurnKind,
        /// Exact instructions selected by the host before durable Turn acceptance.
        ///
        /// `None` exists only so journals written before instruction snapshots remain readable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        instructions: Option<TurnInstructions>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        model: Option<ModelRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        advisor: Option<crate::AdvisorConfig>,
        #[serde(default)]
        activated_skills: Vec<FrozenSkillActivation>,
        /// Activations supplied by the caller before extension contributors run.
        /// `None` identifies a legacy command whose host activations must be inferred.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        host_activated_skills: Option<Vec<FrozenSkillActivation>>,
        #[serde(default)]
        approval_mode: ApprovalMode,
        #[serde(default)]
        tool_mode: ToolMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        tool_profile: Option<Box<ToolProfileSnapshot>>,
        input: Vec<UserInput>,
    },
    ConfigureAdvisor {
        selection: crate::AdvisorSelection,
    },
    StartShellTurn {
        command: String,
        #[serde(default)]
        approval_mode: ApprovalMode,
    },
    CompactContext {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        model: Option<ModelRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        retention_prompt: Option<String>,
    },
    InterruptTurn {
        turn_id: TurnId,
    },
    SteerTurn {
        turn_id: TurnId,
        input: Vec<UserInput>,
    },
    ResolveApproval {
        turn_id: TurnId,
        request_id: RequestId,
        response: ActionApprovalResponse,
    },
    ResolveUserInput {
        turn_id: TurnId,
        request_id: RequestId,
        response: RequestUserInputResponse,
    },
    ResolveDynamicTool {
        turn_id: TurnId,
        request_id: RequestId,
        response: DynamicToolResponse,
    },
}
