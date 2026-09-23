use crate::Store;
use ash_core::AgentTreeLimits;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::MultiAgentCoordinator;
use ash_core::SpawnAgentRequest;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use core_api::SequenceExpectation;
use extension_api::ExtensionRegistry;
use extension_api::ExtensionRegistryBuilder;
use extension_api::TurnInputContext;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::TurnId;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tools::ToolContent;
use tools::ToolExecutionOutcome;
use tools::ToolExecutor;
use tools::ToolInvocation;
use tools::ToolOutputStatus;

#[test]
fn configured_clock_controls_timestamps_and_its_failure_prevents_writes() {
    let runtime = Runtime::new();
    let clock = Arc::new(Clock {
        time: AtomicU64::new(2_000),
        failed: AtomicBool::new(false),
    });
    runtime
        .threads
        .install_time_context_provider(clock.clone())
        .unwrap();
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"work"}),
    );
    let first = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "first",
        json!({
            "action":"post","channel":"work","text":"first"
        }),
    );
    assert_eq!(first["created_at"], 2000);
    clock.time.store(1_000, Ordering::SeqCst);
    let second = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "second",
        json!({
            "action":"post","channel":"work","text":"second"
        }),
    );
    assert_eq!(second["created_at"], 1000);
    clock.failed.store(true, Ordering::SeqCst);
    let (status, error) = runtime.call(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "failed",
        json!({
            "action":"post","channel":"work","text":"not saved"
        }),
    );
    assert_eq!(status, ToolOutputStatus::Error);
    assert!(error.contains("test clock failed"));
    let posts = runtime.ok(
        "board_read",
        &runtime.root,
        &runtime.turn,
        "read",
        json!({"action":"posts"}),
    );
    assert_eq!(posts["items"].as_array().unwrap().len(), 2);
    assert_eq!(posts["items"][0]["id"], second["id"]);
}

struct Runtime {
    threads: Arc<ThreadController>,
    registry: Arc<ExtensionRegistry>,
    session: SessionId,
    root: ThreadId,
    turn: TurnId,
}

struct Clock {
    time: AtomicU64,
    failed: AtomicBool,
}

