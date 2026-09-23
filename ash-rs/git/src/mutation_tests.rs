use super::{GitCommitRequest, GitPathspecSet};
use crate::test_support::{TestBareRepository, TestRepository};
use crate::{GitChangeStatus, GitClient, GitError};
use std::path::PathBuf;

#[test]
fn pathspec_and_commit_requests_reject_ambiguous_inputs() {
    assert!(GitPathspecSet::new(Vec::new()).is_err());
    assert!(GitPathspecSet::new(vec![PathBuf::from("../outside")]).is_err());
    assert!(GitPathspecSet::new(vec![PathBuf::from("/absolute")]).is_err());
    assert!(GitPathspecSet::new(vec![PathBuf::from("path\0suffix")]).is_err());
    assert!(GitCommitRequest::new("   ".into()).is_err());
    assert!(GitCommitRequest::new("message\0suffix".into()).is_err());
}

#[tokio::test]
async fn stages_unstages_discards_and_commits_selected_paths() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "changed\n");
    repository.write("new.txt", "new\n");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let tracked = GitPathspecSet::new(vec![PathBuf::from("tracked.txt")]).unwrap();
    let new_file = GitPathspecSet::new(vec![PathBuf::from("new.txt")]).unwrap();

    client.stage(&opened, &tracked).await.unwrap();
    let staged = client.snapshot(&opened).await.unwrap();
    assert_eq!(
        staged.changes()[0].index_status(),
        GitChangeStatus::Modified
    );

    client.unstage(&opened, &tracked).await.unwrap();
    let unstaged = client.snapshot(&opened).await.unwrap();
    assert_eq!(
        unstaged.changes()[0].index_status(),
        GitChangeStatus::Unmodified
    );
    assert_eq!(
        unstaged.changes()[0].worktree_status(),
        GitChangeStatus::Modified
    );

    client.discard_worktree(&opened, &tracked).await.unwrap();
    assert_eq!(
        repository.read("tracked.txt").replace("\r\n", "\n"),
        "initial\n"
    );
    client.stage(&opened, &new_file).await.unwrap();
    let commit = client
        .commit(
            &opened,
            &GitCommitRequest::new("add new file".into()).unwrap(),
        )
        .await
        .unwrap();
    assert!(!commit.object_id().is_empty());
    assert!(client.snapshot(&opened).await.unwrap().is_clean());
}

#[tokio::test]
async fn fetches_fast_forward_pulls_and_pushes_against_a_local_remote() {
    let origin = TestBareRepository::init();
    let first = TestRepository::clone_from(origin.root());
    first.write("shared.txt", "initial\n");
    first.commit_all("initial");
    first.git(&["push", "--set-upstream", "origin", "main"]);
    let second = TestRepository::clone_from(origin.root());
    let client = GitClient::system();
    let first_repository = client.open_repository(first.root()).await.unwrap();
    let second_repository = client.open_repository(second.root()).await.unwrap();

    first.write("shared.txt", "from first\n");
    first.commit_all("update from first");
    client.push(&first_repository).await.unwrap();
    let first_head = first.git(&["rev-parse", "HEAD"]);

    client.fetch(&second_repository).await.unwrap();
    assert_eq!(
        second.git(&["rev-parse", "refs/remotes/origin/main"]),
        first_head
    );
    client.pull_fast_forward(&second_repository).await.unwrap();
    assert_eq!(second.read("shared.txt"), "from first\n");
    assert_eq!(second.git(&["rev-parse", "HEAD"]), first_head);

    second.write("second.txt", "from second\n");
    second.commit_all("update from second");
    client.push(&second_repository).await.unwrap();
    let second_head = second.git(&["rev-parse", "HEAD"]);
    assert_eq!(origin.git(&["rev-parse", "refs/heads/main"]), second_head);

    client.pull_fast_forward(&first_repository).await.unwrap();
    first.write("first-only.txt", "upstream\n");
    first.commit_all("upstream divergence");
    client.push(&first_repository).await.unwrap();
    second.write("second-only.txt", "local\n");
    second.commit_all("local divergence");
    let local_head = second.git(&["rev-parse", "HEAD"]);

    let error = client
        .pull_fast_forward(&second_repository)
        .await
        .expect_err("a non-fast-forward pull must fail");
    assert!(matches!(error, GitError::CommandFailed { .. }));
    assert_eq!(second.git(&["rev-parse", "HEAD"]), local_head);
}

