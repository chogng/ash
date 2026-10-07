use super::ThreadController;
use crate::CoreError;
use ash_protocol::CollaborationMode;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::TurnInstructions;
use ash_protocol::TurnKind;
use ash_protocol::TurnStatus;

/// An Agent may change its approach, but only a user decision can release analysis restrictions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModeChangeAuthority {
    Agent,
    User,
}

/// The expected mode binds a user decision to the state in which it was requested.
pub struct ChangeTurnModeRequest {
    pub expected_mode: CollaborationMode,
    pub mode: CollaborationMode,
    pub mode_instructions: TurnInstructions,
    pub authority: ModeChangeAuthority,
}

pub struct ChangeTurnModeResult {
    pub sequence: u64,
    pub mode: CollaborationMode,
    pub changed: bool,
}

impl ThreadController {
    /// Commits an approach change at a tool boundary. Permission, model, role and tool ceilings
    /// remain unchanged; the next model invocation consumes the newly committed instructions.
    pub fn change_turn_mode(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request: ChangeTurnModeRequest,
    ) -> Result<ChangeTurnModeResult, CoreError> {
        request
            .mode_instructions
            .validate()
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        self.mutate_thread(thread_id, |snapshot| {
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            if turn.status != TurnStatus::Running || turn.kind != TurnKind::Coding {
                return Err(CoreError::Policy(
                    "mode changes require a running coding Turn".into(),
                ));
            }
            if turn.mode != request.expected_mode {
                return Err(CoreError::Policy(
                    "the Turn mode changed while the switch was pending".into(),
                ));
            }
            if turn.mode == request.mode {
                return Ok(ChangeTurnModeResult {
                    sequence: snapshot.sequence,
                    mode: turn.mode,
                    changed: false,
                });
            }
            if turn.mode.is_analysis()
                && !request.mode.is_analysis()
                && request.authority != ModeChangeAuthority::User
            {
                return Err(CoreError::Policy(
                    "leaving Plan or Ask requires a user decision".into(),
                ));
            }
            let instructions = turn
                .instructions
                .as_ref()
                .ok_or_else(|| {
                    CoreError::Policy("mode changes require frozen Turn instructions".into())
                })?
                .clone()
                .with_mode(&request.mode_instructions);
            self.record_batch(
                snapshot,
                vec![ThreadEvent::TurnModeChanged {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    from_mode: request.expected_mode,
                    mode: request.mode,
                    instructions,
                }],
            )?;
            Ok(ChangeTurnModeResult {
                sequence: snapshot.sequence,
                mode: request.mode,
                changed: true,
            })
        })
    }
}

#[cfg(test)]
#[path = "mode_tests.rs"]
mod tests;