impl ash_core::TimeContextProvider for Clock {
    fn snapshot(&self) -> Result<Option<protocol::TimeContext>, core_api::CoreError> {
        if self.failed.load(Ordering::SeqCst) {
            return Err(core_api::CoreError::Context("test clock failed".into()));
        }
        Ok(Some(protocol::TimeContext {
            sampled_at_unix_ms: protocol::UnixMillis::new(self.time.load(Ordering::SeqCst))
                .unwrap(),
            utc_offset_seconds: 0,
            time_zone: "UTC".into(),
            origin: protocol::TimeZoneOrigin::Configured,
            mode: protocol::TimeContextMode::Time,
        }))
    }
}
impl Runtime {
    fn new() -> Self {
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let mut builder = ExtensionRegistryBuilder::new();
        crate::install(
            &mut builder,
            &threads,
            Arc::new(Store::in_memory().unwrap()),
        );
        let registry = Arc::new(builder.build());
        threads.install_extensions(registry.clone()).unwrap();
        let session = SessionId::new("session").unwrap();
        let root = ThreadId::new("root").unwrap();
        create(&threads, &session, &root);
        let turn = start(&threads, &root, "initial");
        Self {
            threads,
            registry,
            session,
            root,
            turn,
        }
    }
    fn executor(&self, name: &str) -> Arc<dyn ToolExecutor> {
        self.registry
            .contribute_read_only_tools()
            .unwrap()
            .into_iter()
            .chain(
                self.registry
                    .contribute_capability_tools()
                    .unwrap()
                    .into_iter()
                    .map(|tool| tool.into_parts().0),
            )
            .find(|tool| tool.definition().name().as_str() == name)
            .unwrap()
    }
    fn invocation(
        &self,
        name: &str,
        caller: &ThreadId,
        turn: &TurnId,
        operation: &str,
        args: Value,
    ) -> ToolInvocation {
        let definition = self.executor(name).definition();
        ToolInvocation::new(
            tools::ToolOperationId::new(operation).unwrap(),
            protocol::ToolCallId::new("outer-call").unwrap(),
            turn.clone(),
            tools::ToolBinding::new(
                tools::ToolRegistryGeneration::new(1),
                tools::ToolBindingId::new(name).unwrap(),
                definition.name().clone(),
                definition.digest(),
                tools::ToolRuntimeKey::new(name).unwrap(),
            ),
            tools::ToolPayload::FunctionArguments(args),
            tools::ToolExecutionContext::new(
                tools::EnvId::new("test").unwrap(),
                async_utils::CancellationSource::new().token(),
                tools::ToolRuntimeAuthority::Unrestricted,
            )
            .with_session_id(self.session.clone())
            .with_thread_id(caller.clone()),
        )
    }
    fn call(
        &self,
        name: &str,
        caller: &ThreadId,
        turn: &TurnId,
        operation: &str,
        args: Value,
    ) -> (ToolOutputStatus, String) {
        let outcome = pollster::block_on(
            self.executor(name)
                .execute(self.invocation(name, caller, turn, operation, args)),
        );
        let ToolExecutionOutcome::Returned(output) = outcome else {
            panic!("tool did not return")
        };
        let [ToolContent::Text(text)] = output.content() else {
            panic!("tool did not return text")
        };
        (output.status(), text.clone())
    }
    fn ok(
        &self,
        name: &str,
        caller: &ThreadId,
        turn: &TurnId,
        operation: &str,
        args: Value,
    ) -> Value {
        let (status, text) = self.call(name, caller, turn, operation, args);
        assert_eq!(status, ToolOutputStatus::Success, "{text}");
        assert!(text.len() <= 8000);
        serde_json::from_str(&text).unwrap()
    }
    fn child(&self) -> (ThreadId, TurnId) {
        self.child_named("child")
    }
    fn child_named(&self, delegation: &str) -> (ThreadId, TurnId) {
        let spawned = MultiAgentCoordinator::new(self.threads.clone(), AgentTreeLimits::default())
            .spawn(SpawnAgentRequest {
                delegation_id: protocol::DelegationId::new(delegation).unwrap(),
                session_id: self.session.clone(),
                parent_thread_id: self.root.clone(),
                parent_turn_id: self.turn.clone(),
                task: protocol::DelegatedTask {
                    title: "worker".into(),
                    instructions: "Discuss findings".into(),
                },
                role: None,
                base_instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                inheritance: protocol::AgentContextMode::Fresh,
                policy_ceiling: protocol::DelegatedPolicyCeiling {
                    policy_revision: "board-tests".into(),
                },
                capability_scope: protocol::AgentCapabilityScope {
                    tools: vec![],
                    delegation_tools: vec![],
                    skills: vec![],
                },
            })
            .unwrap();
        (spawned.child_thread_id, spawned.child_turn_id)
    }
    fn notices(&self, thread: &ThreadId, turn: &TurnId) -> Vec<extension_api::PromptFragment> {
        self.registry
            .contribute_turn_input(TurnInputContext::for_session(
                &self.session,
                thread,
                turn,
                &[],
            ))
            .unwrap()
    }
}
fn create(threads: &ThreadController, session: &SessionId, thread: &ThreadId) {
    threads
        .create_thread(CreateThreadRequest {
            agent_id: protocol::AgentId::new(format!("agent-{thread}")).unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session.clone(),
            thread_id: thread.clone(),
            title: thread.to_string(),
        })
        .unwrap();
}
fn start(threads: &ThreadController, thread: &ThreadId, key: &str) -> TurnId {
    threads
        .start_turn(
            thread,
            StartTurnRequest {
                command_id: protocol::CommandId::new(key).unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                advisor: None,
                kind: protocol::TurnKind::Coding,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                policy_revision: "board-tests".into(),
                approval_mode: protocol::ApprovalMode::AskPermissions,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![protocol::UserInput::Text {
                    text: "Discuss findings".into(),
                }],
            },
        )
        .unwrap()
        .turn_id
}

