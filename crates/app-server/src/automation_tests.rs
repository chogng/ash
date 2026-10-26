use super::call;
use super::initialize;
use super::server;
use ash_automation::AutomationStore;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use ash_protocol::AutomationSession;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

fn create_run(
    store: &AutomationStore,
    directory: &std::path::Path,
    session: AutomationSession,
) -> AutomationRun {
    let now = ash_automation::now().unwrap();
    let request: ash_automation::AutomationWrite = serde_json::from_value(json!({
        "command_id":"create", "id":"test", "expected_revision":0, "status":"paused",
        "definition":{"title":"Test", "prompt":"Say hello", "directory":directory,
            "session":session, "schedule":{"type":"interval", "anchor":0, "minutes":60}}
    }))
    .unwrap();
    store.write(&request, now).unwrap();
    store.run_now("test", "manual", now).unwrap()
}

#[test]
fn automation_run_reads_return_current_state_and_reject_missing_or_invalid_ids() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let mut run = create_run(&store, dir.path(), AutomationSession::New);
    for (request_id, status) in [
        (2, AutomationRunStatus::Pending),
        (3, AutomationRunStatus::Completed),
    ] {
        run.status = status;
        if status.is_finished() {
            run.finished_at = Some(ash_automation::now().unwrap());
        }
        store.observe(&run).unwrap();
        let response = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":request_id, "method":"automation/run/read", "params":{"runId":run.id}}),
        );
        assert_eq!(
            response["result"],
            serde_json::to_value(&run).unwrap(),
            "{response}"
        );
    }
    let missing = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":4, "method":"automation/run/read", "params":{"runId":"missing"}}),
    );
    assert_eq!(missing["error"]["message"], "AutomationNotFound");
    for (request_id, params) in [(5, json!({})), (6, json!({"runId":1}))] {
        let invalid = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":request_id, "method":"automation/run/read", "params":params}),
        );
        assert_eq!(invalid["error"]["message"], "InvalidParams");
    }
}

#[test]
fn automation_session_deletion_stops_runs_even_before_first_observation() {
    for recorded in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
        let server =
            super::server_with_model(Arc::new(super::AppServerInteractiveModel::default()))
                .with_tool_service(
                    Arc::new(super::AppServerInteractiveTool),
                    Arc::new(super::ShellTestPolicy),
                )
                .with_automation_store(Arc::clone(&store));
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let mut observed = create_run(&store, dir.path(), AutomationSession::New);
        let deadline = Instant::now() + Duration::from_secs(5);
        while observed.status != AutomationRunStatus::NeedsInput && Instant::now() < deadline {
            observed = server
                .advance_automation_run(&observed, ash_automation::now().unwrap())
                .unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            observed.status,
            AutomationRunStatus::NeedsInput,
            "{observed:?}"
        );
        if recorded {
            store.observe(&observed).unwrap();
        }
        let deleted = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":2, "method":"session/request", "params":{
                "commandId":"delete", "sessionId":observed.session_id,
                "request":{"type":"delete"}
            }}),
        );
        assert_eq!(deleted["result"]["type"], "deleted", "{deleted}");
        assert!(store.active_runs().unwrap().is_empty());
        let stopped = store.runs("test", 50).unwrap().remove(0);
        assert_eq!(stopped.status, AutomationRunStatus::Stopped);
        assert!(stopped.finished_at.is_some());
        // A scheduler observation taken before deletion cannot revive the terminal run.
        store.observe(&observed).unwrap();
        assert!(store.active_runs().unwrap().is_empty());
        assert_eq!(store.stop_run(&stopped.id).unwrap(), stopped);
        let next = store
            .run_now("test", "next", ash_automation::now().unwrap())
            .unwrap();
        let stopping = store.stop_run(&next.id).unwrap();
        let stopped = server
            .advance_automation_run(&stopping, ash_automation::now().unwrap())
            .unwrap();
        store.observe(&stopped).unwrap();
        let deleted = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":3, "method":"automation/delete",
                "params":{"id":"test", "expectedRevision":1}}),
        );
        assert!(deleted.get("error").is_none(), "{deleted}");
    }
}

