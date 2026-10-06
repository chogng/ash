use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use crate::tests::repository;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn fork_creation_names_destination_and_preserves_uncertain_outcome() {
    let http = Arc::new(FakeHttp::default());
    http.push(202, json!({"full_name":"organization/new-fork","html_url":"https://github.com/organization/new-fork","default_branch":"main"}));
    let client = github(http.clone());
    let options = CreateFork {
        organization: Some("organization".into()),
        name: "new-fork".into(),
        branches: ForkBranches::Default,
    };
    assert_eq!(
        client
            .create_fork(&repository(), &options)
            .await
            .unwrap()
            .full_name,
        "organization/new-fork"
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests[0].url(),
        "https://api.github.com/repos/team/repo/forks"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[0].body()).unwrap(),
        json!({"organization":"organization","name":"new-fork","default_branch_only":true})
    );
    drop(requests);
    http.push(500, json!({}));
    assert_eq!(
        client
            .create_fork(&repository(), &options)
            .await
            .unwrap_err(),
        Error::SubmissionUncertain
    );
    let invalid = CreateFork {
        organization: None,
        name: "../bad".into(),
        branches: ForkBranches::All,
    };
    assert!(matches!(
        client.create_fork(&repository(), &invalid).await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 2);
}
