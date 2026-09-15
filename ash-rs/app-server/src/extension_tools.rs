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
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_extension_api::ExtensionRegistry;
use ash_extension_api::ExtensionToolAuthority;
use ash_protocol::ToolCall;
use ash_protocol::ToolName;
use ash_tools::EnvId;
use ash_tools::ToolDefinition;
use ash_tools::ToolInvocationKind;
use ash_tools::ToolPayload;
use core_api::ActionPolicyService;
use core_api::CoreError;
use serde_json::json;

use crate::tool_composition::ToolPort;
use crate::tool_executor_adapter::PreparedToolExecution;
use crate::tool_executor_adapter::ToolExecutorReviewer;

const EXTENSION_TOOL_POLICY_REVISION: &str = "host-extension-authority-v2";

pub(crate) fn compose_extension_tools(
    registry: &ExtensionRegistry,
) -> Result<Option<ToolPort>, ExtensionToolCompositionError> {
    let read_only_executors = registry
        .contribute_read_only_tools()
        .map_err(|error| ExtensionToolCompositionError(error.to_string()))?;
    let capability_tools = registry
        .contribute_capability_tools()
        .map_err(|error| ExtensionToolCompositionError(error.to_string()))?;
    let mut registrations = read_only_executors
        .iter()
        .map(|executor| {
            (
                executor.definition().name().clone(),
                ExtensionToolRegistration {
                    definition: executor.definition(),
                    authority: RegisteredExtensionAuthority::ReadOnlyLocal,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    if registrations.len() != read_only_executors.len() {
        return Err(ExtensionToolCompositionError(
            "extension tool names must be unique".into(),
        ));
    }
    for contribution in &capability_tools {
        let definition = contribution.executor().definition();
        if registrations
            .insert(
                definition.name().clone(),
                ExtensionToolRegistration {
                    definition,
                    authority: RegisteredExtensionAuthority::Capability(
                        contribution.authority().clone(),
                    ),
                },
            )
            .is_some()
        {
            return Err(ExtensionToolCompositionError(
                "extension tool names must be unique across authority classes".into(),
            ));
        }
    }
    let mut executors = read_only_executors;
    executors.extend(
        capability_tools
            .into_iter()
            .map(|contribution| contribution.into_parts().0),
    );
    if executors.is_empty() {
        return Ok(None);
    }
    let registrations = Arc::new(registrations);
    let environment_id = EnvId::new("host-extensions")
        .map_err(|error| ExtensionToolCompositionError(error.to_string()))?;
    ToolPort::extension(
        executors,
        environment_id,
        Arc::new(ExtensionToolReviewer {
            registrations: Arc::clone(&registrations),
        }),
        Arc::new(ExtensionToolPolicy { registrations }),
    )
    .map(Some)
    .map_err(|error| ExtensionToolCompositionError(error.to_string()))
}

struct ExtensionToolReviewer {
    registrations: Arc<BTreeMap<ToolName, ExtensionToolRegistration>>,
}

impl ToolExecutorReviewer for ExtensionToolReviewer {
    fn prepare(&self, call: &ToolCall) -> Result<PreparedToolExecution, CoreError> {
        let registration = self.registrations.get(&call.name).ok_or_else(|| {
            CoreError::Policy(format!("extension tool is not available: {}", call.name))
        })?;
        let definition = &registration.definition;
        let payload = match definition.invocation() {
            ToolInvocationKind::Function { .. } => {
                if !call.arguments.is_object() {
                    return Err(CoreError::Policy(
                        "extension function tool arguments must be a JSON object".into(),
                    ));
                }
                ToolPayload::FunctionArguments(call.arguments.clone())
            }
            ToolInvocationKind::Freeform { .. } => ToolPayload::FreeformInput(
                call.arguments
                    .as_str()
                    .ok_or_else(|| {
                        CoreError::Policy(
                            "extension freeform tool input must be a JSON string".into(),
                        )
                    })?
                    .to_owned(),
            ),
        };
        let canonical = serde_json::to_vec(&json!({
            "tool": call.name.as_str(),
            "definition_digest": definition.digest().as_str(),
            "authority": authority_digest_value(&registration.authority),
            "arguments": call.arguments,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let review = ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                extension_action_kind(&registration.authority),
                extension_summary(&call.name, &registration.authority),
                extension_capabilities(&call.name, &registration.authority),
            ),
            ActionProvenance::new(ActionSource::Plugin, call.name.as_str()),
            SandboxCompatibility::NotApplicable {
                reason: extension_sandbox_reason(&registration.authority),
            },
            ActionPolicyRevision::new(EXTENSION_TOOL_POLICY_REVISION),
        );
        Ok(PreparedToolExecution::new(review, payload))
    }
}

struct ExtensionToolPolicy {
    registrations: Arc<BTreeMap<ToolName, ExtensionToolRegistration>>,
}

impl ActionPolicyService for ExtensionToolPolicy {
    fn revision(&self) -> String {
        EXTENSION_TOOL_POLICY_REVISION.into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let tool_name = ToolName::new(request.provenance().source_id()).ok();
        let registration = tool_name
            .as_ref()
            .and_then(|name| self.registrations.get(name));
        let capabilities = tool_name
            .as_ref()
            .zip(registration)
            .map(|(name, registration)| extension_capabilities(name, &registration.authority));
        if request.action_policy_revision().as_str() != EXTENSION_TOOL_POLICY_REVISION
            || request.provenance().source() != &ActionSource::Plugin
            || capabilities.as_ref() != Some(request.action().required_capabilities())
            || registration.is_none_or(|registration| {
                request.action().kind() != &extension_action_kind(&registration.authority)
            })
            || !matches!(request.phase(), ActionReviewPhase::Initial)
            || !matches!(
                request.sandbox(),
                SandboxCompatibility::NotApplicable { .. }
            )
        {
            return Err(CoreError::Policy(
                "extension tool policy rejected an action outside its declared authority".into(),
            ));
        }
        match &registration
            .expect("validated extension registration")
            .authority
        {
            RegisteredExtensionAuthority::Capability(
                ExtensionToolAuthority::ManagedStateWrite { .. },
            ) => Ok(ExecutionDecision::RunUnsandboxed {
                grant_id: GrantId::new(format!(
                    "host-managed-state:{}",
                    request.provenance().source_id()
                )),
            }),
            RegisteredExtensionAuthority::ReadOnlyLocal => Ok(ExecutionDecision::RunUnsandboxed {
                grant_id: GrantId::new(format!(
                    "host-read-only-extension:{}",
                    request.provenance().source_id()
                )),
            }),
            RegisteredExtensionAuthority::Capability(_) => {
                Ok(ExecutionDecision::AskUser(ApprovalRequest::new(
                    request.action().digest().clone(),
                    request.action().required_capabilities().clone(),
                    "extension tool requires exact one-time external access approval",
                )))
            }
        }
    }
}

#[derive(Clone)]
struct ExtensionToolRegistration {
    definition: ToolDefinition,
    authority: RegisteredExtensionAuthority,
}

#[derive(Clone)]
enum RegisteredExtensionAuthority {
    ReadOnlyLocal,
    Capability(ExtensionToolAuthority),
}

fn extension_capabilities(
    name: &ToolName,
    authority: &RegisteredExtensionAuthority,
) -> CapabilitySet {
    match authority {
        RegisteredExtensionAuthority::ReadOnlyLocal => CapabilitySet::new([Capability::new(
            CapabilityKind::FileRead,
            format!("extension-tool:{}", name.as_str()),
        )]),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ManagedStateWrite {
            resource,
        }) => CapabilitySet::new([Capability::new(CapabilityKind::FileWrite, resource)]),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalWrite {
            service,
            network_scopes,
            credential_reference,
            artifact_root,
        }) => CapabilitySet::new(
            network_scopes
                .iter()
                .map(|scope| Capability::new(CapabilityKind::Network, scope))
                .chain(
                    credential_reference
                        .iter()
                        .map(|key| Capability::new(CapabilityKind::CredentialUse, key)),
                )
                .chain([
                    Capability::new(CapabilityKind::ExternalMutation, service),
                    Capability::new(CapabilityKind::FileWrite, artifact_root),
                    Capability::new(CapabilityKind::FileRead, artifact_root),
                ]),
        ),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalRead {
            network_scopes,
            credential_reference,
            ..
        }) => {
            CapabilitySet::new(
                network_scopes
                    .iter()
                    .map(|scope| Capability::new(CapabilityKind::Network, scope))
                    .chain(credential_reference.iter().map(|credential| {
                        Capability::new(CapabilityKind::CredentialUse, credential)
                    })),
            )
        }
    }
}

fn extension_action_kind(authority: &RegisteredExtensionAuthority) -> ActionKind {
    match authority {
        RegisteredExtensionAuthority::ReadOnlyLocal
        | RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ManagedStateWrite {
            ..
        }) => ActionKind::SystemOperation,
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalRead {
            ..
        }) => ActionKind::NetworkRequest,
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalWrite {
            ..
        }) => ActionKind::ExternalServiceMutation,
    }
}