#[test]
fn automation_session_deletion_stops_pending_continuations() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = super::create_session(&server, &mut connection, 2, "target");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let run = create_run(
        &store,
        dir.path(),
        AutomationSession::Continue {
            session_id: ash_protocol::SessionId::new(session_id).unwrap(),
            thread_id: ash_protocol::ThreadId::new(session_id).unwrap(),
        },
    );
    let now = ash_automation::now().unwrap();
    let mut unrelated_definition = run.definition.clone();
    unrelated_definition.session = AutomationSession::New;
    store
        .write(
            &ash_automation::AutomationWrite {
                command_id: "create-unrelated".into(),
                id: "unrelated".into(),
                expected_revision: 0,
                definition: unrelated_definition,
                status: ash_protocol::AutomationStatus::Paused,
            },
            now,
        )
        .unwrap();
    let unrelated = store.run_now("unrelated", "unrelated", now).unwrap();
    server.drain_notifications(&mut connection);
    let deleted = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "jsonrpc":"2.0", "id":3, "method":"session/request", "params":{
            "commandId":"delete", "sessionId":session_id, "request":{"type":"delete"}
        }}),
    );
    assert_eq!(deleted["result"]["type"], "deleted", "{deleted}");
    assert_eq!(store.active_runs().unwrap(), vec![unrelated]);
    assert!(
        server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| notification.contains("\"method\":\"automation/changed\""))
    );
    assert_eq!(
        store.stop_run(&run.id).unwrap().status,
        AutomationRunStatus::Stopped
    );
}

#[test]
fn automation_missing_target_is_terminal_including_after_a_stop_request() {
    for stopping in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
        let server = server();
        let mut run = create_run(
            &store,
            dir.path(),
            AutomationSession::Continue {
                session_id: ash_protocol::SessionId::new("deleted").unwrap(),
                thread_id: ash_protocol::ThreadId::new("deleted").unwrap(),
            },
        );
        // Also exercise a run whose target was already observed before it disappeared.
        if stopping {
            run.session_id = Some(ash_protocol::SessionId::new("deleted").unwrap());
            run.thread_id = Some(ash_protocol::ThreadId::new("deleted").unwrap());
            store.observe(&run).unwrap();
            run = store.stop_run(&run.id).unwrap();
        }
        let now = ash_automation::now().unwrap();
        let observed = server.advance_automation_run(&run, now).unwrap();
        assert_eq!(observed.status, AutomationRunStatus::Stopped);
        assert_eq!(observed.finished_at, Some(now));
        store.observe(&observed).unwrap();
        assert!(store.active_runs().unwrap().is_empty());
        store.run_now("test", "next", now).unwrap();
    }
}

#[test]
fn automation_preview_validates_rules_without_creating_plans_or_runs() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let result = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"automation/preview",
            "params":{"schedule":{"type":"interval","anchor":0,"minutes":60}}
        }),
    );
    let times = result["result"]["occurrences"].as_array().unwrap();
    assert_eq!(times.len(), 3);
    assert_eq!(
        times[1].as_u64().unwrap() - times[0].as_u64().unwrap(),
        3_600_000
    );
    assert!(store.list().unwrap().is_empty());
    let invalid = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"automation/preview",
            "params":{"schedule":{"type":"weekly","timezone":"Invalid/Zone","weekdays":[1],"hour":9,"minute":0}}
        }),
    );
    assert_eq!(invalid["error"]["message"], "InvalidParams");
}

#[test]
fn automation_commands_are_shared_across_connections_and_reject_stale_edits() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(store);
    let mut first = server.connection();
    let mut second = server.connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    let params = json!({
        "commandId": "create", "id": "build", "expectedRevision": 0, "status": "paused",
        "definition": {"title": "Check build", "prompt": "Say hello", "directory": dir.path(),
            "session": {"type":"new"}, "schedule": {"type":"interval", "anchor": 0, "minutes": 60}}
    });
    let created = call(
        &server,
        &mut first,
        json!({"jsonrpc":"2.0", "id":2, "method":"automation/write", "params":params}),
    );
    assert_eq!(created["result"]["revision"], 1, "{created}");
    let list = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0", "id":2, "method":"automation/list", "params":{}}),
    );
    assert_eq!(list["result"]["automations"], json!([created["result"]]));
    let mut stale = params;
    stale["commandId"] = json!("stale");
    let rejected = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0", "id":3, "method":"automation/write", "params":stale}),
    );
    assert_eq!(rejected["error"]["message"], "AutomationConflict");
}

