use super::*;
use protocol::UserInput;

#[test]
fn text_edits_and_cancel_are_revision_checked_and_preserve_frozen_input() {
    let root = tempfile::tempdir().unwrap();
    let store = QueueStore::open(&root.path().join("state.sqlite")).unwrap();
    let mut request = input("editable");
    let context = UserInput::Context {
        source_url: None,
        name: "snapshot".into(),
        content: "immutable".into(),
    };
    let tools = UserInput::ToolSelection {
        disabled: vec![],
        allowed: Some(vec![]),
    };
    request.input = vec![
        UserInput::Text {
            text: "Before".into(),
        },
        context.clone(),
        UserInput::Text {
            text: "After".into(),
        },
        tools.clone(),
    ];
    let first = store.enqueue(&request).unwrap();
    store.enqueue(&input("second")).unwrap();
    let paused = store
        .edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            first.revision,
            &crate::QueueEdit::Pause,
        )
        .unwrap();
    assert!(store.candidates(0).unwrap().is_empty());
    assert!(matches!(
        store.cancel(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            Some(first.revision)
        ),
        Err(QueueError::Conflict)
    ));
    assert!(matches!(
        store.edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            first.revision,
            &crate::QueueEdit::ReplaceText {
                text: "stale".into()
            }
        ),
        Err(QueueError::Conflict)
    ));
    let resumed = store
        .edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            paused.revision,
            &crate::QueueEdit::Resume,
        )
        .unwrap();
    assert_eq!(resumed.request, request);
    assert_eq!(
        store.list(&request.session_id, &request.thread_id).unwrap()[0]
            .request
            .command_id,
        request.command_id
    );
    let paused = store
        .edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            resumed.revision,
            &crate::QueueEdit::Pause,
        )
        .unwrap();
    assert!(matches!(
        store.edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            paused.revision,
            &crate::QueueEdit::ReplaceText { text: " \n".into() }
        ),
        Err(QueueError::Invalid(_))
    ));
    let edited = store
        .edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            paused.revision,
            &crate::QueueEdit::ReplaceText {
                text: "Edited\ntext".into(),
            },
        )
        .unwrap();
    assert_eq!(
        edited.request.input,
        vec![
            UserInput::Text {
                text: "Edited\ntext".into()
            },
            context,
            tools
        ]
    );
    assert_eq!(edited.request.command_id, request.command_id);
    assert_eq!(edited.status, QueueStatus::Pending);
    let cancelled = store
        .cancel(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            Some(edited.revision),
        )
        .unwrap();
    assert_eq!(cancelled.status, QueueStatus::Cancelled);
    assert!(cancelled.revision > edited.revision);
}

#[test]
fn wal_switch_stops_retrying_while_a_reader_holds_the_database() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("queue.sqlite3");
    let mut reader = Connection::open(&path).unwrap();
    reader
        .execute("CREATE TABLE legacy (id INTEGER)", [])
        .unwrap();
    let read_transaction = reader.transaction().unwrap();
    let _: u32 = read_transaction
        .query_row("SELECT COUNT(*) FROM legacy", [], |row| row.get(0))
        .unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.busy_timeout(Duration::from_millis(50)).unwrap();

    let start = std::time::Instant::now();
    let error = enable_wal(&connection).unwrap_err();
    assert_eq!(error.sqlite_error_code(), Some(ErrorCode::DatabaseBusy));
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn concurrent_open_installs_an_empty_queue_once() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("queue.sqlite3");
    let barrier = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                barrier.wait();
                let store = QueueStore::open(&path).unwrap();
                assert!(store.candidates(0).unwrap().is_empty());
            });
        }
    });
    let connection = Connection::open(&path).unwrap();
    let metadata = connection
        .query_row("SELECT version, revision FROM queue_metadata", [], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?))
        })
        .unwrap();
    assert_eq!(metadata, (3, 0));
}

