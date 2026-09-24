use std::path::PathBuf;

use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;

use super::session_tab_input;

#[test]
fn session_input_keeps_primary_and_additional_directories_in_display_order() {
    let session = Session {
        session_id: SessionId::new("session-dirs").unwrap(),
        title: "Release summary".to_owned(),
        status: SessionStatus::Active,
        manager: SessionManagerInfo {
            status: SessionManagerStatus::NeedsInput,
            ..Default::default()
        },
        threads: Vec::new(),
    };

    let input = session_tab_input(
        &session,
        [
            PathBuf::from("/workspace/ash"),
            PathBuf::from("/workspace/docs"),
            PathBuf::from("/workspace/ash"),
        ],
    );

    assert_eq!(input.title(), "Release summary");
    assert_eq!(input.status().kind(), SessionManagerStatus::NeedsInput);
    assert_eq!(input.status().label(), "Needs input");
    assert_eq!(
        input.dirs(),
        [
            PathBuf::from("/workspace/ash"),
            PathBuf::from("/workspace/docs"),
        ]
    );
}
