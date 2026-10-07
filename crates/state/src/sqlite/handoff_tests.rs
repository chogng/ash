use super::*;
use ash_core::CreateThreadRequest;
use ash_core::NoThreadWorktreeBinder;
use ash_core::ThreadController;
use ash_protocol::AgentId;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use attachment_store::MemoryAttachmentStore;
use std::sync::Arc;

fn store(directory: &std::path::Path) -> Arc<SqliteThreadStore> {
    Arc::new(SqliteThreadStore::open(directory.join("state.sqlite3")).unwrap())
}

fn thread(
    controller: &ThreadController,
    name: &str,
    root: Option<&str>,
) -> ash_core::ThreadSnapshot {
    controller
        .create_thread(CreateThreadRequest {
            agent_id: AgentId::new(format!("agent-{name}")).unwrap(),
            origin: ThreadOrigin::Root,
            agent: None,
            session_id: SessionId::new(name).unwrap(),
            thread_id: ThreadId::new(name).unwrap(),
            title: name.into(),
            execution_target: root.map(|root| SessionExecutionTarget::Local { root: root.into() }),
        })
        .unwrap()
}

fn turn_request() -> ash_core::StartTurnRequest {
    ash_core::StartTurnRequest {
        context_policy: Default::default(),
        mode: Default::default(),
        advisor: None,
        command_id: CommandId::new("turn").unwrap(),
        expected_sequence: core_api::SequenceExpectation::Any,
        model: None,
        reasoning_effort: None,
        kind: Default::default(),
        instructions: ash_protocol::TurnInstructions::new("test", "test", "1", "test instructions")
            .unwrap(),
        policy_revision: "policy".into(),
        approval_mode: ash_protocol::ApprovalMode::Manual,
        tool_mode: ash_protocol::ToolMode::Direct,
        tool_profile: None,
        activated_skills: vec![],
        input: vec![ash_protocol::UserInput::Text {
            text: "question".into(),
        }],
    }
}

fn export(
    source: &SqliteThreadStore,
    target: &SqliteThreadStore,
    attachments: &dyn AttachmentStore,
) -> Vec<u8> {
    let mut archive = Vec::new();
    source
        .export_history(
            &target.history_identity().unwrap(),
            attachments,
            &mut archive,
        )
        .unwrap();
    archive
}

#[test]
fn freeze_blocks_every_history_writer_across_existing_connections_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let source = store(directory.path());
    let controller = ThreadController::with_store(source.clone());
    let root = thread(&controller, "old", None);
    let old_connection = Connection::open(source.path()).unwrap();
    let receiver = ContentDigest::sha256(b"receiver");
    source.freeze_history(&receiver).unwrap();
    for (table, columns) in TABLES
        .iter()
        .copied()
        .chain([("remote_history_bindings", "thread_id,source,host,root")])
    {
        let values = vec!["NULL"; columns.split(',').count()].join(",");
        let error = old_connection
            .execute(
                &format!("INSERT INTO {table} ({columns}) VALUES ({values})"),
                [],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("history ownership transferred"),
            "{table}: {error}"
        );
    }
    assert!(
        controller
            .start_turn(&root.thread_id, turn_request())
            .is_err()
    );
    assert_eq!(
        controller.read_thread(&root.thread_id).unwrap().sequence,
        root.sequence
    );
    assert!(source.delete_session(&root.session_id).is_err());
    let reopened = SqliteThreadStore::open(source.path()).unwrap();
    assert_eq!(reopened.history_receiver().unwrap(), Some(receiver.clone()));
    assert_eq!(
        reopened.load(&root.thread_id).unwrap(),
        source.load(&root.thread_id).unwrap()
    );
    reopened.freeze_history(&receiver).unwrap();
    assert!(
        reopened
            .freeze_history(&ContentDigest::sha256(b"another receiver"))
            .is_err()
    );
}

