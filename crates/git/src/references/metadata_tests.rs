use super::GitBranch;
use crate::GitClient;
use crate::test_support::TestRepository;
use pretty_assertions::assert_eq;
#[tokio::test(flavor = "current_thread")]
async fn lists_local_branches_with_current_marker() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "tracked\n");
    repository.commit_all("initial");
    let main_oid = repository.git(&["rev-parse", "HEAD"]);
    repository.git(&["branch", "topic"]);

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let branches = client.local_branches(&opened).await.expect("list branches");

    assert_eq!(
        branches,
        vec![
            GitBranch {
                name: "main".to_string(),
                object_id: main_oid.clone(),
                current: true,
                upstream: None,
            },
            GitBranch {
                name: "topic".to_string(),
                object_id: main_oid,
                current: false,
                upstream: None,
            },
        ]
    );
}