#[test]
fn old_permission_ids_migrate_once_without_changing_queue_delivery_or_revisions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let store = QueueStore::open(&path).unwrap();
    let mut requests = Vec::new();
    for (id, mode) in [
        ("manual", protocol::ApprovalMode::Manual),
        ("auto", protocol::ApprovalMode::Auto),
        (
            "bypassPermissions",
            protocol::ApprovalMode::BypassPermissions,
        ),
    ] {
        let mut request = input(id);
        request.approval_mode = mode;
        request.input = vec![UserInput::Text {
            text: "askPermissions autoReview".into(),
        }];
        requests.push(store.enqueue(&request).unwrap());
    }
    drop(store);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("ALTER TABLE queued_messages DROP COLUMN profile_reference_reads;
        UPDATE queue_metadata SET version=1 WHERE id=1;
        UPDATE queued_messages SET request=json_set(request,'$.approvalMode','askPermissions') WHERE id='manual';
        UPDATE queued_messages SET request=json_set(request,'$.approvalMode','autoReview') WHERE id='auto';").unwrap();
    drop(connection);
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        for _ in 0..2 {
            scope.spawn(|| {
                barrier.wait();
                let store = QueueStore::open(&path).unwrap();
                assert_eq!(
                    store
                        .list(
                            &requests[0].request.session_id,
                            &requests[0].request.thread_id
                        )
                        .unwrap(),
                    requests
                );
                assert_eq!(store.candidates(1).unwrap(), requests[..1]);
                for expected in &requests {
                    assert_eq!(store.enqueue(&expected.request).unwrap(), *expected);
                }
                let connection = Connection::open(&path).unwrap();
                assert_eq!(
                    connection
                        .query_row("SELECT version FROM queue_metadata WHERE id=1", [], |row| {
                            row.get::<_, u32>(0)
                        })
                        .unwrap(),
                    3
                );
            });
        }
    });
}

fn input(id: &str) -> QueueInput {
    QueueInput {
        command_interpretation: protocol::CommandInterpretation::Product,
        mode: Default::default(),
        model: None,
        model_routing: None,
        reasoning_effort: None,
        command_id: CommandId::new(id).unwrap(),
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        directory: Some("/work".into()),
        input: vec![UserInput::Text {
            text: "hello".into(),
        }],
        tool_mode: Default::default(),
        approval_mode: Default::default(),
        steer_turn: None,
    }
}

#[test]
fn reopen_preserves_fifo_and_accepted_command_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let store = QueueStore::open(&path).unwrap();
    let first = store.enqueue(&input("one")).unwrap();
    store.enqueue(&input("two")).unwrap();
    assert_eq!(store.enqueue(&input("one")).unwrap(), first);
    let mut conflict = input("one");
    conflict.input = vec![UserInput::Text {
        text: "different".into(),
    }];
    assert!(matches!(
        store.enqueue(&conflict),
        Err(QueueError::Conflict)
    ));
    drop(store);
    let store = QueueStore::open(&path).unwrap();
    assert_eq!(store.candidates(1).unwrap(), [first.clone()]);
    let claimed = store.claim(&first, 1).unwrap().unwrap();
    assert!(store.candidates(2).unwrap().is_empty());
    store
        .finish(
            &claimed,
            &Delivery::Started(protocol::TurnId::new("turn").unwrap()),
            2,
        )
        .unwrap();
    assert_eq!(
        store.candidates(3).unwrap()[0].request.command_id.as_str(),
        "two"
    );
    assert_eq!(
        store.enqueue(&input("one")).unwrap().status,
        QueueStatus::Started
    );
}

#[test]
fn leases_exclude_other_connections_and_stale_acknowledgments() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let first = QueueStore::open(&path).unwrap();
    let second = QueueStore::open(&path).unwrap();
    let queued = first.enqueue(&input("one")).unwrap();
    let claimed = first.claim(&queued, 1).unwrap().unwrap();
    assert!(second.claim(&queued, 2).unwrap().is_none());
    assert!(matches!(
        second.cancel(
            &queued.request.session_id,
            &queued.request.thread_id,
            &queued.request.command_id,
            None
        ),
        Err(QueueError::Busy)
    ));
    let recovery = second.candidates(60_002).unwrap().remove(0);
    let claimed_again = second.claim(&recovery, 60_002).unwrap().unwrap();
    first
        .finish(&claimed, &Delivery::Rejected("stale".into()), 60_003)
        .unwrap();
    second
        .finish(
            &claimed_again,
            &Delivery::Started(protocol::TurnId::new("turn").unwrap()),
            60_004,
        )
        .unwrap();
    let values = first
        .list(&queued.request.session_id, &queued.request.thread_id)
        .unwrap();
    assert_eq!(values[0].status, QueueStatus::Started);
    assert!(values[0].error.is_none());
}

