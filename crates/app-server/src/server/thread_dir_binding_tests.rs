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
use std::sync::Arc;

fn git(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(directory)
        .args([
            "-c",
            "user.name=Binding test",
            "-c",
            "user.email=binding@example.test",
            "-c",
            "commit.gpgSign=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
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
fn archiving_more_than_the_keep_count_preserves_non_git_edits_until_explicit_checkout_deletion() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("note"), "source").unwrap();
    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_codex_home(profile.path().join("codex"))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(source.path()),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let mut connection = server.connection();
    let mut id = 0;
    let mut call = |method: &str, params: serde_json::Value| {
        id += 1;
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
        "initialize",
        serde_json::json!({"clientInfo":{"name":"cleanup-test","version":"1"},"capabilities":{}}),
    );
    let runtime = server.git_turn_changes.as_ref().unwrap();
    let runtime_lifetime = Arc::downgrade(runtime);
    let mut copies = Vec::new();
    for index in 0..=runtime.dirs.worktrees.settings().keep_count {
        let result = call(
            "session/create",
            serde_json::json!({"commandId":format!("create-{index}"), "title":"Plain directory", "kind":"code", "executionTarget":{"type":"local","root":source.path()}}),
        );
        let session = result["session"]["sessionId"].as_str().unwrap().to_owned();
        let thread = ThreadId::new(
            result["session"]["threads"][0]["threadId"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let binding = runtime.binding(&thread).unwrap();
        let edit = format!("session edit {index}");
        std::fs::write(binding.dir().join("note"), &edit).unwrap();
        call(
            "session/request",
            serde_json::json!({"commandId":format!("archive-{index}"), "sessionId":session, "request":{"type":"archive"}}),
        );
        copies.push((session, binding, edit));
    }
    for (_, binding, edit) in &copies {
        assert_eq!(
            std::fs::read_to_string(binding.dir().join("note")).unwrap(),
            *edit
        );
    }
    let (_, binding, _) = &copies[0];
    assert!(
        server
            .session_dir_authorization(
                &SessionId::new(copies[0].0.clone()).unwrap(),
                binding.dir(),
                ash_file_access::Permission::ReadFiles
            )
            .is_ok()
    );
    assert!(
        server
            .session_dir_authorization(
                &SessionId::new(copies[1].0.clone()).unwrap(),
                binding.dir(),
                ash_file_access::Permission::ReadFiles
            )
            .is_err()
    );
    let directory_id = ash_file_access::Dir::open_local(binding.dir())
        .unwrap()
        .id()
        .to_string();
    std::fs::write(binding.dir().join("watcher-check"), "changed").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let observed = server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| {
                let notification: serde_json::Value = serde_json::from_str(notification).unwrap();
                notification["method"] == "fs/changed"
                    && notification["params"]["dirId"] == directory_id
            });
        if observed {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "managed files did not invalidate the client"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let ManagedDirOwner::Thread { thread_id } = binding.owner();
    server
        .session_processor()
        .delete_worktree_session(thread_id, &CommandId::new("delete-first").unwrap())
        .unwrap();
    assert!(!binding.checkout_root().exists());
    for (_, binding, edit) in copies.iter().skip(1) {
        assert_eq!(
            std::fs::read_to_string(binding.dir().join("note")).unwrap(),
            *edit
        );
    }
    server.close_connection(connection);
    drop(server);
    assert!(
        runtime_lifetime.upgrade().is_none(),
        "Hook observers must release the directory runtime"
    );
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
        ash_app_server_diff::compute,
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
        worktree_start: None,
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
        ash_app_server_diff::compute,
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
        serde_json::json!({"commandId":"binding-root", "title":"Frozen binding", "kind":"code", "executionTarget":{"type":"local","root":repository.path()}}),
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
        worktree_start: None,
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
        worktree_start: None,
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

#[test]
fn comparison_forks_share_the_source_checkpoint_in_distinct_named_worktrees() {
    use serde_json::json;

    let profile = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path();
    git(root, &["init", "--quiet", "--initial-branch=main"]);
    // These assertions compare checkout bytes across worktrees, independently of host Git settings.
    git(root, &["config", "core.autocrlf", "false"]);
    std::fs::create_dir_all(root.join(".ash/agents")).unwrap();
    for name in ["alpha", "beta"] {
        std::fs::write(
            root.join(format!(".ash/agents/{name}.md")),
            format!("---\nname: {name}\ndescription: Compares changes\n---\n\nCompare changes."),
        )
        .unwrap();
    }
    std::fs::write(root.join("tracked.txt"), "original\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "--quiet", "-m", "baseline"]);
    std::fs::write(root.join("tracked.txt"), "source checkpoint\n").unwrap();

    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_codex_home(profile.path().join("codex"))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(root),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let mut connection = server.connection();
    let mut call = |id, method, params| {
        let response: serde_json::Value = serde_json::from_str(&server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
        ))
        .unwrap();
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    };
    call(
        1,
        "initialize",
        json!({"clientInfo":{"name":"comparison-test","version":"1"},"capabilities":{}}),
    );
    let roles = call(2, "agent/roles/list", json!({}));
    let source = call(
        3,
        "session/create",
        json!({"commandId":"comparison-source","title":"Source","kind":"code", "executionTarget":{"type":"local","root":root}}),
    );
    let session = source["session"]["sessionId"].as_str().unwrap();
    let thread = source["session"]["threads"][0]["threadId"]
        .as_str()
        .unwrap();
    let id = ThreadId::new(thread).unwrap();
    let sequence = server.threads.read_thread(&id).unwrap().sequence;
    let runtime = server.git_turn_changes.as_ref().unwrap();
    let source_dir = runtime.binding(&id).unwrap();
    std::fs::write(root.join("tracked.txt"), "project changed\n").unwrap();
    std::fs::write(source_dir.dir().join("tracked.txt"), "source changed\n").unwrap();

    let mut checkouts = Vec::new();
    for (index, name) in ["alpha", "beta"].into_iter().enumerate() {
        let role = roles["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| role["name"] == name)
            .unwrap();
        let branch = format!("ash/compare-{name}");
        let fork = call(
            index + 4,
            "session/request",
            json!({
                "sessionId":session,"commandId":format!("comparison-{name}"),
                "request":{"type":"forkComparison","parentThreadId":thread,"title":name,
                    "comparison":{"sourceSequence":sequence,"branchName":branch,"agent":{"type":"exact","source":role["source"],"name":name}}}
            }),
        );
        let fork_id = ThreadId::new(fork["value"]["threadId"].as_str().unwrap()).unwrap();
        let forked = server.threads.read_thread(&fork_id).unwrap();
        assert_ne!(
            forked.agent_id,
            server.threads.read_thread(&id).unwrap().agent_id
        );
        assert_eq!(
            forked
                .agent_configuration()
                .unwrap()
                .role
                .as_ref()
                .unwrap()
                .name,
            name
        );
        let binding = runtime.binding(&fork_id).unwrap();
        assert_eq!(binding.target_branch(), Some(branch.as_str()));
        assert_eq!(
            std::fs::read_to_string(binding.dir().join("tracked.txt")).unwrap(),
            "source checkpoint\n"
        );
        checkouts.push(binding.checkout_root().to_path_buf());
        if index == 0 {
            git(source_dir.dir(), &["add", "tracked.txt"]);
            git(
                source_dir.dir(),
                &["commit", "--quiet", "-m", "advance source HEAD"],
            );
        }
    }
    assert_ne!(checkouts[0], checkouts[1]);
    assert_eq!(
        git(&checkouts[0], &["rev-parse", "HEAD"]),
        git(&checkouts[1], &["rev-parse", "HEAD"]),
    );
}

#[test]
fn deleting_a_managed_worktree_deletes_its_session_and_discards_checkout_contents() {
    let profile = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "--quiet", "--initial-branch=main"]);
    git(repo.path(), &["config", "user.name", "Ash Test"]);
    git(repo.path(), &["config", "user.email", "ash@example.test"]);
    std::fs::write(repo.path().join("tracked.txt"), "initial\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "--quiet", "-m", "initial"]);
    let search_root = ash_file_access::Dir::open_local(repo.path()).unwrap();
    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_dir_root(repo.path()),
        ash_app_server_diff::compute,
    )
    .unwrap();
    // Use the host's one index service, including the registration created by warmup.
    let grep = server
        .env_runtime
        .read()
        .unwrap()
        .workspace
        .grep
        .clone()
        .unwrap();
    assert_eq!(grep.backend(), grep::Backend::Tgrep);
    let mut connection = server.connection();
    crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"managed-worktree-delete-test","version":"1"},"capabilities":{}}}),
    );
    let created = crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"create-managed","title":"Managed work","kind":"code", "executionTarget":null}}),
    );
    assert!(created.get("error").is_none(), "{created}");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let thread_id = created["result"]["session"]["threads"][0]["threadId"]
        .as_str()
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let manager =
        worktree::WorktreeManager::new(worktree::WorktreeSettings::defaults(profile.path()));
    let listed = runtime.block_on(manager.list(repo.path())).unwrap();
    let checkout = listed
        .iter()
        .find(|worktree| worktree.owner_thread_id() == Some(thread_id))
        .unwrap()
        .checkout_root()
        .to_path_buf();
    std::fs::write(checkout.join("uncommitted.txt"), "discard me").unwrap();
    let search_dir = ash_file_access::Dir::open_local(&checkout).unwrap();
    let query = grep::Query {
        query: "initial".into(),
        pattern: grep::Pattern::Literal,
        case_sensitivity: grep::CaseSensitivity::Sensitive,
        scope: std::path::PathBuf::new(),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results: 100,
        freshness: grep::Freshness::Indexed,
    };
    let cancellation = ash_async_utils::CancellationSource::new();
    assert_eq!(
        grep::Search::search(grep.as_ref(), &search_dir, &query, &cancellation.token())
            .unwrap()
            .matches
            .len(),
        1
    );
    assert_eq!(
        grep::Search::search(grep.as_ref(), &search_root, &query, &cancellation.token())
            .unwrap()
            .matches
            .len(),
        1
    );
    let git_dir = git(&checkout, &["rev-parse", "--absolute-git-dir"]);
    let marker = std::path::Path::new(git_dir.trim()).join("tgrep-view-v1.json");
    assert!(marker.exists());
    // The search service drains its own capability during deletion; release the test's extra
    // directory handle too, otherwise Windows correctly refuses to remove the checkout.
    drop(search_dir);
    let inventory = crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"git/worktree/list","params":{}}),
    );
    assert!(
        inventory["result"]["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .any(|worktree| worktree["state"] == "threadOwned")
    );
    let deleted = crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"git/worktree/delete","params":{"commandId":"delete-managed","checkoutRoot":checkout,"mode":"sessionAndWorktrees"}}),
    );
    assert!(deleted.get("error").is_none(), "{deleted}");
    assert!(!checkout.exists());
    assert!(!marker.exists());
    assert_eq!(
        grep::Search::search(grep.as_ref(), &search_root, &query, &cancellation.token())
            .unwrap()
            .matches
            .len(),
        1
    );
    assert_eq!(deleted["result"]["worktrees"].as_array().unwrap().len(), 1);
    let sessions = crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"session/list","params":{}}),
    );
    assert!(
        sessions["result"]["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let missing = crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"session/read","params":{"sessionId":session_id}}),
    );
    assert!(missing.get("error").is_some(), "{missing}");
}
