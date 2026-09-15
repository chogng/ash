use crate::local_tools::local_policy_revision;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use core_api::CoreError;
use ash_core::ThreadController;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_core::UpdatePlanDisposition;
use ash_protocol::PlanStep;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;

pub(crate) const UPDATE_PLAN_TOOL_NAME: &str = "update_plan";

pub(super) struct UpdatePlanToolService {
    threads: Arc<ThreadController>,
    definition: ToolDefinition,
    action_policy_revision: ActionPolicyRevision,
}

impl UpdatePlanToolService {
    pub(super) fn new(threads: Arc<ThreadController>) -> Self {
        Self {
            threads,
            definition: definition(),
            action_policy_revision: local_policy_revision(),
        }
    }

    pub(super) fn with_action_policy_revision(mut self, revision: ActionPolicyRevision) -> Self {
        self.action_policy_revision = revision;
        self
    }

    fn execute_with_context(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("update_plan requires durable caller identity".into())
        })?;
        let arguments: UpdatePlanArguments = serde_json::from_value(call.arguments.clone())
            .map_err(|error| CoreError::InvalidInput(format!("invalid tool arguments: {error}")))?;
        let plan = PlanUpdate {
            explanation: arguments.explanation,
            steps: arguments
                .plan
                .into_iter()
                .map(|step| PlanStep {
                    step: step.step,
                    status: step.status.into(),
                })
                .collect(),
        };
        let result =
            self.threads
                .update_plan(identity.thread_id(), identity.turn_id(), plan.clone())?;
        success(json!({
            "updated": result.disposition == UpdatePlanDisposition::Changed,
            "sequence": result.sequence,
            "plan": plan,
        }))
    }
}

impl ToolService for UpdatePlanToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![self.definition.clone()]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if call.name != self.definition.name {
            return Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            )));
        }
        let canonical = serde_json::to_vec(&json!({
            "tool": call.name,
            "arguments": call.arguments,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                "update the current Turn plan",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, UPDATE_PLAN_TOOL_NAME),
            SandboxCompatibility::NotApplicable {
                reason: "update_plan only mutates durable Ash Turn state".into(),
            },
            self.action_policy_revision.clone(),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(
            "update_plan requires durable execution facts".into(),
        ))
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_with_context(call, cancellation, facts)
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_with_facts(call, authorization, cancellation, facts)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePlanArguments {
    explanation: Option<String>,
    plan: Vec<UpdatePlanStepArguments>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePlanStepArguments {
    step: String,
    status: UpdatePlanStatusArguments,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum UpdatePlanStatusArguments {
    Pending,
    InProgress,
    Completed,
}

impl From<UpdatePlanStatusArguments> for PlanStepStatus {
    fn from(value: UpdatePlanStatusArguments) -> Self {
        match value {
            UpdatePlanStatusArguments::Pending => Self::Pending,
            UpdatePlanStatusArguments::InProgress => Self::InProgress,
            UpdatePlanStatusArguments::Completed => Self::Completed,
        }
    }
}

fn definition() -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(UPDATE_PLAN_TOOL_NAME).expect("static tool name is valid"),
        description: r#"Records or updates your durable plan for a multi-step task.

- Use for tasks that need 3 or more distinct steps; skip it for trivial work.
- Keep at most one step in_progress at a time. Mark a step completed as soon
  as it is done; update the plan when scope changes rather than following a
  stale plan.
- Steps are short imperative phrases ("Fix parser offset bug"), not essays."#
            .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "explanation": {
                    "type": ["string", "null"],
                    "description": "Optional short explanation for this plan update."
                },
                "plan": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": {
                        "type": "object",
                        "properties": {
                            "step": { "type": "string" },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"]
                            }
                        },
                        "required": ["step", "status"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["explanation", "plan"],
            "additionalProperties": false
        }),
        strict: true,
    }
}

fn success(value: Value) -> Result<ToolExecutionOutput, CoreError> {
    serde_json::to_string(&value)
        .map(ToolExecutionOutput::Success)
        .map_err(|error| CoreError::Execution(error.to_string()))
}

#[cfg(test)]
#[path = "update_plan_tool_tests.rs"]
mod tests;
