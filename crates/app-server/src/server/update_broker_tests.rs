use super::*;
use crate::server::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::common::AgentInteractionCapability;
use ash_app_server_protocol::protocol::language::LanguageServerStateDto;
use ash_app_server_protocol::protocol::language::LanguageServerStateNotification;
use ash_protocol::ActionApprovalCapability;
use ash_protocol::ActionApprovalCapabilityKind;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::AgentInteractionKind;
use ash_protocol::AgentRequest;
use ash_protocol::AgentRequestEnvelope;
use ash_protocol::DynamicToolCall;
use ash_protocol::ItemDelta;
use ash_protocol::ItemId;
use ash_protocol::RequestId;
use ash_protocol::StreamCursor;
use ash_protocol::StreamInstanceId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use core_api::HookEventDecision;

struct RecordingHooks(std::sync::mpsc::Sender<HookEventRequest>);

impl HookService for RecordingHooks {
    fn has_enabled_event(&self, _: HookEvent) -> bool {
        true
    }

    fn event(
        &self,
        request: &HookEventRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<HookEventDecision, core_api::CoreError> {
        self.0.send(request.clone()).unwrap();
        Ok(HookEventDecision::Continue)
    }

    fn before_tool(
        &self,
        _: &core_api::BeforeToolHookRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<core_api::BeforeToolHookDecision, core_api::CoreError> {
        Ok(core_api::BeforeToolHookDecision::Continue)
    }

    fn after_tool(
        &self,
        _: &core_api::AfterToolHookRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<(), core_api::CoreError> {
        Ok(())
    }

    fn turn_completed(
        &self,
        _: &core_api::TurnCompletedHookRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<(), core_api::CoreError> {
        Ok(())
    }
}

#[test]
fn delivered_request_and_assistant_text_emit_ui_hook_events() {
    let broker = UpdateBroker::default();
    let (sender, receiver) = std::sync::mpsc::channel();
    broker.bind_hooks(Arc::new(RecordingHooks(sender)));
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &queue);
    broker.set_agent_interaction_capability(1, Some(approval_capability()));
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);

    broker.offer_agent_request(approval_request(&session_id, &thread_id), 0);
    broker.publish_thread_update(transient_thread_update(&session_id, &thread_id, 1, "Hello"));

    assert_eq!(
        receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .event,
        HookEvent::Notification
    );
    let displayed = receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    assert_eq!(displayed.event, HookEvent::MessageDisplay);
    assert_eq!(displayed.subject.as_deref(), Some("Hello"));
}

#[test]
fn tool_catalog_invalidation_fans_out_only_to_its_environment_connections() {
    let broker = UpdateBroker::default();
    let foreign = broker.fork_scope();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    let unrelated = NotificationQueue::default();
    broker.register(1, false, &first);
    broker.register(2, true, &second);
    foreign.register(3, true, &unrelated);

    broker.publish_agent_tools_changed();
    for queue in [&first, &second] {
        let notifications = queue.drain();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0]["method"], "agent/tools/changed");
        assert_eq!(notifications[0]["params"], serde_json::json!({}));
    }
    assert!(unrelated.drain().is_empty());
    broker.unregister(2);
    broker.publish_agent_tools_changed();
    assert_eq!(first.drain().len(), 1);
    assert!(second.drain().is_empty());
}

#[test]
fn broker_fans_out_filesystem_invalidation_without_a_subscription() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);

    broker.publish_fs_changed(FsChanged::PathsChanged {
        dir_id: None,
        paths: vec!["src/lib.rs".into()],
    });

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "fs/changed");
    assert_eq!(notifications[0]["params"]["paths"][0], "src/lib.rs");
}

#[test]
fn profile_broker_shares_thread_updates_but_isolates_env_notifications() {
    let first_scope = UpdateBroker::default();
    let second_scope = first_scope.fork_scope();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    let first_connection = first_scope.allocate_connection_id();
    let second_connection = second_scope.allocate_connection_id();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    first_scope.register(first_connection, false, &first);
    second_scope.register(second_connection, false, &second);
    first_scope.subscribe_session(first_connection, session_id.clone());
    second_scope.subscribe_session(second_connection, session_id.clone());
    first_scope.subscribe_session_thread(
        first_connection,
        session_id.clone(),
        thread_id.clone(),
        0,
    );
    second_scope.subscribe_session_thread(
        second_connection,
        session_id.clone(),
        thread_id.clone(),
        0,
    );

    first_scope.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 1)]);
    first_scope.publish_fs_changed(FsChanged::PathsChanged {
        dir_id: None,
        paths: vec!["first/src/lib.rs".into()],
    });

    assert_ne!(first_connection, second_connection);
    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 1);
    assert_eq!(second.drain()[0]["method"], "session/thread/update");
}

