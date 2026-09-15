use crate::CoreError;
use ash_action_policy::ActionClassifier;
use ash_action_policy::ActionPolicyEngine;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::PermissionBypassGrant;
use ash_async_utils::CancellationToken;
use ash_protocol::ApprovalMode;

/// Evaluates one fully resolved action without executing it or mutating durable Thread state.
///
/// Implementations must return only the final decision produced for the supplied immutable policy
/// request. `AskUser` remains a request for durable interaction; it is never authorization.
pub trait ActionPolicyService: Send + Sync {
    /// Returns the current immutable policy-environment revision at a Turn safe point.
    fn revision(&self) -> String;

    /// Evaluates under a Turn's durable policy ceiling.
    ///
    /// A changed policy environment fails closed by default. Implementations that can prove a
    /// newer revision is no wider may override this method and apply the stricter decision.
    fn decide_for_turn(
        &self,
        frozen_revision: &str,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        let current_revision = self.revision();
        if current_revision != frozen_revision {
            return Err(CoreError::Policy(format!(
                "Turn policy revision changed from {frozen_revision} to {current_revision}; continuation requires explicit authorization"
            )));
        }
        self.decide(request, cancellation)
    }

    /// Applies one Turn's frozen approval ceiling after the owning policy evaluates the action.
    ///
    /// Permission bypass converts only an interactive approval result. Deterministic blocks,
    /// invalid requests, revision mismatches, sandbox execution, and other policy decisions remain
    /// unchanged. Implementations with an automatic reviewer may override this method to replace
    /// `AskUser` in [`ApprovalMode::AutoReview`] while retaining the same fail-closed boundary.
    fn decide_for_turn_with_approval_mode(
        &self,
        frozen_revision: &str,
        approval_mode: ApprovalMode,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        let decision = self.decide_for_turn(frozen_revision, request, cancellation)?;
        if approval_mode == ApprovalMode::BypassPermissions
            && matches!(decision, ExecutionDecision::AskUser(_))
        {
            return Ok(ExecutionDecision::RunWithPermissionBypass(
                PermissionBypassGrant::new(
                    request.action().digest().clone(),
                    request.action().required_capabilities().clone(),
                    request.action_policy_revision().clone(),
                ),
            ));
        }
        Ok(decision)
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError>;
}

impl<C: ActionClassifier> ActionPolicyService for ActionPolicyEngine<C> {
    fn revision(&self) -> String {
        ActionPolicyEngine::revision(self).as_str().to_owned()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        ActionPolicyEngine::decide(self, request, cancellation)
            .map_err(|error| CoreError::Policy(error.to_string()))
    }
}
