use std::path::PathBuf;

use pretty_assertions::assert_eq;

use super::GitChangeStatus;
use super::GitHead;
use super::GitRepositoryChange;
use super::GitRepositorySnapshot;
use super::GitSubmoduleState;
use super::parse_status;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test(flavor = "current_thread")]
async fn check_ignore_honors_nested_negated_excluded_and_tracked_paths() {
    let repository = TestRepository::init();
    repository.write("tracked.log", "tracked\n");
    repository.commit_all("initial");
    repository.write(".gitignore", "*.log\n!keep.log\ncache/\n\\!literal\n");
    repository.write("nested/.gitignore", "*.tmp\n!keep.tmp\n");
    repository.write(".git/info/exclude", "excluded.txt\n");
    for path in [
        "ignored.log",
        "keep.log",
        "cache/file.txt",
        "nested/ignored.tmp",
        "nested/keep.tmp",
        "excluded.txt",
        "!literal",
        "space name.log",
    ] {
        repository.write(path, "file\n");
    }
    let paths = [
        "tracked.log",
        "ignored.log",
        "keep.log",
        "cache",
        "cache/file.txt",
        "nested/ignored.tmp",
        "nested/keep.tmp",
        "excluded.txt",
        "!literal",
        "space name.log",
    ]
    .map(PathBuf::from);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    assert_eq!(
        client.check_ignore(&opened, &paths).await.unwrap(),
        [
            "ignored.log",
            "cache",
            "cache/file.txt",
            "nested/ignored.tmp",
            "excluded.txt",
            "!literal",
            "space name.log"
        ]
        .map(PathBuf::from)
    );
    assert_eq!(
        client
            .check_ignore(
                &opened,
                &[PathBuf::from("keep.log"), PathBuf::from("tracked.log")]
            )
            .await
            .unwrap(),
        Vec::<PathBuf>::new()
    );
    assert!(
        client
            .snapshot(&opened)
            .await
            .unwrap()
            .changes()
            .iter()
            .all(|change| change.worktree_status() != GitChangeStatus::Ignored)
    );
    repository.write(".gitignore", "");
    assert_eq!(
        client
            .check_ignore(&opened, &[PathBuf::from("ignored.log")])
            .await
            .unwrap(),
        Vec::<PathBuf>::new()
    );
    assert!(
        client
            .check_ignore(&opened, &[PathBuf::from("../outside")])
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_groups_index_worktree_and_untracked_changes() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "old\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "new\n");
    repository.write("staged.txt", "staged\n");
    repository.git(&["add", "staged.txt"]);
    repository.write("untracked.txt", "untracked\n");
    let object_id = repository.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let snapshot = client.snapshot(&opened).await.expect("capture snapshot");

    assert_eq!(
        snapshot,
        GitRepositorySnapshot {
            head: GitHead::Branch {
                name: "main".to_string(),
                object_id,
                upstream: None,
            },
            changes: vec![
                change(
                    "staged.txt",
                    GitChangeStatus::Added,
                    GitChangeStatus::Unmodified,
                ),
                change(
                    "tracked.txt",
                    GitChangeStatus::Unmodified,
                    GitChangeStatus::Modified,
                ),
                change(
                    "untracked.txt",
                    GitChangeStatus::Unmodified,
                    GitChangeStatus::Untracked,
                ),
            ],
        }
    );
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_preserves_rename_source_path() {
    let repository = TestRepository::init();
    repository.write("before.txt", "contents\n");
    repository.commit_all("initial");
    repository.git(&["mv", "before.txt", "after.txt"]);

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let snapshot = client.snapshot(&opened).await.expect("capture snapshot");

    assert_eq!(snapshot.changes.len(), 1);
    assert_eq!(snapshot.changes[0].path, PathBuf::from("after.txt"));
    assert_eq!(
        snapshot.changes[0].original_path,
        Some(PathBuf::from("before.txt"))
    );
    assert_eq!(snapshot.changes[0].index_status, GitChangeStatus::Renamed);
}

#[test]
fn parses_unborn_and_unmerged_porcelain_records() {
    let raw = b"# branch.oid (initial)\0# branch.head topic\0u UU N... 100644 100644 100644 100644 a b c conflict.txt\0";

    let snapshot = parse_status(raw, "git status").expect("parse status");

    assert_eq!(
        snapshot,
        GitRepositorySnapshot {
            head: GitHead::Unborn {
                name: "topic".to_string(),
            },
            changes: vec![GitRepositoryChange {
                path: PathBuf::from("conflict.txt"),
                original_path: None,
                index_status: GitChangeStatus::Unmerged,
                worktree_status: GitChangeStatus::Unmerged,
                submodule: GitSubmoduleState::default(),
            }],
        }
    );
}

fn change(
    path: &str,
    index_status: GitChangeStatus,
    worktree_status: GitChangeStatus,
) -> GitRepositoryChange {
    GitRepositoryChange {
        path: PathBuf::from(path),
        original_path: None,
        index_status,
        worktree_status,
        submodule: GitSubmoduleState::default(),
    }
}