#[test]
fn agents_share_evidence_and_reply_without_starting_idle_members() {
    let runtime = Runtime::new();
    let (child, child_turn) = runtime.child();
    let create = json!({"action":"create_channel","channel":"work"});
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        create,
    );
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "watch",
        json!({
            "action":"subscription","channel":"work","state":"on"
        }),
    );
    let post_args = json!({"action":"post","channel":"work","text":"<untrusted> evidence"});
    let post = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "finding",
        post_args.clone(),
    );
    let notices = runtime.notices(&child, &child_turn);
    assert_eq!(notices.len(), 2);
    assert_eq!(
        notices[0].retention(),
        extension_api::PromptFragmentRetention::Required
    );
    assert_eq!(
        notices[1].layer(),
        extension_api::PromptFragmentLayer::AgentMessage
    );
    assert!(notices[1].body().contains("&lt;untrusted&gt;"));
    assert!(notices[1].body().contains("verify claims"));
    let read = runtime.ok(
        "board_read",
        &child,
        &child_turn,
        "read",
        json!({
            "action":"post","id":post["id"]
        }),
    );
    assert_eq!(read["text"], "<untrusted> evidence");
    runtime.ok("board_write", &child, &child_turn, "reply", json!({
        "action":"post","channel":"work","topic":post["topic"],"text":"Verified at src/store.rs with the integration test."
    }));
    assert_eq!(runtime.notices(&runtime.root, &runtime.turn).len(), 2);
    runtime
        .threads
        .complete_turn(&child, &child_turn, "done".into())
        .unwrap();
    runtime.ok("board_write", &runtime.root, &runtime.turn, "idle", json!({
        "action":"post","channel":"work","topic":post["topic"],"text":"Available on the board later."
    }));
    assert_eq!(runtime.threads.read_thread(&child).unwrap().turns.len(), 1);
    let next = start(&runtime.threads, &child, "next");
    assert!(runtime.notices(&child, &next).is_empty());
    assert_eq!(
        runtime.ok(
            "board_write",
            &runtime.root,
            &runtime.turn,
            "finding",
            post_args
        ),
        post
    );
    assert!(runtime.notices(&child, &next).is_empty());
    let topic = runtime.ok(
        "board_read",
        &child,
        &next,
        "topic",
        json!({"action":"posts","topic":post["topic"]}),
    );
    assert_eq!(topic["items"].as_array().unwrap().len(), 3);
}

#[test]
fn overflowing_notices_report_the_loss_and_prioritize_new_posts() {
    let runtime = Runtime::new();
    let (child, turn) = runtime.child();
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"work"}),
    );
    runtime.ok(
        "board_write",
        &child,
        &turn,
        "watch",
        json!({"action":"subscription","channel":"work","state":"on"}),
    );
    for index in 0..66 {
        runtime.ok(
            "board_write",
            &runtime.root,
            &runtime.turn,
            &format!("post-{index}"),
            json!({"action":"post","channel":"work","text":format!("finding {index}")}),
        );
    }

    let notices = runtime.notices(&child, &turn);
    assert_eq!(notices.len(), 65);
    assert_eq!(
        notices[0].retention(),
        extension_api::PromptFragmentRetention::Required
    );
    assert!(notices[0].body().contains("66 updates"));
    assert!(notices[0].body().contains("2 older previews were dropped"));
    assert!(notices[1].body().contains("finding 65"));
    assert!(notices[64].body().contains("finding 2"));
    assert!(
        notices
            .iter()
            .all(|notice| notice.layer() == extension_api::PromptFragmentLayer::AgentMessage)
    );
}

