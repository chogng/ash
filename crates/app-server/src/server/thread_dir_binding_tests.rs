use super::*;
use crate::AppServerOptions;
use crate::SessionStateMode;
use crate::open_app_server;
use ash_protocol::AgentId;
use ash_protocol::CommandId;
use ash_protocol::DelegationId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::process::Command;

fn git(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(directory)
        .args([
            "-c",
            "user.name=Binding test",
            "-c",
            "user.email=binding@example.test",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn parallel_spawn_without_intent_fails_before_allocating_a_directory() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_codex_home(profile.path().join("codex"))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(directory.path()),
    )
    .unwrap();
    let runtime = server.git_turn_changes.as_ref().unwrap();
    let mut request = ThreadWorktreeBindingRequest {
        session_id: SessionId::new("binding-session").unwrap(),
        thread_id: ThreadId::new("binding-child").unwrap(),
        origin: ThreadOrigin::AgentSpawn {
            parent_thread_id: ThreadId::new("binding-parent").unwrap(),
            parent_sequence: 1,
            delegation_id: DelegationId::new("parallel-missing-intent").unwrap(),
        },
        branch_name: None,
    };
    assert!(
        matches!(runtime.provision(&request), Err(CoreError::Policy(message)) if message.contains("immutable binding intent"))
    );
    assert!(runtime.binding(&request.thread_id).is_none());
    // Ordinary delegation keeps its existing parent-directory validation.
    request.origin = ThreadOrigin::AgentSpawn {
        parent_thread_id: ThreadId::new("binding-parent").unwrap(),
        parent_sequence: 1,
        delegation_id: DelegationId::new("ordinary-delegation").unwrap(),
    };
    assert!(
        matches!(runtime.provision(&request), Err(CoreError::Journal(message)) if message.contains("no dir binding"))
    );
}

#[test]
fn parallel_spawn_uses_the_durable_frozen_tree_after_the_parent_changes() {
    let profile = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    git(
        repository.path(),
        &["init", "--quiet", "--initial-branch=main"],
    );
    git(repository.path(), &["config", "core.autocrlf", "false"]);
    std::fs::write(repository.path().join("tracked.txt"), "frozen\n").unwrap();
    git(repository.path(), &["add", "tracked.txt"]);
    git(repository.path(), &["commit", "--quiet", "-m", "baseline"]);
    let oid = git(repository.path(), &["rev-parse", "HEAD"]);
    let tree = git(repository.path(), &["rev-parse", "HEAD^{tree}"]);
    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_codex_home(profile.path().join("codex"))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(repository.path()),
    )
    .unwrap();
    let mut connection = server.connection();
    let mut call = |id, method, params| {
        let response: serde_json::Value = serde_json::from_str(
            &server.handle_json(
                &mut connection,
                &serde_json::json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
                    .to_string(),
            ),
        )
        .unwrap();
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    };
    call(
        1,
        "initialize",
        serde_json::json!({"clientInfo":{"name":"binding-test","version":"1"},"capabilities":{}}),
    );
    let result = call(
        2,
        "session/create",
        serde_json::json!({"commandId":"binding-root", "title":"Frozen binding", "executionTarget":{"type":"local","root":repository.path()}}),
    );
    let session = SessionId::new(result["session"]["sessionId"].as_str().unwrap()).unwrap();
    let root = ThreadId::new(
        result["session"]["threads"][0]["threadId"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let runtime = server.git_turn_changes.as_ref().unwrap();
    let run = workflows::ParallelDevelopment::new(
        "binding-run".into(),
        "Freeze two tasks".into(),
        tree.clone(),
        workflows::ParallelTarget {
            remote: "origin".into(),
            reference: "main".into(),
            expected_oid: oid.clone(),
        },
        ["a", "b"]
            .into_iter()
            .map(|id| workflows::ParallelTaskDefinition {
                id: id.into(),
                goal: format!("Task {id}"),
                allowed_paths: vec![format!("{id}.txt")],
                dependencies: vec![],
                checks: vec![workflows::CheckPlan {
                    key: "unit".into(),
                    program: "just".into(),
                    arguments: vec!["test".into()],
                    working_directory: String::new(),
                    timeout_ms: 1000,
                    environment_digest: format!("sha256:{}", "d".repeat(64)),
                    required: true,
                }],
            })
            .collect(),
    )
    .unwrap();
    runtime
        .workflows
        .create_parallel_development(
            &session,
            &root,
            &CommandId::new("binding-start").unwrap(),
            run.clone(),
        )
        .unwrap();
    let delegation = DelegationId::new("parallel-binding-worker").unwrap();
    runtime
        .workflows
        .put_parallel_binding_intent(
            &session,
            &root,
            &delegation,
            &workflows::ParallelBindingIntent {
                run_id: run.run_id().into(),
                task_id: "a".into(),
                snapshot_id: "baseline".into(),
                snapshot_digest: run.baseline_digest().unwrap(),
                source_thread: root.clone(),
                target_oid: oid.clone(),
                repository_trees: BTreeMap::from([(".".into(), tree.clone())]),
            },
        )
        .unwrap();
    let parent = runtime.binding(&root).unwrap();
    std::fs::write(parent.dir().join("tracked.txt"), "parent drift\n").unwrap();
    let request = ThreadWorktreeBindingRequest {
        session_id: session.clone(),
        thread_id: ThreadId::new("parallel-frozen-child").unwrap(),
        branch_name: None,
        origin: ThreadOrigin::AgentSpawn {
            parent_thread_id: root.clone(),
            parent_sequence: 1,
            delegation_id: delegation,
        },
    };
    runtime.provision(&request).unwrap();
    let child = runtime.binding(&request.thread_id).unwrap();
    assert_eq!(
        std::fs::read_to_string(child.dir().join("tracked.txt")).unwrap(),
        "frozen\n"
    );
    assert_eq!(git(child.dir(), &["rev-parse", "HEAD"]), oid);
    assert_eq!(
        std::fs::read_to_string(parent.dir().join("tracked.txt")).unwrap(),
        "parent drift\n"
    );
    runtime.provision(&request).unwrap();
    assert_eq!(
        runtime.binding(&request.thread_id).unwrap().dir(),
        child.dir()
    );

    server
        .threads
        .create_thread(ash_core::CreateThreadRequest {
            agent_id: AgentId::new("binding-worker").unwrap(),
            origin: request.origin.clone(),
            agent: None,
            session_id: session.clone(),
            thread_id: request.thread_id.clone(),
            title: "Candidate source".into(),
            execution_target: None,
        })
        .unwrap();
    std::fs::write(child.dir().join("a.txt"), "candidate\n").unwrap();
    git(child.dir(), &["add", "a.txt"]);
    let candidate = git(child.dir(), &["write-tree"]);
    let turn = TurnId::new("binding-turn").unwrap();
    runtime
        .workflows
        .mutate_parallel_development(
            &session,
            &root,
            run.run_id(),
            &CommandId::new("worker-start").unwrap(),
            1,
            workflows::ParallelMutation::StartWorker {
                task_id: "a".into(),
                attempt: workflows::WorkerAttempt {
                    thread_id: request.thread_id.clone(),
                    turn_id: turn.clone(),
                    delegation_id: DelegationId::new("parallel-binding-worker").unwrap(),
                    status: workflows::WorkerStatus::Running,
                },
            },
        )
        .unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    runtime
        .workflows
        .mutate_parallel_development(
            &session,
            &root,
            run.run_id(),
            &CommandId::new("candidate-record").unwrap(),
            2,
            workflows::ParallelMutation::RecordSnapshot {
                task_id: "a".into(),
                snapshot: workflows::ReviewSnapshot {
                    snapshot_id: "binding-candidate".into(),
                    digest: digest.clone(),
                    base_tree: tree,
                    candidate_tree: candidate.clone(),
                    source_thread: request.thread_id.clone(),
                    source_turn: turn,
                    source_sequence: 1,
                    changed_paths: vec!["a.txt".into()],
                },
            },
        )
        .unwrap();
    let review_delegation = DelegationId::new("parallel-binding-review").unwrap();
    runtime
        .workflows
        .put_parallel_binding_intent(
            &session,
            &root,
            &review_delegation,
            &workflows::ParallelBindingIntent {
                run_id: run.run_id().into(),
                task_id: "a".into(),
                snapshot_id: "binding-candidate".into(),
                snapshot_digest: digest,
                source_thread: request.thread_id.clone(),
                target_oid: oid.clone(),
                repository_trees: BTreeMap::from([(".".into(), candidate)]),
            },
        )
        .unwrap();
    std::fs::write(child.dir().join("a.txt"), "worker drift\n").unwrap();
    let review_request = ThreadWorktreeBindingRequest {
        session_id: session,
        thread_id: ThreadId::new("parallel-review-child").unwrap(),
        branch_name: None,
        origin: ThreadOrigin::AgentSpawn {
            parent_thread_id: root,
            parent_sequence: 1,
            delegation_id: review_delegation,
        },
    };
    runtime.provision(&review_request).unwrap();
    let reviewer = runtime.binding(&review_request.thread_id).unwrap();
    assert_eq!(
        std::fs::read_to_string(reviewer.dir().join("a.txt")).unwrap(),
        "candidate\n"
    );
    assert_eq!(git(reviewer.dir(), &["rev-parse", "HEAD"]), oid);
    assert_eq!(
        std::fs::read_to_string(child.dir().join("a.txt")).unwrap(),
        "worker drift\n"
    );
}