#[test]
fn profile_broker_fans_out_extension_packages_generations_across_env_scopes() {
    let first_scope = UpdateBroker::default();
    let second_scope = first_scope.fork_scope();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    first_scope.register(first_scope.allocate_connection_id(), false, &first);
    second_scope.register(second_scope.allocate_connection_id(), false, &second);

    let instance_id = first_scope.extension_packages_instance_id().to_owned();
    assert_eq!(second_scope.extension_packages_instance_id(), instance_id);
    assert_eq!(first_scope.extension_packages_generation(), 1);
    assert_eq!(first_scope.publish_extension_packages_changed(), 2);
    assert_eq!(second_scope.publish_extension_packages_changed(), 3);
    assert_eq!(first_scope.extension_packages_generation(), 3);
    assert_eq!(second_scope.extension_packages_generation(), 3);

    for queue in [&first, &second] {
        let notifications = queue.drain();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0]["method"], "extensions/changed");
        assert_eq!(notifications[0]["params"]["instanceId"], instance_id);
        assert_eq!(notifications[0]["params"]["generation"], 2);
        assert_eq!(notifications[1]["params"]["generation"], 3);
    }
}

#[test]
fn profile_extension_packages_broker_deduplicates_one_manager_commit_seen_by_multiple_scopes() {
    let first_scope = UpdateBroker::default();
    let second_scope = first_scope.fork_scope();
    let queue = NotificationQueue::default();
    first_scope.register(first_scope.allocate_connection_id(), false, &queue);

    assert_eq!(
        first_scope.publish_extension_packages_manager_changed("manager-a", 2),
        2
    );
    assert_eq!(
        second_scope.publish_extension_packages_manager_changed("manager-a", 2),
        2
    );
    assert_eq!(
        second_scope.publish_extension_packages_manager_changed("manager-a", 3),
        3
    );
    assert_eq!(
        first_scope.publish_extension_packages_manager_changed("manager-b", 2),
        4
    );

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 3);
    assert_eq!(notifications[0]["params"]["generation"], 2);
    assert_eq!(notifications[1]["params"]["generation"], 3);
    assert_eq!(notifications[2]["params"]["generation"], 4);
}

#[test]
fn language_download_progress_notifications_precede_background_ready_during_a_request() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);
    let request = queue.defer_causal_notifications(None);
    let causal = serde_json::json!({"method":"config/changed", "params":{"revision":1}});
    queue.push(causal.clone());

    let download = |done| LanguageServerProgressNotification {
        dir_id: None,
        server: "rust-analyzer".into(),
        token: "ash.language-server.download".into(),
        title: None,
        message: None,
        percentage: None,
        done,
    };
    broker.publish_language_server_progress(Some(1), download(false));
    let downloading = queue.drain();
    assert_eq!(
        downloading.len(),
        1,
        "download must be visible before the request returns"
    );
    assert_eq!(downloading[0]["method"], "language/serverProgress");
    assert_eq!(downloading[0]["params"]["done"], false);

    broker.publish_language_server_progress(Some(1), download(true));
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                for state in [
                    LanguageServerStateDto::Starting,
                    LanguageServerStateDto::Ready,
                ] {
                    broker.publish_language_server_state(
                        Some(1),
                        LanguageServerStateNotification {
                            dir_id: None,
                            server: "rust-analyzer".into(),
                            state,
                        },
                    );
                }
            })
            .join()
            .unwrap();
    });
    let notifications = queue.drain();
    assert_eq!(notifications.len(), 3);
    assert_eq!(notifications[0]["method"], "language/serverProgress");
    assert_eq!(notifications[0]["params"]["done"], true);
    assert_eq!(notifications[1]["params"]["state"]["type"], "starting");
    assert_eq!(notifications[2]["params"]["state"]["type"], "ready");
    drop(request);
    assert_eq!(queue.drain(), [causal]);
}

#[test]
fn broker_fans_out_language_server_lifecycle_without_a_subscription() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);

    broker.publish_language_server_state(
        None,
        LanguageServerStateNotification {
            dir_id: None,
            server: "rust-analyzer".into(),
            state: LanguageServerStateDto::BackingOff {
                attempt: 2,
                retry_after_millis: 1_500,
            },
        },
    );

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "language/serverState");
    assert_eq!(notifications[0]["params"]["server"], "rust-analyzer");
    assert_eq!(notifications[0]["params"]["state"]["type"], "backingOff");
    assert_eq!(notifications[0]["params"]["state"]["attempt"], 2);
    assert_eq!(
        notifications[0]["params"]["state"]["retryAfterMillis"],
        1_500
    );
}

