use crate::SqliteMemoryStore;
use ash_protocol::CommandId;
use memories::AddMemoryRequest;
use memories::DeleteMemoryRequest;
use memories::ListMemoriesRequest;
use memories::Memories;
use memories::MemoryError;
use memories::MemoryId;
use memories::MemoryMutationDisposition;
use memories::MemoryScope;
use memories::ReadMemoryRequest;
use memories::SearchMemoriesRequest;
use std::sync::Arc;

#[test]
fn sqlite_memories_persist_search_delete_and_retry_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    let add = AddMemoryRequest {
        command_id: CommandId::new("memory-add").unwrap(),
        memory_id: MemoryId::new("memory-one").unwrap(),
        scope: MemoryScope::Profile,
        title: "Preferred editor".into(),
        body: "Use Ash for Rust work.".into(),
    };
    let committed = service
        .add_user_memory(add.clone(), &async_utils::CancellationSource::new().token())
        .unwrap();
    assert_eq!(committed.disposition, MemoryMutationDisposition::Committed);
    assert_eq!(
        service
            .add_user_memory(add.clone(), &async_utils::CancellationSource::new().token())
            .unwrap()
            .disposition,
        MemoryMutationDisposition::Replayed
    );

    let reopened = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    assert_eq!(
        reopened
            .read(ReadMemoryRequest {
                memory_id: add.memory_id.clone(),
                scope: add.scope.clone(),
            })
            .unwrap()
            .body,
        add.body
    );
    assert_eq!(
        reopened
            .search(SearchMemoriesRequest {
                scope: MemoryScope::Profile,
                query: "ASH".into(),
                cursor: None,
                limit: 10,
            })
            .unwrap()
            .matches
            .len(),
        1
    );

    let deleted = reopened
        .delete(DeleteMemoryRequest {
            command_id: CommandId::new("memory-delete").unwrap(),
            memory_id: add.memory_id.clone(),
            scope: add.scope.clone(),
            expected_revision: 1,
        })
        .unwrap();
    assert_eq!(deleted.disposition, MemoryMutationDisposition::Committed);
    assert!(matches!(
        reopened.read(ReadMemoryRequest {
            memory_id: add.memory_id.clone(),
            scope: add.scope.clone(),
        }),
        Err(MemoryError::NotFound)
    ));
    assert!(matches!(
        reopened.add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new("memory-add-again").unwrap(),
                ..add
            },
            &async_utils::CancellationSource::new().token()
        ),
        Err(MemoryError::AlreadyExists)
    ));
}

#[test]
fn pagination_cursor_rejects_catalog_changes() {
    let root = tempfile::tempdir().unwrap();
    let service = Memories::new(Arc::new(
        SqliteMemoryStore::open(root.path().join("state.sqlite")).unwrap(),
    ));
    for index in 1..=2 {
        service
            .add_user_memory(
                AddMemoryRequest {
                    command_id: CommandId::new(format!("add-{index}")).unwrap(),
                    memory_id: MemoryId::new(format!("memory-{index}")).unwrap(),
                    scope: MemoryScope::Profile,
                    title: format!("title {index}"),
                    body: format!("body {index}"),
                },
                &async_utils::CancellationSource::new().token(),
            )
            .unwrap();
    }
    let first = service
        .list(ListMemoriesRequest {
            scope: MemoryScope::Profile,
            cursor: None,
            limit: 1,
        })
        .unwrap();
    service
        .add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new("add-3").unwrap(),
                memory_id: MemoryId::new("memory-3").unwrap(),
                scope: MemoryScope::Profile,
                title: "title 3".into(),
                body: "body 3".into(),
            },
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert!(matches!(
        service.list(ListMemoriesRequest {
            scope: MemoryScope::Profile,
            cursor: first.next_cursor,
            limit: 1,
        }),
        Err(MemoryError::StaleCursor { .. })
    ));
}

fn enable(
    service: &Memories,
    scope: MemoryScope,
    command: &str,
) -> memories::MemoryPolicyMutationResult {
    service
        .update_policy(memories::UpdateMemoryPolicyRequest {
            command_id: CommandId::new(command).unwrap(),
            scope,
            expected_revision: 0,
            automatic_read: memories::MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Disabled,
        })
        .unwrap()
}

