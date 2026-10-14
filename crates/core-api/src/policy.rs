use crate::CoreError;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;

/// Supplies project-bound background after action preparation. Implementations must resolve the
/// exact Thread's directory authority, recheck provenance, and never turn observations into grants.
pub trait ReviewEnvironmentService: Send + Sync {
    fn evidence(
        &self,
        thread: &ash_protocol::ThreadId,
        request: &ActionReviewRequest,
    ) -> Result<Vec<ash_protocol::ReviewEvidence>, CoreError>;
}

/// Durable caller facts needed to scope temporary grants and reused approvals.
pub struct ActionPolicyContext<'a> {
    pub session: &'a ash_protocol::SessionId,
    pub thread: &'a ash_protocol::ThreadId,
    pub turn: &'a ash_protocol::TurnId,
}

/// Whether recording an explicit user decision changed durable permission policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalRecordEffect {
    Recorded,
    PolicyChanged,
}

/// Evaluates one fully resolved action without executing it or mutating durable Thread state.
///
/// Implementations own the authoritative policy decision. Core checks the Turn's frozen revision
/// and applies its approval mode. `AskUser` is a request for interaction, never authorization.
pub trait ActionPolicyService: Send + Sync {
    /// Freezes model-backed review dependencies at Turn start; permission checks remain live.
    fn snapshot(
        &self,
        _: std::sync::Arc<dyn crate::ModelService>,
    ) -> Result<Option<std::sync::Arc<dyn ActionPolicyService>>, CoreError> {
        Ok(None)
    }

    /// Returns the current immutable policy-environment revision at a Turn safe point.
    fn revision(&self) -> String;

    /// Resolves the revision of the policy that owns this provenance. Hosts that compose
    /// independent policies must freeze the owner's revision before preparing an action.
    fn revision_for(&self, _: &ash_protocol::ActionProvenance) -> String {
        self.revision()
    }

    /// Supplies current host permission facts to both model context and action review.
    fn permission_context(
        &self,
        _: &ash_protocol::SessionId,
        _: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_protocol::ReviewEvidence>, CoreError> {
        Ok(Vec::new())
    }

    /// Checks host-enforced approval-mode ceilings before any action can enter that mode.
    fn check_approval_mode(&self, _: ash_protocol::ApprovalMode) -> Result<(), CoreError> {
        Ok(())
    }

    fn approval_decisions(
        &self,
        _: &ActionReviewRequest,
    ) -> Vec<ash_protocol::ActionApprovalDecision> {
        vec![
            ash_protocol::ActionApprovalDecision::ApproveOnce,
            ash_protocol::ActionApprovalDecision::Decline,
        ]
    }

    /// Records only a matched, durable user response; automated review cannot call this port.
    fn record_approval(
        &self,
        _: &ActionPolicyContext<'_>,
        _: &ActionReviewRequest,
        decision: ash_protocol::ActionApprovalDecision,
    ) -> Result<ApprovalRecordEffect, CoreError> {
        match decision {
            ash_protocol::ActionApprovalDecision::ApproveOnce
            | ash_protocol::ActionApprovalDecision::Decline => Ok(ApprovalRecordEffect::Recorded),
            ash_protocol::ActionApprovalDecision::ApproveForSession
            | ash_protocol::ActionApprovalDecision::ApproveAndSaveRule => Err(CoreError::Policy(
                "this host does not support reusable approvals".into(),
            )),
        }
    }

    /// Rechecks hard constraints immediately before I/O, including after an approval wait.
    fn validate_execution(
        &self,
        _: &ActionReviewRequest,
        _: ash_protocol::ToolExecutionAuthority,
        _: &CancellationToken,
    ) -> Result<(), CoreError> {
        Ok(())
    }

    fn decide_in_context(
        &self,
        _: &ActionPolicyContext<'_>,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        self.decide(request, cancellation)
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError>;

    /// Reviews an authoritative `AskUser` result when Core selects automatic review.
    ///
    /// Return `None` when no reviewer is configured. A configured reviewer must bind its decision
    /// to the supplied request and observe cancellation. Core owns whether review may be invoked.
    fn review_approval(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<Option<ExecutionDecision>, CoreError> {
        Ok(None)
    }
}
