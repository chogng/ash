use ash_async_utils::CancellationSource;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

struct Responses {
    pages: Mutex<VecDeque<serde_json::Value>>,
    cursors: Mutex<Vec<serde_json::Value>>,
    queries: Mutex<Vec<serde_json::Value>>,
}
impl HttpClient for Responses {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        assert_eq!(request.url(), "https://api.linear.app/graphql");
        assert!(request.rejects_redirects());
        assert!(!format!("{request:?}").contains("fixture-secret"));
        let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
        self.queries.lock().unwrap().push(body.clone());
        self.cursors
            .lock()
            .unwrap()
            .push(body["variables"]["after"].clone());
        let page = self
            .pages
            .lock()
            .unwrap()
            .pop_front()
            .expect("one request per page");
        Ok(HttpResponse::new(
            200,
            Vec::new(),
            serde_json::to_vec(&page).unwrap(),
        ))
    }
}

#[test]
fn linear_pagination_normalizes_blockers_and_zero_priority_without_exposing_credentials() {
    let transport = Arc::new(Responses {
        pages: Mutex::new(VecDeque::from([
            json!({"data":{"issues":{"nodes":[{"id":"one","identifier":"LIN-1","title":"First","description":null,"url":"https://linear.app/one","priority":0,"createdAt":"2026-10-08","state":{"name":"Todo"},"labels":{"nodes":[{"name":"ash"}]},"inverseRelations":{"nodes":[{"type":"blocks","issue":{"id":"dependency","state":{"name":"In Progress"}}}]}}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-one"}}}}),
            json!({"data":{"issues":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}),
        ])),
        cursors: Mutex::new(Vec::new()),
        queries: Mutex::new(Vec::new()),
    });
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(ash_symphony::Store::open(&root.path().join("state.db")).unwrap());
    let server = crate::tests::server().with_symphony_store(store, transport.clone());
    let issues = server
        .fetch_symphony_linear(
            &plan(&root),
            "project",
            "fixture-secret",
            &[],
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].priority, None);
    assert_eq!(issues[0].labels, ["ash"]);
    assert_eq!(issues[0].blocked_by["dependency"], "In Progress");
    assert_eq!(
        *transport.cursors.lock().unwrap(),
        [json!(null), json!("cursor-one")]
    );
}

#[test]
fn partial_linear_result_never_returns_a_successful_snapshot() {
    let transport = Arc::new(Responses {
        pages: Mutex::new(VecDeque::from([
            json!({"data":{"issues":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":"one"}}}}),
            json!({"errors":[{"message":"fixture-secret-must-not-escape"}]}),
        ])),
        cursors: Mutex::new(Vec::new()),
        queries: Mutex::new(Vec::new()),
    });
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(ash_symphony::Store::open(&root.path().join("state.db")).unwrap());
    let server = crate::tests::server().with_symphony_store(store, transport);
    let error = server
        .fetch_symphony_linear(
            &plan(&root),
            "project",
            "fixture-secret",
            &[],
            &CancellationSource::new().token(),
        )
        .unwrap_err();
    assert!(error.contains("Linear rejected"));
    assert!(!error.contains("fixture-secret"));
}

fn plan(root: &tempfile::TempDir) -> ash_symphony::Workflow {
    let path = root.path().join("WORKFLOW.md");
    std::fs::write(
        &path,
        "---\ntracker:\n  kind: linear\n  project_slug: project\n---\n{{ issue.title }}",
    )
    .unwrap();
    ash_symphony::Workflow::load(&path).unwrap()
}

#[test]
fn linear_id_refresh_and_viewer_routing_keep_unassigned_issues_visible_but_ineligible() {
    let transport = Arc::new(Responses {
        pages: Mutex::new(VecDeque::from([
            json!({"data":{"viewer":{"id":"worker"}}}),
            json!({"data":{"issues":{"nodes":[
                {"id":"one","identifier":"LIN-1","title":"First","description":null,"url":"https://linear.app/one","priority":1,"createdAt":null,"state":{"name":"Todo"},"assignee":{"id":"worker"},"branchName":"lin-one","updatedAt":"2026-10-08T00:00:00Z","labels":{"nodes":[]},"inverseRelations":{"nodes":[]}},
                {"id":"two","identifier":"LIN-2","title":"Second","description":null,"url":"https://linear.app/two","priority":2,"createdAt":null,"state":{"name":"Todo"},"assignee":null,"labels":{"nodes":[]},"inverseRelations":{"nodes":[]}}
            ],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}),
        ])),
        cursors: Mutex::new(Vec::new()),
        queries: Mutex::new(Vec::new()),
    });
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(ash_symphony::Store::open(&root.path().join("state.db")).unwrap());
    let server = crate::tests::server().with_symphony_store(store, transport.clone());
    let mut workflow = plan(&root);
    workflow.tracker_assignee = Some("me".into());
    let ids = vec!["one".into(), "two".into()];
    let issues = server
        .fetch_symphony_linear(
            &workflow,
            "project",
            "fixture-secret",
            &ids,
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert!(issues[0].dispatchable);
    assert!(!issues[1].dispatchable);
    assert_eq!(issues[0].branch_name.as_deref(), Some("lin-one"));
    let queries = transport.queries.lock().unwrap();
    assert_eq!(queries[1]["variables"]["filter"]["id"]["in"], json!(ids));
    assert_eq!(
        queries[1]["variables"]["filter"]["project"]["slugId"]["eq"],
        "project"
    );
}