#[test]
fn unsubscribe_waits_for_an_earlier_posts_fanout() {
    use std::sync::mpsc;
    use std::time::Duration;
    use std::time::Instant;

    let runtime = Arc::new(Runtime::new());
    let first = runtime.child_named("first");
    let second = runtime.child_named("second");
    let (blocked, unsubscribing) = if first.0 < second.0 {
        (first, second)
    } else {
        (second, first)
    };
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"work"}),
    );
    for (member, turn) in [&blocked, &unsubscribing] {
        runtime.ok(
            "board_write",
            member,
            turn,
            &format!("watch-{member}"),
            json!({"action":"subscription","channel":"work","state":"on"}),
        );
    }

    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let threads = runtime.threads.clone();
    let blocked_id = blocked.0.clone();
    let holder = std::thread::spawn(move || {
        threads.with_running_turn(&blocked_id, |_, _| {
            held_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        })
    });
    held_rx.recv_timeout(Duration::from_secs(5)).unwrap();

    let writer_runtime = runtime.clone();
    let (post_tx, post_rx) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let result = writer_runtime.ok(
            "board_write",
            &writer_runtime.root,
            &writer_runtime.turn,
            "post",
            json!({"action":"post","channel":"work","text":"before unsubscribe"}),
        );
        post_tx.send(result).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let posts = runtime.ok(
            "board_read",
            &runtime.root,
            &runtime.turn,
            "posted",
            json!({"action":"posts","channel":"work"}),
        );
        if !posts["items"].as_array().unwrap().is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "post did not commit");
        std::thread::yield_now();
    }

    let other = ThreadId::new("other-root").unwrap();
    create(&runtime.threads, &runtime.session, &other);
    let other_turn = start(&runtime.threads, &other, "other-turn");
    let other_runtime = runtime.clone();
    let (other_tx, other_rx) = mpsc::channel();
    let unrelated = std::thread::spawn(move || {
        other_runtime.ok(
            "board_write",
            &other,
            &other_turn,
            "other-channel",
            json!({"action":"create_channel","channel":"independent"}),
        );
        other_tx.send(()).unwrap();
    });
    let unrelated_completed = other_rx.recv_timeout(Duration::from_millis(500)).is_ok();

    let off_runtime = runtime.clone();
    let off_member = unsubscribing.0.clone();
    let off_turn = unsubscribing.1.clone();
    let (off_started_tx, off_started_rx) = mpsc::channel();
    let (off_tx, off_rx) = mpsc::channel();
    let off = std::thread::spawn(move || {
        off_started_tx.send(()).unwrap();
        off_runtime.ok(
            "board_write",
            &off_member,
            &off_turn,
            "off",
            json!({"action":"subscription","channel":"work","state":"off"}),
        );
        off_tx.send(()).unwrap();
    });
    off_started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(off_rx.recv_timeout(Duration::from_millis(100)).is_err());
    release_tx.send(()).unwrap();
    holder.join().unwrap().unwrap();
    unrelated.join().unwrap();
    assert!(
        unrelated_completed,
        "another board must not wait for this fanout"
    );
    post_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    off_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    writer.join().unwrap();
    off.join().unwrap();
    assert_eq!(runtime.notices(&unsubscribing.0, &unsubscribing.1).len(), 2);

    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "later",
        json!({"action":"post","channel":"work","text":"after unsubscribe"}),
    );
    assert_eq!(runtime.notices(&unsubscribing.0, &unsubscribing.1).len(), 2);
}

#[test]
fn posting_does_not_restore_an_explicitly_unsubscribed_agents_notices() {
    let runtime = Runtime::new();
    let (child, child_turn) = runtime.child();
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"work"}),
    );
    let first = runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "topic",
        json!({"action":"post","channel":"work","text":"finding"}),
    );
    assert_eq!(runtime.notices(&runtime.root, &runtime.turn).len(), 2);
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "unsubscribe",
        json!({"action":"subscription","channel":"work","topic":first["topic"],"state":"off"}),
    );
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "followup",
        json!({"action":"post","channel":"work","topic":first["topic"],"text":"more evidence"}),
    );
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "reply",
        json!({"action":"post","channel":"work","topic":first["topic"],"text":"reviewed"}),
    );
    assert!(runtime.notices(&child, &child_turn).is_empty());
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "resubscribe",
        json!({"action":"subscription","channel":"work","topic":first["topic"],"state":"on"}),
    );
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "accepted",
        json!({"action":"post","channel":"work","topic":first["topic"],"text":"accepted"}),
    );
    assert_eq!(runtime.notices(&child, &child_turn).len(), 2);
}

