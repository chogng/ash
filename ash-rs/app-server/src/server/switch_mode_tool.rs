use crate::local_tools::local_policy_revision;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ChangeTurnModeRequest;
use ash_core::ModeChangeAuthority;
use ash_core::ThreadController;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolInteractionService;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_core::ToolUserInputOutcome;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::CapabilitySet;
use ash_protocol::CollaborationMode;
use ash_protocol::RequestUserInput;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::UserInputOption;
use ash_protocol::UserInputQuestion;
use core_api::CoreError;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub(crate) const SWITCH_MODE_TOOL_NAME: &str = "switch_mode";

pub(super) struct SwitchModeToolService {
    threads: Arc<ThreadController>,
    definition: ToolDefinition,
    action_policy_revision: ActionPolicyRevision,
}

impl SwitchModeToolService {
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

    fn switch(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Option<&dyn ToolInteractionService>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let args = arguments(call)?;
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Policy("switch_mode requires durable caller identity".into())
        })?;
        let snapshot = self.threads.read_thread(identity.thread_id())?;
        if &snapshot.session_id != identity.session_id() {
            return Err(CoreError::Policy(
                "switch_mode caller does not own this Session".into(),
            ));
        }
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == identity.turn_id())
            .ok_or_else(|| CoreError::NotFound(identity.turn_id().to_string()))?;
        let from = turn.mode;
        let mut authority = ModeChangeAuthority::Agent;
        if from.is_analysis() && !args.mode.is_analysis() {
            let interactions = interactions.ok_or_else(|| {
                CoreError::Policy("leaving Plan or Ask requires a user decision".into())
            })?;
            // Mode IDs and the model-authored reason are protocol/user content. The existing
            // user-input surface owns localized controls and accessibility; no extra dialog is used.
            let outcome = interactions.request_user_input(RequestUserInput {
                questions: vec![UserInputQuestion {
                    id: SWITCH_MODE_TOOL_NAME.into(),
                    header: SWITCH_MODE_TOOL_NAME.into(),
                    question: args.reason.clone(),
                    options: vec![args.mode, from]
                        .into_iter()
                        .map(|mode| UserInputOption {
                            label: mode_id(mode),
                            description: String::new(),
                        })
                        .collect(),
                    allow_free_form: false,
                }],
            })?;
            let approved = match outcome {
                ToolUserInputOutcome::Answered(response) => response
                    .answers
                    .get(SWITCH_MODE_TOOL_NAME)
                    .is_some_and(|answer| answer.value == mode_id(args.mode)),
                ToolUserInputOutcome::Cancelled(_) => false,
            };
            if !approved {
                return Ok(ToolExecutionOutput::Success(
                    json!({"changed": false, "mode": from, "rejected": true}).to_string(),
                ));
            }
            authority = ModeChangeAuthority::User;
        }
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let result = self.threads.change_turn_mode(
            identity.thread_id(),
            identity.turn_id(),
            ChangeTurnModeRequest {
                expected_mode: from,
                mode: args.mode,
                mode_instructions: collaboration_mode_templates::instructions(args.mode),
                authority,
            },
        )?;
        Ok(ToolExecutionOutput::Success(json!({
            "changed": result.changed, "from_mode": from, "mode": result.mode, "sequence": result.sequence,
        }).to_string()))
    }
}

impl ToolService for SwitchModeToolService {
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
        arguments(call)?;
        let canonical =
            serde_json::to_vec(&json!({"tool": call.name, "arguments": call.arguments}))
                .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                SWITCH_MODE_TOOL_NAME,
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, SWITCH_MODE_TOOL_NAME),
            SandboxCompatibility::NotApplicable {
                reason: "switch_mode only changes durable Turn approach instructions".into(),
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
        Err(CoreError::Policy(
            "switch_mode requires durable execution facts".into(),
        ))
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.switch(call, cancellation, facts, None)
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Arc<dyn ToolInteractionService>,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.switch(call, cancellation, facts, Some(interactions.as_ref()))
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
struct SwitchModeArguments {
    mode: CollaborationMode,
    reason: String,
}

fn arguments(call: &ToolCall) -> Result<SwitchModeArguments, CoreError> {
    let args: SwitchModeArguments =
        serde_json::from_value(call.arguments.clone()).map_err(|error| {
            CoreError::InvalidInput(format!("invalid switch_mode arguments: {error}"))
        })?;
    if args.reason.trim().is_empty() || args.reason.chars().count() > 1_000 {
        return Err(CoreError::InvalidInput(
            "switch_mode reason must contain between 1 and 1000 characters".into(),
        ));
    }
    Ok(args)
}

fn mode_id(mode: CollaborationMode) -> String {
    serde_json::to_value(mode)
        .expect("mode serialization is infallible")
        .as_str()
        .expect("modes serialize as strings")
        .to_owned()
}

fn definition() -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(SWITCH_MODE_TOOL_NAME).expect("static tool name is valid"),
        description: "Changes the current approach when the task needs planning, debugging, implementation, delegation or explanation. Use plan to investigate and design without implementing; debug to reproduce and fix a problem; agent to implement; multitask to coordinate delegated work; ask to explain without editing. Supply a short user-facing reason. Do not switch repeatedly or for minor changes. Leaving plan or ask for an execution mode requires an explicit user decision through this tool. A rejected switch keeps the current mode. Permissions, role and tool ceilings remain unchanged. After success, subsequent model invocations use the selected mode instructions.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "mode": {"type": "string", "enum": CollaborationMode::ALL},
                "reason": {"type": "string", "minLength": 1, "maxLength": 1000}
            },
            "required": ["mode", "reason"], "additionalProperties": false
        }),
        strict: true,
    }
}

#[cfg(test)]
#[path = "switch_mode_tool_tests.rs"]
mod tests;