#[test]
fn cancellation_is_durable_and_cannot_cross_session_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let store = QueueStore::open(&root.path().join("state.sqlite")).unwrap();
    let request = input("one");
    store.enqueue(&request).unwrap();
    assert!(matches!(
        store.cancel(
            &SessionId::new("wrong").unwrap(),
            &request.thread_id,
            &request.command_id,
            None
        ),
        Err(QueueError::NotFound)
    ));
    let cancelled = store
        .cancel(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            None,
        )
        .unwrap();
    assert_eq!(cancelled.status, QueueStatus::Cancelled);
    assert_eq!(store.enqueue(&request).unwrap(), cancelled);
    assert!(!store.needs_host().unwrap());
}

#[test]
fn editing_pauses_delivery_and_reordering_is_revision_checked() {
    let root = tempfile::tempdir().unwrap();
    let store = QueueStore::open(&root.path().join("state.sqlite")).unwrap();
    let first = store.enqueue(&input("one")).unwrap();
    let second = store.enqueue(&input("two")).unwrap();
    let paused = store
        .edit(
            &first.request.session_id,
            &first.request.thread_id,
            &first.request.command_id,
            first.revision,
            &crate::QueueEdit::Pause,
        )
        .unwrap();
    assert!(store.candidates(1).unwrap().is_empty());
    assert!(matches!(
        store.edit(
            &first.request.session_id,
            &first.request.thread_id,
            &first.request.command_id,
            first.revision,
            &crate::QueueEdit::Send { turn_id: None }
        ),
        Err(QueueError::Conflict)
    ));
    store
        .edit(
            &second.request.session_id,
            &second.request.thread_id,
            &second.request.command_id,
            second.revision,
            &crate::QueueEdit::Move {
                direction: crate::QueueMove::Up,
            },
        )
        .unwrap();
    assert_eq!(
        store.candidates(1).unwrap()[0].request.command_id,
        second.request.command_id
    );
    let paused = store.get(&paused.request.command_id).unwrap().unwrap();
    let edited = store
        .edit(
            &paused.request.session_id,
            &paused.request.thread_id,
            &paused.request.command_id,
            paused.revision,
            &crate::QueueEdit::Replace {
                input: vec![UserInput::Text {
                    text: "updated".into(),
                }],
            },
        )
        .unwrap();
    assert_eq!(edited.status, QueueStatus::Pending);
    assert_eq!(
        edited.request.input,
        vec![UserInput::Text {
            text: "updated".into()
        }]
    );
    store.delete_session(&first.request.session_id).unwrap();
    assert!(store.get(&first.request.command_id).unwrap().is_none());
    assert!(!store.needs_host().unwrap());
}

#[test]
fn queue_reopen_preserves_mode_and_model_choices_and_rejects_a_different_mode() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let mut request = input("mode-choice");
    request.mode = protocol::CollaborationMode::Multitask;
    request.model = Some(protocol::ModelRef::new(
        protocol::ProviderId::new("test").unwrap(),
        protocol::ModelId::new("model").unwrap(),
    ));
    request.reasoning_effort = Some(protocol::ReasoningEffort::High);
    let accepted = QueueStore::open(&path).unwrap().enqueue(&request).unwrap();
    let reopened = QueueStore::open(&path).unwrap();
    assert_eq!(
        reopened.get(&request.command_id).unwrap(),
        Some(accepted.clone())
    );
    assert_eq!(reopened.enqueue(&request).unwrap(), accepted);
    request.mode = protocol::CollaborationMode::Agent;
    assert!(matches!(
        reopened.enqueue(&request),
        Err(QueueError::Conflict)
    ));
}

