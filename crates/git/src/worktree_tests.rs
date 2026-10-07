use pretty_assertions::assert_eq;

use super::GitWorktreeAvailability;
use super::parse_worktrees;
use crate::GitClient;
use crate::GitError;
use crate::GitNamedWorktreeRequest;
use crate::test_support::TestRepository;

#[tokio::test(flavor = "current_thread")]
async fn lists_primary_linked_locked_and_prunable_worktrees() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "tracked\n");
    repository.commit_all("initial");
    let linked = repository.path("linked");
    repository.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        linked.to_str().expect("UTF-8 linked path"),
        "HEAD",
    ]);
    repository.git(&[
        "worktree",
        "lock",
        "--reason",
        "in use",
        linked.to_str().expect("UTF-8 linked path"),
    ]);
    let stale = repository.path("stale");
    repository.git(&[
        "worktree",
        "add",
        "-b",
        "stale",
        stale.to_str().expect("UTF-8 stale path"),
        "HEAD",
    ]);
    std::fs::remove_dir_all(&stale).expect("remove stale checkout");

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let worktrees = client.worktrees(&opened).await.expect("list worktrees");

    assert_eq!(worktrees.len(), 3);
    assert_eq!(worktrees[0].checkout_root(), repository.root());
    assert_eq!(worktrees[0].branch(), Some("main"));
    assert_eq!(
        worktrees[1].availability(),
        &GitWorktreeAvailability::Locked {
            reason: Some("in use".to_string())
        }
    );
    assert!(matches!(
        worktrees[2].availability(),
        GitWorktreeAvailability::Prunable { .. }
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn creates_a_linked_worktree_on_a_new_named_branch() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    let git = GitClient::system();
    let opened = git.open_repository(repository.root()).await.unwrap();
    let head = git.resolve_commit(&opened, "HEAD").await.unwrap();
    let checkout = repository.path("named-worktree");
    let request =
        GitNamedWorktreeRequest::new(checkout.clone(), head.clone(), "ash/topic".into()).unwrap();
    git.create_named_worktree(&opened, &request).await.unwrap();

    assert_eq!(repository.git(&["branch", "--show-current"]), "main");
    assert_eq!(
        repository.git(&["-C", checkout.to_str().unwrap(), "branch", "--show-current"]),
        "ash/topic"
    );
    assert_eq!(
        git.resolve_commit(&opened, "refs/heads/ash/topic")
            .await
            .unwrap(),
        head
    );
    assert!(git.create_named_worktree(&opened, &request).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn repairs_a_linked_worktree_after_the_source_repository_moves() {
    let mut repository = TestRepository::init();
    repository.write("tracked.txt", "tracked\n");
    repository.commit_all("initial");
    let linked = repository.path("linked");
    repository.git(&[
        "worktree",
        "add",
        "--detach",
        linked.to_str().expect("UTF-8 linked worktree path"),
        "HEAD",
    ]);
    let moved_repository = repository.relocate();
    let moved_linked = moved_repository.join("linked");
    let client = GitClient::system();
    let source = client
        .open_repository(&moved_repository)
        .await
        .expect("open moved source repository");

    assert!(matches!(
        client.open_repository(&moved_linked).await,
        Err(GitError::NotAWorkingTree { .. })
    ));
    client
        .repair_linked_worktree(&source, &moved_linked)
        .await
        .expect("repair linked worktree");

    let repaired = client
        .open_repository(&moved_linked)
        .await
        .expect("open repaired linked worktree");
    assert_eq!(repaired.common_dir(), source.common_dir());
}

#[tokio::test(flavor = "current_thread")]
async fn repair_rejects_a_checkout_owned_by_another_repository() {
    let source = TestRepository::init();
    source.write("source.txt", "source\n");
    source.commit_all("source");
    let other = TestRepository::init();
    other.write("other.txt", "other\n");
    other.commit_all("other");
    let other_linked = other.path("linked");
    other.git(&[
        "worktree",
        "add",
        "--detach",
        other_linked
            .to_str()
            .expect("UTF-8 other linked worktree path"),
        "HEAD",
    ]);
    let client = GitClient::system();
    let source = client
        .open_repository(source.root())
        .await
        .expect("open source repository");

    assert!(
        client
            .repair_linked_worktree(&source, &other_linked)
            .await
            .is_err()
    );
}

#[test]
fn parser_accepts_a_detached_record_fixture() {
    let output = b"worktree /repo/topic\0HEAD 0123456789abcdef\0detached\0\0";

    let worktrees = parse_worktrees(output, "git worktree list").expect("parse fixture");

    assert_eq!(worktrees.len(), 1);
    assert_eq!(
        worktrees[0].checkout_root(),
        std::path::Path::new("/repo/topic")
    );
    assert_eq!(worktrees[0].head(), "0123456789abcdef");
    assert_eq!(worktrees[0].branch(), None);
}

#[test]
fn parser_rejects_truncated_unknown_and_misordered_records() {
    for output in [
        b"worktree /repo/topic\0HEAD 0123456789abcdef\0".as_slice(),
        b"worktree /repo/topic\0HEAD 0123456789abcdef\0future field\0\0".as_slice(),
        b"HEAD 0123456789abcdef\0worktree /repo/topic\0\0".as_slice(),
    ] {
        assert!(matches!(
            parse_worktrees(output, "git worktree list"),
            Err(GitError::InvalidOutput { .. })
        ));
    }
}

#[test]
fn parser_rejects_non_utf8_branch_names() {
    let output = b"worktree /repo/topic\0HEAD 0123456789abcdef\0branch refs/heads/\xff\0\0";

    assert!(matches!(
        parse_worktrees(output, "git worktree list"),
        Err(GitError::InvalidOutput { .. })
    ));
}
