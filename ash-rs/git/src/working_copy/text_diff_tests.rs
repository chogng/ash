use super::GitTextDiffLimits;
use crate::GitClient;
use crate::test_support::TestRepository;
use std::path::Path;

#[tokio::test]
async fn text_diff_snapshot_owns_changed_files_and_line_statistics() {
    let repository = TestRepository::init();
    repository.write("modified.txt", "same\nbefore\n");
    repository.write("deleted.txt", "one\ntwo\n");
    repository.commit_all("initial");
    repository.write("modified.txt", "same\nafter\nadded\n");
    std::fs::remove_file(repository.path("deleted.txt")).unwrap();
    repository.write("untracked.txt", "new\nfile\n");

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client
        .text_diff_snapshot(&opened, GitTextDiffLimits::new(1024).unwrap())
        .await
        .unwrap();

    assert_eq!(snapshot.diffs().len(), 3);
    assert_eq!(snapshot.statistics().files(), 3);
    assert_eq!(snapshot.statistics().additions(), 4);
    assert_eq!(snapshot.statistics().deletions(), 3);
    let modified = snapshot
        .diffs()
        .iter()
        .find(|diff| diff.path() == Path::new("modified.txt"))
        .unwrap();
    assert_eq!(modified.original(), "same\nbefore\n");
    assert_eq!(modified.modified(), "same\nafter\nadded\n");
}

#[tokio::test]
async fn text_diff_snapshot_keeps_status_but_skips_binary_and_oversized_content() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "before\n");
    repository.commit_all("initial");
    std::fs::write(repository.path("tracked.txt"), b"after\0binary\n").unwrap();
    repository.write("large.txt", &"x".repeat(2_048));

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client
        .text_diff_snapshot(&opened, GitTextDiffLimits::new(1_024).unwrap())
        .await
        .unwrap();

    assert_eq!(snapshot.repository().changes().len(), 2);
    assert!(snapshot.diffs().is_empty());
    assert_eq!(snapshot.statistics().files(), 0);
}

#[test]
fn text_diff_limits_reject_zero_bytes() {
    assert!(GitTextDiffLimits::new(0).is_err());
}

#[tokio::test]
async fn path_scoped_snapshot_reads_only_changes_below_the_dir_prefix() {
    let repository = TestRepository::init();
    repository.write("dir/tracked.txt", "before\n");
    repository.write("outside.txt", "before\n");
    repository.commit_all("initial");
    repository.write("dir/tracked.txt", "after\n");
    repository.write("outside.txt", "after\n");

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let snapshot = client
        .text_diff_snapshot_under(
            &opened,
            Path::new("dir"),
            GitTextDiffLimits::new(1_024).unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(snapshot.repository().changes().len(), 2);
    assert_eq!(snapshot.diffs().len(), 1);
    assert_eq!(snapshot.diffs()[0].path(), Path::new("dir/tracked.txt"));
    assert_eq!(snapshot.statistics().additions(), 1);
    assert_eq!(snapshot.statistics().deletions(), 1);
}

#[tokio::test]
async fn path_scoped_snapshot_rejects_paths_outside_the_repository() {
    let repository = TestRepository::init();
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();

    assert!(
        client
            .text_diff_snapshot_under(
                &opened,
                Path::new("../outside"),
                GitTextDiffLimits::new(1_024).unwrap(),
            )
            .await
            .is_err()
    );
}
