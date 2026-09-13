use super::*;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::fs;

#[test]
fn home_context_refreshes_global_instructions_without_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("instructions")).unwrap();
    let path = dir.path().join("instructions/user.md");
    fs::write(&path, "---\nname: user\nload: global\n---\n\nFirst.\n").unwrap();
    let home = Arc::new(AshHome::new(
        AbsolutePathBuf::from_absolute(dir.path()).unwrap(),
    ));
    let provider = HomeContext::new(home);
    let session_id = SessionId::new("session").unwrap();
    let thread_id = ThreadId::new("thread").unwrap();
    let turn_id = TurnId::new("turn").unwrap();
    let request = HarnessContextRequest {
        session_id: &session_id,
        thread_id: &thread_id,
        turn_id: &turn_id,
        read_paths: &[],
    };

    let first = provider.snapshot(&request).unwrap();
    assert!(
        first
            .instructions()
            .user_instructions()
            .unwrap()
            .contains("First.")
    );
    assert!(first.instructions().directory_instructions().is_none());

    fs::write(&path, "---\nname: user\nload: global\n---\n\nSecond.\n").unwrap();
    let second = provider.snapshot(&request).unwrap();
    assert!(
        second
            .instructions()
            .user_instructions()
            .unwrap()
            .contains("Second.")
    );
    assert_ne!(first.instructions(), second.instructions());
}