#[tokio::test]
async fn default_fetch_updates_only_the_tracked_remote_and_never_changes_the_worktree() {
    let origin = TestBareRepository::init();
    let mirror = TestBareRepository::init();
    let seed = TestRepository::clone_from(origin.root());
    seed.write("shared.txt", "initial\n");
    seed.commit_all("initial");
    seed.git(&["push", "--set-upstream", "origin", "main"]);
    seed.git(&["remote", "add", "mirror", mirror.root().to_str().unwrap()]);
    seed.git(&["push", "mirror", "main"]);

    let target = TestRepository::clone_from(origin.root());
    target.git(&["remote", "add", "mirror", mirror.root().to_str().unwrap()]);
    target.git(&["fetch", "mirror"]);
    let initial_head = target.git(&["rev-parse", "HEAD"]);
    let origin_peer = TestRepository::clone_from(origin.root());
    origin_peer.write("shared.txt", "origin update\n");
    origin_peer.commit_all("origin update");
    origin_peer.git(&["push", "origin", "main"]);
    let mirror_peer = TestRepository::clone_from(mirror.root());
    mirror_peer.write("shared.txt", "mirror update\n");
    mirror_peer.commit_all("mirror update");
    mirror_peer.git(&["push", "origin", "main"]);

    let client = GitClient::system();
    let repository = client.open_repository(target.root()).await.unwrap();
    client.fetch_default(&repository).await.unwrap();
    assert_eq!(
        target.git(&["rev-parse", "refs/remotes/origin/main"]),
        origin_peer.git(&["rev-parse", "HEAD"])
    );
    assert_eq!(
        target.git(&["rev-parse", "refs/remotes/mirror/main"]),
        initial_head
    );
    assert_eq!(target.git(&["rev-parse", "HEAD"]), initial_head);
    assert_eq!(target.read("shared.txt"), "initial\n");

    client.fetch(&repository).await.unwrap();
    assert_eq!(
        target.git(&["rev-parse", "refs/remotes/mirror/main"]),
        mirror_peer.git(&["rev-parse", "HEAD"])
    );
    assert_eq!(target.git(&["rev-parse", "HEAD"]), initial_head);
    assert_eq!(target.read("shared.txt"), "initial\n");
}

#[tokio::test]
async fn switches_to_a_listed_local_branch() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "main\n");
    repository.commit_all("initial");
    repository.git(&["branch", "topic"]);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let topic = client
        .local_branches(&opened)
        .await
        .unwrap()
        .into_iter()
        .find(|branch| branch.name() == "topic")
        .unwrap();

    client.switch_branch(&opened, &topic).await.unwrap();

    assert_eq!(repository.git(&["branch", "--show-current"]), "topic");
}

#[tokio::test]
async fn rejected_branch_switch_preserves_the_current_branch_and_worktree() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "main\n");
    repository.commit_all("initial");
    repository.git(&["switch", "-c", "topic"]);
    repository.write("tracked.txt", "topic\n");
    repository.commit_all("topic");
    repository.git(&["switch", "main"]);
    repository.write("tracked.txt", "local\n");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let topic = client
        .local_branches(&opened)
        .await
        .unwrap()
        .into_iter()
        .find(|branch| branch.name() == "topic")
        .unwrap();

    let error = client
        .switch_branch(&opened, &topic)
        .await
        .expect_err("conflicting worktree changes must reject the switch");

    assert!(matches!(error, GitError::CommandFailed { .. }));
    assert_eq!(repository.git(&["branch", "--show-current"]), "main");
    assert_eq!(repository.read("tracked.txt"), "local\n");
}