fn extension_summary(name: &ToolName, authority: &RegisteredExtensionAuthority) -> String {
    match authority {
        RegisteredExtensionAuthority::ReadOnlyLocal => {
            format!("run host-installed read-only extension tool '{name}'")
        }
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ManagedStateWrite {
            resource,
        }) => format!("write {resource} through extension tool '{name}' with domain consent"),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalRead {
            service,
            ..
        }) => format!("query {service} through extension tool '{name}'"),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalWrite {
            service,
            ..
        }) => format!("invoke {service} through extension tool '{name}'"),
    }
}

fn extension_sandbox_reason(authority: &RegisteredExtensionAuthority) -> String {
    match authority {
        RegisteredExtensionAuthority::ReadOnlyLocal => "the host extension executes in process and is constrained to the read-only extension contract".into(),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ManagedStateWrite { .. }) => "the domain storage transaction enforces current user consent and record ownership".into(),
        RegisteredExtensionAuthority::Capability(_) => "external network access cannot be enforced by the local process sandbox".into(),
    }
}

fn authority_digest_value(authority: &RegisteredExtensionAuthority) -> serde_json::Value {
    match authority {
        RegisteredExtensionAuthority::ReadOnlyLocal => json!({"type": "read_only_local"}),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalWrite {
            service,
            network_scopes,
            credential_reference,
            artifact_root,
        }) => {
            json!({"type":"external_write","service":service,"network_scopes":network_scopes,"credential_reference":credential_reference,"artifact_root":artifact_root})
        }
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ManagedStateWrite {
            resource,
        }) => json!({"type": "managed_state_write", "resource": resource}),
        RegisteredExtensionAuthority::Capability(ExtensionToolAuthority::ExternalRead {
            service,
            network_scopes,
            credential_reference,
        }) => json!({
            "type": "external_read",
            "service": service,
            "network_scopes": network_scopes,
            "credential_reference": credential_reference,
        }),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ExtensionToolCompositionError(String);

impl std::fmt::Display for ExtensionToolCompositionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ExtensionToolCompositionError {}

#[cfg(test)]
#[path = "extension_tools_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wait_tests.rs"]
mod wait_tests;
