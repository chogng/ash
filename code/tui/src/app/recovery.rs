use ash_app_server_client::ConnectionCloseReason;

use crate::TuiConnectionLossKind;
use crate::TuiExit;
use crate::TuiRecoveryDrafts;
use crate::TuiRecoveryState;
use crate::client::ClientEvent;

pub(super) fn continue_or_exit(
    event: ClientEvent,
    state: impl FnOnce() -> (Option<TuiRecoveryState>, TuiRecoveryDrafts),
) -> Result<ClientEvent, TuiExit> {
    match event {
        ClientEvent::ConnectionClosed(reason) => {
            let (recovery, drafts) = state();
            Err(TuiExit::ConnectionLost {
                kind: connection_loss_kind(&reason),
                recovery,
                drafts,
                reason: format!("App Server connection closed: {reason:?}"),
            })
        }
        event => Ok(event),
    }
}

fn connection_loss_kind(reason: &ConnectionCloseReason) -> TuiConnectionLossKind {
    match reason {
        ConnectionCloseReason::DriverStopped => TuiConnectionLossKind::Transport,
        ConnectionCloseReason::Shutdown => TuiConnectionLossKind::ServerShutdown,
        ConnectionCloseReason::ProtocolFailure(_) => TuiConnectionLossKind::Protocol,
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