#[test]
fn session_owned_thread_subscription_follows_session_lifecycle() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    broker.register(1, false, &queue);
    broker.subscribe_session(1, session_id.clone());
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);

    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 1)]);
    assert_eq!(queue.len(), 1);
    let notifications = queue.drain();
    assert_eq!(notifications[0]["method"], "session/thread/update");

    broker.unsubscribe_session(1, &session_id);
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 2)]);
    assert_eq!(queue.len(), 0);
}

#[test]
fn session_thread_subscription_can_be_removed_independently() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    broker.register(1, false, &queue);
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 1)]);
    assert_eq!(queue.len(), 1);
    queue.drain();

    broker.unsubscribe_session_thread(1, &session_id, &thread_id);
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 2)]);
    assert_eq!(queue.len(), 0);
}

#[test]
fn thread_subscription_observes_session_changes() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.register(1, false, &queue);
    broker.subscribe_session_thread(1, session_id.clone(), thread_id, 0);

    broker.publish_session_changed(&session_id);

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "session/changed");
    assert_eq!(notifications[0]["params"]["sessionId"], "session_1");
    assert_eq!(notifications[0]["params"]["agentTreeChanged"], false);
}

#[test]
fn session_catalog_changes_reach_connections_without_loading_the_session() {
    let broker = UpdateBroker::default();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    let unrelated = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    broker.register(3, false, &unrelated);
    broker.subscribe_catalog(1);
    broker.subscribe_catalog(2);

    broker.publish_session_changed(&session_id);
    broker.publish_session_deleted(&session_id);
    broker.forget_session(&session_id);

    for queue in [&first, &second] {
        let notifications = queue.drain();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0]["method"], "session/changed");
        assert_eq!(notifications[1]["method"], "session/deleted");
        assert_eq!(notifications[1]["params"]["sessionId"], "session_1");
    }
    assert!(unrelated.drain().is_empty());

    broker.unsubscribe_catalog(1);
    broker.publish_session_changed(&session_id);
    assert!(first.drain().is_empty());
    assert_eq!(second.drain()[0]["method"], "session/changed");
}

#[test]
fn committed_subagent_updates_invalidate_the_catalog_without_a_session_subscription() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let child_thread_id = ThreadId::new("child").unwrap();
    broker.register(1, false, &queue);
    broker.subscribe_catalog(1);

    broker.publish_thread(
        &child_thread_id,
        &[ThreadUpdateEnvelope {
            session_id,
            thread_id: child_thread_id.clone(),
            durable_sequence: 1,
            stream_cursor: None,
            update: ThreadUpdate::Committed {
                event: ThreadEvent::TurnStarted {
                    thread_id: child_thread_id.clone(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                },
            },
        }],
    );

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "session/changed");
    assert_eq!(notifications[0]["params"]["sessionId"], "session_1");
    assert_eq!(notifications[0]["params"]["agentTreeChanged"], true);

    broker.publish_thread(
        &child_thread_id,
        &[ThreadUpdateEnvelope {
            session_id: SessionId::new("session_1").unwrap(),
            thread_id: child_thread_id.clone(),
            durable_sequence: 2,
            stream_cursor: None,
            update: ThreadUpdate::Committed {
                event: ThreadEvent::TurnCancelling {
                    thread_id: child_thread_id.clone(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                },
            },
        }],
    );
    let cancelling = queue.drain();
    assert_eq!(cancelling[0]["method"], "session/changed");
    assert_eq!(cancelling[0]["params"]["agentTreeChanged"], true);

    broker.publish_thread(
        &child_thread_id,
        &[ThreadUpdateEnvelope {
            session_id: SessionId::new("session_1").unwrap(),
            thread_id: child_thread_id.clone(),
            durable_sequence: 3,
            stream_cursor: None,
            update: ThreadUpdate::Committed {
                event: ThreadEvent::TurnSteered {
                    thread_id: child_thread_id.clone(),
                    turn_id: TurnId::new("turn_1").unwrap(),
                    item_ids: Vec::new(),
                },
            },
        }],
    );
    assert_eq!(queue.drain()[0]["params"]["agentTreeChanged"], false);
}

