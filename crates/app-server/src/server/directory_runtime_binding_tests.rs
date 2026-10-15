use ash_async_utils::CancellationToken;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::TurnStatus;
use core_api::CoreError;
use core_api::ModelSelection;
use core_api::ModelService;
use serde_json::json;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

#[derive(Clone, Copy, Debug)]
enum DirectoryKind {
    Git,
    Plain,
}

#[derive(Clone, Copy, Debug)]
enum CreationRuntime {
    Executing,
    TrustedNode,
    ForeignDirectory,
}

struct BindingModel(AtomicUsize);

impl ModelService for BindingModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("The managed directory is ready.".into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

fn run_directory_binding(kind: DirectoryKind, creation: CreationRuntime) {
    let profile = tempfile::Builder::new()
        .prefix("ash-a-binding-repro-profile-")
        .tempdir()
        .unwrap();
    let source = tempfile::Builder::new()
        .prefix("ash-a-binding-repro-workspace-")
        .tempdir()
        .unwrap();
    std::fs::write(source.path().join("main.ts"), "const value = 1;\n").unwrap();
    if let DirectoryKind::Git = kind {
        for args in [
            vec!["init", "-b", "main"],
            vec!["add", "main.ts"],
            vec!["commit", "-m", "Isolated binding baseline"],
        ] {
            let output = Command::new("git")
                .current_dir(source.path())
                .args([
                    "-c",
                    "user.name=Ash Binding Test",
                    "-c",
                    "user.email=ash-binding@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    let profile_runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
    let model = Arc::new(BindingModel(AtomicUsize::new(0)));
    let open = |directory: &std::path::Path| {
        crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::clone(&profile_runtime))
                .with_dir_root(directory)
                .without_built_in_skills()
                .with_agent_model_service(model.clone()),
        )
        .unwrap()
        .with_model_catalog(crate::model_catalog::unavailable_model_catalog())
    };
    // Browser's Directory runtime is already open when trusted Node creates the Thread.
    let other_source = tempfile::Builder::new()
        .prefix("ash-a-binding-repro-other-scope-")
        .tempdir()
        .unwrap();
    let execution_source = match creation {
        CreationRuntime::Executing | CreationRuntime::TrustedNode => source.path(),
        CreationRuntime::ForeignDirectory => other_source.path(),
    };
    let executing = open(execution_source);
    let trusted_node = match creation {
        CreationRuntime::Executing => None,
        CreationRuntime::TrustedNode | CreationRuntime::ForeignDirectory => {
            Some(open(source.path()))
        }
    };
    let creator = trusted_node.as_ref().unwrap_or(&executing);
    let mut seed = creator.product_host_connection();
    let mut browser = executing.browser_connection();
    for (server, connection, capabilities) in [
        (
            creator,
            &mut seed,
            json!({"directoryGrantsHost":{"version":1}}),
        ),
        (
            &executing,
            &mut browser,
            json!({"agentInteractions":{"version":1,"kinds":["approval","userInput"]}}),
        ),
    ] {
        let response = crate::tests::call(
            server,
            connection,
            json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
                    "clientInfo":{"name":"directory-binding-regression","version":"1"},
                    "capabilities":capabilities
                }
            }),
        );
        assert!(response.get("result").is_some(), "{response}");
    }
    let created = crate::tests::call(
        creator,
        &mut seed,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"session/create", "params":{
                "commandId":"binding-session", "title":"Directory binding regression",
                "agent":{"type":"default"},
                "executionTarget":{"type":"local","root":source.path()}
            }
        }),
    );
    assert!(created.get("result").is_some(), "{created}");
    let session = created["result"]["session"]["sessionId"].as_str().unwrap();
    let thread_id = ThreadId::new(session).unwrap();
    let directory = creator
        .git_turn_changes
        .as_ref()
        .unwrap()
        .binding(&thread_id)
        .unwrap();
    let before_binding = executing
        .git_turn_changes
        .as_ref()
        .unwrap()
        .binding(&thread_id)
        .is_some();
    let started = crate::tests::call(
        &executing,
        &mut browser,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"session/request", "params":{
                "commandId":"binding-turn", "sessionId":session, "request":{
                    "type":"startTurn", "threadId":thread_id, "expectedSequence":1,
                    "input":[{"type":"text","text":"Use the managed directory."}]
                }
            }
        }),
    );
    assert!(started.get("result").is_some(), "{started}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let snapshot = loop {
        let snapshot = executing.threads().read_thread(&thread_id).unwrap();
        if snapshot.turns.last().is_some_and(|turn| {
            matches!(
                turn.status,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
            )
        }) {
            break snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "Turn did not reach a terminal state"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let turn = snapshot.turns.last().unwrap();
    let evidence = json!({
        "directoryKind":format!("{kind:?}"), "creationRuntime":format!("{creation:?}"),
        "profile":profile.path(), "workspace":source.path(),
        "managedDirectory":directory.dir(), "executingHadBinding":before_binding,
        "modelInvocations":model.0.load(Ordering::Relaxed),
        "status":turn.status, "error":turn.failure,
    });
    eprintln!("DIRECTORY_BINDING_EVIDENCE {evidence}");
    match creation {
        CreationRuntime::Executing | CreationRuntime::TrustedNode => {
            assert_eq!(turn.status, TurnStatus::Completed, "{evidence}");
            assert_eq!(model.0.load(Ordering::Relaxed), 1, "{evidence}");
            let recovered = executing
                .git_turn_changes
                .as_ref()
                .unwrap()
                .binding(&thread_id)
                .unwrap();
            assert_eq!(recovered.dir(), directory.dir());
            assert_eq!(recovered.baseline_tree(), directory.baseline_tree());
            assert_eq!(recovered.source_dir_id(), directory.source_dir_id());
            assert!(
                executing
                    .env_runtime
                    .read()
                    .unwrap()
                    .dir_grants
                    .thread_scope(&thread_id, ash_file_access::Permission::InspectRepository)
                    .unwrap()
                    .is_some()
            );
        }
        CreationRuntime::ForeignDirectory => {
            assert_eq!(turn.status, TurnStatus::Failed, "{evidence}");
            assert_eq!(model.0.load(Ordering::Relaxed), 0, "{evidence}");
            assert_eq!(
                turn.failure.as_ref().unwrap().code,
                ash_protocol::StableTurnErrorCode::WorktreeCaptureFailed
            );
            assert!(
                executing
                    .git_turn_changes
                    .as_ref()
                    .unwrap()
                    .binding(&thread_id)
                    .is_none()
            );
            assert!(
                executing
                    .env_runtime
                    .read()
                    .unwrap()
                    .dir_grants
                    .thread_scope(&thread_id, ash_file_access::Permission::ReadFiles)
                    .unwrap()
                    .is_none()
            );
        }
    }
    assert_eq!(
        std::fs::read_to_string(directory.dir().join("main.ts")).unwrap(),
        "const value = 1;\n"
    );
    executing.close_connection(browser);
    creator.close_connection(seed);
}

#[test]
fn shared_profile_directory_binding_same_runtime_git() {
    run_directory_binding(DirectoryKind::Git, CreationRuntime::Executing);
}

#[test]
fn shared_profile_directory_binding_cross_runtime_git() {
    run_directory_binding(DirectoryKind::Git, CreationRuntime::TrustedNode);
}

#[test]
fn shared_profile_directory_binding_same_runtime_plain() {
    run_directory_binding(DirectoryKind::Plain, CreationRuntime::Executing);
}

#[test]
fn shared_profile_directory_binding_cross_runtime_plain() {
    run_directory_binding(DirectoryKind::Plain, CreationRuntime::TrustedNode);
}

#[test]
fn shared_profile_directory_binding_rejects_foreign_scope() {
    for kind in [DirectoryKind::Git, DirectoryKind::Plain] {
        run_directory_binding(kind, CreationRuntime::ForeignDirectory);
    }
}
