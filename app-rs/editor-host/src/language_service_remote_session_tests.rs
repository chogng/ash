use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use ash_app_server_protocol::protocol::language::LanguageDocumentDto;
use ash_app_server_protocol::protocol::language::LanguageHoverParams;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;

use super::MAX_RECONNECT_DELAY;
use super::RECONNECT_WINDOW;
use super::RemoteLanguageCommand;
use super::RemoteLanguageEvent;
use super::RemoteLanguageSession;
use super::disconnected_event;
use super::reconnect_delay;
use super::reconnect_delay_within_window;

fn hover_params() -> LanguageHoverParams {
    LanguageHoverParams {
        document: LanguageDocumentDto {
            dir_id: None,
            session_directory: None,
            path: PathBuf::from("/dir/src/main.rs"),
            language_id: "rust".into(),
            revision: 4,
            text: "fn main() {}".into(),
        },
        position: LanguagePositionDto {
            line_index: 0,
            column_index: 3,
        },
    }
}

#[test]
fn remote_language_reconnect_backoff_is_bounded_by_one_window() {
    assert_eq!(reconnect_delay(0), Duration::from_millis(250));
    assert_eq!(reconnect_delay(3), Duration::from_secs(2));
    assert_eq!(reconnect_delay(32), MAX_RECONNECT_DELAY);
    assert_eq!(
        reconnect_delay_within_window(RECONNECT_WINDOW - Duration::from_millis(100), 0),
        None
    );
}

#[test]
fn remote_language_session_rejects_requests_until_connected() {
    let (commands, receiver) = mpsc::sync_channel(2);
    let available = Arc::new(AtomicBool::new(false));
    let closing = Arc::new(AtomicBool::new(false));
    let session = RemoteLanguageSession {
        available: Arc::clone(&available),
        closing,
        commands,
        next_request_id: AtomicU64::new(1),
        worker: None,
    };

    assert!(session.hover(hover_params()).is_err());
    assert!(receiver.try_recv().is_err());

    available.store(true, Ordering::Release);
    assert_eq!(session.hover(hover_params()).unwrap(), 2);
    assert!(matches!(
        receiver.recv().unwrap(),
        RemoteLanguageCommand::Hover { request_id: 2, .. }
    ));
}

#[test]
fn remote_language_reconnect_fails_queued_requests_instead_of_replaying_them() {
    let event = disconnected_event(RemoteLanguageCommand::Hover {
        request_id: 8,
        params: hover_params(),
    })
    .unwrap();

    assert!(matches!(
        event,
        RemoteLanguageEvent::RequestFailed { request_id: 8, .. }
    ));
}
