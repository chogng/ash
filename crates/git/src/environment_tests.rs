use crate::GitClient;
use crate::test_support::TestRepository;

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