#[test]
fn thread_update_publishes_backend_assembled_transcript_entry() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.register(1, false, &queue);
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);

    broker.publish_thread_update(ThreadUpdateEnvelope {
        session_id,
        thread_id,
        durable_sequence: 0,
        stream_cursor: Some(StreamCursor {
            stream_instance_id: StreamInstanceId::new("stream_1").unwrap(),
            sequence: 1,
        }),
        update: ThreadUpdate::ItemDelta {
            turn_id: TurnId::new("turn_1").unwrap(),
            item_id: ItemId::new("item_1").unwrap(),
            delta: ItemDelta::AgentMessage {
                text: "Hello".into(),
            },
        },
    });

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 2);
    assert_eq!(notifications[0]["method"], "session/thread/update");
    assert_eq!(
        notifications[1]["method"],
        "session/thread/transcript/update"
    );
    assert_eq!(
        notifications[1]["params"]["changes"][0]["entry"]["item"]["text"],
        "Hello"
    );
}

#[test]
fn transcript_snapshot_includes_output_assembled_before_a_consumer_subscribes() {
    let broker = UpdateBroker::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.publish_thread_update(transient_thread_update(
        &session_id,
        &thread_id,
        1,
        "Hello before subscribe",
    ));

    let thread = ash_protocol::Thread {
        advisor: Default::default(),
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id,
        thread_id,
        parent_thread_id: None,
        forked_from_id: None,
        title: "Thread".into(),
        status: ash_protocol::ThreadStatus::Active,
        sequence: 0,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: vec![ash_protocol::Turn {
            turn_id: TurnId::new("turn_1").unwrap(),
            status: ash_protocol::TurnStatus::Running,
            kind: ash_protocol::TurnKind::Coding,
            mode: ash_protocol::CollaborationMode::Agent,
            instructions: None,
            model: None,
            reasoning_effort: None,
            advisor: None,
            tool_profile: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::Manual,
            usage: ash_protocol::ModelUsageSummary::default(),
            context_usage: None,
            items: Vec::new(),
            plan: None,
            pending_interaction: None,
            error: None,
        }],
        hook_runs: Vec::new(),
    };
    let snapshot = broker.thread_transcript_snapshot(&thread, true, &[]);

    assert!(matches!(
        &snapshot.entries[0],
        ash_thread_transcript::ThreadTranscriptEntry::Item {
            item: ash_protocol::ThreadItem::AgentMessage { text, .. },
            transient: true,
            ..
        } if text == "Hello before subscribe"
    ));
}

#[test]
fn transcript_accumulator_survives_turn_boundaries() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.register(1, false, &queue);
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.publish_thread_update(transient_thread_update(
        &session_id,
        &thread_id,
        1,
        "first turn",
    ));
    queue.drain();
    broker.publish_thread_update(ThreadUpdateEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        durable_sequence: 1,
        stream_cursor: None,
        update: ThreadUpdate::Committed {
            event: ThreadEvent::TurnCompleted {
                thread_id: thread_id.clone(),
                turn_id: TurnId::new("turn_1").unwrap(),
            },
        },
    });
    queue.drain();

    broker.publish_thread_update(transient_thread_update(
        &session_id,
        &thread_id,
        2,
        "second turn",
    ));

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 2);
    assert_eq!(
        notifications[1]["params"]["changes"][0]["entry"]["item"]["text"],
        "second turn"
    );
}

fn transient_thread_update(
    session_id: &SessionId,
    thread_id: &ThreadId,
    sequence: u64,
    text: &str,
) -> ThreadUpdateEnvelope {
    ThreadUpdateEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        durable_sequence: 0,
        stream_cursor: Some(StreamCursor {
            stream_instance_id: StreamInstanceId::new("stream_1").unwrap(),
            sequence,
        }),
        update: ThreadUpdate::ItemDelta {
            turn_id: TurnId::new(format!("turn_{sequence}")).unwrap(),
            item_id: ItemId::new(format!("item_{sequence}")).unwrap(),
            delta: ItemDelta::AgentMessage { text: text.into() },
        },
    }
}

#[test]
fn agent_request_is_delivered_to_exactly_one_capable_thread_subscriber() {
    let broker = UpdateBroker::default();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    broker.set_agent_interaction_capability(1, Some(approval_capability()));
    broker.set_agent_interaction_capability(2, Some(approval_capability()));
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.subscribe_session_thread(2, session_id.clone(), thread_id.clone(), 0);

    broker.offer_agent_request(approval_request(&session_id, &thread_id), 0);

    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 0);
    assert!(broker.is_agent_interaction_owner(
        1,
        &RequestId::new("approval_1").expect("test ID is non-empty")
    ));
}

