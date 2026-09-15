use super::ExecCancellation;
use super::ExecRunner;
use super::ExecRunnerOptions;
use crate::AppServerTarget;
use crate::DiscardExecEventSink;
use crate::EmbeddedAppServerOptions;
use crate::ExecEntry;
use crate::ExecEvent;
use crate::ExecEventKind;
use crate::ExecFinalOutput;
use crate::ExecInteractionKind;
use crate::ExecInterruptionReason;
use crate::ExecOutcome;
use crate::ExecRunId;
use crate::ExecRunRequest;
use crate::ExecSinkError;
use crate::HeadlessApprovalMode;
use crate::connection::ConnectionError;
use crate::connection::ConnectionEvent;
use crate::connection::ExecConnection;
use crate::connection::ThreadSubscription;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_app_server_protocol::protocol::turn::TurnStartResult;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ItemId;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[test]
fn completed_turn_emits_terminal_event_and_last_agent_message() {
    let ids = TestIds::new();
    let mut connection = FakeConnection::new(
        &ids,
        vec![
            thread(&ids, 1, vec![]),
            thread(
                &ids,
                2,
                vec![turn(
                    &ids,
                    TurnStatus::Completed,
                    vec![agent_message(&ids, "first"), agent_message(&ids, "final")],
                )],
            ),
        ],
    );
    let mut events = Vec::new();
    let mut sink = |event: &ExecEvent| -> Result<(), ExecSinkError> {
        events.push(event.clone());
        Ok(())
    };
    let outcome = test_runner()
        .run_connected(&mut connection, new_request(), &mut sink, &NeverCancelled)
        .unwrap();
    assert_eq!(outcome.final_message(), Some("final"));
    assert!(matches!(
        outcome,
        ExecOutcome::Completed {
            output: ExecFinalOutput::AgentMessage { .. },
            ..
        }
    ));
    assert!(matches!(
        events.last().map(|event| &event.event),
        Some(ExecEventKind::RunCompleted { .. })
    ));
    assert!(connection.unsubscribed);
}

#[test]
fn cancellation_sends_typed_interrupt_and_waits_for_interrupted_state() {
    let ids = TestIds::new();
    let mut connection = FakeConnection::new(
        &ids,
        vec![
            thread(&ids, 1, vec![]),
            thread(&ids, 2, vec![turn(&ids, TurnStatus::Running, vec![])]),
            thread(&ids, 3, vec![turn(&ids, TurnStatus::Interrupted, vec![])]),
        ],
    );
    let cancellation = CountingCancellation::after_checks(2);
    let mut sink = DiscardExecEventSink;
    let outcome = test_runner()
        .run_connected(&mut connection, new_request(), &mut sink, &cancellation)
        .unwrap();
    assert!(matches!(
        outcome,
        ExecOutcome::Interrupted {
            reason: ExecInterruptionReason::CancellationRequested,
            ..
        }
    ));
    assert_eq!(connection.interrupts, 1);
}

#[test]
fn denied_interaction_is_interrupted_and_reported_without_waiting_for_ui() {
    let ids = TestIds::new();
    let mut connection = FakeConnection::new(
        &ids,
        vec![
            thread(&ids, 1, vec![]),
            thread(
                &ids,
                2,
                vec![turn(&ids, TurnStatus::WaitingForApproval, vec![])],
            ),
            thread(&ids, 3, vec![turn(&ids, TurnStatus::Interrupted, vec![])]),
        ],
    );
    let mut sink = DiscardExecEventSink;
    let outcome = test_runner()
        .run_connected(&mut connection, new_request(), &mut sink, &NeverCancelled)
        .unwrap();
    assert!(matches!(
        outcome,
        ExecOutcome::RequiresInteraction { interaction, .. }
            if interaction.kind == ExecInteractionKind::Approval
    ));
    assert_eq!(connection.interrupts, 1);
}

#[test]
fn connection_close_never_fabricates_a_failed_turn() {
    let ids = TestIds::new();
    let mut connection = FakeConnection::new(
        &ids,
        vec![
            thread(&ids, 1, vec![]),
            thread(&ids, 2, vec![turn(&ids, TurnStatus::Running, vec![])]),
        ],
    );
    connection
        .events
        .push_back(ConnectionEvent::Closed("driver stopped".into()));
    let mut sink = DiscardExecEventSink;
    let outcome = test_runner()
        .run_connected(&mut connection, new_request(), &mut sink, &NeverCancelled)
        .unwrap();
    assert!(matches!(outcome, ExecOutcome::OutcomeUnknown { .. }));
}

