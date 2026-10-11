use super::*;

#[test]
fn coalescing_ignore_hints_invalidates_all_affected_paths() {
    let updates = GitUpdates::default();
    for path in ["first.txt", "second.txt"] {
        updates.publish_git_ignore_changed(GitIgnoreChanged {
            repository_id: "repository".into(),
            paths: vec![path.into()],
        });
    }
    let events = updates.drain();
    assert!(
        matches!(events.as_slice(), [GitProviderEvent::IgnoreChanged(change)] if change.paths.is_empty())
    );
}

#[test]
fn queue_overflow_requests_status_and_ignore_resynchronization() {
    let updates = GitUpdates::default();
    for id in 0..4097 {
        updates.publish_git_ignore_changed(GitIgnoreChanged {
            repository_id: id.to_string(),
            paths: vec!["file.txt".into()],
        });
    }
    assert!(matches!(
        updates.drain().first(),
        Some(GitProviderEvent::Resynchronize)
    ));
}