fn remember(service: &Memories, id: &str, scope: MemoryScope, body: &str) {
    service
        .add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new(format!("add-{id}")).unwrap(),
                memory_id: MemoryId::new(id).unwrap(),
                scope,
                title: format!("Memory {id}"),
                body: body.into(),
            },
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
}

#[test]
fn memory_read_consent_is_scoped_persistent_and_cannot_be_reenabled_by_replay() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    let profile = MemoryScope::Profile;
    let project = MemoryScope::Project {
        project_id: ash_protocol::ProjectId::new("project-1").unwrap(),
    };
    remember(
        &service,
        "profile",
        profile.clone(),
        "Use Rust for this tool",
    );
    remember(&service, "project", project.clone(), "Rust project rules");
    let cancellation = async_utils::CancellationSource::new();
    let lookup = |service: &Memories| {
        service
            .collect_context(
                vec![profile.clone(), project.clone()],
                "How should this Rust tool work?",
                &cancellation.token(),
            )
            .unwrap()
    };
    assert!(lookup(&service).is_empty());
    assert_eq!(
        service.policy(&profile).unwrap(),
        memories::MemoryPolicy::disabled(profile.clone())
    );
    let enabled = enable(&service, project.clone(), "enable-project");
    assert_eq!(
        lookup(&service)
            .iter()
            .map(|entry| entry.citation.memory_id.as_str())
            .collect::<Vec<_>>(),
        ["project"]
    );
    let reopened = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    assert_eq!(lookup(&reopened), lookup(&service));
    assert_eq!(reopened.policy(&project).unwrap(), enabled.policy);
    let request = memories::UpdateMemoryPolicyRequest {
        command_id: CommandId::new("disable-project").unwrap(),
        scope: project.clone(),
        expected_revision: 1,
        automatic_read: memories::MemoryReadMode::Disabled,
        model_write: memories::MemoryWriteMode::Disabled,
    };
    let disabled = reopened.update_policy(request.clone()).unwrap();
    assert_eq!(disabled.policy.revision, 2);
    assert!(lookup(&service).is_empty());
    assert_eq!(
        reopened.update_policy(request).unwrap().disposition,
        MemoryMutationDisposition::Replayed
    );
    assert_eq!(
        enable(&service, project.clone(), "enable-project").disposition,
        MemoryMutationDisposition::Replayed
    );
    assert!(lookup(&service).is_empty());
    assert!(matches!(
        service.update_policy(memories::UpdateMemoryPolicyRequest {
            command_id: CommandId::new("stale-update").unwrap(),
            scope: project.clone(),
            expected_revision: 1,
            automatic_read: memories::MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Disabled,
        }),
        Err(MemoryError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert!(matches!(
        service.update_policy(memories::UpdateMemoryPolicyRequest {
            command_id: CommandId::new("add-profile").unwrap(),
            scope: profile.clone(),
            expected_revision: 0,
            automatic_read: memories::MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Disabled,
        }),
        Err(MemoryError::CommandConflict)
    ));
    assert!(matches!(
        service.add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new("enable-project").unwrap(),
                memory_id: MemoryId::new("another").unwrap(),
                scope: profile,
                title: "title".into(),
                body: "body".into(),
            },
            &async_utils::CancellationSource::new().token()
        ),
        Err(MemoryError::CommandConflict)
    ));
}

