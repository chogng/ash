use action_policy::ActionDigest;
use action_policy::ActionKind;
use action_policy::ActionPolicyRevision;
use action_policy::ActionProvenance;
use action_policy::ActionReviewRequest;
use action_policy::ActionSource;
use action_policy::CapabilitySet;
use action_policy::ResolvedAction;
use action_policy::SandboxCompatibility;
use ash_core::ThreadController;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use async_utils::CancellationToken;
use core_api::CoreError;
use protocol::ThreadGoalStatus;
use protocol::ToolCall;
use protocol::ToolDefinition;
use protocol::ToolExecutionOutput;
use protocol::ToolName;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

pub const GET_GOAL_TOOL_NAME: &str = "get_goal";
pub const CREATE_GOAL_TOOL_NAME: &str = "create_goal";
pub const UPDATE_GOAL_TOOL_NAME: &str = "update_goal";

pub struct GoalToolService {
    threads: Arc<ThreadController>,
    definitions: Vec<ToolDefinition>,
    action_policy_revision: ActionPolicyRevision,
}

impl GoalToolService {
    pub fn new(
        threads: Arc<ThreadController>,
        action_policy_revision: ActionPolicyRevision,
    ) -> Self {
        Self {
            threads,
            definitions: vec![get_definition(), create_definition(), update_definition()],
            action_policy_revision,
        }
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
            CoreError::Execution("Goal tool requires durable caller identity".into())
        })?;
        match call.name.as_str() {
            GET_GOAL_TOOL_NAME => {
                let goal = self.threads.get_goal(identity.thread_id())?;
                success(json!({
                    "goal": goal,
                    "remaining_tokens": goal.as_ref().and_then(|goal| goal.remaining_tokens()),
                }))
            }
            CREATE_GOAL_TOOL_NAME => {
                let arguments: CreateGoalArguments = decode(&call.arguments)?;
                let goal = self.threads.create_goal(
                    identity.thread_id(),
                    arguments.objective,
                    arguments.token_budget,
                )?;
                success(json!({"goal": goal}))
            }
            UPDATE_GOAL_TOOL_NAME => {
                let arguments: UpdateGoalArguments = decode(&call.arguments)?;
                let status = match arguments.status {
                    UpdateGoalStatus::Complete => ThreadGoalStatus::Complete,
                    UpdateGoalStatus::Blocked => ThreadGoalStatus::Blocked,
                };
                let goal = self
                    .threads
                    .update_goal_status_from_agent(identity.thread_id(), status)?;
                success(json!({"goal": goal}))
            }
            _ => Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            ))),
        }
    }
}

impl ToolService for GoalToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if !self
            .definitions
            .iter()
            .any(|definition| definition.name == call.name)
        {
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
                format!("manage the current Thread Goal through {}", call.name),
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, call.name.as_str()),
            SandboxCompatibility::NotApplicable {
                reason: "Goal tools only mutate durable Ash Thread state".into(),
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
            "Goal tools require durable execution facts".into(),
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
struct CreateGoalArguments {
    objective: String,
    token_budget: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateGoalArguments {
    status: UpdateGoalStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum UpdateGoalStatus {
    Complete,
    Blocked,
}

fn decode<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, CoreError> {
    serde_json::from_value(value.clone())
        .map_err(|error| CoreError::InvalidInput(format!("invalid Goal tool arguments: {error}")))
}

fn definition(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).expect("static Goal tool name is valid"),
        description: description.into(),
        parameters,
        strict: true,
    }
}

fn get_definition() -> ToolDefinition {
    definition(
        GET_GOAL_TOOL_NAME,
        "Returns the current Thread Goal, its lifecycle status, and remaining token budget. Use only when the user explicitly asked to work toward a Goal or when continuing an existing Goal.",
        json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        }),
    )
}

fn create_definition() -> ToolDefinition {
    definition(
        CREATE_GOAL_TOOL_NAME,
        "Creates one durable Goal for the current Thread. Use only when the user explicitly requests a persistent multi-turn objective. Do not create a duplicate while an unfinished Goal exists.",
        json!({
            "type": "object",
            "properties": {
                "objective": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The complete user-requested objective to preserve across Turns."
                },
                "token_budget": {
                    "type": ["integer", "null"],
                    "minimum": 1,
                    "description": "Optional cumulative token budget for this Goal; null means unbounded."
                }
            },
            "required": ["objective", "token_budget"],
            "additionalProperties": false
        }),
    )
}

fn update_definition() -> ToolDefinition {
    definition(
        UPDATE_GOAL_TOOL_NAME,
        "Marks the current Goal complete or blocked. Only use complete when the objective is fully achieved, or blocked when progress cannot continue without outside action.",
        json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["complete", "blocked"]
                }
            },
            "required": ["status"],
            "additionalProperties": false
        }),
    )
}

fn success(value: Value) -> Result<ToolExecutionOutput, CoreError> {
    serde_json::to_string(&value)
        .map(ToolExecutionOutput::Success)
        .map_err(|error| CoreError::Execution(error.to_string()))
}

#[cfg(test)]
#[path = "tool_tests.rs"]
mod tests;
