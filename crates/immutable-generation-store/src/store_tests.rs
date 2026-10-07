use super::ExpectedCurrent;
use super::GenerationFile;
use super::ImmutableGenerationStore;
use super::PublishError;
use super::PublishOutcome;
use super::PublishStage;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

const ABORT_STAGE_ENV: &str = "ASH_IMMUTABLE_STORE_ABORT_STAGE";
const CHILD_CONTENT_ENV: &str = "ASH_IMMUTABLE_STORE_CHILD_CONTENT";
const CHILD_READY_ENV: &str = "ASH_IMMUTABLE_STORE_CHILD_READY";
const CHILD_RELEASE_ENV: &str = "ASH_IMMUTABLE_STORE_CHILD_RELEASE";
const CHILD_RESULT_ENV: &str = "ASH_IMMUTABLE_STORE_CHILD_RESULT";
const CHILD_ROOT_ENV: &str = "ASH_IMMUTABLE_STORE_CHILD_ROOT";
const CHILD_START_ENV: &str = "ASH_IMMUTABLE_STORE_CHILD_START";

#[test]
fn changed_file_input_is_rejected_before_staged_data_can_commit() {
    let directory = tempfile::tempdir().unwrap();
    let store = ImmutableGenerationStore::open(directory.path()).unwrap();
    let source = tempfile::NamedTempFile::new().unwrap();
    fs::write(source.path(), b"original bytes").unwrap();
    let files = [GenerationFile::from_file("base", source.as_file())];
    let next = super::Manifest {
        snapshot: 1,
        base: 1,
        previous: None,
        content_digest: super::publication_digest(
            super::PublicationKind::Base,
            ExpectedCurrent::Empty,
            1,
            1,
            &files,
            &[],
        )
        .unwrap(),
    };
    fs::write(source.path(), b"modified bytes").unwrap();
    let base = store
        .write_generation_directory(store.pending_base(1), &files)
        .unwrap();
    let layer = store
        .write_generation_directory(store.pending_layer(1), &[])
        .unwrap();
    let error = super::verify_staged_digest(
        super::PublicationKind::Base,
        ExpectedCurrent::Empty,
        next,
        &base,
        &layer,
        &files,
        &[],
    )
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn file_sources_publish_with_the_same_digest_as_bytes_and_keep_their_cursor() {
    use std::io::Seek;
    use std::io::SeekFrom;
    let directory = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let contents = (0..700_000).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    let path = source.path().join("prepared");
    fs::write(&path, &contents).unwrap();
    let mut file = fs::File::open(&path).unwrap();
    file.seek(SeekFrom::Start(73)).unwrap();
    let store = ImmutableGenerationStore::open(directory.path()).unwrap();
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::from_file("base", &file)],
            &[GenerationFile::new("delta", b"initial")],
        )
        .unwrap();
    assert_eq!(file.stream_position().unwrap(), 73);
    assert_eq!(
        store
            .open_current()
            .unwrap()
            .unwrap()
            .read_base("base")
            .unwrap(),
        contents
    );
    let retry = store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("base", &contents)],
            &[GenerationFile::new("delta", b"initial")],
        )
        .unwrap();
    assert!(matches!(retry.outcome, PublishOutcome::AlreadyPublished));
    store
        .publish_layer(
            ExpectedCurrent::Snapshot(1),
            2,
            &[GenerationFile::from_file("delta", &file)],
        )
        .unwrap();
    assert_eq!(
        store
            .open_current()
            .unwrap()
            .unwrap()
            .read_layer("delta")
            .unwrap(),
        contents
    );
}

#[test]
fn unreadable_file_source_does_not_advance_the_generation() {
    let directory = tempfile::tempdir().unwrap();
    let store = ImmutableGenerationStore::open(directory.path()).unwrap();
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("base", b"old")],
            &[],
        )
        .unwrap();
    let source = tempfile::NamedTempFile::new().unwrap();
    let write_only = fs::OpenOptions::new()
        .write(true)
        .open(source.path())
        .unwrap();
    fs::write(source.path(), b"cannot read through this handle").unwrap();
    assert!(
        store
            .publish_base(
                ExpectedCurrent::Snapshot(1),
                2,
                &[GenerationFile::from_file("base", &write_only)],
                &[]
            )
            .is_err()
    );
    assert_eq!(store.open_current().unwrap().unwrap().generation(), 1);
}

