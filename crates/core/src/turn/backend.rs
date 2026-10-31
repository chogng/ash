use crate::CoreError;
use crate::ThreadController;
use crate::ThreadUpdateSink;
use ash_protocol::CommandId;
use ash_protocol::StableTurnError;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;

/// Executes an already-created durable Turn without owning Thread persistence.
///
/// [`crate::TurnExecutor`] owns the production model/tool loop. Product hosts may wrap it with a
/// stable local handle while rebuilding environment-scoped services, but model providers and OAuth
/// drivers must not implement or replace this port. Core remains the authority for Thread state,
/// interactions, cancellation, and terminal outcomes.
pub trait TurnExecutionBackend: Send + Sync {
    /// Accepts a newly created running Turn for asynchronous execution.
    fn start(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError>;

    /// Continues a running Turn after a durable interaction response or recovery decision.
    fn resume(&self, thread_id: &ThreadId, turn_id: &TurnId) -> Result<(), CoreError>;

    /// Delivers one already-durable steering command to the active execution runtime.
    ///
    /// The local executor may treat this as a wake-free acknowledgement because every model safe
    /// point reads the canonical Thread snapshot.
    fn steer(
        &self,
        _: &ThreadId,
        _: &TurnId,
        _: &CommandId,
        _: &[UserInput],
    ) -> Result<(), CoreError> {
        Err(CoreError::Execution(
            "Turn execution backend does not support steering".into(),
        ))
    }
}

/// Returns whether recovered work was accepted for execution. A rejected Turn must have a
/// durable terminal state before the recovery batch can continue; storage failures still abort it.
pub(crate) fn recover_dispatch(
    threads: &ThreadController,
    updates: &dyn ThreadUpdateSink,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    result: Result<(), CoreError>,
) -> Result<bool, CoreError> {
    if let Err(error) = result {
        let snapshot = threads.read_thread(thread_id)?;
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .ok_or(error)?;
        if !matches!(
            turn.status,
            TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
        ) {
            threads.fail_turn(
                thread_id,
                turn_id,
                StableTurnError::model_invocation_failed(),
            )?;
            for update in threads.thread_updates_after(thread_id, snapshot.sequence)? {
                updates.publish(update);
            }
        }
        return Ok(false);
    }
    Ok(true)
}
