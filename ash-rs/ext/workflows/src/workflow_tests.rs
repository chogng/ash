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

impl Fixture {
    fn new(store: Store) -> Self {
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let root = threads
            .start_thread(
                &NoThreadWorktreeBinder,
                StartThreadRequest {
                    branch_name: None,
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
    fn request(&self, id: &str, text: &str) -> StartTurnRequest {
        StartTurnRequest {
            command_id: CommandId::new(id).unwrap(),
            expected_sequence: SequenceExpectation::Exact(
                self.threads.read_thread(&self.root).unwrap().sequence,
            ),
            model: None,
            advisor: None,
            kind: protocol::TurnKind::Coding,
            instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
            policy_revision: "workflow-test".into(),
            approval_mode: protocol::ApprovalMode::AskPermissions,
            tool_mode: protocol::ToolMode::Direct,
            tool_profile: Some(ToolProfileSnapshot {
                id: "test".into(),
                revision: "1".into(),
                definition_digest: format!("sha256:{}", "a".repeat(64)),
                parallel_tool_calls: true,
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
                    branch_name: None,
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
        let plan = fixture
            .runtime()
            .prepare(
                &fixture.root,
                Command::parse("/develop durable feature").unwrap().unwrap(),
                fixture.request("start", "/develop durable feature"),
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
        assert_eq!(fixture.runtime().recover().unwrap(), 1);
        assert_eq!(fixture.runtime().recover().unwrap(), 0);
        let snapshot = fixture.threads.read_thread(&fixture.root).unwrap();
        assert_eq!(snapshot.turns.len(), 1);
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
                        questions: vec![protocol::UserInputQuestion {
                            id: "choice".into(),
                            header: "Choice".into(),
                            question: "Which scope?".into(),
                            options: Vec::new(),
                            allow_free_form: true,
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
