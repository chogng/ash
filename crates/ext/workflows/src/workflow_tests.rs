use super::*;
use ash_core::AgentTreeLimits;
use ash_core::InMemoryThreadStore;
use ash_core::NoThreadWorktreeBinder;
use core_api::SequenceExpectation;
use core_api::StartThreadRequest;
use protocol::CommandId;
use protocol::ToolName;
use protocol::ToolProfileSnapshot;
use protocol::UserInput;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
struct Backend(
    Mutex<Vec<(ThreadId, TurnId)>>,
    std::sync::atomic::AtomicBool,
);
impl TurnExecutionBackend for Backend {
    fn start(&self, thread: &ThreadId, turn: &TurnId) -> Result<(), CoreError> {
        if self.1.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(CoreError::Execution("executor unavailable".into()));
        }
        self.0.lock().unwrap().push((thread.clone(), turn.clone()));
        Ok(())
    }
    fn resume(&self, thread: &ThreadId, turn: &TurnId) -> Result<(), CoreError> {
        self.start(thread, turn)
    }
}

struct Fixture {
    threads: Arc<ThreadController>,
    agents: MultiAgentCoordinator,
    store: Store,
    backend: Backend,
    root: ThreadId,
}

#[test]
fn retired_mode_workflow_records_recover_and_replay_original_receipts() {
    use serde_json::json;

    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.sqlite3");
    drop(Store::open(&database).unwrap());
    let session = protocol::SessionId::new("legacy-session").unwrap();
    let root = ThreadId::new("legacy-root").unwrap();
    let input = vec![UserInput::Text {
        text: "/team Investigate".into(),
    }];
    let request = serde_json::to_string(&(&input, "agent", "direct", "manual")).unwrap();
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE ash_schema_migrations SET version=1 WHERE component='workflows'",
            [],
        )
        .unwrap();
    for (id, finished, turn, sequence) in [
        ("pending", 0, None, None),
        ("completed", 2, Some("completed-turn"), Some(7)),
    ] {
        let plan = json!({
            "turn": turn, "response_sequence": sequence,
            "transition": { "work": {
                "id": "legacy-work", "mode": "team", "task": "Investigate",
                "anchor_sequence": 1, "stage": "team", "status": "active",
                "accepted": {}, "attempts": []
            }, "launch": null, "cancel": [] },
            "agent": null,
            "submission": { "command_id": id, "sequence": 1, "policy": "legacy-policy",
                "command": { "type": "startTurn", "kind": "coding", "mode": "agent",
                    "instructions": { "owner": "test", "id": "base", "revision": "1", "body": "Base",
                        "modeInstructions": { "owner": "test", "id": "agent", "revision": "1", "body": "Retired" }
                    }, "input": input, "toolMode": "direct", "approvalMode": "manual"
                }
            }
        });
        connection.execute(
            "INSERT INTO agent_workflow_commands (session, root, command, request, plan, finished) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![session.as_str(), root.as_str(), id, request, plan.to_string(), finished],
        ).unwrap();
    }
    drop(connection);
    for _ in 0..2 {
        let store = Store::open(&database).unwrap();
        let pending = store.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, root);
        assert_eq!(pending[0].1.submission.request().input, input);
        assert!(
            pending[0]
                .1
                .submission
                .request()
                .instructions
                .task_instructions()
                .is_none()
        );
        let receipt = store
            .replay_completed(
                &session,
                &root,
                &CommandId::new("completed").unwrap(),
                &input,
                None,
                protocol::ToolMode::Direct,
                protocol::ApprovalMode::Manual,
                false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(receipt.turn_id.as_str(), "completed-turn");
        assert_eq!(receipt.sequence, 7);
    }
}