#[test]
fn import_preserves_old_event_bytes_ids_and_excludes_configuration() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let controller = ThreadController::with_store(source.clone());
    let root = thread(&controller, "known", Some("/remote/project"));
    let repository =
        github::Repository::new("ghe.example".into(), "team".into(), "repo".into()).unwrap();
    source
        .attach_pull_request(&root.thread_id, &repository, 12)
        .unwrap();
    let connection = Connection::open(source.path()).unwrap();
    connection.execute_batch("CREATE TABLE credentials (value TEXT); INSERT INTO credentials VALUES ('outside-secret');").unwrap();
    let mut record = source.load(&root.thread_id).unwrap().remove(0);
    record.schema_version -= 1;
    let json = format!(" {} ", serde_json::to_string(&record).unwrap());
    let digest = ContentDigest::sha256(json.as_bytes());
    connection
        .execute(
            "INSERT INTO history_records VALUES (?1, ?2)",
            params![digest.as_str(), json],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE thread_events SET schema_version = ?1, record_digest = ?2 WHERE thread_id = ?3",
            params![
                record.schema_version,
                digest.as_str(),
                root.thread_id.as_str()
            ],
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM history_records WHERE digest != ?1",
            [digest.as_str()],
        )
        .unwrap();
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    assert!(
        !archive
            .windows(b"outside-secret".len())
            .any(|bytes| bytes == b"outside-secret")
    );
    let receipt = target
        .import_history(
            "build-host",
            &MemoryAttachmentStore::default(),
            archive.as_slice(),
        )
        .unwrap();
    assert_eq!(receipt.threads, 1);
    assert_eq!(
        target.list_pull_requests(&root.thread_id).unwrap(),
        vec![(repository.clone(), 12)]
    );
    assert!(
        source
            .detach_pull_request(&root.thread_id, &repository, 12)
            .is_err()
    );
    assert_eq!(target.load(&root.thread_id).unwrap(), vec![record]);
    let preserved: String = Connection::open(target.path())
        .unwrap()
        .query_row(
            "SELECT record_json FROM history_records WHERE digest = ?1",
            [digest.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preserved, json);
    let local_controller = ThreadController::with_store(target.clone());
    let imported = local_controller.read_thread(&root.thread_id).unwrap();
    assert_eq!(imported.session_id, root.session_id);
    assert_eq!(
        imported.execution_target,
        Some(SessionExecutionTarget::Ssh {
            host: "build-host".into(),
            root: "/remote/project".into()
        })
    );
    assert_eq!(
        target
            .read_session(&root.session_id)
            .unwrap()
            .unwrap()
            .execution_target,
        imported.execution_target
    );
    assert_eq!(
        target.list_catalog().unwrap()[0].execution_target,
        imported.execution_target
    );
    assert!(source.history_receiver().unwrap().is_some());
}

#[test]
fn unbound_history_is_readable_but_requires_explicit_binding_even_when_cached() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let root = thread(
        &ThreadController::with_store(source.clone()),
        "unknown",
        None,
    );
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    target
        .import_history(
            "build-host",
            &MemoryAttachmentStore::default(),
            archive.as_slice(),
        )
        .unwrap();
    let controller = ThreadController::with_store(target.clone());
    assert!(
        controller
            .read_thread(&root.thread_id)
            .unwrap()
            .execution_target
            .is_none()
    );
    assert!(
        controller
            .start_turn(&root.thread_id, turn_request())
            .err()
            .expect("unbound history must reject execution")
            .to_string()
            .contains("explicit execution directory")
    );
    assert!(
        target
            .bind_imported_session(&root.session_id, "relative")
            .is_err()
    );
    target
        .bind_imported_session(&root.session_id, "/chosen/project")
        .unwrap();
    let bound = Some(SessionExecutionTarget::Ssh {
        host: "build-host".into(),
        root: "/chosen/project".into(),
    });
    assert_eq!(
        controller
            .read_thread(&root.thread_id)
            .unwrap()
            .execution_target,
        bound
    );
    assert_eq!(target.list_sessions().unwrap()[0].execution_target, bound);
    assert!(
        target
            .bind_imported_session(&root.session_id, "/different/project")
            .is_err()
    );
    controller
        .start_turn(&root.thread_id, turn_request())
        .unwrap();
}

