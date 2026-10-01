use super::*;
use crate::test_support::TestRepository;

#[tokio::test]
async fn unborn_repository_can_stage_selected_lines_and_unstage_them() {
    let source = TestRepository::init();
    source.write("added.txt", "first\nsecond\n");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let diff = client
        .index_diff(
            &repository,
            Path::new("added.txt"),
            GitChangeFileComparison::Unstaged,
        )
        .await
        .unwrap();
    assert_eq!(diff.original, None);
    client
        .edit_index(
            &repository,
            &GitIndexEdit {
                path: "added.txt".into(),
                comparison: GitChangeFileComparison::Unstaged,
                expected_original: diff.original,
                expected_modified: diff.modified,
                selection: GitIndexSelection::Lines { start: 1, end: 1 },
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["show", ":added.txt"]), "first");
    let diff = client
        .index_diff(
            &repository,
            Path::new("added.txt"),
            GitChangeFileComparison::Staged,
        )
        .await
        .unwrap();
    client
        .edit_index(
            &repository,
            &GitIndexEdit {
                path: "added.txt".into(),
                comparison: GitChangeFileComparison::Staged,
                expected_original: diff.original,
                expected_modified: diff.modified,
                selection: GitIndexSelection::Hunk { index: 0 },
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["ls-files", "added.txt"]), "");
    assert_eq!(source.read("added.txt"), "first\nsecond\n");
    assert!(!repository.git_dir().join("index.lock").exists());
}

#[tokio::test]
async fn selected_lines_round_trip_and_stale_comparisons_leave_index_untouched() {
    let source = TestRepository::init();
    source.write("file.txt", "one\ntwo\nthree\n");
    source.commit_all("Initial");
    source.write("file.txt", "ONE\ntwo\nTHREE\n");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let diff = client
        .index_diff(
            &repository,
            Path::new("file.txt"),
            GitChangeFileComparison::Unstaged,
        )
        .await
        .unwrap();
    let request = GitIndexEdit {
        path: "file.txt".into(),
        comparison: GitChangeFileComparison::Unstaged,
        expected_original: diff.original,
        expected_modified: diff.modified,
        selection: GitIndexSelection::Lines { start: 1, end: 1 },
    };
    client.edit_index(&repository, &request).await.unwrap();
    assert_eq!(source.git(&["show", ":file.txt"]), "ONE\ntwo\nthree");
    assert_eq!(source.read("file.txt"), "ONE\ntwo\nTHREE\n");
    assert!(matches!(
        client.edit_index(&repository, &request).await,
        Err(GitError::IndexChanged)
    ));
    let diff = client
        .index_diff(
            &repository,
            Path::new("file.txt"),
            GitChangeFileComparison::Staged,
        )
        .await
        .unwrap();
    client
        .edit_index(
            &repository,
            &GitIndexEdit {
                path: "file.txt".into(),
                comparison: GitChangeFileComparison::Staged,
                expected_original: diff.original,
                expected_modified: diff.modified,
                selection: GitIndexSelection::Hunk { index: 0 },
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["show", ":file.txt"]), "one\ntwo\nthree");
    assert!(!repository.git_dir().join("index.lock").exists());
}

#[tokio::test]
async fn deletion_and_added_files_keep_missing_distinct_from_empty() {
    let source = TestRepository::init();
    source.write("file.txt", "one\n");
    source.commit_all("Initial");
    std::fs::remove_file(source.path("file.txt")).unwrap();
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    for comparison in [
        GitChangeFileComparison::Unstaged,
        GitChangeFileComparison::Staged,
    ] {
        let diff = client
            .index_diff(&repository, Path::new("file.txt"), comparison)
            .await
            .unwrap();
        client
            .edit_index(
                &repository,
                &GitIndexEdit {
                    path: "file.txt".into(),
                    comparison,
                    expected_original: diff.original,
                    expected_modified: diff.modified,
                    selection: GitIndexSelection::Hunk { index: 0 },
                },
            )
            .await
            .unwrap();
    }
    assert_eq!(source.git(&["show", ":file.txt"]), "one");
    assert!(!source.path("file.txt").exists());
    source.write("added.txt", "new\n");
    for comparison in [
        GitChangeFileComparison::Unstaged,
        GitChangeFileComparison::Staged,
    ] {
        let diff = client
            .index_diff(&repository, Path::new("added.txt"), comparison)
            .await
            .unwrap();
        client
            .edit_index(
                &repository,
                &GitIndexEdit {
                    path: "added.txt".into(),
                    comparison,
                    expected_original: diff.original,
                    expected_modified: diff.modified,
                    selection: GitIndexSelection::Hunk { index: 0 },
                },
            )
            .await
            .unwrap();
    }
    assert_eq!(source.git(&["ls-files", "added.txt"]), "");
    assert_eq!(source.read("added.txt"), "new\n");
}

#[tokio::test]
async fn partial_staging_preserves_another_process_index_lock() {
    let source = TestRepository::init();
    source.write("file.txt", "before\n");
    source.commit_all("initial");
    source.write("file.txt", "after\n");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let diff = client
        .index_diff(
            &repository,
            Path::new("file.txt"),
            GitChangeFileComparison::Unstaged,
        )
        .await
        .unwrap();
    let request = GitIndexEdit {
        path: "file.txt".into(),
        comparison: GitChangeFileComparison::Unstaged,
        expected_original: diff.original,
        expected_modified: diff.modified,
        selection: GitIndexSelection::Hunk { index: 0 },
    };
    let index = repository.git_dir().join("index");
    let before = std::fs::read(&index).unwrap();
    let lock = repository.git_dir().join("index.lock");
    std::fs::write(&lock, "other Git process").unwrap();
    assert!(client.edit_index(&repository, &request).await.is_err());
    assert_eq!(std::fs::read(&index).unwrap(), before);
    assert_eq!(std::fs::read_to_string(&lock).unwrap(), "other Git process");
    assert_eq!(source.read("file.txt"), "after\n");
    std::fs::remove_file(&lock).unwrap();
    client.edit_index(&repository, &request).await.unwrap();
    assert_eq!(source.git(&["show", ":file.txt"]), "after");
    assert!(!lock.exists());
}
