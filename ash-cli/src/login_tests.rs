use super::*;
use ash_app_server_client::ConnectionCloseReason;
use ash_app_server_protocol::protocol::account::AccountLoginCompleted;
use ash_app_server_protocol::protocol::account::AccountLoginFailureDto;

fn completion(id: &str, status: AccountLoginCompletionStatusDto) -> AppServerEvent {
    AppServerEvent::Notification(ServerNotification::AccountLoginCompleted(
        AccountLoginCompleted {
            login_id: id.into(),
            status,
            account: AccountReadResult {
                revision: 7,
                accounts: Vec::new(),
            },
        },
    ))
}

#[test]
fn only_the_requested_login_can_complete_the_command() {
    assert!(
        completed_login(
            completion("other", AccountLoginCompletionStatusDto::Succeeded),
            "selected"
        )
        .unwrap()
        .is_none()
    );
    let account = completed_login(
        completion("selected", AccountLoginCompletionStatusDto::Succeeded),
        "selected",
    )
    .unwrap()
    .unwrap();
    assert_eq!(account.revision, 7);
}

#[test]
fn login_failure_and_connection_loss_cannot_report_success() {
    let error = completed_login(
        completion(
            "selected",
            AccountLoginCompletionStatusDto::Failed {
                failure: AccountLoginFailureDto {
                    code: "denied".into(),
                    message: "authorization denied".into(),
                },
            },
        ),
        "selected",
    )
    .unwrap_err();
    assert_eq!(error.exit_code, 1);
    assert!(error.message.contains("denied"));
    assert!(
        completed_login(
            AppServerEvent::ConnectionClosed(ConnectionCloseReason::DriverStopped),
            "selected"
        )
        .is_err()
    );
}
