use crate::CoreError;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;

/// Evaluates one fully resolved action without executing it or mutating durable Thread state.
///
/// Implementations own the authoritative policy decision. Core checks the Turn's frozen revision
/// and applies its approval mode. `AskUser` is a request for interaction, never authorization.
pub trait ActionPolicyService: Send + Sync {
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
