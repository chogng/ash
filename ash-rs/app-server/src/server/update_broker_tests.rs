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
fn profile_broker_fans_out_marketplace_generations_across_env_scopes() {
    let first_scope = UpdateBroker::default();
    let second_scope = first_scope.fork_scope();
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    first_scope.register(first_scope.allocate_connection_id(), false, &first);
    second_scope.register(second_scope.allocate_connection_id(), false, &second);

    let instance_id = first_scope.marketplace_instance_id().to_owned();
    assert_eq!(second_scope.marketplace_instance_id(), instance_id);
    assert_eq!(first_scope.marketplace_generation(), 1);
    assert_eq!(first_scope.publish_marketplace_changed(), 2);
    assert_eq!(second_scope.publish_marketplace_changed(), 3);
    assert_eq!(first_scope.marketplace_generation(), 3);
    assert_eq!(second_scope.marketplace_generation(), 3);

    for queue in [&first, &second] {
        let notifications = queue.drain();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0]["method"], "marketplace/changed");
        assert_eq!(notifications[0]["params"]["instanceId"], instance_id);
        assert_eq!(notifications[0]["params"]["generation"], 2);
        assert_eq!(notifications[1]["params"]["generation"], 3);
    }
}

#[test]
fn profile_marketplace_broker_deduplicates_one_manager_commit_seen_by_multiple_scopes() {
    let first_scope = UpdateBroker::default();
    let second_scope = first_scope.fork_scope();
    let queue = NotificationQueue::default();
    first_scope.register(first_scope.allocate_connection_id(), false, &queue);

    assert_eq!(
        first_scope.publish_marketplace_manager_changed("manager-a", 2),
        2
    );
    assert_eq!(
        second_scope.publish_marketplace_manager_changed("manager-a", 2),
        2
    );
    assert_eq!(
        second_scope.publish_marketplace_manager_changed("manager-a", 3),
        3
    );
    assert_eq!(
        first_scope.publish_marketplace_manager_changed("manager-b", 2),
        4
    );

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 3);
    assert_eq!(notifications[0]["params"]["generation"], 2);
    assert_eq!(notifications[1]["params"]["generation"], 3);
    assert_eq!(notifications[2]["params"]["generation"], 4);
}

#[test]
fn broker_fans_out_language_server_lifecycle_without_a_subscription() {
    let broker = UpdateBroker::default();
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);

    broker.publish_language_server_state(LanguageServerStateNotification {
        dir_id: None,
        server: "rust-analyzer".into(),
        state: LanguageServerStateDto::BackingOff {
            attempt: 2,
            retry_after_millis: 1_500,
        },
    });

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
    assert_eq!(queue.drain()[0]["method"], "session/changed");
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
        turns: Vec::new(),
    };
    let snapshot = broker.thread_transcript_snapshot(&thread, true);

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

    broker.offer_agent_request(approval_request(&session_id, &thread_id));

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
    broker.offer_agent_request(approval_request(&session_id, &thread_id));
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
    broker.offer_agent_request(dynamic_tool_request(&session_id, &thread_id));
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

    broker.offer_agent_request(dynamic_tool_request(&session_id, &thread_id));

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
    broker.offer_agent_request(approval_request(&session_id, &thread_id));
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

    owning_scope.offer_agent_request(approval_request(&session_id, &thread_id));

    assert!(queue.drain().is_empty());
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
