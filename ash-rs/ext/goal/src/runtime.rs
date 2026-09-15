use extension_api::ExtensionTurn;
use protocol::CommandId;
use protocol::SessionId;
use protocol::ThreadCommand;
use protocol::ThreadId;
use protocol::TurnId;
use protocol::TurnStatus;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Weak;
use core_api::CoreError;
use ash_core::StartGoalTurnRequest;
use ash_core::ThreadController;

pub(crate) struct GoalExtension {
    threads: Weak<ThreadController>,
}
impl GoalExtension {
    pub(crate) fn new(threads: &Arc<ThreadController>) -> Self {
        Self {
            threads: Arc::downgrade(threads),
        }
    }
    pub(crate) fn threads(&self) -> Result<Arc<ThreadController>, CoreError> {
        self.threads
            .upgrade()
            .ok_or_else(|| CoreError::Execution("Goal Thread owner has stopped".into()))
    }
    /// Starts the next hidden model Turn after a completed answer when the Goal is still active.
    ///
    /// The command ID is derived from the completed Turn, making the boundary idempotent across
    /// duplicate completion callbacks and recovery. A user-created Turn that wins the race is
    /// allowed to suppress this continuation; its eventual completion will evaluate the Goal
    /// again.
    fn next(
        &self,
        thread_id: &ThreadId,
        completed_turn_id: &TurnId,
    ) -> Result<Option<ExtensionTurn>, CoreError> {
        let threads = self.threads()?;
        let snapshot = threads.read_thread(thread_id)?;
        if !snapshot
            .goal
            .as_ref()
            .is_some_and(|goal| goal.status.is_active())
        {
            return Ok(None);
        }
        let Some(completed_turn) = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == completed_turn_id)
            .filter(|turn| turn.status == TurnStatus::Completed)
        else {
            return Ok(None);
        };
        if completed_turn.kind == protocol::TurnKind::Review {
            return Ok(None);
        }
        let command_id = CommandId::new(format!("goal_continue_{}", completed_turn.turn_id))
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let Some(start) = threads.start_goal_turn(
            thread_id,
            StartGoalTurnRequest {
                command_id,
                model: completed_turn.model.clone(),
                instructions: completed_turn.instructions.clone().ok_or_else(|| {
                    CoreError::Context(format!(
                        "completed Turn {} has no frozen instructions",
                        completed_turn.turn_id
                    ))
                })?,
                policy_revision: completed_turn.policy_revision.clone(),
                approval_mode: completed_turn.approval_mode,
                tool_mode: completed_turn.tool_mode,
                tool_profile: completed_turn.tool_profile.clone(),
            },
        )?
        else {
            return Ok(None);
        };
        if start.disposition == ash_core::StartTurnDisposition::Created {
            return Ok(Some(ExtensionTurn {
                thread_id: thread_id.clone(),
                turn_id: start.turn_id,
            }));
        }
        Ok(None)
    }

    /// Starts an idle continuation for every recovered active Goal owned by the supplied Sessions.
    ///
    /// Completed Turns and Goal state are already durable, so this pass is safe to repeat after a
    /// restart. The Thread mutation gate suppresses a duplicate when another executor wins the
    /// completion-to-continuation race first.
    fn recover(&self, session_ids: &BTreeSet<SessionId>) -> Result<Vec<ExtensionTurn>, CoreError> {
        let threads = self.threads()?;
        let mut resumed = Vec::new();
        for snapshot in threads.list_loaded_threads()? {
            if !session_ids.contains(&snapshot.session_id) {
                continue;
            }
            if let Some(running_goal_turn) = snapshot.turns.iter().find(|turn| {
                turn.status == TurnStatus::Running
                    && is_goal_continuation_turn(&snapshot, &turn.turn_id)
            }) {
                resumed.push(ExtensionTurn {
                    thread_id: snapshot.thread_id.clone(),
                    turn_id: running_goal_turn.turn_id.clone(),
                });
                continue;
            }
            let Some(completed_turn) = snapshot
                .turns
                .iter()
                .rev()
                .find(|turn| turn.status == TurnStatus::Completed)
            else {
                continue;
            };
            if let Some(turn) = self.next(&snapshot.thread_id, &completed_turn.turn_id)? {
                resumed.push(turn);
            }
        }
        Ok(resumed)
    }
}
fn is_goal_continuation_turn(snapshot: &ash_core::ThreadSnapshot, turn_id: &TurnId) -> bool {
    snapshot.commands.iter().any(|command| {
        matches!(
            (&command.receipt.command, &command.result),
            (
                ThreadCommand::StartTurn { input, .. },
                ash_core::ThreadCommandResult::TurnAccepted { turn_id: command_turn_id },
            ) if command_turn_id == turn_id && input.is_empty()
        )
    })
}

impl extension_api::ContinuationContributor for GoalExtension {
    fn next_turn(
        &self,
        thread: &ThreadId,
        completed: &TurnId,
    ) -> Result<Option<ExtensionTurn>, extension_api::ExtensionError> {
        self.next(thread, completed)
            .map_err(|error| extension_api::ExtensionError::new(error.to_string()))
    }
    fn recover(
        &self,
        sessions: &BTreeSet<SessionId>,
    ) -> Result<Vec<ExtensionTurn>, extension_api::ExtensionError> {
        self.recover(sessions)
            .map_err(|error| extension_api::ExtensionError::new(error.to_string()))
    }
}