#[test]
fn prepared_artifact_workflow_retains_its_authority_across_restart() {
    for revoke in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let history = Arc::new(state::SqliteThreadStore::open(&database).unwrap());
        let threads = Arc::new(ThreadController::with_store(history.clone()));
        let root = threads
            .start_thread(
                &NoThreadWorktreeBinder,
                StartThreadRequest {
                    kind: protocol::SessionKind::Code,
                    execution_target: None,
                    branch_name: None,
                    worktree_start: None,
                    agent_id: None,
                    agent: None,
                    command_id: CommandId::new("source").unwrap(),
                    title: "Workflow source".into(),
                },
            )
            .unwrap()
            .thread_id;
        let repository = serde_json::from_value(
            serde_json::json!({"host":"github.com","owner":"team","name":"repo"}),
        )
        .unwrap();
        history.record_pull_request(&root, &repository, 7).unwrap();
        let precondition = ash_core::ThreadEventPrecondition::PullRequestArtifact {
            source_thread_id: root.clone(),
            artifact_id: history
                .pull_request_artifact_id(&root, &repository, 7)
                .unwrap()
                .unwrap(),
        };
        let mut fixture = Fixture {
            agents: MultiAgentCoordinator::new(threads.clone(), AgentTreeLimits::default()),
            threads,
            root,
            store: Store::open(&database).unwrap(),
            backend: Backend::default(),
        };
        let text = "/develop Fix CI";
        let interrupted = fixture.runtime().execute_with_turn_submission(
            &fixture.root,
            Command::parse(text).unwrap().unwrap(),
            fixture.request("repair", text),
            None,
            Some(precondition.clone()),
            |_, _, _| Err(CoreError::Execution("shutdown before admission".into())),
        );
        assert!(
            matches!(interrupted, Err(CoreError::Execution(message)) if message == "shutdown before admission")
        );
        let changed_authority = fixture.runtime().execute_with_turn_submission(
            &fixture.root,
            Command::parse(text).unwrap().unwrap(),
            fixture.request("repair", text),
            None,
            None,
            |_, _, _| unreachable!("a retry cannot drop its frozen authority"),
        );
        assert!(matches!(changed_authority, Err(CoreError::CommandConflict)));
        if revoke {
            history
                .detach_pull_request(&fixture.root, &repository, 7)
                .unwrap();
            history
                .record_pull_request(&fixture.root, &repository, 7)
                .unwrap();
        }
        // Reopen both owners, including Core's in-memory Thread projections.
        fixture.threads = Arc::new(ThreadController::with_store(Arc::new(
            state::SqliteThreadStore::open(&database).unwrap(),
        )));
        fixture.agents =
            MultiAgentCoordinator::new(fixture.threads.clone(), AgentTreeLimits::default());
        fixture.store = Store::open(&database).unwrap();
        assert_eq!(fixture.recover().unwrap(), 1);
        assert_eq!(fixture.recover().unwrap(), 0);
        let source = fixture.threads.read_thread(&fixture.root).unwrap();
        assert_eq!(source.turns.len(), usize::from(!revoke));
        assert_eq!(source.delegations.len(), usize::from(!revoke));
        assert_eq!(
            fixture.backend.0.lock().unwrap().len(),
            usize::from(!revoke)
        );
    }
}

