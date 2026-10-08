use super::GitCommitRequest;
use super::GitPathspecSet;
use crate::GitChangeStatus;
use crate::GitClient;
use crate::GitError;
use crate::test_support::TestBareRepository;
use crate::test_support::TestRepository;
use std::path::PathBuf;

#[tokio::test]
async fn commit_scopes_preserve_partial_staging_and_require_untracked_opt_in() {
    for scope in ["staged", "tracked", "includeUntracked"] {
        let repository = TestRepository::init();
        for file in ["partial.txt", "unstaged.txt", "deleted.txt", "old.txt"] {
            repository.write(file, "initial\n");
        }
        repository.write(".gitignore", "*.ignored\n");
        repository.commit_all("initial");
        repository.write("partial.txt", "staged\n");
        repository.git(&["add", "partial.txt"]);
        repository.write("partial.txt", "working\n");
        repository.write("unstaged.txt", "changed\n");
        std::fs::remove_file(repository.path("deleted.txt")).unwrap();
        repository.git(&["mv", "old.txt", "renamed.txt"]);
        repository.write("new.txt", "new\n");
        repository.write("secret.ignored", "ignored\n");
        let client = GitClient::system();
        let opened = client.open_repository(repository.root()).await.unwrap();
        let request = GitCommitRequest::new(format!("scope {scope}")).unwrap();
        let request = match scope {
            "staged" => request,
            "tracked" => request.with_tracked_changes(),
            "includeUntracked" => request.with_untracked_changes(),
            _ => unreachable!(),
        };
        client.commit(&opened, &request).await.unwrap();
        assert_eq!(
            repository.git(&["show", "HEAD:partial.txt"]),
            if scope == "staged" {
                "staged"
            } else {
                "working"
            }
        );
        assert_eq!(
            repository.git(&["show", "HEAD:unstaged.txt"]),
            if scope == "staged" {
                "initial"
            } else {
                "changed"
            }
        );
        let files = repository.git(&["ls-tree", "--name-only", "HEAD"]);
        assert!(files.lines().any(|file| file == "renamed.txt"));
        assert!(!files.lines().any(|file| file == "old.txt"));
        assert_eq!(
            files.lines().any(|file| file == "deleted.txt"),
            scope == "staged"
        );
        assert_eq!(
            files.lines().any(|file| file == "new.txt"),
            scope == "includeUntracked"
        );
        assert!(!files.lines().any(|file| file == "secret.ignored"));
        assert_eq!(repository.read("partial.txt"), "working\n");
        assert_eq!(repository.read("new.txt"), "new\n");
        assert!(
            repository
                .git(&["diff", "--cached", "--name-only"])
                .is_empty()
        );
    }
}

#[tokio::test]
async fn amend_and_signoff_share_commit_execution_and_preserve_the_parent() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "second\n");
    repository.commit_all("second");
    let old_head = repository.git(&["rev-parse", "HEAD"]);
    let parent = repository.git(&["rev-parse", "HEAD^"]);
    repository.write("tracked.txt", "amended\n");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let result = client
        .commit(
            &opened,
            &GitCommitRequest::new("--not-an-option\n\nComplete body.".into())
                .unwrap()
                .with_tracked_changes()
                .amend()
                .sign_off(),
        )
        .await
        .unwrap();
    assert_ne!(result.object_id(), old_head);
    assert_eq!(repository.git(&["rev-parse", "HEAD^"]), parent);
    assert_eq!(repository.git(&["show", "HEAD:tracked.txt"]), "amended");
    assert_eq!(
        repository.git(&["log", "-1", "--format=%B"]),
        "--not-an-option\n\nComplete body.\n\nSigned-off-by: Ash Test <ash@example.invalid>"
    );
}

#[tokio::test]
async fn commit_failure_keeps_successfully_staged_changes_and_never_invents_identity() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("initial");
    let head = repository.git(&["rev-parse", "HEAD"]);
    repository.write("tracked.txt", "changed\n");
    repository.write("new.txt", "new\n");
    repository.git(&["config", "user.name", ""]);
    repository.git(&["config", "user.email", ""]);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let error = client
        .commit(
            &opened,
            &GitCommitRequest::new("Keep this message".into())
                .unwrap()
                .with_untracked_changes()
                .sign_off(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, GitError::CommandFailed { .. }));
    assert_eq!(repository.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(repository.git(&["show", ":tracked.txt"]), "changed");
    assert_eq!(repository.git(&["show", ":new.txt"]), "new");
    assert_eq!(repository.read("tracked.txt"), "changed\n");
}