#[test]
fn interrupted_transfer_is_atomic_and_retry_does_not_overwrite_local_progress() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let root = thread(
        &ThreadController::with_store(source.clone()),
        "retry",
        Some("/remote/project"),
    );
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    assert!(
        target
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                &archive[..archive.len() - 1]
            )
            .is_err()
    );
    assert!(target.list_thread_ids().unwrap().is_empty());
    let receipt = target
        .import_history(
            "build-host",
            &MemoryAttachmentStore::default(),
            archive.as_slice(),
        )
        .unwrap();
    ThreadController::with_store(target.clone())
        .start_turn(&root.thread_id, turn_request())
        .unwrap();
    let advanced = target.load(&root.thread_id).unwrap();
    let repeated = export(&source, &target, &MemoryAttachmentStore::default());
    assert_eq!(repeated, archive);
    assert_eq!(
        target
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                repeated.as_slice()
            )
            .unwrap(),
        receipt
    );
    assert_eq!(target.load(&root.thread_id).unwrap(), advanced);
    assert!(
        target
            .import_history(
                "other-host",
                &MemoryAttachmentStore::default(),
                archive.as_slice()
            )
            .is_err()
    );
}

#[test]
fn collisions_wrong_receiver_and_corruption_never_merge_history() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let wrong_receiver = store(other.path());
    thread(
        &ThreadController::with_store(source.clone()),
        "duplicate",
        None,
    );
    let local = thread(
        &ThreadController::with_store(target.clone()),
        "duplicate",
        Some("/local/project"),
    );
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    assert!(
        wrong_receiver
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                archive.as_slice()
            )
            .is_err()
    );
    assert!(
        target
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                archive.as_slice()
            )
            .is_err()
    );
    assert_eq!(
        ThreadController::with_store(target.clone())
            .read_thread(&local.thread_id)
            .unwrap()
            .execution_target,
        local.execution_target
    );
    let count: i64 = Connection::open(target.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM history_imports", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let mut corrupt = archive.clone();
    let position = corrupt
        .windows(b"duplicate".len())
        .position(|value| value == b"duplicate")
        .unwrap();
    corrupt[position] = b'X';
    assert!(
        target
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                corrupt.as_slice()
            )
            .is_err()
    );
    assert!(
        target
            .import_history(
                "-oProxyCommand=x",
                &MemoryAttachmentStore::default(),
                archive.as_slice()
            )
            .is_err()
    );
    assert!(
        target
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                (u32::MAX).to_be_bytes().as_slice()
            )
            .is_err()
    );
}

#[test]
fn archive_with_valid_transport_digest_and_invalid_agent_binding_is_rejected_atomically() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    thread(
        &ThreadController::with_store(source.clone()),
        "invalid-binding",
        None,
    );
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    let bindings_table = TABLES
        .iter()
        .position(|(name, _)| *name == "agent_threads")
        .unwrap();
    for index in [3, 4, 5] {
        let mut changed = false;
        let output = rewrite_archive(&archive, |frame| {
            if let Frame::Row { table, cells } = frame
                && *table == bindings_table
            {
                cells[index] = if index == 5 {
                    Cell::Text("{}".into())
                } else {
                    let Cell::Text(thread) = &cells[0] else {
                        panic!("Thread ID")
                    };
                    Cell::Text(thread.clone())
                };
                changed = true;
            }
        });
        assert!(changed);
        assert!(
            target
                .import_history(
                    "build-host",
                    &MemoryAttachmentStore::default(),
                    output.as_slice()
                )
                .is_err()
        );
        assert!(target.list_thread_ids().unwrap().is_empty());
    }
    assert!(
        target
            .import_history(
                "build-host",
                &MemoryAttachmentStore::default(),
                archive.as_slice()
            )
            .is_ok()
    );
}