impl Fixture {
    fn new(store: Store) -> Self {
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let root = threads
            .start_thread(
                &NoThreadWorktreeBinder,
                StartThreadRequest {
                    kind: protocol::SessionKind::Code,
                    execution_target: None,
                    branch_name: None,
                    worktree_start: None,
                    agent_id: None,
                    agent: None,
                    command_id: CommandId::new("root").unwrap(),
                    title: "Workflow".into(),
                },
            )
            .unwrap()
            .thread_id;
        Self {
            agents: MultiAgentCoordinator::new(threads.clone(), AgentTreeLimits::default()),
            threads,
            store,
            backend: Backend::default(),
            root,
        }
    }
    fn runtime(&self) -> Runtime<'_> {
        Runtime {
            store: &self.store,
            threads: &self.threads,
            agents: &self.agents,
            backend: &self.backend,
        }
    }
    fn recover(&self) -> Result<usize, CoreError> {
        self.runtime()
            .recover(|thread, request, routing, precondition| {
                self.threads
                    .start_turn_with_admission(thread, request, None, routing, precondition)
            })
    }
    fn request(&self, id: &str, text: &str) -> StartTurnRequest {
        StartTurnRequest {
            context_policy: Default::default(),
            command_id: CommandId::new(id).unwrap(),
            expected_sequence: SequenceExpectation::Exact(
                self.threads.read_thread(&self.root).unwrap().sequence,
            ),
            model: None,
            reasoning_effort: None,
            advisor: None,
            kind: protocol::TurnKind::Coding,
            instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
            policy_revision: "workflow-test".into(),
            approval_mode: protocol::ApprovalMode::Manual,
            tool_mode: protocol::ToolMode::Direct,
            tool_profile: Some(ToolProfileSnapshot {
                id: "test".into(),
                revision: "1".into(),
                definition_digest: format!("sha256:{}", "a".repeat(64)),
                parallel_tool_calls: true,
                disabled_tools: Vec::new(),
                allowed_tools: None,
                tool_names: [
                    "read_file",
                    "grep",
                    "glob",
                    "write_file",
                    "shell-command",
                    "board_read",
                    "board_write",
                    "spawn_agent",
                    "send_agent_message",
                    "wait_agent",
                    "web_search",
                ]
                .into_iter()
                .map(|name| ToolName::new(name).unwrap())
                .collect(),
            }),
            activated_skills: Vec::new(),
            input: vec![UserInput::Text { text: text.into() }],
        }
    }
    fn command(&self, id: &str, text: &str) -> Result<Receipt, CoreError> {
        self.runtime().execute(
            &self.root,
            Command::parse(text)?.unwrap(),
            self.request(id, text),
        )
    }
    fn complete(&self, child: &ThreadId, outcome: &str, content: &str) {
        let snapshot = self.threads.read_thread(child).unwrap();
        let turn = &snapshot.turns.last().unwrap().turn_id;
        self.threads.complete_turn_with_agent_message(child, turn, ItemId::new(format!("result:{turn}")).unwrap(), serde_json::json!({"outcome":outcome,"content":content,"evidence":["src/main.rs:10; test-command exit 0"]}).to_string()).unwrap();
    }
    fn report(&self) -> String {
        self.threads
            .read_thread(&self.root)
            .unwrap()
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                ThreadItem::AgentMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .unwrap()
    }
}

#[test]
fn develop_requires_each_exact_candidate_and_uses_independent_restricted_roles() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let first = fixture
        .command("begin", "/develop implement search")
        .unwrap();
    let intent = first.child.unwrap();
    let replay = fixture
        .command("begin", "/develop implement search")
        .unwrap();
    assert_eq!(replay.child.as_ref(), Some(&intent));
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.root)
            .unwrap()
            .delegations
            .len(),
        1
    );
    assert!(fixture.command("early", "/develop accept 1").is_err());
    let root = fixture.threads.read_thread(&fixture.root).unwrap();
    assert_eq!(
        root.turns.len(),
        1,
        "invalid transitions do not create a Turn"
    );
    fixture.complete(&intent, "ready", "Accepted intent marker");
    assert!(fixture.command("stale", "/develop accept 9").is_err());
    let mut child = fixture
        .command("accept-intent", "/develop accept 1")
        .unwrap()
        .child
        .unwrap();
    for (revision, role, content) in [
        (2, "develop/spec", "Spec marker"),
        (3, "develop/plan", "Plan marker"),
        (4, "develop/implementer", "Implementation marker"),
        (5, "develop/acceptance", "Acceptance marker"),
    ] {
        let snapshot = fixture.threads.read_thread(&child).unwrap();
        let seed = snapshot.agent_context_seed.as_ref().unwrap();
        assert_eq!(seed.agent.role.as_ref().unwrap().name, role);
        assert!(seed.task.instructions.contains("Accepted intent marker"));
        assert_eq!(seed.inheritance, AgentContextMode::Fresh);
        if role != "develop/implementer" {
            assert!(
                !seed
                    .agent
                    .capability_scope
                    .tools
                    .iter()
                    .any(|tool| matches!(
                        tool.as_str(),
                        "write_file" | "shell-command" | "spawn_agent"
                    ))
            );
            assert!(seed.agent.capability_scope.delegation_tools.is_empty());
        }
        fixture.complete(
            &child,
            if revision == 5 { "passed" } else { "ready" },
            content,
        );
        let accepted = fixture
            .command(
                &format!("accept-{revision}"),
                &format!("/develop accept {revision}"),
            )
            .unwrap();
        if revision < 5 {
            child = accepted.child.unwrap();
        } else {
            assert!(accepted.child.is_none());
        }
    }
    assert!(fixture.report().contains("completed"));
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.root)
            .unwrap()
            .delegations
            .len(),
        5
    );
}