#[test]
fn resume_and_fork_preserve_their_distinct_preparation_semantics() {
    let ids = TestIds::new();
    let completed = vec![
        thread(&ids, 7, vec![]),
        thread(&ids, 8, vec![turn(&ids, TurnStatus::Completed, vec![])]),
    ];
    let mut resume = FakeConnection::new(&ids, completed.clone());
    let mut sink = DiscardExecEventSink;
    test_runner()
        .run_connected(
            &mut resume,
            ExecRunRequest::new(ExecEntry::Resume {
                session_id: ids.session_id.clone(),
                thread_id: ids.thread_id.clone(),
                input: vec![InputItem::Text {
                    text: "continue".into(),
                }],
            }),
            &mut sink,
            &NeverCancelled,
        )
        .unwrap();
    assert_eq!(resume.preparation_calls, ["read-session"]);
    assert_eq!(resume.start_sequences, [7]);

    let parent_thread_id = ThreadId::new("parent-thread").unwrap();
    let mut fork = FakeConnection::new(&ids, completed);
    test_runner()
        .run_connected(
            &mut fork,
            ExecRunRequest::new(ExecEntry::Fork {
                session_id: ids.session_id.clone(),
                parent_thread_id: parent_thread_id.clone(),
                title: "alternative".into(),
                input: vec![InputItem::Text {
                    text: "try another path".into(),
                }],
            }),
            &mut sink,
            &NeverCancelled,
        )
        .unwrap();
    assert_eq!(fork.preparation_calls, ["read-session", "fork-thread"]);
    assert_eq!(fork.fork_parent, Some(parent_thread_id));
    assert_eq!(fork.start_sequences, [7]);
}

fn test_runner() -> ExecRunner {
    ExecRunner::new(AppServerTarget::Embedded(EmbeddedAppServerOptions::new(
        "/tmp/ash-exec-tests",
        ClientInfo {
            name: "ash-exec-tests".into(),
            version: "1".into(),
        },
    )))
    .with_options(
        ExecRunnerOptions::new()
            .with_turn_timeout(Duration::from_secs(1))
            .with_interrupt_timeout(Duration::from_secs(1))
            .with_event_poll_interval(Duration::from_millis(1)),
    )
}

fn new_request() -> ExecRunRequest {
    ExecRunRequest::new(ExecEntry::New {
        title: "test run".into(),
        input: vec![InputItem::Text {
            text: "perform the task".into(),
        }],
    })
    .with_run_id(ExecRunId::new("run-test").unwrap())
    .with_approval_mode(HeadlessApprovalMode::DenyInteractiveRequests)
}

struct NeverCancelled;

impl ExecCancellation for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
}

struct CountingCancellation {
    checks: AtomicUsize,
    trigger_at: usize,
}

impl CountingCancellation {
    fn after_checks(trigger_at: usize) -> Self {
        Self {
            checks: AtomicUsize::new(0),
            trigger_at,
        }
    }
}

impl ExecCancellation for CountingCancellation {
    fn is_cancelled(&self) -> bool {
        self.checks.fetch_add(1, Ordering::AcqRel) + 1 >= self.trigger_at
    }
}

struct TestIds {
    session_id: SessionId,
    thread_id: ThreadId,
    turn_id: TurnId,
}

impl TestIds {
    fn new() -> Self {
        Self {
            session_id: SessionId::new("session-test").unwrap(),
            thread_id: ThreadId::new("thread-test").unwrap(),
            turn_id: TurnId::new("turn-test").unwrap(),
        }
    }
}

fn session(ids: &TestIds) -> Session {
    Session {
        session_id: ids.session_id.clone(),
        title: "test run".into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: vec![],
    }
}

fn thread(ids: &TestIds, sequence: u64, turns: Vec<Turn>) -> Thread {
    Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: ids.session_id.clone(),
        thread_id: ids.thread_id.clone(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "test run".into(),
        status: ThreadStatus::Active,
        sequence,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns,
    }
}

