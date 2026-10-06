//! Turn policy composition and approval-mode enforcement.
use crate::ActionPolicyService;
use crate::CoreError;
use ash_action_policy::ActionPolicyEngine;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::PermissionBypassGrant;
use ash_action_policy::ReviewFailurePolicy;
use ash_async_utils::CancellationToken;
use ash_protocol::ApprovalMode;
use std::sync::Arc;
/// Composes the policies used by one Turn execution environment.
///
/// Host actions use the base policy; isolated Code Mode controls use Core-owned authority.
/// The policy revision includes the configured reviewer. Core invokes that reviewer only after
/// an interactive decision in automatic review mode.
/// Host-owned factory; called once at Turn start, before any assessment can run.
pub type ApprovalReviewerFactory = Arc<
    dyn Fn(Arc<dyn crate::ModelService>) -> Result<ash_extension_api::ApprovalReviewer, CoreError>
        + Send
        + Sync,
>;

pub struct TurnActionPolicy {
    factory: Option<ApprovalReviewerFactory>,
    revision_identity: Option<String>,
    base: Arc<dyn ActionPolicyService>,
    reviewer: ash_extension_api::ApprovalReviewer,
}

impl TurnActionPolicy {
    pub fn new(
        base: Arc<dyn ActionPolicyService>,
        reviewer: ash_extension_api::ApprovalReviewer,
    ) -> Self {
        Self {
            base,
            reviewer,
            factory: None,
            revision_identity: None,
        }
    }
}

impl TurnActionPolicy {
    pub fn with_reviewer_factory(
        base: Arc<dyn ActionPolicyService>,
        factory: ApprovalReviewerFactory,
    ) -> Self {
        Self {
            base,
            reviewer: ash_extension_api::ApprovalReviewer::Unavailable,
            factory: Some(factory),
            revision_identity: Some("profile-review".into()),
        }
    }
}

impl ActionPolicyService for TurnActionPolicy {
    fn snapshot(
        &self,
        model: Arc<dyn crate::ModelService>,
    ) -> Result<Option<Arc<dyn ActionPolicyService>>, CoreError> {
        let Some(factory) = &self.factory else {
            return Ok(None);
        };
        Ok(Some(Arc::new(Self {
            base: self.base.clone(),
            reviewer: factory(model)?,
            factory: None,
            revision_identity: self.revision_identity.clone(),
        })))
    }

    fn revision(&self) -> String {
        let reviewer = self
            .revision_identity
            .as_deref()
            .unwrap_or_else(|| match &self.reviewer {
                ash_extension_api::ApprovalReviewer::Unavailable => "unavailable",
                ash_extension_api::ApprovalReviewer::Configured { identity, .. } => {
                    identity.as_str()
                }
            });
        format!(
            "{}:auto-review={reviewer}:isolated-controls=v1",
            self.base.revision()
        )
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        if request.provenance().source() == &ash_protocol::ActionSource::BuiltInTool
            && request.provenance().source_id() == "code-mode"
        {
            cancellation
                .check()
                .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
            let capabilities = ash_protocol::CapabilitySet::new([ash_protocol::Capability::new(
                ash_protocol::CapabilityKind::SystemConfiguration,
                "code-mode",
            )]);
            if request.action().kind() != &ash_protocol::ActionKind::SystemOperation
                || request.action().required_capabilities() != &capabilities
                || request.action_policy_revision().as_str() != self.revision()
                || !matches!(request.phase(), ash_protocol::ActionReviewPhase::Initial)
                || !matches!(
                    request.sandbox(),
                    ash_action_policy::SandboxCompatibility::NotApplicable { .. }
                )
            {
                return Err(CoreError::Policy(
                    "Code Mode control request exceeds its isolated runtime authority".into(),
                ));
            }
            // The runtime has no ambient host authority. Every nested tool re-enters its own policy.
            return Ok(ash_action_policy::ExecutionDecision::RunUnsandboxed {
                grant_id: ash_action_policy::GrantId::new("host-code-mode-control"),
            });
        }
        self.base.decide(request, cancellation)
    }

    fn review_approval(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<Option<ExecutionDecision>, CoreError> {
        let ash_extension_api::ApprovalReviewer::Configured { registry, .. } = &self.reviewer
        else {
            return Ok(None);
        };
        let engine = ActionPolicyEngine::with_no_exec_rules(
            request.action_policy_revision().clone(),
            RegistryReviewer(registry.clone()),
            ReviewFailurePolicy::AskUser,
        );
        let reviewed = engine
            .review_after_authoritative_ask_user(request, cancellation)
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(Some(reviewed))
    }
}

/// Evaluates an action under the Turn's frozen policy revision and approval mode.
///
/// Every execution path uses this operation before constructing Tool authorization. Host policies
/// cannot override the revision check or apply automatic review to a deterministic decision.
pub fn decide_turn_action(
    policy: &dyn ActionPolicyService,
    frozen_revision: &str,
    approval_mode: ApprovalMode,
    request: &ActionReviewRequest,
    cancellation: &CancellationToken,
) -> Result<ExecutionDecision, CoreError> {
    let current_revision = policy.revision();
    if current_revision != frozen_revision {
        return Err(CoreError::Policy(format!(
            "Turn policy revision changed from {frozen_revision} to {current_revision}; continuation requires explicit authorization"
        )));
    }
    let decision = policy.decide(request, cancellation)?;
    if !matches!(decision, ExecutionDecision::AskUser(_)) {
        return Ok(decision);
    }
    match approval_mode {
        ApprovalMode::Manual => Ok(decision),
        ApprovalMode::BypassPermissions => Ok(ExecutionDecision::RunWithPermissionBypass(
            PermissionBypassGrant::new(
                request.action().digest().clone(),
                request.action().required_capabilities().clone(),
                request.action_policy_revision().clone(),
            ),
        )),
        ApprovalMode::Auto => Ok(policy
            .review_approval(request, cancellation)?
            .unwrap_or(decision)),
    }
}

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

struct RegistryReviewer(Arc<ash_extension_api::ExtensionRegistry>);
impl ash_action_policy::ActionClassifier for RegistryReviewer {
    type Error = ash_extension_api::ExtensionError;
    fn classify(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ClassifierAssessment, Self::Error> {
        self.0.review(request, cancellation)
    }
}