#[test]
fn publishes_and_reads_a_consistent_base_and_layer_snapshot() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    let report = store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"lookup one")],
            &[GenerationFile::new("delta.bin", b"delta one")],
        )
        .expect("publish base");
    assert!(matches!(report.outcome, PublishOutcome::Published));
    assert!(report.cleanup_error.is_none());

    let snapshot = store
        .open_current()
        .expect("read snapshot")
        .expect("published snapshot");
    assert_eq!(snapshot.generation(), 1);
    assert_eq!(snapshot.base_generation(), 1);
    let lookup = snapshot.open_base("lookup.bin").expect("open lookup");
    let mut bytes = vec![0; lookup.length().unwrap() as usize];
    lookup
        .read_exact_at(0, &mut bytes)
        .expect("positioned read");

    assert_eq!(bytes, b"lookup one");
    assert_eq!(snapshot.read_layer("delta.bin").unwrap(), b"delta one");
}

#[test]
fn layer_publication_reuses_the_immutable_base() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            4,
            &[GenerationFile::new("lookup.bin", b"base four")],
            &[GenerationFile::new("delta.bin", b"delta four")],
        )
        .expect("publish base");
    store
        .publish_layer(
            ExpectedCurrent::Snapshot(4),
            5,
            &[GenerationFile::new("delta.bin", b"delta five")],
        )
        .expect("publish layer");

    let snapshot = store.open_current().unwrap().unwrap();
    assert_eq!(snapshot.generation(), 5);
    assert_eq!(snapshot.base_generation(), 4);
    assert_eq!(snapshot.read_base("lookup.bin").unwrap(), b"base four");
    assert_eq!(snapshot.read_layer("delta.bin").unwrap(), b"delta five");
}

#[test]
fn identical_publication_is_idempotent_but_different_content_conflicts() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    let base = [GenerationFile::new("lookup.bin", b"same lookup")];
    let layer = [GenerationFile::new("delta.bin", b"same delta")];
    store
        .publish_base(ExpectedCurrent::Empty, 7, &base, &layer)
        .expect("first publication");

    let retry = store
        .publish_base(ExpectedCurrent::Empty, 7, &base, &layer)
        .expect("idempotent retry");
    assert!(matches!(retry.outcome, PublishOutcome::AlreadyPublished));

    let wrong_precondition = store
        .publish_base(ExpectedCurrent::Snapshot(6), 7, &base, &layer)
        .unwrap_err();
    assert!(matches!(
        wrong_precondition,
        PublishError::Conflict { current: Some(7) }
    ));

    let conflict = store
        .publish_base(
            ExpectedCurrent::Empty,
            7,
            &[GenerationFile::new("lookup.bin", b"different lookup")],
            &layer,
        )
        .unwrap_err();
    assert!(matches!(
        conflict,
        PublishError::Conflict { current: Some(7) }
    ));
}

#[test]
fn compare_and_set_prevents_lost_updates() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"lookup")],
            &[GenerationFile::new("delta.bin", b"first")],
        )
        .expect("base");
    store
        .publish_layer(
            ExpectedCurrent::Snapshot(1),
            2,
            &[GenerationFile::new("delta.bin", b"writer one")],
        )
        .expect("first writer");

    let second_writer = store
        .publish_layer(
            ExpectedCurrent::Snapshot(1),
            3,
            &[GenerationFile::new("delta.bin", b"writer two")],
        )
        .unwrap_err();
    assert!(matches!(
        second_writer,
        PublishError::Conflict { current: Some(2) }
    ));
}

