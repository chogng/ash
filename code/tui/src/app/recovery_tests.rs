use ash_app_server_client::ConnectionCloseReason;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

use super::continue_or_exit;
use crate::TuiConnectionLossKind;
use crate::TuiExit;
use crate::client::ClientEvent;

#[test]
fn connection_loss_returns_only_durable_identity_and_diagnostic() {
    let session_id = SessionId::new("session-recovery").unwrap();
    let thread_id = ThreadId::new("thread-recovery").unwrap();

    let exit = continue_or_exit(
        ClientEvent::ConnectionClosed(ConnectionCloseReason::DriverStopped),
        || {
            (
                Some(crate::TuiRecoveryState::new(
                    session_id.clone(),
                    thread_id.clone(),
                )),
                crate::TuiRecoveryDrafts::default(),
            )
        },
    )
    .unwrap_err();

    let TuiExit::ConnectionLost {
        kind,
        recovery,
        drafts,
        reason,
    } = exit
    else {
        panic!("expected connection loss");
    };
    assert_eq!(kind, TuiConnectionLossKind::Transport);
    assert_eq!(recovery.as_ref().unwrap().session_id(), &session_id);
    assert_eq!(recovery.as_ref().unwrap().thread_id(), &thread_id);
    assert_eq!(drafts, crate::TuiRecoveryDrafts::default());
    assert_eq!(reason, "App Server connection closed: DriverStopped");
}

#[test]
fn protocol_failure_remains_terminally_classified() {
    let session_id = SessionId::new("session-recovery").unwrap();
    let thread_id = ThreadId::new("thread-recovery").unwrap();

    let exit = continue_or_exit(
        ClientEvent::ConnectionClosed(ConnectionCloseReason::ProtocolFailure(
            "malformed frame".into(),
        )),
        || {
            (
                Some(crate::TuiRecoveryState::new(
                    session_id.clone(),
                    thread_id.clone(),
                )),
                crate::TuiRecoveryDrafts::default(),
            )
        },
    )
    .unwrap_err();

    assert!(matches!(
        exit,
        TuiExit::ConnectionLost {
            kind: TuiConnectionLossKind::Protocol,
            ..
        }
    ));
}

#[test]
fn home_connection_loss_has_no_invented_conversation_identity() {
    let exit = continue_or_exit(
        ClientEvent::ConnectionClosed(ConnectionCloseReason::DriverStopped),
        || (None, crate::TuiRecoveryDrafts::default()),
    )
    .unwrap_err();
    assert!(matches!(
        exit,
        TuiExit::ConnectionLost {
            kind: TuiConnectionLossKind::Transport,
            recovery: None,
            ..
        }
    ));
}
