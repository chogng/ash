//! A task-local second opinion using one explicitly selected model and no tools.
use action_policy::ActionDigest;
use action_policy::ActionKind;
use action_policy::ActionPolicyRevision;
use action_policy::ActionProvenance;
use action_policy::ActionReviewRequest;
use action_policy::ActionSource;
use action_policy::Capability;
use action_policy::CapabilityKind;
use action_policy::CapabilitySet;
use action_policy::ResolvedAction;
use action_policy::SandboxCompatibility;
use ash_core::ThreadController;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolModel;
use ash_core::ToolModelRequest;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use async_utils::CancellationToken;
use core_api::CoreError;
use core_api::ModelService;
use protocol::AdvisorConfig;
use protocol::ToolCall;
use protocol::ToolDefinition;
use protocol::ToolExecutionOutput;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub const TOOL_NAME: &str = "advisor";
const INSTRUCTIONS: &str = include_str!("../templates/instructions.md");

pub struct AdvisorToolService {
    threads: Arc<ThreadController>,
    model: ToolModel,
    revision: ActionPolicyRevision,
}

impl AdvisorToolService {
    pub fn new(
        threads: Arc<ThreadController>,
        model: Arc<dyn ModelService>,
        revision: ActionPolicyRevision,
    ) -> Self {
        Self {
            model: ToolModel::new(Arc::clone(&threads), model),
            threads,
            revision,
        }
    }

    fn config(&self, facts: &ToolExecutionFacts) -> Result<AdvisorConfig, CoreError> {
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("advisor requires durable caller identity".into())
        })?;
        let snapshot = self.threads.read_thread(identity.thread_id())?;
        let config = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == identity.turn_id())
            .and_then(|turn| turn.advisor.clone())
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "advisor is off for this Turn; select a model with /advisor".into(),
                )
            })?;
        config
            .validate()
            .map_err(|message| CoreError::InvalidInput(message.into()))?;
        Ok(config)
    }

    fn consult(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
        cancellation: &CancellationToken,
    ) -> Result<serde_json::Value, CoreError> {
        let arguments = arguments(call)?;
        let config = self.config(facts)?;
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("advisor requires durable caller identity".into())
        })?;
        let snapshot = self.threads.read_thread(identity.thread_id())?;
        let calls = snapshot.items.iter().take_while(|item| !matches!(item, protocol::ThreadItem::ToolCall { tool_call_id, .. } if tool_call_id == &call.id))
            .filter(|item| matches!(item, protocol::ThreadItem::ToolCall { turn_id, name, .. } if turn_id == identity.turn_id() && name.as_str() == TOOL_NAME)).count();
        if calls >= config.max_calls as usize {
            return Ok(json!({"status": "limitReached", "maxCalls": config.max_calls}));
        }
        let result = self.model.invoke(
            ToolModelRequest {
                identity,
                call_id: &call.id,
                model: &config.model,
                instructions: INSTRUCTIONS.trim(),
                question: &arguments.question,
                max_output_tokens: config.max_output_tokens,
                reasoning: config
                    .reasoning_effort
                    .map(|effort| protocol::ReasoningConfig {
                        effort,
                        summary: false,
                    }),
            },
            cancellation,
        )?;
        let refusal = result.response.output.iter().find_map(|item| match item {
            protocol::ResponseItem::Refusal(reason) => Some(reason.clone()),
            _ => None,
        });
        if result.response.tool_calls().next().is_some() {
            return Err(CoreError::Model(
                "advisor returned an unsupported tool call".into(),
            ));
        }
        let advice = refusal.clone().unwrap_or_else(|| result.response.text());
        if advice.trim().is_empty() {
            return Err(CoreError::Model("advisor returned no advice".into()));
        }
        Ok(json!({
            "status": if refusal.is_some() { "declined" } else { "reviewed" },
            "model": config.model,
            "question": arguments.question,
            "advice": advice,
            "sourceSequence": result.source_sequence,
            "checkpoint": result.checkpoint,
            "elapsedMs": result.elapsed_ms,
            "usage": result.response.usage,
            "stopReason": result.response.stop_reason,
        }))
    }
}

impl ToolService for AdvisorToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            strict: true,
            name: protocol::ToolName::new(TOOL_NAME).expect("valid advisor tool name"),
            description: "Consult the configured advisor for a second opinion on a consequential decision, a recurring unexplained failure, or an unresolved completion risk. Ask a concrete question. Ash supplies conversation evidence. The advisor only advises; verify its claims and continue the task yourself. Use sparingly; each consultation has a separate model cost and a per-Turn limit.".into(),
            parameters: json!({"type": "object", "properties": {"question": {"type": "string", "minLength": 1, "maxLength": 8000}}, "required": ["question"], "additionalProperties": false}),
        }]
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Err(CoreError::Execution(
            "advisor requires durable execution facts".into(),
        ))
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        arguments(call)?;
        let config = self.config(facts)?;
        let scope = format!("model:{}/{}", config.model.provider, config.model.model);
        let canonical = serde_json::to_vec(
            &json!({"tool": TOOL_NAME, "arguments": call.arguments, "config": config}),
        )
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                format!("consult {scope} using this conversation"),
                CapabilitySet::new([
                    Capability::new(CapabilityKind::Network, scope.clone()),
                    Capability::new(CapabilityKind::CredentialUse, scope),
                ]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, TOOL_NAME),
            SandboxCompatibility::NotApplicable {
                reason: "model access is handled by the configured provider runtime".into(),
            },
            self.revision.clone(),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(
            "advisor requires durable execution facts".into(),
        ))
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let (value, is_error) = match self.consult(call, facts, cancellation) {
            Ok(value) => {
                let is_error = value["status"] == "limitReached";
                (value, is_error)
            }
            Err(
                error @ (CoreError::Cancelled(_)
                | CoreError::Journal(_)
                | CoreError::ThreadStore(_)
                | CoreError::Execution(_)),
            ) => return Err(error),
            Err(error) => (
                json!({"status": "failed", "message": error.to_string()}),
                true,
            ),
        };
        Ok(if is_error {
            ToolExecutionOutput::Failure(value.to_string())
        } else {
            ToolExecutionOutput::Success(value.to_string())
        })
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
struct Arguments {
    question: String,
}

fn arguments(call: &ToolCall) -> Result<Arguments, CoreError> {
    if call.name.as_str() != TOOL_NAME {
        return Err(CoreError::InvalidInput("unknown advisor tool".into()));
    }
    let arguments: Arguments = serde_json::from_value(call.arguments.clone())
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    if arguments.question.trim().is_empty() || arguments.question.len() > 8000 {
        return Err(CoreError::InvalidInput(
            "advisor question must contain 1 to 8000 bytes".into(),
        ));
    }
    Ok(arguments)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
