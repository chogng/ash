use std::path::Path;

use super::GitChangeFileComparison;
use super::GitConflictChoice;
use super::GitFileRevision;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test]
async fn versioned_index_baselines_share_inflight_reads_and_keep_working_contents_fresh() {
    #[derive(Debug, Default)]
    struct Observer(std::sync::Mutex<usize>);
    impl crate::GitProcessObserver for Observer {
        fn observe(&self, timing: crate::GitProcessTiming) {
            if matches!(timing.kind, crate::GitProcessKind::Show) {
                *self.0.lock().unwrap() += 1;
            }
        }
    }
    let repository = TestRepository::init();
    repository.write("tracked.txt", "head\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "index\n");
    repository.git(&["add", "."]);
    repository.write("tracked.txt", "working\n");
    let observer = std::sync::Arc::new(Observer::default());
    let client = GitClient::with_executable(
        GitClient::system().executable().unwrap(),
        crate::GitExecutionLimits::default(),
    )
    .unwrap()
    .with_process_observer(observer.clone());
    let opened = client.open_repository(repository.root()).await.unwrap();
    let path = Path::new("tracked.txt");
    let read = || client.read_file_at_revision(&opened, path, GitFileRevision::Index, 1024);
    let (first, second) = tokio::join!(read(), read());
    assert_eq!(first.unwrap().as_deref(), Some(b"index\n".as_slice()));
    assert_eq!(second.unwrap().as_deref(), Some(b"index\n".as_slice()));
    assert_eq!(*observer.0.lock().unwrap(), 1);
    read().await.unwrap();
    assert_eq!(*observer.0.lock().unwrap(), 1);
    repository.write("tracked.txt", "fresh working\n");
    let change = client
        .change_file_at_paths(&opened, path, path, GitChangeFileComparison::Unstaged, 1024)
        .await
        .unwrap();
    assert_eq!(change.original(), Some(b"index\n".as_slice()));
    assert_eq!(change.modified(), Some(b"fresh working\n".as_slice()));
    assert_eq!(*observer.0.lock().unwrap(), 1);
    // The caller's smaller output budget cannot reuse a larger successful reply.
    assert!(matches!(
        client
            .read_file_at_revision(&opened, path, GitFileRevision::Index, 3)
            .await,
        Err(crate::GitError::OutputLimitExceeded { .. })
    ));
}

#[tokio::test]
async fn shared_baselines_honor_each_clients_output_limit_without_charging_batch_headers() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base");
    repository.commit_all("initial");
    let owner = GitClient::system();
    let opened = owner.open_repository(repository.root()).await.unwrap();
    let path = Path::new("tracked.txt");
    owner
        .read_file_at_revision(&opened, path, GitFileRevision::Index, 1024)
        .await
        .unwrap();
    for (budget, fits) in [(4, true), (3, false)] {
        let limits = crate::GitExecutionLimits::new(
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(30),
            budget,
        )
        .unwrap();
        let client = GitClient::system()
            .with_limits(limits)
            .with_shared_reads(&owner);
        let result = client
            .read_file_at_revision(&opened, path, GitFileRevision::Index, 1024)
            .await;
        if fits {
            assert_eq!(result.unwrap().as_deref(), Some(b"base".as_slice()));
        } else {
            assert!(matches!(
                result,
                Err(crate::GitError::OutputLimitExceeded { .. })
            ));
        }
    }
}