#[test]
fn revision_invalidates_downstream_and_preserves_old_candidates_after_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.db");
    let mut fixture = Fixture::new(Store::open(&database).unwrap());
    let intent = fixture
        .command("begin", "/develop feature")
        .unwrap()
        .child
        .unwrap();
    fixture.complete(&intent, "ready", "original intent");
    let spec = fixture
        .command("accept", "/develop accept 1")
        .unwrap()
        .child
        .unwrap();
    fixture.complete(&spec, "ready", "original spec");
    fixture.store = Store::open(&database).unwrap();
    let revised = fixture
        .command("revise", "/develop revise intent add offline support")
        .unwrap()
        .child
        .unwrap();
    let snapshot = fixture.threads.read_thread(&revised).unwrap();
    let context = &snapshot
        .agent_context_seed
        .as_ref()
        .unwrap()
        .task
        .instructions;
    assert!(context.contains("original intent"));
    assert!(context.contains("add offline support"));
    assert!(context.contains("\"accepted\":[]"));
    assert!(fixture.command("stale", "/develop accept 2").is_err());
    fixture.complete(&revised, "ready", "revised intent");
    let next = fixture
        .command("accept-revision", "/develop accept 3")
        .unwrap()
        .child
        .unwrap();
    let snapshot = fixture.threads.read_thread(&next).unwrap();
    assert!(
        snapshot
            .agent_context_seed
            .as_ref()
            .unwrap()
            .task
            .instructions
            .contains("revised intent")
    );
    let context: serde_json::Value = serde_json::from_str(
        snapshot
            .agent_context_seed
            .as_ref()
            .unwrap()
            .task
            .instructions
            .split_once('\n')
            .unwrap()
            .1,
    )
    .unwrap();
    assert!(!context["accepted"].to_string().contains("original spec"));
    assert_eq!(
        context["previous_candidate"]["invalidation"],
        "add offline support"
    );
}

#[test]
fn decisions_and_invalid_candidates_cannot_advance_the_workflow() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let intent = fixture
        .command("begin", "/develop feature")
        .unwrap()
        .child
        .unwrap();
    fixture.complete(
        &intent,
        "needs_user_decision",
        "Choose local or remote storage",
    );
    assert!(fixture.command("reject", "/develop accept 1").is_err());
    assert!(fixture.command("empty", "/develop resume").is_err());
    let retry = fixture
        .command("answer", "/develop resume local storage")
        .unwrap()
        .child
        .unwrap();
    assert_ne!(retry, intent);
    let snapshot = fixture.threads.read_thread(&retry).unwrap();
    assert!(
        snapshot
            .agent_context_seed
            .as_ref()
            .unwrap()
            .task
            .instructions
            .contains("local storage")
    );
    fixture.complete(&retry, "passed", "Intent cannot pass acceptance");
    assert!(fixture.command("invalid", "/develop accept 2").is_err());
    fixture.command("status", "/develop status").unwrap();
    assert!(
        fixture
            .report()
            .contains("did not return a valid candidate")
    );
}

#[test]
fn team_without_a_final_report_requires_a_new_attempt() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let child = fixture
        .command("begin", "/team improve search")
        .unwrap()
        .child
        .unwrap();
    let snapshot = fixture.threads.read_thread(&child).unwrap();
    let turn = &snapshot.turns.last().unwrap().turn_id;
    fixture
        .threads
        .complete_turn_with_agent_message(
            &child,
            turn,
            ItemId::new("empty-report").unwrap(),
            " ".into(),
        )
        .unwrap();
    fixture.command("status", "/team status").unwrap();
    assert!(fixture.report().contains("without a final report"));
    assert!(fixture.report().contains("active"));
    let retry = fixture
        .command("retry", "/team resume")
        .unwrap()
        .child
        .unwrap();
    assert_ne!(retry, child);
}

