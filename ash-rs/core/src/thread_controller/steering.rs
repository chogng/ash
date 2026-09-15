use super::BatchCommand;
use super::SteerTurnDisposition;
use super::SteerTurnRequest;
use super::SteerTurnResult;
use super::ThreadController;
use super::user_input;
use crate::CoreError;
use crate::ThreadCommandResult;
use ash_history::ThreadCommandReceipt;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;

impl ThreadController {
    /// Atomically appends ordered user input to an active Turn through a retry-safe command.
    pub fn steer_turn(
        &self,
        thread_id: &ThreadId,
        request: SteerTurnRequest,
    ) -> Result<SteerTurnResult, CoreError> {
        super::validate_command_id(&request.command_id)?;
        if request
            .input
            .iter()
            .any(|input| matches!(input, UserInput::Skill { .. }))
        {
            return Err(CoreError::InvalidInput(
                "Turn steering cannot change the frozen Skill selection".into(),
            ));
        }
        let input = user_input::normalize_attachments(&request.input, &self.attachments)?;
        let validated = user_input::validate(&input, &[])?;
        let command = ThreadCommand::SteerTurn {
            turn_id: request.turn_id.clone(),
            input: input.clone(),
        };
        self.mutate_thread(thread_id, |snapshot| {
            if let Some(existing) = snapshot
                .commands
                .iter()
                .find(|existing| existing.receipt.command_id == request.command_id)
            {
                if existing.receipt.command != command {
                    return Err(CoreError::CommandConflict);
                }
                if !matches!(
                    &existing.result,
                    ThreadCommandResult::TurnSteered { turn_id }
                        if turn_id == &request.turn_id
                ) {
                    return Err(CoreError::Journal(
                        "steer-Turn command has an invalid result".into(),
                    ));
                }
                return Ok(SteerTurnResult {
                    sequence: existing.response_sequence,
                    disposition: SteerTurnDisposition::Replayed,
                });
            }
            super::validate_thread_expectation(request.expected_sequence, snapshot.sequence)?;
            let status = snapshot
                .turns
                .iter()
                .find(|turn| turn.turn_id == request.turn_id)
                .map(|turn| turn.status)
                .ok_or_else(|| CoreError::NotFound(request.turn_id.to_string()))?;
            if !matches!(
                status,
                TurnStatus::Running
                    | TurnStatus::WaitingForApproval
                    | TurnStatus::WaitingForUserInput
            ) {
                return Err(CoreError::InvalidInput(format!(
                    "cannot steer a {status:?} Turn"
                )));
            }
            let items = user_input::thread_items(&validated, &request.turn_id, || {
                ash_protocol::ItemId::new(self.next_identifier("item"))
                    .expect("generated Item ID is non-empty")
            });
            let item_ids = items
                .iter()
                .map(|item| item.item_id().clone())
                .collect::<Vec<_>>();
            let mut events = items
                .into_iter()
                .map(|item| ThreadEvent::ItemCompleted {
                    checkpoint_after_sequence: None,
                    workspace_checkpoint: None,
                    thread_id: thread_id.clone(),
                    turn_id: request.turn_id.clone(),
                    item,
                })
                .collect::<Vec<_>>();
            events.push(ThreadEvent::TurnSteered {
                thread_id: thread_id.clone(),
                turn_id: request.turn_id.clone(),
                item_ids,
            });
            let command_event_index = events.len() - 1;
            let (next_snapshot, batch) = self.project_batch(
                Some(snapshot.clone()),
                thread_id,
                events,
                BatchCommand::AtEvent {
                    index: command_event_index,
                    receipt: ThreadCommandReceipt {
                        command_id: request.command_id,
                        command,
                    },
                },
            )?;
            self.commit_batch(&batch)?;
            *snapshot = next_snapshot;
            Ok(SteerTurnResult {
                sequence: snapshot.sequence,
                disposition: SteerTurnDisposition::Steered,
            })
        })
    }

    /// Records that the selected execution backend accepted one already-durable steer command.
    pub fn mark_turn_steer_delivered(
        &self,
        thread_id: &ThreadId,
        turn_id: &ash_protocol::TurnId,
        command_id: &ash_protocol::CommandId,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(thread_id, |snapshot| {
            if let Some(sequence) = snapshot.steer_deliveries.get(command_id) {
                return Ok(*sequence);
            }
            if !snapshot.commands.iter().any(|command| {
                command.receipt.command_id == *command_id
                    && matches!(
                        &command.result,
                        ThreadCommandResult::TurnSteered {
                            turn_id: command_turn_id,
                        } if command_turn_id == turn_id
                    )
            }) {
                return Err(CoreError::InvalidInput(
                    "Turn steer delivery does not match an accepted command".into(),
                ));
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::TurnSteerDelivered {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    command_id: command_id.clone(),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }
}