fn rewrite_archive(archive: &[u8], mut mutate: impl FnMut(&mut Frame)) -> Vec<u8> {
    let mut input = archive;
    let mut input_hash = Sha256::new();
    let mut input_count = 0;
    let mut output = Vec::new();
    let mut output_hash = Sha256::new();
    let mut output_count = 0;
    loop {
        let mut frame = read_frame(&mut input, &mut input_hash, &mut input_count).unwrap();
        if matches!(frame, Frame::End { .. }) {
            let frame = Frame::End {
                digest: hash_digest(output_hash.clone()),
            };
            write_frame(&mut output, &frame, &mut output_hash, &mut output_count).unwrap();
            break;
        }
        mutate(&mut frame);
        write_frame(&mut output, &frame, &mut output_hash, &mut output_count).unwrap();
        if matches!(frame, Frame::Attachment { .. }) {
            let bytes = read_bytes(&mut input, &mut input_hash, &mut input_count).unwrap();
            write_bytes(&mut output, &bytes, &mut output_hash, &mut output_count).unwrap();
        }
    }
    output
}

#[test]
fn archive_retention_indexes_must_match_original_prefix_events() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let controller = ThreadController::with_store(source.clone());
    let mut branch = thread(&controller, "prefix-root", Some("/remote/project"));
    for name in ["first-prefix", "second-prefix"] {
        branch = controller
            .fork_thread(
                &NoThreadWorktreeBinder,
                core_api::ForkThreadRequest {
                    command_id: CommandId::new(name).unwrap(),
                    source_thread_id: branch.thread_id.clone(),
                    title: name.into(),
                },
            )
            .unwrap();
    }
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    for name in ["history_prefix_records", "history_prefix_links"] {
        let table = TABLES
            .iter()
            .position(|(table_name, _)| *table_name == name)
            .unwrap();
        let mut changed = false;
        let output = rewrite_archive(&archive, |frame| {
            if let Frame::Row {
                table: selected,
                cells,
            } = frame
                && *selected == table
                && !changed
            {
                cells[1] = if name == "history_prefix_records" {
                    let Cell::Integer(sequence) = &cells[1] else {
                        panic!("prefix sequence")
                    };
                    Cell::Integer(sequence + 1000)
                } else {
                    let Cell::Text(digest) = &cells[0] else {
                        panic!("prefix digest")
                    };
                    Cell::Text(digest.clone())
                };
                changed = true;
            }
        });
        assert!(changed, "archive must contain retention table {table}");
        assert!(
            target
                .import_history(
                    "build-host",
                    &MemoryAttachmentStore::default(),
                    output.as_slice()
                )
                .is_err()
        );
        assert!(target.list_thread_ids().unwrap().is_empty());
    }
    target
        .import_history(
            "build-host",
            &MemoryAttachmentStore::default(),
            archive.as_slice(),
        )
        .unwrap();
    assert_eq!(
        ThreadController::with_store(target)
            .read_thread(&branch.thread_id)
            .unwrap()
            .origin,
        branch.origin
    );
}

