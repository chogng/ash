use crate::ExecFailure;
use crate::ExecFinalOutput;
use crate::ExecInteractionKind;
use crate::ExecInterruptionReason;
use crate::ExecOutcome;
use crate::ExecRequiredInteraction;
use crate::ExecUnknownReason;
use crate::HeadlessApprovalMode;
use ash_protocol::ApprovalMode;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;

#[derive(Clone, Debug)]
pub(crate) enum InterruptIntent {
    CancellationRequested,
    TurnTimeout,
    RequiresInteraction(ExecRequiredInteraction),
}

pub(crate) fn terminal_outcome(
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn: &Turn,
    interrupt: Option<&InterruptIntent>,
) -> Option<ExecOutcome> {
    match turn.status {
        TurnStatus::Completed => {
            let output = turn
                .items
                .iter()
                .rev()
                .find_map(|item| match item {
                    ThreadItem::AgentMessage { text, .. } => {
                        Some(ExecFinalOutput::AgentMessage { text: text.clone() })
                    }
                    _ => None,
                })
                .unwrap_or(ExecFinalOutput::Empty);
            Some(ExecOutcome::Completed {
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                turn_id: turn.turn_id.clone(),
                output,
            })
        }
        TurnStatus::Failed => Some(ExecOutcome::Failed {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn.turn_id.clone(),
            failure: turn
                .error
                .clone()
                .map(|error| ExecFailure::Reported { error })
                .unwrap_or(ExecFailure::Unspecified),
        }),
        TurnStatus::Interrupted => Some(interrupted_outcome(
            session_id,
            thread_id,
            &turn.turn_id,
            interrupt,
        )),
        TurnStatus::Created
        | TurnStatus::Running
        | TurnStatus::WaitingForApproval
        | TurnStatus::WaitingForUserInput
        | TurnStatus::WaitingForCapability
        | TurnStatus::Cancelling => None,
    }
}

fn interrupted_outcome(
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    interrupt: Option<&InterruptIntent>,
) -> ExecOutcome {
    match interrupt {
        Some(InterruptIntent::RequiresInteraction(interaction)) => {
            ExecOutcome::RequiresInteraction {
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                interaction: interaction.clone(),
            }
        }
        Some(InterruptIntent::CancellationRequested) => ExecOutcome::Interrupted {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            reason: ExecInterruptionReason::CancellationRequested,
        },
        Some(InterruptIntent::TurnTimeout) => ExecOutcome::Interrupted {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            reason: ExecInterruptionReason::TurnTimeout,
        },
        None => ExecOutcome::Interrupted {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            reason: ExecInterruptionReason::External,
        },
    }
}

pub(crate) fn required_interaction(turn: &Turn) -> Option<ExecRequiredInteraction> {
    let waiting_requires_stop = match turn.status {
        // Automatic review finishes before Core creates a pending human interaction.
        // A headless client cannot resolve that interaction in any approval mode.
        TurnStatus::WaitingForApproval
        | TurnStatus::WaitingForUserInput
        | TurnStatus::WaitingForCapability => true,
        _ => false,
    };
    if !waiting_requires_stop {
        return None;
    }
    if let Some(pending) = &turn.pending_interaction {
        return Some(ExecRequiredInteraction {
            kind: pending.kind.clone().into(),
            request_id: Some(pending.request_id.clone()),
        });
    }
    let kind = match turn.status {
        TurnStatus::WaitingForApproval => ExecInteractionKind::Approval,
        TurnStatus::WaitingForUserInput => ExecInteractionKind::UserInput,
        TurnStatus::WaitingForCapability => ExecInteractionKind::Capability,
        _ => return None,
    };
    Some(ExecRequiredInteraction {
        kind,
        request_id: None,
    })
}

pub(crate) fn protocol_approval_mode(mode: HeadlessApprovalMode) -> ApprovalMode {
    match mode {
        HeadlessApprovalMode::DenyInteractiveRequests => ApprovalMode::Manual,
        HeadlessApprovalMode::AutomaticReview => ApprovalMode::Auto,
        HeadlessApprovalMode::BypassPermissions => ApprovalMode::BypassPermissions,
    }
}

pub(crate) fn unknown_outcome(
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    reason: ExecUnknownReason,
) -> ExecOutcome {
    ExecOutcome::OutcomeUnknown {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        reason,
    }
}