#[test]
fn agent_request_is_reassigned_when_its_connection_closes() {
    let broker = UpdateBroker::default();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    broker.set_agent_interaction_capability(1, Some(approval_capability()));
    broker.set_agent_interaction_capability(2, Some(approval_capability()));
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.subscribe_session_thread(2, session_id.clone(), thread_id.clone(), 0);
    broker.offer_agent_request(approval_request(&session_id, &thread_id), 0);
    first.drain();

    broker.unregister(1);

    let notifications = second.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "agent/request");
    assert!(broker.is_agent_interaction_owner(
        2,
        &RequestId::new("approval_1").expect("test ID is non-empty")
    ));
}

#[test]
fn delivered_dynamic_tool_is_not_reassigned_when_its_owner_closes() {
    let broker = UpdateBroker::default();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    broker.set_agent_interaction_capability(1, Some(dynamic_tool_capability()));
    broker.set_agent_interaction_capability(2, Some(dynamic_tool_capability()));
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.subscribe_session_thread(2, session_id.clone(), thread_id.clone(), 0);
    broker.offer_agent_request(dynamic_tool_request(&session_id, &thread_id), 0);
    first.drain();

    let lost = broker.unregister(1);

    assert_eq!(lost.len(), 1);
    assert_eq!(lost[0].interaction.request_id.as_str(), "dynamic_1");
    assert!(second.drain().is_empty());
}

#[test]
fn dynamic_tool_is_delivered_only_to_a_connection_hosting_that_tool_name() {
    let broker = UpdateBroker::default();
    let other = NotificationQueue::default();
    let owner = NotificationQueue::default();
    let session_id = SessionId::new("session_1").unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &other);
    broker.register(2, false, &owner);
    broker.set_agent_interaction_capability(1, Some(dynamic_tool_capability_for("other_tool")));
    broker.set_agent_interaction_capability(2, Some(dynamic_tool_capability()));
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.subscribe_session_thread(2, session_id.clone(), thread_id.clone(), 0);

    broker.offer_agent_request(dynamic_tool_request(&session_id, &thread_id), 0);

    assert!(other.drain().is_empty());
    assert_eq!(owner.drain().len(), 1);
}

#[test]
fn agent_request_waits_until_a_matching_capability_subscribes() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &queue);
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    broker.offer_agent_request(approval_request(&session_id, &thread_id), 0);
    assert_eq!(queue.len(), 0);

    broker.set_agent_interaction_capability(1, Some(approval_capability()));

    assert_eq!(queue.len(), 1);
}

#[test]
fn agent_request_is_not_assigned_to_a_foreign_env_scope() {
    let owning_scope = UpdateBroker::default();
    let foreign_scope = owning_scope.fork_scope();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("session_1").expect("test ID is non-empty");
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");
    let connection_id = foreign_scope.allocate_connection_id();
    owning_scope.bind_session_scope(session_id.clone());
    foreign_scope.register(connection_id, false, &queue);
    foreign_scope.set_agent_interaction_capability(connection_id, Some(approval_capability()));
    foreign_scope.subscribe_session_thread(connection_id, session_id.clone(), thread_id.clone(), 0);

    owning_scope.offer_agent_request(approval_request(&session_id, &thread_id), 0);

    assert!(queue.drain().is_empty());
}

fn subscription_lifecycle_fixture() -> (UpdateBroker, NotificationQueue, SessionId, ThreadId) {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    let session_id = SessionId::new("subscription-session").unwrap();
    let thread_id = ThreadId::new("subscription-thread").unwrap();
    broker.bind_session_scope(session_id.clone());
    broker.register(1, false, &queue);
    broker.set_agent_interaction_capability(1, Some(approval_capability()));
    (broker, queue, session_id, thread_id)
}

#[test]
fn subscription_commit_releases_only_updates_after_the_response_and_grants_ownership() {
    let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
    broker.offer_agent_request(approval_request(&session_id, &thread_id), 0);
    let registration = broker
        .begin_session_thread_subscription(1, session_id.clone(), thread_id.clone())
        .unwrap();
    broker.publish_thread(
        &thread_id,
        &[
            thread_update(&session_id, &thread_id, 1),
            thread_update(&session_id, &thread_id, 2),
        ],
    );
    broker.publish_thread_update(transient_thread_update(&session_id, &thread_id, 1, "live"));
    assert!(queue.drain().is_empty());
    assert!(!broker.is_agent_interaction_owner(1, &RequestId::new("approval_1").unwrap()));
    broker.commit_session_thread_subscription(registration, 1, 0, ThreadSubscriptionScope::Thread);
    let notifications = queue.drain();
    let durable = notifications
        .iter()
        .filter(|notice| notice["params"]["update"]["type"] == "committed")
        .collect::<Vec<_>>();
    assert_eq!(durable.len(), 1);
    assert_eq!(durable[0]["params"]["durableSequence"], 2);
    assert!(
        notifications
            .iter()
            .any(|notice| notice["method"] == "session/thread/transcript/update")
    );
    assert_eq!(
        notifications
            .iter()
            .filter(|notice| notice["method"] == "agent/request")
            .count(),
        1
    );
    assert!(broker.is_agent_interaction_owner(1, &RequestId::new("approval_1").unwrap()));
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 2)]);
    assert!(queue.drain().is_empty());
}