#[test]
fn literal_messages_preserve_command_interpretation_after_edit_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let store = QueueStore::open(&path).unwrap();
    let mut request = input("literal-message");
    request.command_interpretation = protocol::CommandInterpretation::Literal;
    request.input = vec![UserInput::Text {
        text: "/init".into(),
    }];
    let accepted = store.enqueue(&request).unwrap();
    let paused = store
        .edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            accepted.revision,
            &crate::QueueEdit::Pause,
        )
        .unwrap();
    let edited = store
        .edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            paused.revision,
            &crate::QueueEdit::ReplaceText {
                text: "/develop ordinary message".into(),
            },
        )
        .unwrap();
    assert_eq!(
        edited.request.command_interpretation,
        protocol::CommandInterpretation::Literal
    );
    drop(store);
    let store = QueueStore::open(&path).unwrap();
    let saved = store.get(&request.command_id).unwrap().unwrap();
    assert_eq!(
        saved.request.command_interpretation,
        protocol::CommandInterpretation::Literal
    );
    assert_eq!(
        saved.request.input,
        vec![UserInput::Text {
            text: "/develop ordinary message".into()
        }]
    );
}

#[test]
fn delivery_edits_preserve_frozen_context_and_atomically_promote_immediate_messages() {
    let root = tempfile::tempdir().unwrap();
    let store = QueueStore::open(&root.path().join("state.sqlite")).unwrap();
    let mut request = input("steering");
    let turn = protocol::TurnId::new("active-turn").unwrap();
    request.steer_turn = Some(turn.clone());
    let context = UserInput::Context {
        source_url: None,
        name: "captured".into(),
        content: "original bytes".into(),
    };
    request.input.push(context.clone());
    let original = store.enqueue(&request).unwrap();
    let edit = |revision, action: &crate::QueueEdit| {
        let paused = store.edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            revision,
            &crate::QueueEdit::Pause,
        )?;
        store.edit(
            &request.session_id,
            &request.thread_id,
            &request.command_id,
            paused.revision,
            action,
        )
    };
    let preserved = edit(
        original.revision,
        &crate::QueueEdit::ReplaceText {
            text: "edited steering".into(),
        },
    )
    .unwrap();
    assert_eq!(preserved.request.steer_turn, Some(turn.clone()));
    let queued = edit(
        preserved.revision,
        &crate::QueueEdit::ReplaceTextWithDelivery {
            text: "queued".into(),
            delivery: crate::QueueDelivery::Queued,
        },
    )
    .unwrap();
    assert_eq!(queued.request.steer_turn, None);
    let ahead = store.enqueue(&input("ahead")).unwrap();
    store
        .edit(
            &ahead.request.session_id,
            &ahead.request.thread_id,
            &ahead.request.command_id,
            ahead.revision,
            &crate::QueueEdit::Send { turn_id: None },
        )
        .unwrap();
    let steering = edit(
        queued.revision,
        &crate::QueueEdit::ReplaceTextWithDelivery {
            text: "steering again".into(),
            delivery: crate::QueueDelivery::Steering {
                turn_id: turn.clone(),
            },
        },
    )
    .unwrap();
    assert_eq!(steering.request.steer_turn, Some(turn));
    assert_eq!(
        store.candidates(0).unwrap()[0].request.command_id,
        request.command_id
    );
    assert_eq!(steering.request.input[1], context);
    let front = store.enqueue(&input("front")).unwrap();
    store
        .edit(
            &front.request.session_id,
            &front.request.thread_id,
            &front.request.command_id,
            front.revision,
            &crate::QueueEdit::Send { turn_id: None },
        )
        .unwrap();
    let immediate = edit(
        steering.revision,
        &crate::QueueEdit::ReplaceTextWithDelivery {
            text: "immediate edited text".into(),
            delivery: crate::QueueDelivery::Immediate,
        },
    )
    .unwrap();
    assert!(immediate.revision > steering.revision);
    assert_eq!(immediate.request.steer_turn, None);
    assert_eq!(
        immediate.request.input,
        vec![
            UserInput::Text {
                text: "immediate edited text".into()
            },
            context
        ]
    );
    assert_eq!(
        store.candidates(0).unwrap()[0].request.command_id,
        request.command_id
    );
    assert!(matches!(
        edit(
            steering.revision,
            &crate::QueueEdit::ReplaceTextWithDelivery {
                text: "stale".into(),
                delivery: crate::QueueDelivery::Queued
            }
        ),
        Err(QueueError::Conflict)
    ));
}
