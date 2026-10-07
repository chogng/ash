use crate::CoreError;
use ash_protocol::TurnStatus;

pub(crate) fn transition_turn_status(
    current: TurnStatus,
    next: TurnStatus,
) -> Result<TurnStatus, CoreError> {
    let allowed = matches!(
        (current, next),
        (
            TurnStatus::Created,
            TurnStatus::Running | TurnStatus::Cancelling
        ) | (
            TurnStatus::Running,
            TurnStatus::WaitingForApproval
                | TurnStatus::WaitingForUserInput
                | TurnStatus::WaitingForCapability
                | TurnStatus::Completed
                | TurnStatus::Failed
                | TurnStatus::Cancelling
        ) | (
            TurnStatus::WaitingForApproval
                | TurnStatus::WaitingForUserInput
                | TurnStatus::WaitingForCapability,
            TurnStatus::Running | TurnStatus::Cancelling
        ) | (TurnStatus::Cancelling, TurnStatus::Interrupted)
    );
    if allowed {
        Ok(next)
    } else {
        Err(CoreError::InvalidTransition {
            from: format!("{current:?}"),
            to: format!("{next:?}"),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ItemStatus {
    Created,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

impl ItemStatus {
    pub fn transition(self, next: Self) -> Result<Self, CoreError> {
        let allowed = matches!(
            (self, next),
            (Self::Created, Self::InProgress)
                | (
                    Self::InProgress,
                    Self::Completed | Self::Failed | Self::Cancelled
                )
        );
        if allowed {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                from: format!("{self:?}"),
                to: format!("{next:?}"),
            })
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolCallStatus {
    Proposed,
    AwaitingApproval,
    Running,
    Succeeded,
    Failed,
    Declined,
    Cancelled,
}

impl ToolCallStatus {
    pub fn transition(self, next: Self) -> Result<Self, CoreError> {
        let allowed = matches!(
            (self, next),
            (Self::Proposed, Self::AwaitingApproval | Self::Running)
                | (
                    Self::AwaitingApproval,
                    Self::Running | Self::Declined | Self::Cancelled
                )
                | (
                    Self::Running,
                    Self::Succeeded | Self::Failed | Self::Cancelled
                )
        );
        if allowed {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                from: format!("{self:?}"),
                to: format!("{next:?}"),
            })
        }
    }
}