#[test]
fn automation_retry_reconciles_the_same_accepted_turn() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":2, "method":"automation/write", "params":{
            "commandId":"create", "id":"hello", "expectedRevision":0, "status":"paused",
            "definition":{"title":"Hello", "prompt":"Say hello", "directory":dir.path(), "session":{"type":"new"},
                "schedule":{"type":"interval", "anchor":0, "minutes":60}}
        }}),
    );
    assert!(created.get("error").is_none(), "{created}");
    let dispatched = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":3, "method":"automation/run", "params":{"id":"hello", "commandId":"manual"}}),
    );
    let original: AutomationRun = serde_json::from_value(dispatched["result"].clone()).unwrap();
    let first = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    let retry = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(first.thread_id, retry.thread_id);
    assert_eq!(first.turn_id, retry.turn_id);
    assert!(first.turn_id.is_some(), "{first:?}");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut observed = retry;
    while !observed.status.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
        observed = server
            .advance_automation_run(&observed, ash_automation::now().unwrap())
            .unwrap();
    }
    assert_eq!(
        observed.status,
        AutomationRunStatus::Completed,
        "{observed:?}"
    );
    assert!(observed.started_at <= observed.finished_at);
}

#[test]
fn automation_stopped_before_dispatch_does_not_create_a_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let now = ash_automation::now().unwrap();
    let request: ash_automation::AutomationWrite = serde_json::from_value(json!({
        "command_id": "create", "id": "stopped", "expected_revision": 0, "status": "paused",
        "definition": { "title": "Stopped", "prompt": "Must not run", "directory": dir.path(),
            "session": { "type": "new" }, "schedule": { "type": "interval", "anchor": 0, "minutes": 60 } }
    })).unwrap();
    store.write(&request, now).unwrap();
    let run = store.run_now("stopped", "manual", now).unwrap();
    let stopping = store.stop_run(&run.id).unwrap();
    let stopped = server.advance_automation_run(&stopping, now).unwrap();
    assert_eq!(stopped.status, AutomationRunStatus::Stopped);
    assert!(stopped.thread_id.is_none());
    assert!(stopped.turn_id.is_none());
    assert_eq!(stopped.finished_at, Some(now));
}

#[test]
fn automation_uses_its_directory_after_another_profile_environment_opens() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let other_directory = tempfile::tempdir().unwrap();
    let runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
    let open = |directory: &std::path::Path| {
        crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::clone(&runtime))
                .with_dir_root(directory)
                .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(
                    Arc::new(super::EchoModel),
                )))
                .without_built_in_skills(),
            ash_app_server_diff::compute,
        )
        .unwrap()
    };
    let automation_server = open(directory.path());
    let _other_server = open(other_directory.path());
    let store = runtime.automation_store();
    let now = ash_automation::now().unwrap();
    let request: ash_automation::AutomationWrite = serde_json::from_value(json!({
        "command_id": "create", "id": "directory", "expected_revision": 0, "status": "paused",
        "definition": {"title": "Own directory", "prompt": "Say hello", "directory": directory.path(),
            "session": {"type": "new"}, "schedule": {"type": "interval", "anchor": 0, "minutes": 60}}
    })).unwrap();
    store.write(&request, now).unwrap();
    let mut observed = store.run_now("directory", "manual", now).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !observed.status.is_finished() && Instant::now() < deadline {
        observed = automation_server
            .advance_automation_run(&observed, ash_automation::now().unwrap())
            .unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        observed.status,
        AutomationRunStatus::Completed,
        "{observed:?}"
    );
    assert!(observed.turn_id.is_some());
}

