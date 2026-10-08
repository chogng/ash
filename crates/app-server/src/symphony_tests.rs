use super::call;
use super::initialize;
use super::server;
use ash_async_utils::CancellationSource;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_protocol::SymphonyControl;
use ash_protocol::SymphonyTaskStatus;
use ash_symphony::Store;
use ash_symphony::Workflow;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

struct NoHttp;
impl HttpClient for NoHttp {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        panic!("local Symphony must not use HTTP")
    }
}

#[test]
fn symphony_rpc_is_profile_shared_and_retry_uses_one_conversation_and_turn() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("WORKFLOW.md");
    std::fs::write(
        &path,
        "---\ntracker:\n  kind: local\n---\n{{ issue.description }}",
    )
    .unwrap();
    let workflow = Workflow::load(&path).unwrap();
    let store = Arc::new(Store::open(&root.path().join("state.db")).unwrap());
    let config = Arc::new(ash_config::ConfigStore::open(&root.path().join("config.db")).unwrap());
    let server = server()
        .with_config_store(config)
        .with_symphony_store(Arc::clone(&store), Arc::new(NoHttp));
    let mut first = server.connection();
    let mut second = server.connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    let configured = call(
        &server,
        &mut first,
        json!({"jsonrpc":"2.0","id":2,"method":"symphony/configure","params":{"commandId":"configure","path":path}}),
    );
    assert!(configured.get("error").is_none(), "{configured}");
    let submitted = call(
        &server,
        &mut first,
        json!({"jsonrpc":"2.0","id":3,"method":"symphony/submit","params":{"commandId":"submit","workflowId":workflow.id,"title":"Hello","prompt":"Say hello"}}),
    );
    assert!(submitted.get("error").is_none(), "{submitted}");
    let read = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0","id":2,"method":"symphony/read","params":{}}),
    );
    assert_eq!(read["result"]["conversations"][0], submitted["result"]);
    let updated = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0","id":10,"method":"config/update","params":{"commandId":"symphony-defaults","expectedRevision":0,"execution":{"approvalMode":"auto","commandFileAccess":"readOnly","commandNetworkAccess":"denied"}}}),
    );
    assert_eq!(updated["result"]["revision"], 1);
    let job = store.reserve(ash_symphony::now()).unwrap().remove(0);
    let token = CancellationSource::new().token();
    let first = server.advance_symphony(&job, &token).unwrap();
    let retry = server.advance_symphony(&job, &token).unwrap();
    assert_eq!(first.thread_id, retry.thread_id);
    assert_eq!(first.turn_id, retry.turn_id);
    assert!(first.turn_id.is_some());
    let snapshot = server
        .threads()
        .read_thread(first.thread_id.as_ref().unwrap())
        .unwrap();
    assert_eq!(
        snapshot.turns.last().unwrap().approval_mode,
        ash_protocol::ApprovalMode::Auto
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut observed = retry;
    while observed.status != SymphonyTaskStatus::Completed && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
        observed = server.advance_symphony(&job, &token).unwrap();
    }
    assert_eq!(
        observed.status,
        SymphonyTaskStatus::Completed,
        "{observed:?}"
    );
    let thread_id = observed.thread_id.clone();
    store.observe(&job, observed, ash_symphony::now()).unwrap();
    let messages = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0","id":3,"method":"symphony/messages","params":{"id":job.id}}),
    );
    assert_eq!(messages["result"]["conversation"]["status"], "completed");
    assert_eq!(messages["result"]["messages"][0]["role"], "user");
    assert_eq!(messages["result"]["messages"][0]["text"], "Say hello");
    let previous_duration = messages["result"]["conversation"]["durationMs"]
        .as_u64()
        .unwrap();
    store
        .control("resume", &job.id, SymphonyControl::Run)
        .unwrap();
    let resumed = store.reserve(ash_symphony::now()).unwrap().remove(0);
    let observed = server.advance_symphony(&resumed, &token).unwrap();
    assert_eq!(observed.thread_id, thread_id);
    assert_ne!(observed.turn_id, first.turn_id);
    store
        .observe(&resumed, observed, ash_symphony::now())
        .unwrap();
    let read = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0","id":4,"method":"symphony/read","params":{}}),
    );
    assert!(
        read["result"]["conversations"][0]["durationMs"]
            .as_u64()
            .unwrap()
            >= previous_duration
    );
}

#[test]
fn paused_reservation_never_starts_a_thread() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("WORKFLOW.md");
    std::fs::write(&path, "{{ issue.title }}").unwrap();
    let workflow = Workflow::load(&path).unwrap();
    let store = Arc::new(Store::open(&root.path().join("state.db")).unwrap());
    store.configure("configure", workflow.clone()).unwrap();
    let id = store
        .submit("submit", &workflow.id, "Never start", "")
        .unwrap();
    let original = store.reserve(0).unwrap().remove(0);
    store.control("pause", &id, SymphonyControl::Pause).unwrap();
    let server = server().with_symphony_store(Arc::clone(&store), Arc::new(NoHttp));
    let observed = server
        .advance_symphony(&original, &CancellationSource::new().token())
        .unwrap();
    assert_eq!(observed.status, SymphonyTaskStatus::Paused);
    assert!(observed.thread_id.is_none());
    store.observe(&original, observed, 0).unwrap();
    assert_eq!(store.job(&id).unwrap().status, SymphonyTaskStatus::Paused);
}
