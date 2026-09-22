use super::*;

fn version(modified_at_millis: u64) -> TextFileDiskVersion {
    TextFileDiskVersion::new(
        4,
        TextFileModifiedAt::KnownMillis(modified_at_millis),
        TextFileAccess::Writable,
    )
}

fn snapshot(path: &str, content: &str, modified_at_millis: u64) -> TextFileSnapshot {
    TextFileSnapshot::new(path.into(), content.into(), version(modified_at_millis))
}

#[test]
fn dirty_text_produces_an_optimistic_save_request() {
    let mut lifecycle = TextFileLifecycle::new(snapshot("src/main.rs", "base", 1));

    assert_eq!(lifecycle.status("base"), TextFileStatus::Clean);
    let request = lifecycle.save_request("changed").unwrap();
    assert_eq!(request.path(), Path::new("src/main.rs"));
    assert_eq!(request.content(), "changed");
    assert_eq!(request.expected_version(), version(1));

    lifecycle.mark_saved("changed", version(2));
    assert_eq!(lifecycle.status("changed"), TextFileStatus::Clean);
}

#[test]
fn read_only_snapshots_never_produce_save_requests() {
    let snapshot = TextFileSnapshot::new(
        "generated.rs".into(),
        "base".into(),
        TextFileDiskVersion::new(
            4,
            TextFileModifiedAt::KnownMillis(1),
            TextFileAccess::ReadOnly,
        ),
    );
    let lifecycle = TextFileLifecycle::new(snapshot);

    assert!(lifecycle.is_read_only());
    assert_eq!(lifecycle.save_request("changed"), None);
}

#[test]
fn external_snapshots_distinguish_reload_from_conflict() {
    let mut lifecycle = TextFileLifecycle::new(snapshot("data.json", "base", 1));

    assert_eq!(
        lifecycle.observe_external("base", snapshot("data.json", "disk", 2)),
        TextFileObserveResult::ReloadAvailable
    );
    assert_eq!(lifecycle.status("base"), TextFileStatus::ReloadAvailable);
    assert_eq!(lifecycle.status("edited"), TextFileStatus::Conflict);
    assert_eq!(lifecycle.take_pending_external().unwrap().content(), "disk");
}

#[test]
fn explicit_overwrite_uses_the_observed_external_version() {
    let mut lifecycle = TextFileLifecycle::new(snapshot("data.json", "base", 1));
    assert_eq!(
        lifecycle.observe_external("local", snapshot("data.json", "disk", 2)),
        TextFileObserveResult::ReloadAvailable
    );

    let request = lifecycle.overwrite_request("local").unwrap();

    assert_eq!(request.content(), "local");
    assert_eq!(request.expected_version(), version(2));
    assert_eq!(lifecycle.status("local"), TextFileStatus::Conflict);
}

#[test]
fn matching_external_text_advances_the_baseline() {
    let mut lifecycle = TextFileLifecycle::new(snapshot("notes.txt", "base", 1));

    assert_eq!(
        lifecycle.observe_external("edited", snapshot("notes.txt", "edited", 2)),
        TextFileObserveResult::Synchronized
    );
    assert_eq!(lifecycle.status("edited"), TextFileStatus::Clean);
}

#[test]
fn snapshot_for_another_path_is_rejected_without_changing_state() {
    let mut lifecycle = TextFileLifecycle::new(snapshot("a.txt", "base", 1));

    assert_eq!(
        lifecycle.observe_external("base", snapshot("b.txt", "other", 2)),
        TextFileObserveResult::PathMismatch
    );
    assert_eq!(lifecycle.status("base"), TextFileStatus::Clean);
    assert_eq!(lifecycle.take_pending_external(), None);
}