#[test]
fn open_reader_keeps_an_old_base_until_its_lease_is_dropped() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"old lookup")],
            &[GenerationFile::new("delta.bin", b"old delta")],
        )
        .expect("old base");
    let old_reader = store
        .open_current()
        .unwrap()
        .unwrap()
        .open_base("lookup.bin")
        .unwrap();

    store
        .publish_base(
            ExpectedCurrent::Snapshot(1),
            2,
            &[GenerationFile::new("lookup.bin", b"new lookup")],
            &[GenerationFile::new("delta.bin", b"new delta")],
        )
        .expect("new base");

    let mut bytes = vec![0; old_reader.length().unwrap() as usize];
    old_reader.read_exact_at(0, &mut bytes).unwrap();
    assert_eq!(bytes, b"old lookup");
    assert!(directory.path().join("bases/00000000000000000001").exists());
    drop(old_reader);
    store.cleanup_stale().expect("cleanup");
    assert!(!directory.path().join("bases/00000000000000000001").exists());
}

#[test]
fn multiple_readers_keep_an_old_base_until_every_lease_is_dropped() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"old lookup")],
            &[GenerationFile::new("delta.bin", b"old delta")],
        )
        .expect("old base");
    let first_reader = store.open_current().unwrap().unwrap();
    let second_reader = store.open_current().unwrap().unwrap();

    let report = store
        .publish_base(
            ExpectedCurrent::Snapshot(1),
            2,
            &[GenerationFile::new("lookup.bin", b"new lookup")],
            &[GenerationFile::new("delta.bin", b"new delta")],
        )
        .expect("new base");

    assert!(report.cleanup_error.is_none());
    assert!(directory.path().join("bases/00000000000000000001").exists());
    drop(first_reader);
    store.cleanup_stale().expect("first cleanup");
    assert!(directory.path().join("bases/00000000000000000001").exists());
    drop(second_reader);
    store.cleanup_stale().expect("second cleanup");
    assert!(!directory.path().join("bases/00000000000000000001").exists());
}

#[test]
fn cleanup_removes_manifest_before_unleased_data() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"old")],
            &[GenerationFile::new("delta.bin", b"old")],
        )
        .expect("old");
    let old_snapshot = store.open_current().unwrap().unwrap();
    store
        .publish_base(
            ExpectedCurrent::Snapshot(1),
            2,
            &[GenerationFile::new("lookup.bin", b"new")],
            &[GenerationFile::new("delta.bin", b"new")],
        )
        .expect("new");
    assert!(
        directory
            .path()
            .join("manifests/00000000000000000001.manifest")
            .exists()
    );

    drop(old_snapshot);
    let cleanup = store.cleanup_stale().expect("cleanup");
    assert_eq!(cleanup.manifests_removed, 1);
    assert!(
        !directory
            .path()
            .join("manifests/00000000000000000001.manifest")
            .exists()
    );
    assert!(
        !directory
            .path()
            .join("layers/00000000000000000001")
            .exists()
    );
}

#[test]
fn incomplete_directories_do_not_become_current() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    let pending = directory.path().join("bases/.pending-00000000000000000001");
    fs::create_dir(&pending).expect("pending directory");
    fs::write(pending.join("lookup.bin"), b"incomplete").expect("pending file");

    assert!(store.open_current().unwrap().is_none());
}

#[test]
fn a_newer_directory_without_a_manifest_does_not_replace_the_current_snapshot() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"published")],
            &[GenerationFile::new("delta.bin", b"published delta")],
        )
        .expect("published base");
    let orphan = directory.path().join("layers/00000000000000000002");
    fs::create_dir(&orphan).expect("orphan layer");
    fs::write(orphan.join(".lease"), []).expect("orphan lease");
    fs::write(orphan.join("delta.bin"), b"not published").expect("orphan delta");

    let snapshot = store.open_current().unwrap().unwrap();
    assert_eq!(snapshot.generation(), 1);
    assert_eq!(
        snapshot.read_layer("delta.bin").unwrap(),
        b"published delta"
    );
}

#[test]
fn empty_files_support_positioned_reads() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("empty.bin", b"")],
            &[GenerationFile::new("delta.bin", b"delta")],
        )
        .expect("base");
    let snapshot = store.open_current().unwrap().unwrap();
    let empty = snapshot.open_base("empty.bin").unwrap();

    assert_eq!(empty.length().unwrap(), 0);
    empty.read_exact_at(0, &mut []).unwrap();
}