#[test]
fn subscription_rollback_discards_background_updates_and_preserves_an_existing_subscription() {
    for existing in [false, true] {
        let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
        if existing {
            broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 1);
        }
        let registration = broker
            .begin_session_thread_subscription(1, session_id.clone(), thread_id.clone())
            .unwrap();
        let updates = broker.state.clone();
        let pending_update = thread_update(&session_id, &thread_id, 2);
        // Background producers do not participate in the issuing request's notification deferral.
        std::thread::scope(|scope| {
            scope
                .spawn(|| broker.publish_thread(&thread_id, &[pending_update]))
                .join()
                .unwrap();
        });
        drop(registration);
        assert_eq!(queue.drain().len(), usize::from(existing));
        let state = updates.lock().unwrap();
        let threads = &state.subscribers[&1].threads;
        if existing {
            assert_eq!(threads[&thread_id].sequence, 2);
            assert!(threads[&thread_id].pending.is_empty());
        } else {
            assert!(threads.is_empty());
        }
    }
}

#[test]
fn concurrent_subscription_attempts_and_unsubscribe_do_not_resurrect_a_removed_subscription() {
    let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
    let failed = broker
        .begin_session_thread_subscription(1, session_id.clone(), thread_id.clone())
        .unwrap();
    let successful = broker
        .begin_session_thread_subscription(1, session_id.clone(), thread_id.clone())
        .unwrap();
    drop(failed);
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 1)]);
    broker.commit_session_thread_subscription(successful, 0, 0, ThreadSubscriptionScope::Thread);
    assert_eq!(queue.drain().len(), 1);
    let cancelled = broker
        .begin_session_thread_subscription(1, session_id.clone(), thread_id.clone())
        .unwrap();
    broker.unsubscribe_session_thread(1, &session_id, &thread_id);
    broker.commit_session_thread_subscription(cancelled, 1, 0, ThreadSubscriptionScope::Thread);
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 2)]);
    assert!(queue.drain().is_empty());
    assert!(
        broker.state.lock().unwrap().subscribers[&1]
            .threads
            .is_empty()
    );
}

#[test]
fn session_unsubscribe_invalidates_pending_thread_and_session_catalog_registration() {
    let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
    let registration = broker
        .begin_session_thread_subscription(1, session_id.clone(), thread_id.clone())
        .unwrap();
    broker.unsubscribe_session(1, &session_id);
    broker.commit_session_thread_subscription(registration, 0, 0, ThreadSubscriptionScope::Session);
    broker.publish_session_changed(&session_id);
    broker.publish_thread(&thread_id, &[thread_update(&session_id, &thread_id, 1)]);
    assert!(queue.drain().is_empty());
    let state = broker.state.lock().unwrap();
    assert!(state.subscribers[&1].sessions.is_empty());
    assert!(state.subscribers[&1].threads.is_empty());
}