#[test]
fn team_cancel_interrupts_the_coordinator_and_replay_does_not_create_another_child() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let first = fixture.command("begin", "/team improve search").unwrap();
    let child = first.child.unwrap();
    let snapshot = fixture.threads.read_thread(&child).unwrap();
    assert_eq!(
        snapshot
            .agent_configuration()
            .unwrap()
            .role
            .as_ref()
            .unwrap()
            .name,
        "team/coordinator"
    );
    assert!(fixture.command("different", "/develop status").is_err());
    fixture.command("cancel", "/team cancel").unwrap();
    assert_eq!(
        fixture.threads.read_thread(&child).unwrap().turns[0].status,
        TurnStatus::Interrupted
    );
    fixture.command("begin", "/team improve search").unwrap();
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.root)
            .unwrap()
            .delegations
            .len(),
        1
    );
    assert!(fixture.report().contains("cancelled"));
}

#[test]
fn unavailable_tools_fail_before_accepting_a_command_and_children_cannot_control_workflows() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let mut request = fixture.request("unavailable", "/team work");
    request.tool_profile.as_mut().unwrap().tool_names.clear();
    assert!(
        fixture
            .runtime()
            .execute(
                &fixture.root,
                Command::parse("/team work").unwrap().unwrap(),
                request
            )
            .is_err()
    );
    assert!(
        fixture
            .threads
            .read_thread(&fixture.root)
            .unwrap()
            .turns
            .is_empty()
    );
    let child = fixture
        .command("start", "/team work")
        .unwrap()
        .child
        .unwrap();
    assert!(
        fixture
            .runtime()
            .execute(
                &child,
                Command::parse("/develop work").unwrap().unwrap(),
                fixture.request("child", "/develop work")
            )
            .is_err()
    );
}

#[test]
fn command_parser_rejects_malformed_controls_and_leaves_ordinary_text_alone() {
    assert!(Command::parse("please /team work").unwrap().is_none());
    assert!(Command::parse("/teams work").unwrap().is_none());
    assert!(Command::parse("/develop accept latest").is_err());
    assert!(Command::parse("/develop revise spec").is_err());
    assert!(Command::parse("/team cancel extra").is_err());
}

#[test]
fn parallel_develop_command_is_not_reinterpreted_as_generic_team_work() {
    assert!(Command::parse("/team develop").is_err());
    let command = Command::parse("/team develop implement two independent changes")
        .unwrap()
        .unwrap();
    assert_eq!(command.mode, Mode::ParallelDevelop);

    let fixture = Fixture::new(Store::in_memory().unwrap());
    let sequence_before = fixture.threads.read_thread(&fixture.root).unwrap().sequence;
    let result = fixture.runtime().execute(
        &fixture.root,
        command,
        fixture.request(
            "parallel-start",
            "/team develop implement two independent changes",
        ),
    );
    assert!(matches!(result, Err(CoreError::InvalidInput(_))));
    assert_eq!(
        fixture.threads.read_thread(&fixture.root).unwrap().sequence,
        sequence_before
    );
}