fn turn(ids: &TestIds, status: TurnStatus, items: Vec<ThreadItem>) -> Turn {
    Turn {
        turn_id: ids.turn_id.clone(),
        status,
        kind: ash_protocol::TurnKind::Coding,
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items,
        plan: None,
        pending_interaction: None,
        error: None,
    }
}

fn agent_message(ids: &TestIds, text: &str) -> ThreadItem {
    ThreadItem::AgentMessage {
        item_id: ItemId::new(format!("item-{text}")).unwrap(),
        turn_id: ids.turn_id.clone(),
        text: text.into(),
    }
}

struct FakeConnection {
    session: Session,
    thread_id: ThreadId,
    snapshots: VecDeque<Thread>,
    current_thread: Thread,
    events: VecDeque<ConnectionEvent>,
    interrupts: usize,
    unsubscribed: bool,
    preparation_calls: Vec<&'static str>,
    fork_parent: Option<ThreadId>,
    start_sequences: Vec<u64>,
}

impl FakeConnection {
    fn new(ids: &TestIds, snapshots: Vec<Thread>) -> Self {
        let current_thread = snapshots
            .first()
            .cloned()
            .unwrap_or_else(|| thread(ids, 1, vec![]));
        Self {
            session: session(ids),
            thread_id: ids.thread_id.clone(),
            snapshots: snapshots.into(),
            current_thread,
            events: VecDeque::new(),
            interrupts: 0,
            unsubscribed: false,
            preparation_calls: Vec::new(),
            fork_parent: None,
            start_sequences: Vec::new(),
        }
    }
}

impl ExecConnection for FakeConnection {
    fn create_session(
        &mut self,
        _command_id: CommandId,
        _title: String,
    ) -> Result<Session, ConnectionError> {
        self.preparation_calls.push("create-session");
        Ok(self.session.clone())
    }

    fn read_session(&mut self, _session_id: SessionId) -> Result<Session, ConnectionError> {
        self.preparation_calls.push("read-session");
        Ok(self.session.clone())
    }

    fn fork_thread(
        &mut self,
        _command_id: CommandId,
        _session_id: SessionId,
        parent_thread_id: ThreadId,
        _title: String,
    ) -> Result<ThreadId, ConnectionError> {
        self.preparation_calls.push("fork-thread");
        self.fork_parent = Some(parent_thread_id);
        Ok(self.thread_id.clone())
    }

    fn read_thread(
        &mut self,
        _session_id: SessionId,
        _thread_id: ThreadId,
    ) -> Result<Thread, ConnectionError> {
        if let Some(snapshot) = self.snapshots.pop_front() {
            self.current_thread = snapshot;
        }
        Ok(self.current_thread.clone())
    }

    fn subscribe_thread(
        &mut self,
        _session_id: SessionId,
        _thread_id: ThreadId,
        _after_sequence: u64,
    ) -> Result<ThreadSubscription, ConnectionError> {
        Ok(ThreadSubscription {
            thread: self.current_thread.clone(),
            updates: vec![],
        })
    }

    fn unsubscribe_thread(
        &mut self,
        _session_id: SessionId,
        _thread_id: ThreadId,
    ) -> Result<(), ConnectionError> {
        self.unsubscribed = true;
        Ok(())
    }

    fn start_turn(
        &mut self,
        _command_id: CommandId,
        _session_id: SessionId,
        _thread_id: ThreadId,
        expected_sequence: u64,
        _approval_mode: ApprovalMode,
        _input: Vec<InputItem>,
    ) -> Result<TurnStartResult, ConnectionError> {
        self.start_sequences.push(expected_sequence);
        Ok(TurnStartResult {
            turn_id: TurnId::new("turn-test").unwrap(),
            sequence: 2,
        })
    }

    fn interrupt_turn(
        &mut self,
        _command_id: CommandId,
        _session_id: SessionId,
        _thread_id: ThreadId,
        _turn_id: TurnId,
        _expected_sequence: u64,
    ) -> Result<(), ConnectionError> {
        self.interrupts += 1;
        Ok(())
    }

    fn poll_event(&mut self, _timeout: Duration) -> Result<ConnectionEvent, ConnectionError> {
        Ok(self.events.pop_front().unwrap_or(ConnectionEvent::TimedOut))
    }

    fn close(&mut self) -> Result<(), ConnectionError> {
        Ok(())
    }
}