#[tokio::test]
async fn baseline_version_observes_external_same_size_index_edits_with_restored_mtime() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "old\n");
    repository.commit_all("initial");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let path = Path::new("tracked.txt");
    let read = || client.read_file_at_revision(&opened, path, GitFileRevision::Index, 1024);
    assert_eq!(read().await.unwrap().as_deref(), Some(b"old\n".as_slice()));
    let index = opened.git_dir().join("index");
    let modified = std::fs::metadata(&index).unwrap().modified().unwrap();
    repository.write("tracked.txt", "new\n");
    repository.git(&["-c", "index.skipHash=true", "add", "tracked.txt"]);
    std::fs::File::options()
        .write(true)
        .open(&index)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(read().await.unwrap().as_deref(), Some(b"new\n".as_slice()));
    repository.git(&["update-index", "--split-index"]);
    assert_eq!(read().await.unwrap().as_deref(), Some(b"new\n".as_slice()));
    repository.write("tracked.txt", "end\n");
    repository.git(&["add", "tracked.txt"]);
    assert_eq!(read().await.unwrap().as_deref(), Some(b"end\n".as_slice()));
}

#[tokio::test]
async fn batch_reader_reuses_only_the_current_index_generation() {
    let repository = TestRepository::init();
    repository.write("first.txt", "first\n");
    repository.write("second.txt", "second\n");
    repository.commit_all("initial");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let first_version = super::index_version(&opened).unwrap();
    for (path, expected) in [
        ("first.txt", b"first\n".as_slice()),
        ("second.txt", b"second\n".as_slice()),
    ] {
        assert_eq!(
            client
                .read_index_batch(&opened, Path::new(path), first_version.clone(), 1024)
                .await
                .unwrap()
                .as_deref(),
            Some(expected)
        );
    }
    repository.write("first.txt", "updated\n");
    repository.git(&["add", "."]);
    assert!(matches!(
        client
            .read_index_batch(&opened, Path::new("first.txt"), first_version, 1024)
            .await,
        Err(crate::GitError::IndexChanged)
    ));
    let next_version = super::index_version(&opened).unwrap();
    assert_eq!(
        client
            .read_index_batch(&opened, Path::new("first.txt"), next_version, 1024)
            .await
            .unwrap()
            .as_deref(),
        Some(b"updated\n".as_slice())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_a_partial_batch_reply_discards_the_process_before_reuse() {
    use std::os::unix::fs::PermissionsExt;
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("initial");
    let original = GitClient::system();
    let opened = original.open_repository(repository.root()).await.unwrap();
    let version = super::index_version(&opened).unwrap();
    let scripts = tempfile::tempdir().unwrap();
    let started = scripts.path().join("started");
    let release = scripts.path().join("release");
    let executable = scripts.path().join("git");
    let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
    std::fs::write(&executable, format!(
        "#!/bin/sh\nfor arg do if [ \"$arg\" = --version ]; then exec {} \"$@\"; fi; done\nprintf 'start\\n' >> {}\nprintf '0000000000000000000000000000000000000000 blob 4\\n'\nwhile ! test -f {}; do sleep 0.01; done\nprintf 'new\\n\\n'\n",
        quote(&original.executable().unwrap()), quote(&started), quote(&release),
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client =
        GitClient::with_executable(executable, crate::GitExecutionLimits::default()).unwrap();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            client.read_index_batch(&opened, Path::new("tracked.txt"), version.clone(), 1024)
        )
        .await
        .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(&started).unwrap().lines().count(),
        1
    );
    std::fs::write(&release, "release").unwrap();
    assert_eq!(
        client
            .read_index_batch(&opened, Path::new("tracked.txt"), version, 1024)
            .await
            .unwrap()
            .as_deref(),
        Some(b"new\n".as_slice())
    );
    assert_eq!(std::fs::read_to_string(started).unwrap().lines().count(), 2);
}

#[tokio::test]
async fn reads_head_and_index_content_and_reports_missing_paths() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "head\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    repository.write("tracked.txt", "index\n");
    repository.git(&["add", "tracked.txt"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();

    assert_eq!(
        client
            .read_file_at_revision(
                &opened,
                Path::new("tracked.txt"),
                GitFileRevision::Head,
                1024,
            )
            .await
            .unwrap(),
        Some(b"head\n".to_vec())
    );
    assert_eq!(
        client
            .read_file_at_revision(
                &opened,
                Path::new("tracked.txt"),
                GitFileRevision::Index,
                1024,
            )
            .await
            .unwrap(),
        Some(b"index\n".to_vec())
    );
    assert_eq!(
        client
            .read_file_at_revision(
                &opened,
                Path::new("missing.txt"),
                GitFileRevision::Head,
                1024,
            )
            .await
            .unwrap(),
        None
    );
    let head = repository.git(&["rev-parse", "HEAD"]);
    let tree = client.resolve_tree(&opened, &head).await.unwrap();
    repository.write("tracked.txt", "later worktree\n");
    assert_eq!(
        client
            .read_file_at_tree(&opened, &tree, Path::new("tracked.txt"), 1024)
            .await
            .unwrap(),
        Some(b"head\n".to_vec())
    );
}

#[tokio::test]
async fn reads_staged_and_unstaged_change_sides_without_collapsing_the_index() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "head\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "index\n");
    repository.git(&["add", "tracked.txt"]);
    repository.write("tracked.txt", "worktree\n");

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client.snapshot(&opened).await.unwrap();
    let change = &snapshot.changes()[0];

    let staged = client
        .change_file(&opened, change, GitChangeFileComparison::Staged, 1024)
        .await
        .unwrap();
    assert_eq!(staged.original(), Some(b"head\n".as_slice()));
    assert_eq!(staged.modified(), Some(b"index\n".as_slice()));

    let unstaged = client
        .change_file(&opened, change, GitChangeFileComparison::Unstaged, 1024)
        .await
        .unwrap();
    assert_eq!(unstaged.original(), Some(b"index\n".as_slice()));
    assert_eq!(unstaged.modified(), Some(b"worktree\n".as_slice()));
}

#[tokio::test]
async fn reads_three_unmerged_index_stages_and_worktree_result() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    repository.git(&["switch", "-c", "topic"]);
    repository.write("tracked.txt", "incoming\n");
    repository.commit_all("incoming");
    repository.git(&["switch", "main"]);
    repository.write("tracked.txt", "current\n");
    repository.commit_all("current");
    let output = std::process::Command::new("git")
        .args(["merge", "topic"])
        .current_dir(repository.root())
        .output()
        .unwrap();
    assert!(!output.status.success());

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client.snapshot(&opened).await.unwrap();
    let change = snapshot
        .changes()
        .iter()
        .find(|change| change.path() == Path::new("tracked.txt"))
        .unwrap();
    let file = client.conflict_file(&opened, change, 1024).await.unwrap();
    assert_eq!(file.base(), Some(b"base\n".as_slice()));
    assert_eq!(file.current(), Some(b"current\n".as_slice()));
    assert_eq!(file.incoming(), Some(b"incoming\n".as_slice()));
    assert!(file.stage_ids().iter().all(Option::is_some));
    assert!(file.result().unwrap().starts_with(b"<<<<<<<"));
}

#[tokio::test]
async fn reads_deleted_stage_and_can_choose_deletion() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    repository.git(&["switch", "-c", "topic"]);
    repository.git(&["rm", "tracked.txt"]);
    repository.commit_all("delete");
    repository.git(&["switch", "main"]);
    repository.write("tracked.txt", "current\n");
    repository.commit_all("current");
    let output = std::process::Command::new("git")
        .args(["merge", "topic"])
        .current_dir(repository.root())
        .output()
        .unwrap();
    assert!(!output.status.success());

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client.snapshot(&opened).await.unwrap();
    let change = snapshot
        .changes()
        .iter()
        .find(|change| change.path() == Path::new("tracked.txt"))
        .unwrap();
    let file = client.conflict_file(&opened, change, 1024).await.unwrap();
    assert_eq!(file.current(), Some(b"current\n".as_slice()));
    assert_eq!(file.incoming(), None);
    assert_eq!(file.stage_ids()[2], None);
    client
        .choose_conflict_side(&opened, Path::new("tracked.txt"), GitConflictChoice::Delete)
        .await
        .unwrap();
    assert!(!repository.root().join("tracked.txt").exists());
    assert!(
        !client
            .snapshot(&opened)
            .await
            .unwrap()
            .changes()
            .iter()
            .any(|change| change.is_conflicted())
    );
}

