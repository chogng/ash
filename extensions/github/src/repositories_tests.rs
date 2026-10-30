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

#[tokio::test(flavor = "current_thread")]
async fn virtual_repository_tree_preserves_git_kinds_and_encoded_refs() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    let sha = "a".repeat(40);
    http.push(
        200,
        json!({"sha":sha,"truncated":false,"tree":[
            {"path":"src","mode":"040000","type":"tree","sha":sha},
            {"path":"src/a #%.rs","mode":"100644","type":"blob","sha":sha,"size":4},
            {"path":"link","mode":"120000","type":"blob","sha":sha,"size":2},
            {"path":"dependency","mode":"160000","type":"commit","sha":sha}
        ]}),
    );
    let tree = client
        .repository_tree(&repository(), "feature/链接 #?")
        .await
        .unwrap();
    assert_eq!(tree.sha, sha);
    assert_eq!(
        tree.entries
            .iter()
            .map(|entry| entry.kind)
            .collect::<Vec<_>>(),
        vec![
            RepositoryEntryKind::Directory,
            RepositoryEntryKind::File,
            RepositoryEntryKind::SymbolicLink,
            RepositoryEntryKind::Submodule
        ]
    );
    assert_eq!(tree.entries[1].path, "src/a #%.rs");
    assert_eq!(
        http.requests.lock().unwrap()[0].url(),
        "https://api.github.com/repos/team/repo/git/trees/feature%2F%E9%93%BE%E6%8E%A5%20%23%3F?recursive=1"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn virtual_repository_rejects_partial_trees_and_invalid_remote_paths() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    let sha = "a".repeat(40);
    http.push(200, json!({"sha":sha,"truncated":true,"tree":[]}));
    assert!(matches!(
        client.repository_tree(&repository(), "main").await,
        Err(Error::InvalidResponse(_))
    ));
    for path in ["../secret", "a/../b", "/absolute", "a//b", "a\\b", "a\n"] {
        http.push(200, json!({"sha":sha,"truncated":false,"tree":[{"path":path,"mode":"100644","type":"blob","sha":sha,"size":0}]}));
        assert!(
            matches!(
                client.repository_tree(&repository(), "main").await,
                Err(Error::InvalidResponse(_))
            ),
            "{path}"
        );
    }
    let before = http.requests.lock().unwrap().len();
    for reference in ["", "main\n", "bad\0ref"] {
        assert!(matches!(
            client.repository_tree(&repository(), reference).await,
            Err(Error::InvalidInput(_))
        ));
    }
    assert_eq!(http.requests.lock().unwrap().len(), before);
}

#[tokio::test(flavor = "current_thread")]
async fn virtual_repository_blobs_preserve_binary_bom_empty_content_and_exact_sha() {
    use base64::Engine;
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    let sha = "a".repeat(40);
    for bytes in [vec![0, 255, 128, 10], vec![239, 187, 191, 65], vec![]] {
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        http.push(200, json!({"sha":sha,"size":bytes.len(),"encoding":"base64","content":format!("{encoded}\r\n")}));
        let blob = client.repository_blob(&repository(), &sha).await.unwrap();
        assert_eq!(blob.sha, sha);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(blob.content_base64)
                .unwrap(),
            bytes
        );
    }
    for reply in [
        json!({"sha":"b".repeat(40),"size":1,"encoding":"base64","content":"YQ=="}),
        json!({"sha":sha,"size":2,"encoding":"base64","content":"YQ=="}),
        json!({"sha":sha,"size":1,"encoding":"base64","content":"????"}),
        json!({"sha":sha,"size":5*1024*1024+1,"encoding":"base64","content":""}),
    ] {
        http.push(200, reply);
        assert!(matches!(
            client.repository_blob(&repository(), &sha).await,
            Err(Error::InvalidResponse(_))
        ));
    }
    let before = http.requests.lock().unwrap().len();
    assert!(matches!(
        client.repository_blob(&repository(), "../main").await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(http.requests.lock().unwrap().len(), before);
}