#[test]
fn memory_context_and_citations_are_bounded_utf8_exact_and_removed_after_delete() {
    let root = tempfile::tempdir().unwrap();
    let service = Memories::new(Arc::new(
        SqliteMemoryStore::open(root.path().join("state.sqlite")).unwrap(),
    ));
    let scope = MemoryScope::Profile;
    let body = format!(
        "{}İstanbul Rust: keep this decision.{}",
        "背景".repeat(700),
        "资料".repeat(500)
    );
    remember(&service, "first", scope.clone(), &body);
    let search = service
        .search(SearchMemoriesRequest {
            scope: scope.clone(),
            query: "İSTANBUL".into(),
            cursor: None,
            limit: 5,
        })
        .unwrap();
    let hit = &search.matches[0];
    assert!(hit.excerpt.contains("İstanbul"));
    assert!(hit.excerpt.len() <= 1024);
    assert_eq!(
        service.read_citation(hit.citation.clone()).unwrap().body,
        hit.excerpt
    );
    let mut stale = hit.citation.clone();
    stale.revision = 2;
    assert!(matches!(
        service.read_citation(stale),
        Err(MemoryError::RevisionConflict { .. })
    ));
    let mut split = hit.citation.clone();
    split.start_byte = 1;
    assert!(matches!(
        service.read_citation(split),
        Err(MemoryError::InvalidInput(_))
    ));
    enable(&service, scope.clone(), "enable");
    for index in 0..12 {
        remember(&service, &format!("record-{index}"), scope.clone(), &body);
    }
    let cancellation = async_utils::CancellationSource::new();
    let evidence = service
        .collect_context(
            vec![scope.clone()],
            "Remember Rust decisions",
            &cancellation.token(),
        )
        .unwrap();
    assert!(!evidence.is_empty());
    assert!(evidence.len() <= 8);
    assert!(evidence.iter().all(|entry| entry.body.len() <= 4096));
    assert!(evidence.iter().map(|entry| entry.body.len()).sum::<usize>() <= 16 * 1024);
    for entry in &evidence {
        assert_eq!(
            &service.read_citation(entry.citation.clone()).unwrap(),
            entry
        );
    }
    service
        .delete(DeleteMemoryRequest {
            command_id: CommandId::new("delete-first").unwrap(),
            memory_id: hit.memory_id.clone(),
            scope: scope.clone(),
            expected_revision: 1,
        })
        .unwrap();
    assert!(matches!(
        service.read_citation(hit.citation.clone()),
        Err(MemoryError::NotFound)
    ));
    assert!(
        service
            .collect_context(vec![scope], "Rust", &cancellation.token())
            .unwrap()
            .iter()
            .all(|entry| entry.citation.memory_id != hit.memory_id)
    );
    cancellation.cancel();
    assert!(matches!(
        service.collect_context(vec![MemoryScope::Profile], "Rust", &cancellation.token()),
        Err(MemoryError::Cancelled(_))
    ));
}

#[test]
fn memory_policy_migration_preserves_existing_records_and_defaults_to_disabled() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    {
        let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
        remember(
            &service,
            "old",
            MemoryScope::Profile,
            "Existing Rust memory",
        );
    }
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "DROP TABLE memory_policies; DROP TABLE memory_policy_commands;
        UPDATE ash_schema_migrations SET version = 1 WHERE component = 'memories';",
        )
        .unwrap();
    drop(connection);
    let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    assert_eq!(
        service
            .read(ReadMemoryRequest {
                memory_id: MemoryId::new("old").unwrap(),
                scope: MemoryScope::Profile
            })
            .unwrap()
            .body,
        "Existing Rust memory"
    );
    assert_eq!(
        service
            .policy(&MemoryScope::Profile)
            .unwrap()
            .automatic_read,
        memories::MemoryReadMode::Disabled
    );
    enable(&service, MemoryScope::Profile, "enable-migrated");
}

#[test]
fn memory_search_handles_contextual_case_and_mixed_chinese_queries() {
    let root = tempfile::tempdir().unwrap();
    let service = Memories::new(Arc::new(
        SqliteMemoryStore::open(root.path().join("state.sqlite")).unwrap(),
    ));
    let body = format!("{} ΟΣ", "背景".repeat(700));
    remember(&service, "greek", MemoryScope::Profile, &body);
    let page = service
        .search(SearchMemoriesRequest {
            scope: MemoryScope::Profile,
            query: "ΟΣ".into(),
            cursor: None,
            limit: 5,
        })
        .unwrap();
    assert!(page.matches[0].excerpt.contains("ΟΣ"));
    remember(
        &service,
        "chinese",
        MemoryScope::Profile,
        "项目记忆只用于补全读取能力",
    );
    enable(&service, MemoryScope::Profile, "enable-chinese");
    let matches = service
        .collect_context(
            vec![MemoryScope::Profile],
            "继续补全memories中的记忆引用",
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].citation.memory_id.as_str(), "chinese");
}