#[test]
fn only_the_member_can_change_subscriptions_and_notify_respects_opt_out() {
    let runtime = Runtime::new();
    let (child, child_turn) = runtime.child();
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"work"}),
    );
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "onboard-child",
                json!({"action":"subscription","channel":"work","member":child,"state":"on"}),
            )
            .0,
        ToolOutputStatus::Error
    );
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "self-subscribe",
        json!({"action":"subscription","channel":"work","state":"on"}),
    );
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "mute-channel",
        json!({"action":"subscription","channel":"work","state":"off"}),
    );
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "subscribe-child",
                json!({"action":"subscription","channel":"work","member":child,"state":"on"}),
            )
            .0,
        ToolOutputStatus::Error
    );
    let topic = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "topic",
        json!({"action":"post","channel":"work","text":"finding","notify":[child]}),
    );
    assert!(runtime.notices(&child, &child_turn).is_empty());

    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "watch-channel",
        json!({"action":"subscription","channel":"work","state":"on"}),
    );
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "unsubscribe-child",
                json!({"action":"subscription","channel":"work","member":child,"state":"off"}),
            )
            .0,
        ToolOutputStatus::Error
    );
    runtime.ok(
        "board_write",
        &child,
        &child_turn,
        "mute-topic",
        json!({"action":"subscription","channel":"work","topic":topic["topic"],"state":"off"}),
    );
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "subscribe-topic-for-child",
                json!({"action":"subscription","channel":"work","topic":topic["topic"],"member":child,"state":"on"}),
            )
            .0,
        ToolOutputStatus::Error
    );
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "reply",
        json!({"action":"post","channel":"work","topic":topic["topic"],"text":"reviewed","notify":[child]}),
    );
    assert!(runtime.notices(&child, &child_turn).is_empty());
}

#[test]
fn tools_reject_other_trees_forged_turns_and_write_actions_on_the_reader() {
    let runtime = Runtime::new();
    let other = ThreadId::new("other-root").unwrap();
    create(&runtime.threads, &runtime.session, &other);
    let other_turn = start(&runtime.threads, &other, "start-other");
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"private"}),
    );
    let post = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "secret",
        json!({
            "action":"post","channel":"private","text":"private evidence"
        }),
    );
    for args in [
        json!({"action":"post","channel":"private","text":"bad","notify":[other]}),
        json!({"action":"post","channel":"private","text":"bad","session":"forged"}),
        json!({"action":"subscription","channel":"private","state":"on","member":other}),
        json!({"action":"post","channel":"private","text":"bad","topic":-1}),
    ] {
        assert_eq!(
            runtime
                .call("board_write", &runtime.root, &runtime.turn, "invalid", args)
                .0,
            ToolOutputStatus::Error
        );
    }
    assert_eq!(
        runtime
            .call(
                "board_read",
                &other,
                &other_turn,
                "read",
                json!({"action":"post","id":post["id"]})
            )
            .0,
        ToolOutputStatus::Error
    );
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &other_turn,
                "forged",
                json!({
                    "action":"post","channel":"private","text":"bad"
                })
            )
            .0,
        ToolOutputStatus::Error
    );
    assert_eq!(
        runtime
            .call(
                "board_read",
                &runtime.root,
                &runtime.turn,
                "write",
                json!({
                    "action":"create_channel","channel":"unauthorized"
                })
            )
            .0,
        ToolOutputStatus::Error
    );
    let read = runtime.ok(
        "board_read",
        &runtime.root,
        &runtime.turn,
        "list",
        json!({"action":"posts"}),
    );
    assert_eq!(read["items"].as_array().unwrap().len(), 1);
    runtime
        .threads
        .complete_turn(&runtime.root, &runtime.turn, "done".into())
        .unwrap();
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "late",
                json!({
                    "action":"post","channel":"private","text":"bad"
                })
            )
            .0,
        ToolOutputStatus::Error
    );
}