#[tokio::test]
async fn all_changes_commit_refuses_unresolved_conflicts_before_staging() {
    let repository = TestRepository::init();
    repository.write("conflict.txt", "initial\n");
    repository.commit_all("initial");
    repository.git(&["switch", "-c", "topic"]);
    repository.write("conflict.txt", "topic\n");
    repository.commit_all("topic");
    repository.git(&["switch", "main"]);
    repository.write("conflict.txt", "main\n");
    repository.commit_all("main");
    let merged = std::process::Command::new("git")
        .current_dir(repository.root())
        .args(["merge", "topic"])
        .output()
        .unwrap();
    assert!(!merged.status.success());
    repository.write("new.txt", "must stay untracked\n");
    let unresolved = repository.git(&["ls-files", "--unmerged"]);
    let worktree = repository.read("conflict.txt");
    let head = repository.git(&["rev-parse", "HEAD"]);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let error = client
        .commit(
            &opened,
            &GitCommitRequest::new("not resolved".into())
                .unwrap()
                .with_untracked_changes(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GitError::InvalidConfiguration {
            field: "commit",
            ..
        }
    ));
    assert_eq!(repository.git(&["ls-files", "--unmerged"]), unresolved);
    assert_eq!(repository.git(&["ls-files", "new.txt"]), "");
    assert_eq!(repository.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(repository.read("conflict.txt"), worktree);
}

#[tokio::test]
async fn empty_creation_and_unborn_amend_do_not_create_commits() {
    let repository = TestRepository::init();
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let error = client
        .commit(
            &opened,
            &GitCommitRequest::new("amend unborn".into())
                .unwrap()
                .amend(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, GitError::CommandFailed { .. }));
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("initial");
    let head = repository.git(&["rev-parse", "HEAD"]);
    let error = client
        .commit(&opened, &GitCommitRequest::new("empty".into()).unwrap())
        .await
        .unwrap_err();
    assert!(matches!(error, GitError::CommandFailed { .. }));
    assert_eq!(repository.git(&["rev-parse", "HEAD"]), head);
}

#[cfg(unix)]
#[tokio::test]
async fn scoped_and_amended_commits_keep_repository_hooks_disabled() {
    use std::os::unix::fs::PermissionsExt;
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("initial");
    let hook = repository.path(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nprintf hook > .git/hook-ran\nexit 1\n").unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    repository.write("tracked.txt", "changed\n");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    client
        .commit(
            &opened,
            &GitCommitRequest::new("scoped".into())
                .unwrap()
                .with_tracked_changes(),
        )
        .await
        .unwrap();
    client
        .commit(
            &opened,
            &GitCommitRequest::new("amended".into())
                .unwrap()
                .amend()
                .sign_off(),
        )
        .await
        .unwrap();
    assert!(!repository.path(".git/hook-ran").exists());
    assert_eq!(repository.git(&["log", "-1", "--format=%s"]), "amended");
}

#[test]
fn pathspec_and_commit_requests_reject_ambiguous_inputs() {
    assert!(GitPathspecSet::new(Vec::new()).is_err());
    assert!(GitPathspecSet::new(vec![PathBuf::from("../outside")]).is_err());
    assert!(GitPathspecSet::new(vec![PathBuf::from("/absolute")]).is_err());
    assert!(GitPathspecSet::new(vec![PathBuf::from("path\0suffix")]).is_err());
    assert!(GitCommitRequest::new("   ".into()).is_err());
    assert!(GitCommitRequest::new("message\0suffix".into()).is_err());
    assert!(GitCommitRequest::new("x".repeat(65_537)).is_err());
    assert!(GitCommitRequest::new("字".repeat(21_846)).is_err());
    assert!(GitCommitRequest::new("x".repeat(65_536)).is_ok());
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