#[test]
fn context_citation_checks_consent_before_loading_body_and_observes_other_connections() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    let writer = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    let scope = MemoryScope::Profile;
    remember(&service, "private", scope.clone(), "Rust data");
    let cancellation = async_utils::CancellationSource::new();
    let citation = memories::MemoryCitation {
        memory_id: MemoryId::new("private").unwrap(),
        scope: scope.clone(),
        revision: 1,
        start_byte: 0,
        end_byte: 9,
    };
    let read = || {
        service.read_context_citation(
            std::slice::from_ref(&scope),
            citation.clone(),
            &cancellation.token(),
        )
    };
    assert_eq!(read(), Err(MemoryError::ReadDenied));
    enable(&writer, scope.clone(), "enable");
    assert_eq!(read().unwrap().body, "Rust data");
    writer
        .update_policy(memories::UpdateMemoryPolicyRequest {
            command_id: CommandId::new("disable").unwrap(),
            scope: scope.clone(),
            expected_revision: 1,
            automatic_read: memories::MemoryReadMode::Disabled,
            model_write: memories::MemoryWriteMode::Disabled,
        })
        .unwrap();
    // If disabled reads loaded the row before checking policy, corrupt content would yield Storage.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE memories SET record_json = 'invalid JSON' WHERE memory_id = 'private'",
            [],
        )
        .unwrap();
    assert_eq!(read(), Err(MemoryError::ReadDenied));
    cancellation.cancel();
    assert!(matches!(read(), Err(MemoryError::Cancelled(_))));
}

