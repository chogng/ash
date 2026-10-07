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