#[derive(Default)]
struct FollowUpAccounts {
    revision: std::sync::atomic::AtomicU64,
}
impl github::GitHubCredentialProvider for FollowUpAccounts {
    fn authorization(&self) -> Result<github::GitHubAuthorization, ash_login::LoginError> {
        Ok(github::GitHubAuthorization {
            host: "github.com".into(),
            account_id: "account".into(),
            grant_id: "grant".into(),
        })
    }
    fn token(
        &self,
        _: &github::GitHubAuthorization,
    ) -> Result<ash_secrets::SecretValue, ash_login::LoginError> {
        Ok(ash_secrets::SecretValue::new(b"fixture-only".to_vec()))
    }
}
impl github::GitHubAccountManager for FollowUpAccounts {
    fn accounts(&self) -> Result<Vec<github::GitHubAccount>, ash_login::LoginError> {
        Ok(vec![github::GitHubAccount {
            id: "account".into(),
            host: "github.com".into(),
            login: "fixture".into(),
            status: ash_login::AccountStatus::Ready,
            credential_revision: 1 + self.revision.load(std::sync::atomic::Ordering::SeqCst),
        }])
    }
    fn connect_token(
        &self,
        _: &str,
        _: ash_secrets::SecretValue,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<github::GitHubAccount, ash_login::LoginError> {
        Err(ash_login::LoginError::new(
            ash_login::LoginErrorKind::Unavailable,
            "unused",
        ))
    }
}

#[derive(Default)]
struct FollowUpApi {
    head: std::sync::atomic::AtomicUsize,
    before_checks: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl github::GitHubProvider for FollowUpApi {
    fn call(
        &self,
        authorization: Option<github::GitHubAuthorization>,
        request: github::GitHubRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> github::Result<github::GitHubResponse> {
        assert_eq!(authorization.unwrap().account_id, "account");
        match request {
            github::GitHubRequest::PullRequest { .. } => {
                let head = if self.head.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    "a"
                } else {
                    "b"
                }
                .repeat(40);
                Ok(github::GitHubResponse::PullRequest(serde_json::from_value(json!({
                    "number":7,"node_id":"node","title":"PR","body":null,"html_url":"https://github.com/team/repo/pull/7",
                    "state":"open","draft":false,"merged_at":null,"mergeable":true,
                    "head":{"sha":head,"ref":"topic","repo":null}, "base":{"sha":"base","ref":"main","repo":null}
                })).unwrap()))
            }
            github::GitHubRequest::Checks { .. } => {
                if let Some(callback) = self.before_checks.lock().unwrap().take() {
                    callback();
                }
                Ok(github::GitHubResponse::Checks(github::CheckStatus {
                    state: "failure".into(),
                    statuses: vec![],
                    next_page: None,
                    checks: vec![github::CheckRun {
                        id: 3,
                        name: "build".into(),
                        status: "completed".into(),
                        conclusion: Some("failure".into()),
                        details_url: None,
                    }],
                }))
            }
            github::GitHubRequest::CheckDetails { .. } => {
                Ok(github::GitHubResponse::CheckDetails(github::CheckDetails {
                    title: "Build failed".into(),
                    summary: "Compiler diagnostics".into(),
                    text: "src/main.rs:3: missing value".into(),
                    annotations: vec![],
                    next_page: None,
                    actions_job: true,
                }))
            }
            _ => panic!("unexpected follow-up operation"),
        }
    }
}

fn follow_up_plan(
    store: &AutomationStore,
    directory: &std::path::Path,
    session_id: &str,
) -> AutomationRun {
    let now = ash_automation::now().unwrap();
    let request = serde_json::from_value(json!({
        "command_id":"create-follow-up", "id":"follow-up", "expected_revision":0, "status":"enabled",
        "definition":{"title":"Follow PR", "prompt":"Fix this CI failure using normal permissions", "directory":directory,
            "session":{"type":"continue","sessionId":session_id,"threadId":session_id},
            "schedule":{"type":"interval","anchor":0,"minutes":1},
            "condition":{"type":"gitHubChecks","host":"github.com","owner":"team","repository":"repo", "number":7,
                "accountId":"account","credentialRevision":"1"}}
    })).unwrap();
    store.write(&request, now).unwrap();
    store.run_now("follow-up", "first-check", now).unwrap()
}

fn open_follow_up_server(
    profile: &std::path::Path,
    directory: &std::path::Path,
    api: Arc<FollowUpApi>,
) -> (crate::AppServer, Arc<AutomationStore>) {
    let runtime = Arc::new(crate::LocalProfileRuntime::open(profile).unwrap());
    let store = runtime.automation_store();
    let server = crate::open_app_server(
        crate::AppServerOptions::new(profile)
            .with_profile_runtime(runtime)
            .with_dir_root(directory)
            .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(Arc::new(
                super::EchoModel,
            ))))
            .without_built_in_skills(),
        ash_app_server_diff::compute,
    )
    .unwrap()
    .with_github_accounts(Arc::new(FollowUpAccounts::default()))
    .with_github_provider(Arc::new(FollowUpAccounts::default()), api)
    .unwrap();
    (server, store)
}