#[test]
fn memory_updates_are_versioned_retry_safe_and_never_restore_deleted_text() {
    let root = tempfile::tempdir().unwrap();
    let service = Memories::new(Arc::new(
        SqliteMemoryStore::open(root.path().join("state.sqlite")).unwrap(),
    ));
    remember(
        &service,
        "decision",
        MemoryScope::Profile,
        "Old Rust decision",
    );
    let old = service
        .search(SearchMemoriesRequest {
            scope: MemoryScope::Profile,
            query: "Rust".into(),
            cursor: None,
            limit: 10,
        })
        .unwrap()
        .matches
        .remove(0)
        .citation;
    let update = memories::UpdateMemoryRequest {
        command_id: CommandId::new("update").unwrap(),
        memory_id: MemoryId::new("decision").unwrap(),
        scope: MemoryScope::Profile,
        expected_revision: 1,
        title: "Changed decision".into(),
        body: "New Rust decision".into(),
    };
    let saved = service
        .update_user_memory(
            update.clone(),
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(saved.memory.revision, 2);
    assert_eq!(
        saved.memory.created_at_unix_ms <= saved.memory.updated_at_unix_ms,
        true
    );
    assert_eq!(
        service
            .update_user_memory(
                update.clone(),
                &async_utils::CancellationSource::new().token()
            )
            .unwrap()
            .disposition,
        MemoryMutationDisposition::Replayed
    );
    assert!(matches!(
        service.read_citation(old),
        Err(MemoryError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert!(matches!(
        service.update_user_memory(
            memories::UpdateMemoryRequest {
                command_id: CommandId::new("stale").unwrap(),
                ..update.clone()
            },
            &async_utils::CancellationSource::new().token()
        ),
        Err(MemoryError::RevisionConflict { .. })
    ));
    assert!(matches!(
        service.update_user_memory(
            memories::UpdateMemoryRequest {
                body: "different payload".into(),
                ..update.clone()
            },
            &async_utils::CancellationSource::new().token()
        ),
        Err(MemoryError::CommandConflict)
    ));
    service
        .delete(DeleteMemoryRequest {
            command_id: CommandId::new("delete").unwrap(),
            memory_id: update.memory_id.clone(),
            scope: update.scope.clone(),
            expected_revision: 2,
        })
        .unwrap();
    assert_eq!(
        service.update_user_memory(update, &async_utils::CancellationSource::new().token()),
        Err(MemoryError::NotFound)
    );
}

#[test]
fn model_writes_require_consent_and_observed_revision_and_user_edits_take_ownership() {
    let root = tempfile::tempdir().unwrap();
    let service = Memories::new(Arc::new(
        SqliteMemoryStore::open(root.path().join("state.sqlite")).unwrap(),
    ));
    let cancellation = async_utils::CancellationSource::new();
    let request = memories::SaveModelMemoryRequest {
        command_id: CommandId::new("model-save").unwrap(),
        scope: MemoryScope::Profile,
        expected_revision: 0,
        title: "Build choice".into(),
        body: "Use Rust".into(),
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
        turn_id: ash_protocol::TurnId::new("turn").unwrap(),
    };
    assert_eq!(
        service.save_model_memory(request.clone(), &cancellation.token()),
        Err(MemoryError::WriteDenied)
    );
    service
        .update_policy(memories::UpdateMemoryPolicyRequest {
            command_id: CommandId::new("enable-save").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: memories::MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Enabled,
        })
        .unwrap();
    let first = service
        .save_model_memory(request.clone(), &cancellation.token())
        .unwrap();
    assert!(
        matches!(&first.memory.source, memories::MemorySource::Model { thread_id, .. } if thread_id.as_str() == "thread")
    );
    assert_eq!(
        service
            .save_model_memory(request.clone(), &cancellation.token())
            .unwrap()
            .disposition,
        MemoryMutationDisposition::Replayed
    );
    let second = service
        .save_model_memory(
            memories::SaveModelMemoryRequest {
                command_id: CommandId::new("merge").unwrap(),
                expected_revision: 1,
                body: "Use Rust and verify changes".into(),
                ..request.clone()
            },
            &cancellation.token(),
        )
        .unwrap();
    assert_eq!(second.memory.memory_id, first.memory.memory_id);
    assert_eq!(second.memory.revision, 2);
    assert!(matches!(
        service.save_model_memory(request.clone(), &cancellation.token()),
        Err(MemoryError::RevisionConflict { .. })
    ));
    let user = service
        .update_user_memory(
            memories::UpdateMemoryRequest {
                command_id: CommandId::new("user-edit").unwrap(),
                memory_id: first.memory.memory_id,
                scope: MemoryScope::Profile,
                expected_revision: 2,
                title: "Build choice".into(),
                body: "User-approved decision".into(),
            },
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(user.memory.source, memories::MemorySource::User);
    assert_eq!(
        service.save_model_memory(
            memories::SaveModelMemoryRequest {
                command_id: CommandId::new("overwrite").unwrap(),
                expected_revision: 3,
                ..request.clone()
            },
            &cancellation.token(),
        ),
        Err(MemoryError::WriteDenied)
    );
    service
        .update_policy(memories::UpdateMemoryPolicyRequest {
            command_id: CommandId::new("disable-save").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 1,
            automatic_read: memories::MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Disabled,
        })
        .unwrap();
    assert_eq!(
        service.save_model_memory(request, &cancellation.token()),
        Err(MemoryError::WriteDenied)
    );
}

#[test]
fn version_two_policy_migration_keeps_model_writes_disabled_and_replays_old_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    let request = memories::UpdateMemoryPolicyRequest {
        command_id: CommandId::new("enable").unwrap(),
        scope: MemoryScope::Profile,
        expected_revision: 0,
        automatic_read: memories::MemoryReadMode::FirstInvocation,
        model_write: memories::MemoryWriteMode::Disabled,
    };
    service.update_policy(request.clone()).unwrap();
    drop(service);
    rusqlite::Connection::open(&path).unwrap().execute_batch(
        "UPDATE memory_policies SET policy_json = json_remove(policy_json, '$.modelWrite');
         UPDATE memory_policy_commands SET result_json = json_remove(result_json, '$.policy.modelWrite');
         UPDATE ash_schema_migrations SET version = 2 WHERE component = 'memories';"
    ).unwrap();
    let service = Memories::new(Arc::new(SqliteMemoryStore::open(&path).unwrap()));
    assert_eq!(
        service.policy(&MemoryScope::Profile).unwrap().model_write,
        memories::MemoryWriteMode::Disabled
    );
    assert_eq!(
        service.update_policy(request).unwrap().disposition,
        MemoryMutationDisposition::Replayed
    );
}