#[test]
fn workflow_delegation_preserves_debug_and_replaces_swarm_with_agent() {
    for mode in [
        protocol::TaskExecution::Agent,
        protocol::TaskExecution::Debug,
        protocol::TaskExecution::Swarm,
    ] {
        let fixture = Fixture::new(Store::in_memory().unwrap());
        let mut request = fixture.request("begin", "/team improve search");
        request.instructions = request
            .instructions
            .with_task_instructions(&task_command_templates::instructions(mode))
            .with_task_command((!mode.is_default()).then_some(mode));
        let receipt = fixture
            .runtime()
            .execute(
                &fixture.root,
                Command::parse("/team improve search").unwrap().unwrap(),
                request,
            )
            .unwrap();
        assert_eq!(
            fixture.threads.read_thread(&fixture.root).unwrap().turns[0].execution_approach(),
            mode
        );
        let child = fixture
            .threads
            .read_thread(&receipt.child.unwrap())
            .unwrap();
        let child_turn = child.turns.last().unwrap();
        assert_eq!(child_turn.execution_approach(), mode.delegated());
        assert_eq!(
            child_turn
                .instructions
                .as_ref()
                .unwrap()
                .task_instructions(),
            Some(&task_command_templates::instructions(mode.delegated()).as_text()),
        );
        let mut request = fixture.request("begin", "/team improve search");
        request.instructions = request
            .instructions
            .with_task_command(Some(protocol::TaskExecution::Ask));
        assert!(matches!(
            fixture.runtime().execute(
                &fixture.root,
                Command::parse("/team improve search").unwrap().unwrap(),
                request,
            ),
            Err(CoreError::CommandConflict)
        ));
    }
}

#[test]
fn prepared_and_accepted_commands_recover_once_with_core_and_workflow_in_the_same_database() {
    for accept_before_restart in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("state.db");
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            state::SqliteThreadStore::open(&database).unwrap(),
        )));
        let root = threads
            .start_thread(
                &NoThreadWorktreeBinder,
                StartThreadRequest {
                    kind: protocol::SessionKind::Code,
                    execution_target: None,
                    branch_name: None,
                    worktree_start: None,
                    agent_id: None,
                    agent: None,
                    command_id: CommandId::new("durable-root").unwrap(),
                    title: "Durable workflow".into(),
                },
            )
            .unwrap()
            .thread_id;
        let mut fixture = Fixture {
            agents: MultiAgentCoordinator::new(threads.clone(), AgentTreeLimits::default()),
            threads,
            store: Store::open(&database).unwrap(),
            backend: Backend::default(),
            root,
        };
        let mut request = fixture.request("start", "/develop durable feature");
        let execution = protocol::TaskExecution::Swarm;
        request.reasoning_effort = Some(protocol::ReasoningEffort::High);
        request.instructions = request
            .instructions
            .with_task_instructions(&task_command_templates::instructions(execution))
            .with_task_command(Some(execution));
        let plan = fixture
            .runtime()
            .prepare(
                &fixture.root,
                Command::parse("/develop durable feature").unwrap().unwrap(),
                request,
            )
            .unwrap();
        assert!(
            fixture
                .threads
                .read_thread(&fixture.root)
                .unwrap()
                .turns
                .is_empty()
        );
        if accept_before_restart {
            fixture
                .threads
                .start_turn(&fixture.root, plan.submission.request())
                .unwrap();
        }
        fixture.store = Store::open(&database).unwrap();
        assert_eq!(fixture.recover().unwrap(), 1);
        assert_eq!(fixture.recover().unwrap(), 0);
        let snapshot = fixture.threads.read_thread(&fixture.root).unwrap();
        assert_eq!(snapshot.turns.len(), 1);
        assert_eq!(
            snapshot.turns[0].execution_approach(),
            protocol::TaskExecution::Swarm
        );
        assert_eq!(
            snapshot.turns[0].reasoning_effort,
            Some(protocol::ReasoningEffort::High)
        );
        assert_eq!(snapshot.turns[0].status, TurnStatus::Completed);
        assert_eq!(snapshot.delegations.len(), 1);
        let child = snapshot
            .delegations
            .values()
            .next()
            .unwrap()
            .child_thread_id
            .as_ref()
            .unwrap();
        assert_eq!(
            fixture
                .threads
                .read_thread(child)
                .unwrap()
                .turns
                .iter()
                .filter(|turn| turn.status == TurnStatus::Running)
                .count(),
            1
        );
        assert_eq!(fixture.backend.0.lock().unwrap().len(), 1);
        let child_snapshot = fixture.threads.read_thread(child).unwrap();
        let child_turn = child_snapshot.turns.last().unwrap();
        assert_eq!(
            child_turn.execution_approach(),
            protocol::TaskExecution::Agent
        );
        assert_eq!(
            child_turn
                .instructions
                .as_ref()
                .unwrap()
                .task_instructions(),
            Some(&task_command_templates::instructions(protocol::TaskExecution::Agent).as_text()),
        );
        fixture.complete(child, "ready", "durable intent");
        fixture.command("accept", "/develop accept 1").unwrap();
    }
}

