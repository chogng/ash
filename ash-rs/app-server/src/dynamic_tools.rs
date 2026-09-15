use std::collections::BTreeMap;
use std::sync::Arc;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewPhase;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolService;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::ContentPart;
use ash_protocol::DynamicToolCall;
use ash_protocol::DynamicToolSpec;
use ash_protocol::ImageDetail;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolSourceProvenance;
use ash_tools::from_dynamic_tool_spec;
use ash_tools::to_protocol_tool_definition;
use core_api::ActionPolicyService;
use core_api::CoreError;
use serde_json::json;

const DYNAMIC_TOOL_POLICY_REVISION: &str = "dynamic-tool-user-approval-v1";

pub(crate) struct DynamicToolComposition {
    pub(crate) tools: Arc<dyn ToolService>,
    pub(crate) policy: Arc<dyn ActionPolicyService>,
}

#[derive(Clone)]
struct DynamicToolBinding {
    definition_digest: String,
    capabilities: CapabilitySet,
}

pub(crate) fn compose_dynamic_tools(
    specifications: Vec<DynamicToolSpec>,
) -> Result<Option<DynamicToolComposition>, DynamicToolCompositionError> {
    if specifications.is_empty() {
        return Ok(None);
    }
    let mut definitions = Vec::with_capacity(specifications.len());
    let mut bindings = BTreeMap::new();
    for specification in specifications {
        let host_definition = from_dynamic_tool_spec(&specification).map_err(|error| {
            DynamicToolCompositionError(format!(
                "invalid dynamic tool '{}': {error}",
                specification.name
            ))
        })?;
        let definition_digest = host_definition.digest().to_string();
        let definition = to_protocol_tool_definition(&host_definition).map_err(|error| {
            DynamicToolCompositionError(format!(
                "could not project dynamic tool '{}': {error}",
                specification.name
            ))
        })?;
        let capabilities = dynamic_tool_capabilities(&specification.name);
        if bindings
            .insert(
                specification.name.clone(),
                DynamicToolBinding {
                    definition_digest,
                    capabilities,
                },
            )
            .is_some()
        {
            return Err(DynamicToolCompositionError(format!(
                "duplicate dynamic tool name: {}",
                specification.name
            )));
        }
        definitions.push(definition);
    }
    let bindings = Arc::new(bindings);
    Ok(Some(DynamicToolComposition {
        tools: Arc::new(DynamicToolService {
            definitions,
            bindings: Arc::clone(&bindings),
        }),
        policy: Arc::new(DynamicToolPolicy { bindings }),
    }))
}

struct DynamicToolService {
    definitions: Vec<ToolDefinition>,
    bindings: Arc<BTreeMap<ToolName, DynamicToolBinding>>,
}

impl DynamicToolService {
    fn binding(&self, name: &ToolName) -> Result<&DynamicToolBinding, CoreError> {
        self.bindings
            .get(name)
            .ok_or_else(|| CoreError::Policy(format!("dynamic tool is not available: {name}")))
    }
}

impl ToolService for DynamicToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn source_provenance(&self, name: &ToolName) -> Vec<ToolSourceProvenance> {
        if self.bindings.contains_key(name) {
            vec![ToolSourceProvenance::Dynamic {
                name: name.to_string(),
            }]
        } else {
            Vec::new()
        }
    }

    fn execution_interaction(&self, call: &ToolCall) -> Result<Option<AgentRequest>, CoreError> {
        let binding = self.binding(&call.name)?;
        Ok(Some(AgentRequest::DynamicTool {
            call: DynamicToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                definition_digest: binding.definition_digest.clone(),
                arguments: call.arguments.clone(),
            },
        }))
    }

    fn resolve_execution_interaction(
        &self,
        call: &ToolCall,
        request: &AgentRequest,
        response: &AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        let binding = self.binding(&call.name)?;
        let AgentRequest::DynamicTool {
            call: requested_call,
        } = request
        else {
            return Ok(None);
        };
        let AgentResponse::DynamicTool { response } = response else {
            return Ok(None);
        };
        if requested_call.call_id != call.id
            || requested_call.name != call.name
            || requested_call.arguments != call.arguments
            || requested_call.definition_digest != binding.definition_digest
            || response.call_id != call.id
        {
            return Err(CoreError::Policy(
                "dynamic tool response does not match the frozen Tool Call binding".into(),
            ));
        }
        let content = response
            .content
            .iter()
            .map(|part| match part {
                ash_protocol::DynamicToolOutput::Text { text } => ContentPart::Text(text.clone()),
                ash_protocol::DynamicToolOutput::Image { data_url } => ContentPart::ImageUrl {
                    url: data_url.clone(),
                    detail: ImageDetail::Auto,
                },
            })
            .collect();
        Ok(Some(if response.success {
            ToolExecutionOutput::SuccessContent(content)
        } else {
            ToolExecutionOutput::FailureContent(content)
        }))
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if !call.arguments.is_object() {
            return Err(CoreError::Policy(
                "dynamic tool arguments must be a JSON object".into(),
            ));
        }
        let binding = self.binding(&call.name)?;
        let canonical = serde_json::to_vec(&json!({
            "tool": call.name.as_str(),
            "definition_digest": binding.definition_digest,
            "arguments": call.arguments,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::ExternalServiceMutation,
                format!("call client-hosted dynamic tool '{}'", call.name),
                binding.capabilities.clone(),
            ),
            ActionProvenance::new(ActionSource::DynamicTool, call.name.as_str()),
            SandboxCompatibility::NotApplicable {
                reason: "client-hosted side effects cannot be enforced by the local sandbox".into(),
            },
            ActionPolicyRevision::new(DYNAMIC_TOOL_POLICY_REVISION),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(format!(
            "dynamic tool '{}' must execute through its client interaction owner",
            call.name
        )))
    }
}

struct DynamicToolPolicy {
    bindings: Arc<BTreeMap<ToolName, DynamicToolBinding>>,
}

impl ActionPolicyService for DynamicToolPolicy {
    fn revision(&self) -> String {
        DYNAMIC_TOOL_POLICY_REVISION.into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let binding = ToolName::new(request.provenance().source_id())
            .ok()
            .and_then(|name| self.bindings.get(&name));
        if request.action_policy_revision().as_str() != DYNAMIC_TOOL_POLICY_REVISION
            || request.provenance().source() != &ActionSource::DynamicTool
            || binding.map(|binding| &binding.capabilities)
                != Some(request.action().required_capabilities())
            || request.action().kind() != &ActionKind::ExternalServiceMutation
            || !matches!(request.phase(), ActionReviewPhase::Initial)
            || !matches!(
                request.sandbox(),
                SandboxCompatibility::NotApplicable { .. }
            )
        {
            return Err(CoreError::Policy(
                "dynamic tool policy rejected an action outside its exact review contract".into(),
            ));
        }
        Ok(ExecutionDecision::AskUser(ApprovalRequest::new(
            request.action().digest().clone(),
            request.action().required_capabilities().clone(),
            "client-hosted dynamic tools execute outside the local sandbox and require one-time approval",
        )))
    }
}

fn dynamic_tool_capabilities(name: &ToolName) -> CapabilitySet {
    CapabilitySet::new([Capability::new(
        CapabilityKind::ExternalMutation,
        name.as_str(),
    )])
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynamicToolCompositionError(String);

impl DynamicToolCompositionError {
    pub(crate) fn configuration(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for DynamicToolCompositionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DynamicToolCompositionError {}

#[cfg(test)]
#[path = "dynamic_tools_tests.rs"]
mod tests;
