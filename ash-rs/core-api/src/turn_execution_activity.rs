/// Supplies host resources held only while a Turn's model and Tool work is executing.
///
/// Core drops the returned scope on completion, error, interruption, unwinding, or when it yields
/// execution for approval or a missing capability. Synchronous interactions inside a running Tool
/// retain the scope. Resumption acquires a new scope. Implementations must support concurrent
/// Thread workers. This boundary cannot veto execution or mutate durable Turn state.
pub trait TurnExecutionActivity: Send + Sync {
    /// Returns a resource scope, or `None` when the host resource is unavailable.
    fn enter(&self) -> Option<Box<dyn Send>>;
}