#[test]
fn resolved_interactions_are_not_resurrected_by_old_snapshots_or_replayed_events() {
    let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    let request = approval_request(&session_id, &thread_id);
    let requested = ThreadUpdateEnvelope {
        update: ThreadUpdate::Committed {
            event: ThreadEvent::InteractionRequested {
                thread_id: thread_id.clone(),
                turn_id: request.turn_id.clone(),
                interaction: request.interaction.clone(),
            },
        },
        ..thread_update(&session_id, &thread_id, 1)
    };
    broker.publish_thread(&thread_id, std::slice::from_ref(&requested));
    assert!(broker.is_agent_interaction_owner(1, &request.interaction.request_id));
    let resolved = ThreadUpdateEnvelope {
        update: ThreadUpdate::Committed {
            event: ThreadEvent::InteractionResolved {
                thread_id: thread_id.clone(),
                turn_id: request.turn_id.clone(),
                request_id: request.interaction.request_id.clone(),
                response: ash_protocol::AgentResponse::Approval {
                    response: ash_protocol::ActionApprovalResponse {
                        decision: ash_protocol::ActionApprovalDecision::ApproveOnce,
                    },
                },
            },
        },
        ..thread_update(&session_id, &thread_id, 3)
    };
    broker.publish_thread(&thread_id, &[resolved]);
    assert!(!broker.is_agent_interaction_owner(1, &request.interaction.request_id));
    queue.drain();
    broker.offer_agent_request(request.clone(), 2);
    broker.publish_thread(&thread_id, &[requested]);
    assert!(queue.drain().is_empty());
    assert!(broker.state.lock().unwrap().pending_interactions.is_empty());
    let mut next = request.clone();
    next.interaction.request_id = RequestId::new("approval-next").unwrap();
    broker.offer_agent_request(next.clone(), 4);
    broker.offer_agent_request(request, 2);
    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(
        notifications[0]["params"]["interaction"]["requestId"],
        "approval-next"
    );
    assert!(broker.is_agent_interaction_owner(1, &next.interaction.request_id));
    broker.forget_session(&session_id);
    let state = broker.state.lock().unwrap();
    assert!(state.interaction_versions.is_empty());
    assert!(state.interaction_assignments.is_empty());
}

#[test]
fn disconnected_dynamic_tool_owner_cannot_be_restored_by_a_stale_snapshot() {
    let (broker, first, session_id, thread_id) = subscription_lifecycle_fixture();
    let second = NotificationQueue::default();
    broker.register(2, false, &second);
    for connection in [1, 2] {
        broker.set_agent_interaction_capability(connection, Some(dynamic_tool_capability()));
        broker.subscribe_session_thread(connection, session_id.clone(), thread_id.clone(), 0);
    }
    let request = dynamic_tool_request(&session_id, &thread_id);
    broker.offer_agent_request(request.clone(), 1);
    assert_eq!(first.drain().len(), 1);
    let lost = broker.unregister(1);
    assert_eq!(lost.len(), 1);
    broker.offer_agent_request(request.clone(), 2);
    assert!(second.drain().is_empty());
    assert!(!broker.is_agent_interaction_owner(2, &request.interaction.request_id));
    let mut next = request;
    next.interaction.request_id = RequestId::new("dynamic-next").unwrap();
    broker.offer_agent_request(next, 3);
    assert_eq!(second.drain().len(), 1);
}

#[test]
fn expired_unassigned_interaction_is_not_delivered_to_a_new_subscriber() {
    let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
    let mut request = approval_request(&session_id, &thread_id);
    request.interaction.deadline = Some(ash_protocol::InteractionDeadline {
        expires_at_unix_ms: 0,
    });
    broker.offer_agent_request(request.clone(), 1);
    broker.subscribe_session_thread(1, session_id, thread_id, 0);
    assert!(queue.drain().is_empty());
    assert_eq!(
        broker.expired_agent_requests(unix_time_millis()),
        vec![request]
    );
}

#[test]
fn terminal_turn_prevents_late_approval_delivery_before_its_resolution_event_arrives() {
    let (broker, queue, session_id, thread_id) = subscription_lifecycle_fixture();
    broker.subscribe_session_thread(1, session_id.clone(), thread_id.clone(), 0);
    let request = approval_request(&session_id, &thread_id);
    broker.publish_thread(
        &thread_id,
        &[ThreadUpdateEnvelope {
            update: ThreadUpdate::Committed {
                event: ThreadEvent::TurnCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: request.turn_id.clone(),
                },
            },
            ..thread_update(&session_id, &thread_id, 4)
        }],
    );
    queue.drain();
    broker.offer_agent_request(request.clone(), 2);
    broker.publish_thread(
        &thread_id,
        &[ThreadUpdateEnvelope {
            update: ThreadUpdate::Committed {
                event: ThreadEvent::InteractionRequested {
                    thread_id: thread_id.clone(),
                    turn_id: request.turn_id.clone(),
                    interaction: request.interaction.clone(),
                },
            },
            ..thread_update(&session_id, &thread_id, 1)
        }],
    );
    assert!(queue.drain().is_empty());
    assert!(!broker.is_agent_interaction_owner(1, &request.interaction.request_id));
    assert!(broker.state.lock().unwrap().pending_interactions.is_empty());
}

fn approval_capability() -> AgentInteractionCapability {
    AgentInteractionCapability {
        version: 1,
        kinds: vec![AgentInteractionKind::Approval],
        dynamic_tools: None,
    }
}

fn dynamic_tool_capability() -> AgentInteractionCapability {
    dynamic_tool_capability_for("client_lookup")
}

