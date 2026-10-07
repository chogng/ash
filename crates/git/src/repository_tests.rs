use pretty_assertions::assert_eq;

use super::GitRepositoryKind;
use crate::GitClient;
use crate::GitError;
use crate::test_support::TestRepository;

#[tokio::test(flavor = "current_thread")]
async fn opens_repository_from_nested_file() {
    let repository = TestRepository::init();
    repository.write("nested/file.txt", "contents");

    let opened = GitClient::system()
        .open_repository(&repository.path("nested/file.txt"))
        .await
        .expect("open repository");

    assert_eq!(opened.worktree_root(), repository.root());
    assert_eq!(opened.kind(), GitRepositoryKind::Standard);
    assert_eq!(opened.git_dir(), &repository.path(".git"));
    assert_eq!(opened.common_dir(), &repository.path(".git"));
}

#[tokio::test(flavor = "current_thread")]
async fn reports_non_repository_directory() {
    let directory = TestRepository::init();
    let outside = directory.path("outside");
    std::fs::create_dir_all(&outside).expect("create non-repository directory");
    std::fs::remove_dir_all(directory.path(".git")).expect("remove repository metadata");

    let error = GitClient::system()
        .open_repository(&outside)
        .await
        .expect_err("reject non-repository directory");

    assert!(matches!(error, GitError::NotAWorkingTree { path } if path == outside));
}

#[tokio::test(flavor = "current_thread")]
async fn identifies_linked_worktree_metadata() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "tracked");
    repository.commit_all("initial");
    let worktree = repository.path("linked-worktree");
    repository.git(&[
        "worktree",
        "add",
        "--detach",
        worktree.to_str().expect("UTF-8 worktree path"),
    ]);

    let opened = GitClient::system()
        .open_repository(&worktree)
        .await
        .expect("open linked worktree");

    assert_eq!(opened.kind(), GitRepositoryKind::LinkedWorktree);
    assert_eq!(opened.worktree_root(), worktree);
    assert_ne!(opened.git_dir(), opened.common_dir());
}

#[tokio::test]
async fn completed_discovery_does_not_hide_repository_initialization() {
    let directory = tempfile::tempdir().unwrap();
    let git = GitClient::system();
    assert!(matches!(
        git.open_repository(directory.path()).await,
        Err(GitError::NotAWorkingTree { .. })
    ));
    git.run_mutation(directory.path(), ["init", "--initial-branch=main"])
        .await
        .unwrap()
        .require_success()
        .unwrap();
    let opened = git.open_repository(directory.path()).await.unwrap();
    assert_eq!(
        opened.worktree_root(),
        dunce::canonicalize(directory.path()).unwrap()
    );
    assert_eq!(
        opened,
        git.open_repository(&directory.path().join("."))
            .await
            .unwrap()
    );
}