#[test]
fn retries_a_generation_left_unpublished_after_interruption() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    let orphan = directory.path().join("bases/00000000000000000001");
    fs::create_dir(&orphan).expect("orphan base");
    fs::write(orphan.join(".lease"), []).expect("orphan lease");
    fs::write(orphan.join("lookup.bin"), b"partial").expect("orphan lookup");

    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"complete")],
            &[GenerationFile::new("delta.bin", b"delta")],
        )
        .expect("retry publication");

    let snapshot = store.open_current().unwrap().unwrap();
    assert_eq!(snapshot.read_base("lookup.bin").unwrap(), b"complete");
}

#[test]
fn rejects_unsafe_file_names_before_commit() {
    let directory = tempfile::tempdir().expect("store directory");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    let error = store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("../lookup.bin", b"escaped")],
            &[GenerationFile::new("delta.bin", b"delta")],
        )
        .unwrap_err();

    assert!(matches!(
        error,
        PublishError::BeforeCommit { source }
            if source.kind() == std::io::ErrorKind::InvalidInput
    ));
}

#[test]
fn process_abort_recovery_matches_the_typed_publish_stages() {
    for stage in [
        PublishStage::GenerationWritten,
        PublishStage::GenerationSynced,
        PublishStage::PendingManifestWritten,
        PublishStage::PendingManifestSynced,
        PublishStage::ManifestRenamed,
        PublishStage::ManifestDirectorySynced,
    ] {
        let directory = tempfile::tempdir().expect("store directory");
        let status = helper_command("store::tests::publication_abort_child")
            .env(CHILD_ROOT_ENV, directory.path())
            .env(ABORT_STAGE_ENV, stage.name())
            .status()
            .expect("abort child");
        assert!(!status.success(), "{stage:?} must abort the child");

        let store = ImmutableGenerationStore::open(directory.path()).expect("reopen store");
        let current = store.open_current().expect("open current");
        if matches!(
            stage,
            PublishStage::ManifestRenamed | PublishStage::ManifestDirectorySynced
        ) {
            assert_eq!(current.expect("committed snapshot").generation(), 1);
        } else {
            assert!(current.is_none(), "{stage:?} committed too early");
        }
    }

    // process::abort verifies process-crash recovery only. It cannot model lost device caches or
    // prove that a rename survives machine power loss before the manifest-directory sync.
}

#[test]
fn publication_abort_child() {
    let Some(root) = std::env::var_os(CHILD_ROOT_ENV) else {
        return;
    };
    let store = ImmutableGenerationStore::open(root).expect("child store");
    let _ = store.publish_base(
        ExpectedCurrent::Empty,
        1,
        &[GenerationFile::new("lookup.bin", b"lookup")],
        &[GenerationFile::new("delta.bin", b"delta")],
    );
}

#[test]
fn a_cross_process_lease_keeps_the_old_generation_alive() {
    let directory = tempfile::tempdir().expect("store directory");
    let coordination = tempfile::tempdir().expect("coordination directory");
    let ready = coordination.path().join("ready");
    let release = coordination.path().join("release");
    let store = ImmutableGenerationStore::open(directory.path()).expect("store");
    store
        .publish_base(
            ExpectedCurrent::Empty,
            1,
            &[GenerationFile::new("lookup.bin", b"old")],
            &[GenerationFile::new("delta.bin", b"old")],
        )
        .expect("old generation");
    let mut child = helper_command("store::tests::lease_holder_child")
        .env(CHILD_ROOT_ENV, directory.path())
        .env(CHILD_READY_ENV, &ready)
        .env(CHILD_RELEASE_ENV, &release)
        .spawn()
        .expect("lease child");
    wait_for_path(&ready);

    store
        .publish_base(
            ExpectedCurrent::Snapshot(1),
            2,
            &[GenerationFile::new("lookup.bin", b"new")],
            &[GenerationFile::new("delta.bin", b"new")],
        )
        .expect("new generation");
    assert!(directory.path().join("bases/00000000000000000001").exists());

    fs::write(&release, []).expect("release child");
    assert!(child.wait().expect("wait child").success());
    store.cleanup_stale().expect("cleanup");
    assert!(!directory.path().join("bases/00000000000000000001").exists());
}