#[test]
fn pr_follow_up_sequence_conflict_retries_the_reserved_head_even_after_restart() {
    let initialize = |server: &crate::AppServer, connection: &mut crate::ConnectionState| {
        let response = call(
            server,
            connection,
            json!({"jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{"clientInfo":{"name":"test","version":"1"}}}),
        );
        assert!(response.get("error").is_none(), "{response}");
    };
    for restart in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let api = Arc::new(FollowUpApi::default());
        let open = || {
            let (server, store) =
                open_follow_up_server(profile.path(), directory.path(), api.clone());
            (Arc::new(server), store)
        };
        let (server, store) = open();
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let created = super::create_session(&server, &mut connection, 2, "source");
        let session_id = created["result"]["session"]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let original = follow_up_plan(&store, directory.path(), &session_id);
        let user_server = server.clone();
        let user_session = session_id.clone();
        *api.before_checks.lock().unwrap() = Some(Box::new(move || {
            // Complete a real user Turn after automation captured the sequence, but
            // before GitHub returns its checks. No timing sleeps control this race.
            let mut connection = user_server.connection();
            initialize(&user_server, &mut connection);
            let response = call(
                &user_server,
                &mut connection,
                json!({"jsonrpc":"2.0", "id":3, "method":"session/request", "params":{
                    "commandId":"user-message", "sessionId":user_session,
                    "request":{"type":"startTurn", "threadId":user_session, "expectedSequence":1,
                        "input":[{"type":"text", "text":"User message during the GitHub check"}]}
                }}),
            );
            assert!(response.get("error").is_none(), "{response}");
            super::wait_for_latest_turn(
                &user_server,
                &user_session,
                ash_protocol::TurnStatus::Completed,
            );
        }));
        let rejected = server
            .advance_automation_run(&original, ash_automation::now().unwrap())
            .unwrap();
        assert_eq!(
            rejected.status,
            AutomationRunStatus::Pending,
            "{rejected:?}"
        );
        assert!(rejected.turn_id.is_none());
        assert!(rejected.finished_at.is_none());
        assert!(rejected.event.is_some());
        store.observe(&rejected).unwrap();
        assert!(matches!(
            store.run_now(
                "follow-up",
                "concurrent-check",
                ash_automation::now().unwrap()
            ),
            Err(ash_automation::AutomationError::Busy)
        ));
        let (server, store) = if restart {
            drop(connection);
            drop(server);
            drop(store);
            open()
        } else {
            (server, store)
        };
        assert_eq!(store.get_run(&original.id).unwrap().event, rejected.event);
        let retried = server
            .advance_automation_run(&original, ash_automation::now().unwrap())
            .unwrap();
        assert!(retried.turn_id.is_some(), "{retried:?}");
        assert_eq!(retried.event, rejected.event);
        super::wait_for_latest_turn(&server, &session_id, ash_protocol::TurnStatus::Completed);
        let completed = server
            .advance_automation_run(&original, ash_automation::now().unwrap())
            .unwrap();
        assert_eq!(completed.status, AutomationRunStatus::Completed);
        assert_eq!(completed.turn_id, retried.turn_id);
        store.observe(&completed).unwrap();
        let next = store
            .run_now("follow-up", "same-head", ash_automation::now().unwrap())
            .unwrap();
        let skipped = server
            .advance_automation_run(&next, ash_automation::now().unwrap())
            .unwrap();
        assert_eq!(skipped.status, AutomationRunStatus::Skipped);
        assert!(skipped.turn_id.is_none());
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let thread = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":4, "method":"session/thread/read",
                "params":{"sessionId":session_id,"threadId":session_id}}),
        );
        assert_eq!(
            thread["result"]["thread"]["turns"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}

struct FollowUpStartFailure {
    starts: std::sync::atomic::AtomicUsize,
    error: core_api::CoreError,
}

impl ash_core::TurnExecutionBackend for FollowUpStartFailure {
    fn start(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
    ) -> Result<(), core_api::CoreError> {
        self.starts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(self.error.clone())
    }

    fn resume(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
    ) -> Result<(), core_api::CoreError> {
        panic!("a failed start must not resume")
    }
}

#[test]
fn pr_follow_up_accepted_start_errors_keep_the_receipt_and_head_reserved_across_restart() {
    for error in [
        core_api::CoreError::Execution("backend outcome unavailable".into()),
        core_api::CoreError::ThreadStore(thread_store::ThreadStoreError::SequenceConflict {
            expected: 1,
            actual: 2,
        }),
    ] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let api = Arc::new(FollowUpApi::default());
        let backend = Arc::new(FollowUpStartFailure {
            starts: std::sync::atomic::AtomicUsize::new(0),
            error,
        });
        let open = || {
            let (server, store) =
                open_follow_up_server(profile.path(), directory.path(), api.clone());
            (server.with_turn_backend(backend.clone()), store)
        };
        let (server, store) = open();
        let mut connection = server.connection();
        let initialized = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":1,
            "method":"initialize", "params":{"clientInfo":{"name":"test","version":"1"}}}),
        );
        assert!(initialized.get("error").is_none(), "{initialized}");
        let created = super::create_session(&server, &mut connection, 2, "source");
        let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
        let original = follow_up_plan(&store, directory.path(), session_id);
        let first = server
            .advance_automation_run(&original, ash_automation::now().unwrap())
            .unwrap();
        assert_eq!(first.status, AutomationRunStatus::Failed, "{first:?}");
        assert!(first.turn_id.is_some());
        // Lose the scheduler observation: recovery must use the acceptance receipt,
        // including when the backend reported the same error as a rejected admission.
        assert!(store.get_run(&original.id).unwrap().turn_id.is_none());
        drop(connection);
        drop(server);
        drop(store);
        let (server, store) = open();
        let recovered = server
            .advance_automation_run(&original, ash_automation::now().unwrap())
            .unwrap();
        assert_eq!(recovered.status, AutomationRunStatus::Failed);
        assert_eq!(recovered.turn_id, first.turn_id);
        store.observe(&recovered).unwrap();
        let next = store
            .run_now("follow-up", "same-head", ash_automation::now().unwrap())
            .unwrap();
        let skipped = server
            .advance_automation_run(&next, ash_automation::now().unwrap())
            .unwrap();
        assert_eq!(skipped.status, AutomationRunStatus::Skipped);
        assert!(skipped.turn_id.is_none());
        assert_eq!(backend.starts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}

