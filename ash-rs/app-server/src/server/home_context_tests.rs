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
        selected_instructions: &[],
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

#[test]
fn home_context_loads_only_the_pinned_user_on_demand_instruction() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("instructions")).unwrap();
    let path = dir.path().join("instructions/manual.md");
    fs::write(
        &path,
        "---\nname: manual\nload: on-demand\n---\n\nPersonal manual rule.\n",
    )
    .unwrap();
    let home = Arc::new(AshHome::new(
        AbsolutePathBuf::from_absolute(dir.path()).unwrap(),
    ));
    let entry = home.instructions().entries()[0].clone();
    let reference = ash_protocol::InstructionRef {
        source: ash_protocol::InstructionSource::User,
        relative_path: entry.relative_path().to_path_buf(),
        digest: ash_protocol::ContentDigest::sha256(entry.body().as_bytes()),
    };
    let provider = HomeContext::new(home);
    let session_id = SessionId::new("session").unwrap();
    let thread_id = ThreadId::new("thread").unwrap();
    let turn_id = TurnId::new("turn").unwrap();
    let request = HarnessContextRequest {
        session_id: &session_id,
        thread_id: &thread_id,
        turn_id: &turn_id,
        read_paths: &[],
        selected_instructions: std::slice::from_ref(&reference),
    };
    let selected = provider.snapshot(&request).unwrap();
    assert!(
        selected
            .instructions()
            .user_instructions()
            .unwrap()
            .contains("Personal manual rule.")
    );

    fs::write(
        &path,
        "---\nname: manual\nload: on-demand\n---\n\nChanged manual rule.\n",
    )
    .unwrap();
    assert!(provider.snapshot(&request).is_err());
}