#[tokio::test]
async fn text_diff_batch_reads_fresh_head_and_isolates_missing_and_oversized_blobs() {
    let repository = TestRepository::init();
    repository.write("space name.txt", "before\n");
    repository.write("中文.txt", "Unicode\n");
    repository.write("large.txt", &"x".repeat(128));
    repository.commit_all("initial");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let paths = [
        Path::new("space name.txt"),
        Path::new("missing.txt"),
        Path::new("large.txt"),
        Path::new("中文.txt"),
    ];
    let mut values = client
        .read_text_diff_bases(&opened, &paths, 32)
        .await
        .into_iter();
    assert_eq!(
        values.next().unwrap().unwrap().as_deref(),
        Some(b"before\n".as_slice())
    );
    assert!(values.next().unwrap().unwrap().is_none());
    assert!(matches!(
        values.next().unwrap(),
        Err(crate::GitError::OutputLimitExceeded { .. })
    ));
    assert_eq!(
        values.next().unwrap().unwrap().as_deref(),
        Some(b"Unicode\n".as_slice())
    );
    repository.write("space name.txt", "new HEAD\n");
    repository.commit_all("next");
    let values = client.read_text_diff_bases(&opened, &paths[..2], 32).await;
    assert_eq!(
        values[0].as_ref().unwrap().as_deref(),
        Some(b"new HEAD\n".as_slice())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn text_diff_batch_preserves_newline_filenames_and_falls_back_from_invalid_output() {
    use std::os::unix::fs::PermissionsExt;
    let repository = TestRepository::init();
    repository.write("line\nname.txt", "newline\n");
    repository.write("ordinary.txt", "ordinary\n");
    repository.commit_all("initial");
    let system = GitClient::system();
    let opened = system.open_repository(repository.root()).await.unwrap();
    let paths = [Path::new("line\nname.txt"), Path::new("ordinary.txt")];
    let values = system.read_text_diff_bases(&opened, &paths, 1024).await;
    assert_eq!(
        values[0].as_ref().unwrap().as_deref(),
        Some(b"newline\n".as_slice())
    );
    let scripts = tempfile::tempdir().unwrap();
    let executable = scripts.path().join("git");
    let log = scripts.path().join("commands");
    let quote = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
    for (corrupt, output_limit) in [
        (false, 8 * 1024 * 1024),
        (true, 8 * 1024 * 1024),
        (false, 64),
    ] {
        let failure = if corrupt {
            "for arg do if [ \"$arg\" = cat-file ]; then printf 'invalid header\\n'; exit 0; fi; done\n"
        } else {
            ""
        };
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\n{failure}exec {} \"$@\"\n",
                quote(&log),
                quote(&system.executable().unwrap())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&log, "").unwrap();
        let limits = crate::GitExecutionLimits::new(
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(5),
            output_limit,
        )
        .unwrap();
        let client = GitClient::with_executable(executable.clone(), limits).unwrap();
        let values = client
            .read_text_diff_bases(
                &opened,
                &[Path::new("ordinary.txt"), Path::new("missing.txt")],
                1024,
            )
            .await;
        assert_eq!(
            values[0].as_ref().unwrap().as_deref(),
            Some(b"ordinary\n".as_slice())
        );
        assert!(values[1].as_ref().unwrap().is_none());
        let commands = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            commands
                .lines()
                .filter(|line| line.contains("cat-file --batch"))
                .count(),
            if corrupt || output_limit == 64 { 1 } else { 2 }
        );
        let expected_fallbacks = if corrupt || output_limit == 64 { 2 } else { 0 };
        assert_eq!(
            commands
                .lines()
                .filter(|line| line.contains("show --no-textconv"))
                .count(),
            expected_fallbacks
        );
    }
}