struct UncertainFollowUpCatalog;

impl crate::model_catalog::ModelCatalog for UncertainFollowUpCatalog {
    fn set_preferences(
        &self,
        _: crate::model_catalog::ModelPreferencesCommand,
    ) -> Result<ash_config::ConfigCommandResult, crate::model_catalog::ModelPreferencesError> {
        unreachable!("this fixture does not accept preference writes")
    }

    fn list(
        &self,
    ) -> Result<Vec<ash_app_server_protocol::protocol::model::ModelCatalogEntry>, core_api::CoreError>
    {
        Ok(Vec::new())
    }

    fn current_access(
        &self,
        _: &ash_protocol::ModelRef,
    ) -> Result<ash_protocol::ModelAccess, core_api::CoreError> {
        Ok(ash_protocol::ModelAccess::Unknown)
    }

    fn configured_default(&self) -> Result<Option<ash_protocol::ModelRef>, core_api::CoreError> {
        Err(core_api::CoreError::Execution(
            "command outcome unavailable".into(),
        ))
    }
}

#[test]
fn pr_follow_up_unclassified_start_error_without_acceptance_keeps_the_head_reserved() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let api = Arc::new(FollowUpApi::default());
    let (server, store) = open_follow_up_server(profile.path(), directory.path(), api.clone());
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":1,
        "method":"initialize", "params":{"clientInfo":{"name":"test","version":"1"}}}),
    );
    assert!(initialized.get("error").is_none(), "{initialized}");
    let created = super::create_session(&server, &mut connection, 2, "source");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let original = follow_up_plan(&store, directory.path(), session_id);
    let server = server.with_model_catalog(Arc::new(UncertainFollowUpCatalog));
    let failed = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(failed.status, AutomationRunStatus::Failed, "{failed:?}");
    assert!(failed.turn_id.is_none());
    assert!(failed.event.is_some());
    assert!(
        server
            .threads()
            .read_thread(&ash_protocol::ThreadId::new(session_id).unwrap())
            .unwrap()
            .turns
            .is_empty()
    );
    store.observe(&failed).unwrap();
    drop(connection);
    drop(server);
    drop(store);
    // No receipt plus an unclassified error is insufficient evidence to release a
    // claim. Even a healthy execution owner after restart must deduplicate this head.
    let (server, store) = open_follow_up_server(profile.path(), directory.path(), api);
    let recovered = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(recovered, failed);
    let next = store
        .run_now("follow-up", "same-head", ash_automation::now().unwrap())
        .unwrap();
    let skipped = server
        .advance_automation_run(&next, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(skipped.status, AutomationRunStatus::Skipped);
    assert!(skipped.turn_id.is_none());
    assert!(
        server
            .threads()
            .read_thread(&ash_protocol::ThreadId::new(session_id).unwrap())
            .unwrap()
            .turns
            .is_empty()
    );
}

