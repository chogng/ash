use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test]
async fn plain_directory_environment_skips_processes_without_caching_repository_absence() {
    #[derive(Debug, Default)]
    struct Processes(std::sync::atomic::AtomicUsize);
    impl crate::GitProcessObserver for Processes {
        fn observe(&self, _: crate::GitProcessTiming) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let repository = TestRepository::init();
    std::fs::remove_dir_all(repository.path(".git")).unwrap();
    let processes = std::sync::Arc::new(Processes::default());
    let client = GitClient::system().with_process_observer(processes.clone());
    assert!(matches!(
        client.environment_summary(repository.root()).await,
        Err(crate::GitError::NotAWorkingTree { .. })
    ));
    assert_eq!(processes.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    let explicit_processes = std::sync::Arc::new(Processes::default());
    let explicit = GitClient::with_executable(
        client.executable().unwrap(),
        crate::GitExecutionLimits::default(),
    )
    .unwrap()
    .with_process_observer(explicit_processes.clone());
    assert!(matches!(
        explicit.environment_summary(repository.root()).await,
        Err(crate::GitError::NotAWorkingTree { .. })
    ));
    assert!(
        explicit_processes
            .0
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
    );
    repository.git(&["init", "--initial-branch=environment"]);
    let summary = client.environment_summary(repository.root()).await.unwrap();
    assert_eq!(summary.branch.as_deref(), Some("environment"));
    assert!(processes.0.load(std::sync::atomic::Ordering::SeqCst) > 0);
    repository.write("new.txt", "new content\n");
    assert!(
        client
            .environment_summary(repository.root())
            .await
            .unwrap()
            .status
            .unwrap()
            .contains("new.txt")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn environment_discovery_follows_directory_symlinks_into_linked_worktrees() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("environment baseline");
    let outside = tempfile::tempdir().unwrap();
    let linked = outside.path().join("worktree");
    repository.git(&["worktree", "add", "--detach", linked.to_str().unwrap()]);
    std::fs::create_dir(linked.join("nested")).unwrap();
    std::fs::write(linked.join("nested/new.txt"), "new content\n").unwrap();
    let alias = outside.path().join("alias");
    std::os::unix::fs::symlink(linked.join("nested"), &alias).unwrap();
    let summary = GitClient::system()
        .environment_summary(&alias)
        .await
        .unwrap();
    assert_eq!(summary.branch, None);
    assert!(summary.status.unwrap().contains("nested/"));
    assert!(
        summary
            .recent_commits
            .unwrap()
            .contains("environment baseline")
    );
}

#[tokio::test]
async fn unused_filters_preserve_status_but_effective_filters_omit_it() {
    let repository = TestRepository::init();
    repository.git(&[
        "config",
        "filter.environment.clean",
        "unavailable-filter-command",
    ]);
    std::fs::write(repository.path("note with spaces.txt"), "initial\n").unwrap();
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "baseline"]);
    std::fs::write(repository.path("note with spaces.txt"), "changed\n").unwrap();
    let client = GitClient::system();
    let summary = client.environment_summary(repository.root()).await.unwrap();
    assert!(summary.status.unwrap().contains("note with spaces.txt"));
    assert!(summary.recent_commits.unwrap().contains("baseline"));

    std::fs::write(
        repository.path(".gitattributes"),
        "*.txt filter=environment\n",
    )
    .unwrap();
    let summary = client.environment_summary(repository.root()).await.unwrap();
    assert_eq!(summary.status, None);
    assert!(summary.recent_commits.unwrap().contains("baseline"));
}
