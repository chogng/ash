use crate::HookRunEvidence;
use ash_protocol::ModelInvocationId;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;

/// ModelService boundaries; these do not count physical provider requests or retries.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InferencePurpose {
    Agent,
    Compaction,
    Tool,
}

/// Execution identities sampled by the owner before invoking ModelService.
#[derive(Clone, Debug)]
pub struct InferenceContext {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub source_thread_sequence: u64,
    pub model: Option<ModelRef>,
    pub purpose: InferencePurpose,
}

/// Receipt published only after the accounting event has committed to Thread history.
#[derive(Clone, Debug)]
pub struct ModelInvocationReceipt {
    pub invocation_id: ModelInvocationId,
    pub sequence: u64,
}

/// Optional observations, independent of authorization, checkpointing and execution decisions.
/// Implementations must bound retained input and return without waiting for storage or workers.
/// `None` declines capture without copying or serializing the request. Failures stay diagnostic.
pub trait ExecutionDiagnostics: Send + Sync {
    fn start_attempt(
        &self,
        context: InferenceContext,
        request: &ModelRequest,
    ) -> Option<Box<dyn ModelAttemptObserver>>;

    fn record_hook(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
        turn_id: Option<&TurnId>,
        run_id: &str,
        evidence: &HookRunEvidence,
    );
}

/// One admitted attempt. Terminal callbacks are idempotent; dropping an unfinished observer
/// records abandonment. Accounting may arrive after the model's terminal observation.
pub trait ModelAttemptObserver: Send {
    fn prepared_request(&mut self, request: &ModelRequest);
    fn output(&mut self, event: &ModelStreamEvent);
    fn complete(&mut self, response: &ModelResponse);
    fn fail(&mut self, error: &str);
    fn cancel(&mut self, reason: &str);
    fn accounted(&mut self, receipt: &ModelInvocationReceipt);
}