#[test]
fn pr_follow_up_restart_recovers_the_original_turn_and_next_poll_deduplicates_the_head() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let api = Arc::new(FollowUpApi::default());
    let open = || {
        let runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
        let store = runtime.automation_store();
        let server = crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .with_profile_runtime(runtime)
                .with_dir_root(directory.path())
                .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(
                    Arc::new(super::EchoModel),
                )))
                .without_built_in_skills(),
            ash_app_server_diff::compute,
        )
        .unwrap()
        .with_github_accounts(Arc::new(FollowUpAccounts::default()))
        .with_github_provider(Arc::new(FollowUpAccounts::default()), api.clone())
        .unwrap();
        (server, store)
    };
    let (server, store) = open();
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"test","version":"1"}}
        }),
    );
    assert_eq!(
        initialized["result"]["capabilities"]["contracts"]["automationConditions"]["version"],
        1
    );

    let created = super::create_session(&server, &mut connection, 2, "source");
    let session_id = created["result"]["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let original = follow_up_plan(&store, directory.path(), &session_id);
    let first = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    assert!(first.turn_id.is_some(), "{first:?}");
    assert_eq!(
        first.session_id.as_ref().map(|id| id.as_str()),
        Some(session_id.as_str())
    );
    // Simulate losing the scheduler observation after the Turn was accepted. Only the event reservation is saved.
    assert!(store.get_run(&original.id).unwrap().turn_id.is_none());
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut observed = first.clone();
    while !observed.status.is_finished() && Instant::now() < deadline {
        observed = server
            .advance_automation_run(&original, ash_automation::now().unwrap())
            .unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(observed.status, AutomationRunStatus::Completed);
    drop(connection);
    drop(server);
    drop(store);
    let (server, store) = open();
    let recovered = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(recovered.turn_id, first.turn_id);
    assert_eq!(recovered.status, AutomationRunStatus::Completed);
    store.observe(&recovered).unwrap();
    let next = store
        .run_now("follow-up", "same-head", ash_automation::now().unwrap())
        .unwrap();
    let skipped = server
        .advance_automation_run(&next, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(skipped.status, AutomationRunStatus::Skipped);
    assert!(skipped.turn_id.is_none());
    store.observe(&skipped).unwrap();
    api.head.store(1, std::sync::atomic::Ordering::SeqCst);
    let next = store
        .run_now("follow-up", "new-head", ash_automation::now().unwrap())
        .unwrap();
    let dispatched = server
        .advance_automation_run(&next, ash_automation::now().unwrap())
        .unwrap();
    assert!(dispatched.turn_id.is_some());
    assert_ne!(dispatched.turn_id, recovered.turn_id);
}

#[test]
fn pr_follow_up_stop_during_provider_read_prevents_any_agent_turn() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&directory.path().join("automation.db")).unwrap());
    let api = Arc::new(FollowUpApi::default());
    let server = server()
        .with_automation_store(store.clone())
        .with_github_accounts(Arc::new(FollowUpAccounts::default()))
        .with_github_provider(Arc::new(FollowUpAccounts::default()), api.clone())
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = super::create_session(&server, &mut connection, 2, "source");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let run = follow_up_plan(&store, directory.path(), session_id);
    let stopping_store = store.clone();
    let run_id = run.id.clone();
    *api.before_checks.lock().unwrap() = Some(Box::new(move || {
        stopping_store.stop_run(&run_id).unwrap();
    }));
    let observed = server
        .advance_automation_run(&run, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(observed.status, AutomationRunStatus::Stopped);
    assert!(observed.turn_id.is_none());
    assert!(store.get_run(&run.id).unwrap().event.is_none());
    store.observe(&observed).unwrap();
    let deleted = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"session/request", "params":{"commandId":"delete-source", "sessionId":session_id, "request":{"type":"delete"}}
        }),
    );
    assert!(deleted.get("error").is_none(), "{deleted}");
    assert_eq!(
        store.list().unwrap()[0].status,
        ash_protocol::AutomationStatus::Paused
    );
}