#[test]
fn stale_command_admission_leaves_workflow_state_unchanged() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let mut request = fixture.request("stale", "/develop feature");
    request.expected_sequence = SequenceExpectation::Exact(0);
    assert!(
        fixture
            .runtime()
            .execute(
                &fixture.root,
                Command::parse("/develop feature").unwrap().unwrap(),
                request
            )
            .is_err()
    );
    assert!(fixture.store.pending().unwrap().is_empty());
    fixture.command("start", "/develop feature").unwrap();
}

#[test]
fn waiting_stage_keeps_its_identity_and_cancellation_reaches_its_pending_interaction() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    let child = fixture
        .command("start", "/develop feature")
        .unwrap()
        .child
        .unwrap();
    let snapshot = fixture.threads.read_thread(&child).unwrap();
    let turn = &snapshot.turns.last().unwrap().turn_id;
    fixture
        .threads
        .request_turn_interaction(
            &child,
            turn,
            ash_core::RequestTurnInteraction {
                request_id: protocol::RequestId::new("question").unwrap(),
                item_id: None,
                deadline: None,
                request: protocol::AgentRequest::UserInput {
                    request: protocol::RequestUserInput {
                        plan_review: None,
                        questions: vec![protocol::UserInputQuestion {
                            required: true,
                            id: "choice".into(),
                            header: "Choice".into(),
                            question: "Which scope?".into(),
                            options: Vec::new(),
                            allow_free_form: true,
                            validation: None,
                        }],
                    },
                },
            },
        )
        .unwrap();
    fixture.command("status", "/develop status").unwrap();
    assert!(fixture.report().contains("Agent running"));
    let resumed = fixture.command("resume", "/develop resume").unwrap();
    assert_eq!(resumed.child.as_ref(), Some(&child));
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.root)
            .unwrap()
            .delegations
            .len(),
        1
    );
    fixture.command("cancel", "/develop cancel").unwrap();
    assert_eq!(
        fixture
            .threads
            .read_thread(&child)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Interrupted
    );
}

#[test]
fn dispatch_failure_is_visible_and_can_be_retried_without_a_stuck_command() {
    let fixture = Fixture::new(Store::in_memory().unwrap());
    fixture
        .backend
        .1
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let failed = fixture
        .command("start", "/develop feature")
        .unwrap()
        .child
        .unwrap();
    assert_eq!(
        fixture
            .threads
            .read_thread(&failed)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Failed
    );
    assert!(fixture.report().contains("executor unavailable"));
    assert!(fixture.store.pending().unwrap().is_empty());
    let retry = fixture
        .command("retry", "/develop resume")
        .unwrap()
        .child
        .unwrap();
    assert_ne!(retry, failed);
    assert_eq!(
        fixture
            .threads
            .read_thread(&retry)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Running
    );
}

#[test]
fn spawn_capacity_failure_preserves_accepted_artifacts_and_allows_cancellation() {
    let mut fixture = Fixture::new(Store::in_memory().unwrap());
    fixture.agents = MultiAgentCoordinator::new(
        fixture.threads.clone(),
        AgentTreeLimits::new(1, 1, 1).unwrap(),
    );
    let intent = fixture
        .command("start", "/develop feature")
        .unwrap()
        .child
        .unwrap();
    fixture.complete(&intent, "ready", "accepted intent");
    let next = fixture.command("accept", "/develop accept 1").unwrap();
    assert!(next.child.is_none());
    assert!(fixture.report().contains("maximum"));
    assert!(fixture.store.pending().unwrap().is_empty());
    fixture.command("cancel", "/develop cancel").unwrap();
    assert!(fixture.report().contains("cancelled"));
}
