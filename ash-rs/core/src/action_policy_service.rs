use core_api::ActionPolicyService;
use crate::CoreError;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::CapabilityKind;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;
use ash_protocol::ActionApprovalCapability;
use ash_protocol::ActionApprovalCapabilityKind;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::SandboxDenialOutput;
use ash_protocol::ToolReplaySafety;

pub(crate) struct UnavailableActionPolicyService;

impl ActionPolicyService for UnavailableActionPolicyService {
    fn revision(&self) -> String {
        "unavailable-policy-v1".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Err(CoreError::Policy(
            "no action policy service is configured".into(),
        ))
    }
}

/// Converts a policy `AskUser` decision into an exact durable interaction payload.
///
/// The policy revision comes from the reviewed request rather than the client. The approval must
/// remain bound to the same digest and complete capability set or conversion fails closed.
pub fn durable_approval_request(
    reviewed: &ActionReviewRequest,
    approval: &ApprovalRequest,
) -> Result<ActionApprovalRequest, CoreError> {
    if approval.action_digest() != reviewed.action().digest()
        || approval.capabilities() != reviewed.action().required_capabilities()
    {
        return Err(CoreError::Policy(
            "approval request is not bound to the reviewed action".into(),
        ));
    }
    if approval.reason().trim().is_empty() {
        return Err(CoreError::Policy(
            "approval request reason must not be empty".into(),
        ));
    }
    if reviewed.action_policy_revision().as_str().trim().is_empty() {
        return Err(CoreError::Policy(
            "approval policy revision must not be empty".into(),
        ));
    }
    let capabilities = approval
        .capabilities()
        .iter()
        .map(protocol_capability)
        .collect::<Vec<_>>();
    if capabilities.is_empty() {
        return Err(CoreError::Policy(
            "approval request must contain at least one capability".into(),
        ));
    }
    if capabilities
        .iter()
        .any(|capability| capability.scope.trim().is_empty())
    {
        return Err(CoreError::Policy(
            "approval capability scope must not be empty".into(),
        ));
    }
    Ok(ActionApprovalRequest {
        action_digest: reviewed.action().digest().as_str().to_owned(),
        policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
        capabilities,
        reason: approval.reason().to_owned(),
        sandbox_denial: None,
    })
}

pub(crate) fn durable_sandbox_escalation_approval_request(
    reviewed: &ActionReviewRequest,
    approval: &ApprovalRequest,
    denial: SandboxDenialOutput,
) -> Result<ActionApprovalRequest, CoreError> {
    if denial.replay_safety() != ToolReplaySafety::SafeToRetry || denial.reason().trim().is_empty()
    {
        return Err(CoreError::Policy(
            "sandbox escalation approval requires a safe-to-retry denial".into(),
        ));
    }
    let mut request = durable_approval_request(reviewed, approval)?;
    request.sandbox_denial = Some(denial);
    Ok(request)
}

pub(crate) fn approval_matches_review(
    approval: &ActionApprovalRequest,
    reviewed: &ActionReviewRequest,
) -> bool {
    approval.action_digest == reviewed.action().digest().as_str()
        && approval.policy_revision == reviewed.action_policy_revision().as_str()
        && approval.capabilities
            == reviewed
                .action()
                .required_capabilities()
                .iter()
                .map(protocol_capability)
                .collect::<Vec<_>>()
}

fn protocol_capability(capability: &ash_action_policy::Capability) -> ActionApprovalCapability {
    ActionApprovalCapability {
        kind: match capability.kind() {
            CapabilityKind::FileRead => ActionApprovalCapabilityKind::FileRead,
            CapabilityKind::FileWrite => ActionApprovalCapabilityKind::FileWrite,
            CapabilityKind::ProcessSpawn => ActionApprovalCapabilityKind::ProcessSpawn,
            CapabilityKind::Network => ActionApprovalCapabilityKind::Network,
            CapabilityKind::CredentialUse => ActionApprovalCapabilityKind::CredentialUse,
            CapabilityKind::ExternalMutation => ActionApprovalCapabilityKind::ExternalMutation,
            CapabilityKind::SystemConfiguration => {
                ActionApprovalCapabilityKind::SystemConfiguration
            }
            CapabilityKind::UserInterface => ActionApprovalCapabilityKind::UserInterface,
        },
        scope: capability.scope().to_owned(),
    }
}

#[cfg(test)]
#[path = "action_policy_service_tests.rs"]
mod tests;
