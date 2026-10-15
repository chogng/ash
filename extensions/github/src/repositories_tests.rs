use super::*;
use crate::tests::FakeHttp;
use crate::tests::github;
use crate::tests::repository;
use std::sync::Arc;

fn remote() -> Value {
    json!({"full_name":"team/repo","description":"A repository","private":true,"stargazers_count":12,"default_branch":"main","html_url":"https://github.com/team/repo","clone_url":"https://github.com/team/repo.git","ssh_url":"git@github.com:team/repo.git"})
}
#[tokio::test(flavor = "current_thread")]
async fn search_supports_personal_repositories_qualified_queries_and_exact_urls() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    http.push(200, json!([remote()]));
    assert_eq!(
        client.search_repositories("", 1).await.unwrap().items[0]
            .repository
            .owner,
        "team"
    );
    http.push(200, json!({"items":[remote()]}));
    assert_eq!(
        client
            .search_repositories("team/repo", 1)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    http.push(200, remote());
    client
        .search_repositories("https://github.com/team/repo.git", 1)
        .await
        .unwrap();
    let requests = http.requests.lock().unwrap();
    assert!(requests[0].url().contains("user/repos?sort=updated"));
    let query: std::collections::BTreeMap<_, _> = url::Url::parse(requests[1].url())
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(query["q"], "user:team repo fork:true");
    assert_eq!(requests[2].url(), "https://api.github.com/repos/team/repo");
}
#[tokio::test(flavor = "current_thread")]
async fn search_rejects_cross_host_urls_and_api_supplied_clone_commands() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    for query in [
        "https://evil.example/team/repo",
        "https://name@github.com/team/repo",
        "https://github.com/team/repo?x=1",
        "https://github.com/team/repo/extra",
    ] {
        assert!(matches!(
            client.search_repositories(query, 1).await,
            Err(Error::InvalidInput(_))
        ));
    }
    assert!(http.requests.lock().unwrap().is_empty());
    let mut row = remote();
    row["clone_url"] = json!("ext::sh -c attack");
    http.push(200, json!([row]));
    assert!(matches!(
        client.search_repositories("", 1).await,
        Err(Error::InvalidResponse(_))
    ));
}
#[tokio::test(flavor = "current_thread")]
async fn create_sets_visibility_and_does_not_initialize_or_replay_an_uncertain_write() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    http.push(201, remote());
    client
        .create_repository("repo", "Description", RepositoryVisibility::Private)
        .await
        .unwrap();
    http.push(500, json!({}));
    assert_eq!(
        client
            .create_repository("repo", "", RepositoryVisibility::Public)
            .await
            .unwrap_err(),
        Error::SubmissionUncertain
    );
    assert!(matches!(
        client
            .create_repository("../bad", "", RepositoryVisibility::Private)
            .await,
        Err(Error::InvalidInput(_))
    ));
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        serde_json::from_slice::<Value>(requests[0].body()).unwrap(),
        json!({"name":"repo","description":"Description","private":true,"auto_init":false})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(requests[1].body()).unwrap()["private"],
        false
    );
}
#[tokio::test(flavor = "current_thread")]
async fn branch_listing_places_the_default_first_and_pages_explicitly() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    http.push(200,json!({"node_id":"repository","full_name":"team/repo","default_branch":"main","allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true}));
    http.push(200, json!([{"name":"topic"},{"name":"main"}]));
    let branches = client.repository_branches(&repository(), 1).await.unwrap();
    assert!(branches.items[0].default);
    assert_eq!(branches.items[0].name, "main");
    assert_eq!(branches.next_page, None);
}
fn permissions(permission: &str) -> Value {
    json!({"data":{"repository":{"defaultBranchRef":{"name":"main"},"viewerPermission":permission}}})
}
fn rules(nodes: Value, next: Option<&str>) -> Value {
    json!({"data":{"repository":{"rulesets":{"nodes":nodes,"pageInfo":{"hasNextPage":next.is_some(),"endCursor":next}}}}})
}
fn rule(enforcement: &str) -> Value {
    json!({"target":"BRANCH","enforcement":enforcement,"rules":{"totalCount":1},"conditions":{"refName":{"include":["~ALL","~DEFAULT_BRANCH","refs/heads/release/*"],"exclude":["refs/heads/scratch/*"]}}})
}
#[tokio::test(flavor = "current_thread")]
async fn protection_reads_inherited_active_pull_request_rules_and_paginates() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    http.push(200, permissions("WRITE"));
    http.push(
        200,
        rules(json!([rule("ACTIVE"), rule("EVALUATE")]), Some("next")),
    );
    http.push(200, rules(json!([]), None));
    let protection = client.branch_protection(&repository()).await.unwrap();
    assert_eq!(protection.rules.len(), 1);
    assert_eq!(
        protection.rules[0].include,
        vec!["**/*", "main", "release/*"]
    );
    assert_eq!(protection.rules[0].exclude, vec!["scratch/*"]);
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        serde_json::from_slice::<Value>(requests[1].body()).unwrap()["query"]
            .as_str()
            .unwrap()
            .contains("includeParents:true")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(requests[2].body()).unwrap()["variables"]["cursor"],
        "next"
    );
}
#[tokio::test(flavor = "current_thread")]
async fn protection_does_not_query_rules_for_readers_and_rejects_cursor_loops() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    http.push(200, permissions("READ"));
    assert!(
        client
            .branch_protection(&repository())
            .await
            .unwrap()
            .rules
            .is_empty()
    );
    assert_eq!(http.requests.lock().unwrap().len(), 1);
    http.push(200, permissions("ADMIN"));
    for _ in 0..2 {
        http.push(200, rules(json!([]), Some("same")));
    }
    assert!(matches!(
        client.branch_protection(&repository()).await,
        Err(Error::InvalidResponse(_))
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn incomplete_active_rules_are_not_misreported_as_unprotected() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    http.push(200, permissions("WRITE"));
    let mut value = rule("ACTIVE");
    value["conditions"] = Value::Null;
    http.push(200, rules(json!([value]), None));
    assert!(matches!(
        client.branch_protection(&repository()).await,
        Err(Error::InvalidResponse(_))
    ));
}
