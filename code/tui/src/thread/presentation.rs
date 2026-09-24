use ash_protocol::StableTurnError;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::ThreadItem;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TurnActivity {
    Starting,
    Working,
    WaitingForApproval,
    WaitingForUserInput,
    WaitingForCapability,
    Cancelling,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ActiveTurnUpdate {
    ActivityChanged(TurnActivity),
    Completed,
    Failed,
    FailureReported(String),
    Interrupted,
    Unchanged,
}

pub(crate) fn evaluate_active_turn(
    active_turn: &mut Option<TurnId>,
    turns: &[Turn],
) -> ActiveTurnUpdate {
    let Some(turn_id) = active_turn.as_ref() else {
        return ActiveTurnUpdate::Unchanged;
    };
    let Some(turn) = turns.iter().find(|turn| &turn.turn_id == turn_id) else {
        return ActiveTurnUpdate::Unchanged;
    };

    match turn.status {
        TurnStatus::Completed => {
            *active_turn = None;
            if turn
                .items
                .iter()
                .any(|item| matches!(item, ThreadItem::AgentMessage { .. }))
            {
                ActiveTurnUpdate::Completed
            } else {
                ActiveTurnUpdate::FailureReported("turn completed without an agent message".into())
            }
        }
        TurnStatus::Failed => {
            *active_turn = None;
            ActiveTurnUpdate::Failed
        }
        TurnStatus::Interrupted => {
            *active_turn = None;
            ActiveTurnUpdate::Interrupted
        }
        TurnStatus::WaitingForApproval => {
            ActiveTurnUpdate::ActivityChanged(TurnActivity::WaitingForApproval)
        }
        TurnStatus::WaitingForUserInput => {
            ActiveTurnUpdate::ActivityChanged(TurnActivity::WaitingForUserInput)
        }
        TurnStatus::WaitingForCapability => {
            ActiveTurnUpdate::ActivityChanged(TurnActivity::WaitingForCapability)
        }
        TurnStatus::Created => ActiveTurnUpdate::ActivityChanged(TurnActivity::Starting),
        TurnStatus::Running => ActiveTurnUpdate::ActivityChanged(TurnActivity::Working),
        TurnStatus::Cancelling => ActiveTurnUpdate::ActivityChanged(TurnActivity::Cancelling),
    }
}

pub(crate) fn recover_active_turn(turns: &[Turn]) -> Option<TurnId> {
    turns
        .iter()
        .find(|turn| {
            matches!(
                turn.status,
                TurnStatus::Created
                    | TurnStatus::Running
                    | TurnStatus::WaitingForApproval
                    | TurnStatus::WaitingForUserInput
                    | TurnStatus::WaitingForCapability
                    | TurnStatus::Cancelling
            )
        })
        .map(|turn| turn.turn_id.clone())
}

pub(crate) fn present_turn_error(error: &StableTurnError) -> String {
    match error.code {
        StableTurnErrorCode::ModelConfiguration => {
            "Check your provider and model configuration in /config.".into()
        }
        StableTurnErrorCode::ProviderCredentials => {
            "Credentials unavailable. Check your provider credentials in /config.".into()
        }
        StableTurnErrorCode::RateLimited => "Too many requests (429). Try again later.".into(),
        StableTurnErrorCode::ConnectionFailed => {
            "Could not connect to the provider. Check your network and service address.".into()
        }
        StableTurnErrorCode::ProviderUnavailable => "Provider is busy. Try again later.".into(),
        StableTurnErrorCode::ProviderHttp => match error.http_status {
            Some(status) => {
                let action = if error.retryable {
                    "Try again later."
                } else {
                    "Check your provider and model in /config."
                };
                format!("Provider request failed ({status}). {action}")
            }
            None => "Provider request failed.".into(),
        },
        StableTurnErrorCode::ModelInvocationFailed => "Request failed. Try again.".into(),
        StableTurnErrorCode::ContextOverflow => {
            "The conversation is too large for the configured model. Compact the context or start \
             a new thread, then try again."
                .into()
        }
        StableTurnErrorCode::ProviderAuth => {
            let status = error
                .http_status
                .map(|status| format!(" ({status})"))
                .unwrap_or_default();
            format!("Authentication failed{status}. Check your provider credentials in /config.")
        }
        StableTurnErrorCode::InvalidRequest => {
            "The model rejected this request as invalid. Adjust the request or model settings, then \
             try again."
                .into()
        }
        StableTurnErrorCode::InvalidResponse => {
            "The model returned a response Ash couldn't process. Please try again.".into()
        }
        StableTurnErrorCode::CompletionPersistenceFailed => {
            "Ash generated a response but couldn't save it. Please try again.".into()
        }
        StableTurnErrorCode::InteractionDeadlineElapsed => {
            "The approval or input request expired before it received a response. Please try the \
             request again."
                .into()
        }
        StableTurnErrorCode::ToolRepetition => {
            "Ash stopped after the same tool call failed repeatedly. Review the tool output or \
             change the request before retrying."
                .into()
        }
        StableTurnErrorCode::WorktreeCaptureFailed => {
            "Ash could not capture the worktree state needed to track this Turn's changes."
                .into()
        }
        StableTurnErrorCode::UsageLimited => {
            "The model provider's usage limit was reached. Check the provider account or try again later."
                .into()
        }
    }
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;