#[test]
fn pr_follow_up_stops_the_accepted_turn_without_starting_another() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&directory.path().join("automation.db")).unwrap());
    let server = super::server_with_model(Arc::new(super::AppServerInteractiveModel::default()))
        .with_tool_service(
            Arc::new(super::AppServerInteractiveTool),
            Arc::new(super::ShellTestPolicy),
        )
        .with_automation_store(store.clone())
        .with_github_accounts(Arc::new(FollowUpAccounts::default()))
        .with_github_provider(
            Arc::new(FollowUpAccounts::default()),
            Arc::new(FollowUpApi::default()),
        )
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = super::create_session(&server, &mut connection, 2, "source");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let run = follow_up_plan(&store, directory.path(), session_id);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut observed = run;
    while observed.status != AutomationRunStatus::NeedsInput && Instant::now() < deadline {
        observed = server
            .advance_automation_run(&observed, ash_automation::now().unwrap())
            .unwrap();
        store.observe(&observed).unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(observed.status, AutomationRunStatus::NeedsInput);
    let original_turn = observed.turn_id.clone();
    let stopped = call(
        &server,
        &mut connection,
        json!({ "jsonrpc":"2.0", "id":3,
        "method":"automation/stop", "params":{"runId":observed.id} }),
    );
    assert!(stopped.get("error").is_none(), "{stopped}");
    let thread = call(
        &server,
        &mut connection,
        json!({ "jsonrpc":"2.0", "id":4,
        "method":"session/thread/read", "params":{"sessionId":session_id,"threadId":session_id} }),
    );
    let status = thread["result"]["thread"]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|turn| turn["turnId"] == json!(original_turn))
        .unwrap()["status"]
        .as_str()
        .unwrap();
    assert!(
        ["cancelling", "interrupted"].contains(&status),
        "stop must reach the Turn before a scheduler tick: {thread}"
    );

    while !observed.status.is_finished() && Instant::now() < deadline {
        observed = server
            .advance_automation_run(&observed, ash_automation::now().unwrap())
            .unwrap();
        store.observe(&observed).unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(observed.status, AutomationRunStatus::Stopped);
    assert_eq!(observed.turn_id, original_turn);
}

#[test]
fn pr_follow_up_account_change_during_observation_cannot_grant_a_repair() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&directory.path().join("automation.db")).unwrap());
    let api = Arc::new(FollowUpApi::default());
    let accounts = Arc::new(FollowUpAccounts::default());
    let server = server()
        .with_automation_store(store.clone())
        .with_github_accounts(accounts.clone())
        .with_github_provider(accounts.clone(), api.clone())
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = super::create_session(&server, &mut connection, 2, "source");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let run = follow_up_plan(&store, directory.path(), session_id);
    *api.before_checks.lock().unwrap() = Some(Box::new(move || {
        accounts
            .revision
            .store(1, std::sync::atomic::Ordering::SeqCst);
    }));
    let error = server
        .advance_automation_run(&run, ash_automation::now().unwrap())
        .unwrap_err();
    assert!(error.contains("account changed"), "{error}");
    assert!(store.get_run(&run.id).unwrap().event.is_none());
    let thread = call(
        &server,
        &mut connection,
        json!({ "jsonrpc":"2.0", "id":3,
        "method":"session/thread/read", "params":{"sessionId":session_id,"threadId":session_id} }),
    );
    assert_eq!(thread["result"]["thread"]["turns"], json!([]));
}