#[test]
fn fork_retains_unbound_remote_authority_and_deleted_import_does_not_return_on_retry() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let root = thread(
        &ThreadController::with_store(source.clone()),
        "unknown-fork",
        None,
    );
    let archive = export(&source, &target, &MemoryAttachmentStore::default());
    target
        .import_history(
            "build-host",
            &MemoryAttachmentStore::default(),
            archive.as_slice(),
        )
        .unwrap();
    let controller = ThreadController::with_store(target.clone());
    let branch = controller
        .fork_thread(
            &NoThreadWorktreeBinder,
            core_api::ForkThreadRequest {
                command_id: CommandId::new("local-fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    assert_eq!(
        target.execution_binding(&branch.thread_id).unwrap(),
        ash_thread_store::ThreadExecutionBinding::Remote {
            host: "build-host".into(),
            root: None
        }
    );
    assert!(
        controller
            .start_turn(&branch.thread_id, turn_request())
            .is_err()
    );
    target
        .bind_imported_session(&branch.session_id, "/chosen/project")
        .unwrap();
    assert_eq!(
        controller
            .read_thread(&branch.thread_id)
            .unwrap()
            .execution_target,
        Some(SessionExecutionTarget::Ssh {
            host: "build-host".into(),
            root: "/chosen/project".into()
        })
    );
    target.delete_session(&root.session_id).unwrap();
    let remaining = target.list_thread_ids().unwrap();
    target
        .import_history(
            "build-host",
            &MemoryAttachmentStore::default(),
            archive.as_slice(),
        )
        .unwrap();
    assert_eq!(target.list_thread_ids().unwrap(), remaining);
}

#[test]
fn retained_prefix_and_its_attachment_survive_source_thread_removal() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let source = store(from.path());
    let target = store(to.path());
    let attachments = MemoryAttachmentStore::default();
    let bytes: Arc<[u8]> = Arc::from(b"encoded-image".as_slice());
    let digest = attachments.put(bytes.clone()).unwrap();
    let controller = ThreadController::with_store(source.clone());
    let root = thread(&controller, "with-image", Some("/remote/project"));
    controller
        .start_turn(&root.thread_id, turn_request())
        .unwrap();
    let records = source.load(&root.thread_id).unwrap();
    let original = records
        .iter()
        .find(|record| {
            matches!(
                &record.event,
                ThreadEvent::ItemCompleted {
                    item: ThreadItem::UserMessage { .. },
                    ..
                }
            )
        })
        .unwrap();
    let mut record = original.clone();
    if let ThreadEvent::ItemCompleted { item, .. } = &mut record.event {
        *item = ThreadItem::UserImageAttachment {
            client_id: None,
            item_id: item.item_id().clone(),
            turn_id: item.turn_id().clone(),
            attachment: ash_protocol::ImageAttachmentRef {
                content_digest: digest.clone(),
                media_type: ash_protocol::ImageMediaType::Png,
                encoded_bytes: bytes.len() as u64,
                width: 1,
                height: 1,
            },
        };
    }
    let json = serde_json::to_string(&record).unwrap();
    let record_digest = ContentDigest::sha256(json.as_bytes());
    let sql = Connection::open(source.path()).unwrap();
    sql.execute(
        "INSERT INTO history_records VALUES (?1, ?2)",
        params![record_digest.as_str(), json],
    )
    .unwrap();
    sql.execute(
        "UPDATE thread_events SET record_digest = ?1 WHERE event_id = ?2",
        params![record_digest.as_str(), record.event_id.0],
    )
    .unwrap();
    // Reload so the real fork path retains the immutable image record rather than cached text.
    let controller = ThreadController::with_store(source.clone());
    let branch = controller
        .fork_thread(
            &NoThreadWorktreeBinder,
            core_api::ForkThreadRequest {
                command_id: CommandId::new("fork-image").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "branch".into(),
            },
        )
        .unwrap();
    for table in [
        "agent_threads",
        "thread_history_prefixes",
        "thread_catalog",
        "thread_events",
        "thread_batches",
        "thread_streams",
    ] {
        sql.execute(
            &format!("DELETE FROM {table} WHERE thread_id = ?1"),
            [root.thread_id.as_str()],
        )
        .unwrap();
    }
    source.rebuild_session(&root.session_id).unwrap();
    let archive = export(&source, &target, &attachments);
    let local_attachments = MemoryAttachmentStore::default();
    target
        .import_history("build-host", &local_attachments, archive.as_slice())
        .unwrap();
    assert_eq!(
        local_attachments.read(&digest, bytes.len() as u64).unwrap(),
        bytes
    );
    let snapshot = ThreadController::with_store(target)
        .read_thread(&branch.thread_id)
        .unwrap();
    assert!(snapshot.items.iter().any(|item| matches!(item, ThreadItem::UserImageAttachment { attachment, .. } if attachment.content_digest == digest)));
}