#[test]
fn code_mode_operations_have_separate_replay_receipts_and_bounded_unicode_reads() {
    let runtime = Runtime::new();
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "create",
        json!({"action":"create_channel","channel":"work"}),
    );
    let source = "😀\"\\".repeat(6000);
    let args = json!({"action":"post","channel":"work","text":source});
    let first = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "cell:1",
        args.clone(),
    );
    let second = runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "cell:2",
        args.clone(),
    );
    assert_ne!(first["id"], second["id"]);
    assert_eq!(
        runtime.ok("board_write", &runtime.root, &runtime.turn, "cell:1", args),
        first
    );
    assert_eq!(
        runtime
            .call(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "cell:1",
                json!({
                    "action":"post","channel":"work","text":"changed"
                })
            )
            .0,
        ToolOutputStatus::Error
    );
    let mut offset = 0;
    let mut content = String::new();
    loop {
        let page = runtime.ok(
            "board_read",
            &runtime.root,
            &runtime.turn,
            "read",
            json!({
                "action":"post","id":first["id"],"offset":offset,"chars":4000
            }),
        );
        content.push_str(page["text"].as_str().unwrap());
        match page["next_offset"].as_u64() {
            Some(next) => {
                assert!(next > offset);
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(content, source);
    let list = runtime.ok(
        "board_read",
        &runtime.root,
        &runtime.turn,
        "search",
        json!({"action":"posts","limit":50}),
    );
    assert_eq!(list["items"].as_array().unwrap().len(), 2);
}

#[test]
fn completion_racing_a_post_does_not_leave_a_notice_for_the_next_turn() {
    let runtime = Arc::new(Runtime::new());
    let (child, child_turn) = runtime.child();
    runtime.ok(
        "board_write",
        &runtime.root,
        &runtime.turn,
        "channel",
        json!({"action":"create_channel","channel":"work"}),
    );
    let gate = Arc::new(std::sync::Barrier::new(2));
    let writer = {
        let runtime = runtime.clone();
        let child = child.clone();
        let gate = gate.clone();
        std::thread::spawn(move || {
            gate.wait();
            runtime.ok(
                "board_write",
                &runtime.root,
                &runtime.turn,
                "race",
                json!({
                    "action":"post","channel":"work","text":"new evidence","notify":[child]
                }),
            )
        })
    };
    gate.wait();
    runtime
        .threads
        .complete_turn(&child, &child_turn, "done".into())
        .unwrap();
    writer.join().unwrap();
    let next = start(&runtime.threads, &child, "next");
    assert!(runtime.notices(&child, &next).is_empty());
}

#[test]
fn cancellation_prevents_writes_and_read_tools_need_no_write_authority() {
    let runtime = Runtime::new();
    assert_eq!(
        runtime.registry.contribute_read_only_tools().unwrap().len(),
        1
    );
    let write = runtime.registry.contribute_capability_tools().unwrap();
    assert_eq!(write.len(), 1);
    assert!(
        matches!(write[0].authority(), extension_api::ExtensionToolAuthority::ManagedStateWrite { resource } if resource == "agent-message-board")
    );
    let source = async_utils::CancellationSource::new();
    let definition = runtime.executor("board_write").definition();
    let invocation = ToolInvocation::new(
        tools::ToolOperationId::new("cancelled").unwrap(),
        protocol::ToolCallId::new("call").unwrap(),
        runtime.turn.clone(),
        tools::ToolBinding::new(
            tools::ToolRegistryGeneration::new(1),
            tools::ToolBindingId::new("board_write").unwrap(),
            definition.name().clone(),
            definition.digest(),
            tools::ToolRuntimeKey::new("board_write").unwrap(),
        ),
        tools::ToolPayload::FunctionArguments(
            json!({"action":"create_channel","channel":"cancelled"}),
        ),
        tools::ToolExecutionContext::new(
            tools::EnvId::new("test").unwrap(),
            source.token(),
            tools::ToolRuntimeAuthority::Unrestricted,
        )
        .with_session_id(runtime.session.clone())
        .with_thread_id(runtime.root.clone()),
    );
    source.cancel();
    let outcome = pollster::block_on(runtime.executor("board_write").execute(invocation));
    assert!(
        matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Error)
    );
    let channels = runtime.ok(
        "board_read",
        &runtime.root,
        &runtime.turn,
        "read",
        json!({"action":"channels"}),
    );
    assert_eq!(channels["items"].as_array().unwrap().len(), 0);
}