fn dynamic_tool_capability_for(name: &str) -> AgentInteractionCapability {
    AgentInteractionCapability {
        version: 1,
        kinds: vec![AgentInteractionKind::DynamicTool],
        dynamic_tools: Some(vec![ToolName::new(name).unwrap()]),
    }
}

fn dynamic_tool_request(session_id: &SessionId, thread_id: &ThreadId) -> AgentRequestEnvelope {
    AgentRequestEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        turn_id: TurnId::new("turn_1").unwrap(),
        interaction: ash_protocol::TurnInteraction {
            request_id: RequestId::new("dynamic_1").unwrap(),
            item_id: None,
            request: AgentRequest::DynamicTool {
                call: DynamicToolCall {
                    call_id: ToolCallId::new("call_1").unwrap(),
                    name: ToolName::new("client_lookup").unwrap(),
                    definition_digest: "a".repeat(64),
                    arguments: serde_json::json!({"query": "ash"}),
                },
            },
            deadline: None,
        },
    }
}

fn approval_request(session_id: &SessionId, thread_id: &ThreadId) -> AgentRequestEnvelope {
    AgentRequestEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
        interaction: ash_protocol::TurnInteraction {
            request_id: RequestId::new("approval_1").expect("test ID is non-empty"),
            item_id: None,
            request: AgentRequest::Approval {
                request: ActionApprovalRequest {
                    action_digest: "digest".into(),
                    policy_revision: "policy-1".into(),
                    capabilities: vec![ActionApprovalCapability {
                        kind: ActionApprovalCapabilityKind::Network,
                        scope: "api.example.test".into(),
                    }],
                    reason: "connect to the test service".into(),
                    command: None,
                    allowed_decisions: vec![
                        ash_protocol::ActionApprovalDecision::ApproveOnce,
                        ash_protocol::ActionApprovalDecision::Decline,
                    ],
                    sandbox_denial: None,
                },
            },
            deadline: None,
        },
    }
}

fn thread_update(
    session_id: &SessionId,
    thread_id: &ThreadId,
    sequence: u64,
) -> ThreadUpdateEnvelope {
    ThreadUpdateEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        durable_sequence: sequence,
        stream_cursor: None,
        update: ThreadUpdate::Committed {
            event: ThreadEvent::ThreadArchived {
                thread_id: thread_id.clone(),
                reason: ash_protocol::ThreadArchiveReason::Completed,
            },
        },
    }
}

#[test]
fn login_completion_routing_keeps_directory_local_ids_separate() {
    let first = UpdateBroker::default();
    let second = first.fork_scope();
    let first_queue = NotificationQueue::default();
    let second_queue = NotificationQueue::default();
    first.register(1, false, &first_queue);
    second.register(2, false, &second_queue);
    first.register_login_owner("login-1", 1);
    second.register_login_owner("login-1", 2);
    first.publish_account_login_completed(AccountLoginCompleted {
        login_id: "login-1".into(),
        status:
            ash_app_server_protocol::protocol::account::AccountLoginCompletionStatusDto::Succeeded,
        account: ash_app_server_protocol::protocol::account::AccountReadResult {
            revision: "1".into(),
            accounts: vec![],
        },
    });
    assert_eq!(first_queue.drain().len(), 1);
    assert!(second_queue.drain().is_empty());
    assert!(second.owns_login("login-1", 2));
    assert_eq!(second.take_connection_logins(2), ["login-1"]);
}

#[test]
fn language_diagnostics_and_capabilities_are_delivered_only_to_the_owning_connection() {
    let broker = UpdateBroker::default();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    broker.register(101, false, &first);
    broker.register(202, false, &second);
    broker.publish_language_diagnostics(
        Some(101),
        ash_app_server_protocol::protocol::language::LanguageDiagnosticsNotification {
            dir_id: None,
            path: "same.rs".into(),
            revision: 1,
            diagnostics: Vec::new(),
        },
    );
    broker.publish_language_server_capabilities(
        Some(101),
        ash_app_server_protocol::protocol::language::LanguageServerCapabilitiesNotification {
            dir_id: None,
            server: "custom".into(),
            language_ids: vec!["rust".into()],
            features: vec![
                ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::DocumentColors,
                ash_app_server_protocol::protocol::language::LanguageServerFeatureDto::CodeActions,
            ],
            completion_trigger_characters: vec!["=".into()],
            on_type_formatting_trigger_characters: Vec::new(),
            signature_help_trigger_characters: Vec::new(),
            signature_help_retrigger_characters: Vec::new(),
        },
    );
    assert_eq!(first.drain().len(), 2);
    assert!(second.drain().is_empty());
}