#[test]
fn lease_holder_child() {
    let Some(root) = std::env::var_os(CHILD_ROOT_ENV) else {
        return;
    };
    let ready = PathBuf::from(std::env::var_os(CHILD_READY_ENV).expect("ready path"));
    let release = PathBuf::from(std::env::var_os(CHILD_RELEASE_ENV).expect("release path"));
    let store = ImmutableGenerationStore::open(root).expect("child store");
    let _snapshot = store.open_current().unwrap().expect("current snapshot");
    fs::write(ready, []).expect("signal ready");
    wait_for_path(&release);
}

#[test]
fn same_generation_cross_process_writers_are_idempotent_or_conflicting_by_digest() {
    let identical = run_competing_publishers("same", "same");
    assert_eq!(identical, ["AlreadyPublished", "Published"]);

    let different = run_competing_publishers("first", "second");
    assert_eq!(different, ["Conflict", "Published"]);
}

#[test]
fn competing_publisher_child() {
    let Some(root) = std::env::var_os(CHILD_ROOT_ENV) else {
        return;
    };
    let ready = PathBuf::from(std::env::var_os(CHILD_READY_ENV).expect("ready path"));
    let start = PathBuf::from(std::env::var_os(CHILD_START_ENV).expect("start path"));
    let result = PathBuf::from(std::env::var_os(CHILD_RESULT_ENV).expect("result path"));
    let content = std::env::var(CHILD_CONTENT_ENV).expect("content");
    let store = ImmutableGenerationStore::open(root).expect("child store");
    fs::write(ready, []).expect("signal ready");
    wait_for_path(&start);
    let outcome = match store.publish_base(
        ExpectedCurrent::Empty,
        9,
        &[GenerationFile::new("lookup.bin", content.as_bytes())],
        &[GenerationFile::new("delta.bin", b"delta")],
    ) {
        Ok(report) if matches!(report.outcome, PublishOutcome::Published) => "Published",
        Ok(report) if matches!(report.outcome, PublishOutcome::AlreadyPublished) => {
            "AlreadyPublished"
        }
        Err(PublishError::Conflict { .. }) => "Conflict",
        other => panic!("unexpected publication result: {other:?}"),
    };
    fs::write(result, outcome).expect("write outcome");
}

fn run_competing_publishers(left: &str, right: &str) -> [&'static str; 2] {
    let directory = tempfile::tempdir().expect("store directory");
    let coordination = tempfile::tempdir().expect("coordination directory");
    let start = coordination.path().join("start");
    let mut children = Vec::new();
    for (index, content) in [left, right].into_iter().enumerate() {
        let ready = coordination.path().join(format!("ready-{index}"));
        let result = coordination.path().join(format!("result-{index}"));
        let child = helper_command("store::tests::competing_publisher_child")
            .env(CHILD_ROOT_ENV, directory.path())
            .env(CHILD_READY_ENV, &ready)
            .env(CHILD_START_ENV, &start)
            .env(CHILD_RESULT_ENV, &result)
            .env(CHILD_CONTENT_ENV, content)
            .spawn()
            .expect("publisher child");
        children.push((child, ready, result));
    }
    for (_, ready, _) in &children {
        wait_for_path(ready);
    }
    fs::write(&start, []).expect("start publishers");
    let mut outcomes = Vec::new();
    for (mut child, _, result) in children {
        assert!(child.wait().expect("wait publisher").success());
        outcomes.push(fs::read_to_string(result).expect("read outcome"));
    }
    outcomes.sort();
    outcomes
        .into_iter()
        .map(|outcome| match outcome.as_str() {
            "AlreadyPublished" => "AlreadyPublished",
            "Conflict" => "Conflict",
            "Published" => "Published",
            _ => panic!("unknown outcome"),
        })
        .collect::<Vec<_>>()
        .try_into()
        .expect("two outcomes")
}

fn helper_command(test: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
        .args(["--exact", test, "--nocapture"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn wait_for_path(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
