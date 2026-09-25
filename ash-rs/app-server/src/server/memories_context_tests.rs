use super::*;
use ash_async_utils::CancellationSource;
use ash_extension_api::ContextSourceRequest;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permissions;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use memories::AddMemoryRequest;
use memories::Memories;
use memories::MemoryReadMode;
use memories::UpdateMemoryPolicyRequest;

#[test]
fn automatic_memories_follow_session_projects_and_current_directory_grants() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let memories = Arc::new(Memories::new(Arc::new(
        ash_state::SqliteMemoryStore::open(&path).unwrap(),
    )));
    let projects = Arc::new(ProjectCoordinator::new(Arc::new(
        ash_state::SqliteProjectStore::open(&path).unwrap(),
    )));
    let dirs = Arc::new(DirGrants::default());
    let session = SessionId::new("session").unwrap();
    let other_session = SessionId::new("other-session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = TurnId::new("turn").unwrap();
    let project = ProjectId::new("project").unwrap();
    for (id, expected_revision, command) in [
        (
            "create",
            0,
            ash_projects::ProjectCommand::Create {
                name: "project".into(),
                description: String::new(),
            },
        ),
        (
            "link",
            1,
            ash_projects::ProjectCommand::LinkSession {
                session_id: session.clone(),
            },
        ),
    ] {
        projects
            .apply(ash_projects::ProjectCommandRequest {
                command_id: CommandId::new(id).unwrap(),
                project_id: project.clone(),
                expected_revision,
                command,
            })
            .unwrap();
    }
    let work = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(work.path()).unwrap();
    dirs.bind_thread_dir(thread.clone(), dir.clone());
    for (id, scope) in [
        ("profile", MemoryScope::Profile),
        (
            "project",
            MemoryScope::Project {
                project_id: project.clone(),
            },
        ),
        ("dir", MemoryScope::Dir { dir_id: dir.id() }),
    ] {
        memories
            .add_user_memory(
                AddMemoryRequest {
                    command_id: CommandId::new(format!("add-{id}")).unwrap(),
                    memory_id: memories::MemoryId::new(id).unwrap(),
                    scope: scope.clone(),
                    title: id.into(),
                    body: format!("Rust {id} decision"),
                },
                &CancellationSource::new().token(),
            )
            .unwrap();
        memories
            .update_policy(UpdateMemoryPolicyRequest {
                command_id: CommandId::new(format!("enable-{id}")).unwrap(),
                scope,
                expected_revision: 0,
                automatic_read: MemoryReadMode::FirstInvocation,
                model_write: memories::MemoryWriteMode::Disabled,
            })
            .unwrap();
    }
    let mut builder = ExtensionRegistryBuilder::new();
    memories_extension::install(
        &mut builder,
        memories,
        Arc::new(MemoryScopes {
            config: Some(enabled_memories(root.path())),
            projects: Some(projects.clone()),
            dirs: dirs.clone(),
        }),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
    );
    let source = builder.build();
    let request = ContextSourceRequest {
        session_id: &session,
        thread_id: &thread,
        turn_id: &turn,
        query: "Rust",
    };
    let cancellation = CancellationSource::new();
    let read_ids = |request: &ContextSourceRequest<'_>| {
        let mut ids = source
            .collect_context(request, &cancellation.token())
            .unwrap()
            .into_iter()
            .map(|entry| {
                memories::MemoryCitation::parse(&entry.reference)
                    .unwrap()
                    .memory_id
                    .to_string()
            })
            .collect::<Vec<_>>();
        ids.sort();
        ids
    };
    assert_eq!(read_ids(&request), ["dir", "profile", "project"]);
    let other_thread = ThreadId::new("other-thread").unwrap();
    let other = ContextSourceRequest {
        session_id: &other_session,
        thread_id: &other_thread,
        turn_id: &turn,
        query: "Rust",
    };
    assert_eq!(read_ids(&other), ["profile"]);
    dirs.unbind_thread_dir(&thread);
    assert_eq!(read_ids(&request), ["profile", "project"]);
    dirs.add_dir(
        session.clone(),
        Grant::for_session_tree(
            session.clone(),
            dir.clone(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::ReadFiles]),
        ),
    )
    .unwrap();
    assert_eq!(read_ids(&request), ["dir", "profile", "project"]);
    dirs.remove_dir(&session, work.path());
    projects
        .apply(ash_projects::ProjectCommandRequest {
            command_id: CommandId::new("unlink").unwrap(),
            project_id: project,
            expected_revision: 2,
            command: ash_projects::ProjectCommand::UnlinkSession {
                session_id: session.clone(),
            },
        })
        .unwrap();
    assert_eq!(read_ids(&request), ["profile"]);
}

struct RevokingModel {
    memories: Arc<Memories>,
    measured: std::sync::Mutex<Vec<String>>,
    invoked: std::sync::Mutex<Vec<String>>,
}

impl core_api::ModelService for RevokingModel {
    fn context_budget(
        &self,
        _: core_api::ModelSelection<'_>,
    ) -> Result<ash_core::ContextBudget, core_api::CoreError> {
        Ok(ash_core::ContextBudget::core_managed(
            ash_core::ContextTokenCount::new(15_000),
            ash_core::ContextTokenCount::new(200),
            ash_core::ContextTokenCount::new(100),
            ash_core::ContextCompactionLimit::Tokens(ash_core::ContextTokenCount::new(12_000)),
        ))
    }
    fn input_token_measurement_capability(
        &self,
        _: core_api::ModelSelection<'_>,
    ) -> Result<ash_core::ContextTokenMeasurementCapability, core_api::CoreError> {
        Ok(ash_core::ContextTokenMeasurementCapability::Remote)
    }
    fn measure_input(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_core::ContextTokenMeasurementOutcome, core_api::CoreError> {
        let mut measured = self.measured.lock().unwrap();
        measured.push(serde_json::to_string(request).unwrap());
        if measured.len() == 1 {
            self.memories
                .update_policy(UpdateMemoryPolicyRequest {
                    command_id: CommandId::new("revoke-during-prepare").unwrap(),
                    scope: MemoryScope::Profile,
                    expected_revision: 1,
                    automatic_read: MemoryReadMode::Disabled,
                    model_write: memories::MemoryWriteMode::Disabled,
                })
                .unwrap();
        }
        let count = if measured.len() == 1 { 12_000 } else { 1_000 };
        Ok(ash_core::ContextTokenMeasurementOutcome::Measured(
            ash_context_engine::ContextTokenMeasurement::exact(
                ash_core::ContextTokenCount::new(count),
                ash_context_engine::ContextTokenMeasurementSource::provider_preflight(
                    "memory-test",
                )
                .unwrap(),
            ),
        ))
    }
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, core_api::CoreError> {
        self.invoked
            .lock()
            .unwrap()
            .push(serde_json::to_string(request).unwrap());
        let text = if request
            .instructions
            .as_deref()
            .is_some_and(|text| text.contains("durable context checkpoint"))
        {
            "measured checkpoint"
        } else {
            "done"
        };
        Ok(ash_protocol::ModelResponse {
            output: vec![ash_protocol::ResponseItem::Text(text.into())],
            usage: None,
            billing: None,
            stop_reason: ash_protocol::StopReason::Completed,
        })
    }
}

#[test]
fn memories_are_recollected_after_preflight_compaction_and_revocation() {
    let root = tempfile::tempdir().unwrap();
    let memories = Arc::new(Memories::new(Arc::new(
        ash_state::SqliteMemoryStore::open(root.path().join("memories.sqlite")).unwrap(),
    )));
    memories
        .add_user_memory(
            AddMemoryRequest {
                command_id: CommandId::new("add").unwrap(),
                memory_id: memories::MemoryId::new("decision").unwrap(),
                scope: MemoryScope::Profile,
                title: "Rust decision".into(),
                body: "Rust MEMORY_REVOKED_DURING_PREPARATION".into(),
            },
            &CancellationSource::new().token(),
        )
        .unwrap();
    memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("enable").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Disabled,
        })
        .unwrap();
    let threads = Arc::new(ash_core::ThreadController::with_store(Arc::new(
        ash_state::SqliteThreadStore::open(root.path().join("threads.sqlite")).unwrap(),
    )));
    let thread = threads
        .start_thread(
            &ash_core::NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                branch_name: None,
                command_id: CommandId::new("thread").unwrap(),
                title: "Memory preparation test".into(),
                agent_id: None,
                agent: None,
            },
        )
        .unwrap();
    let start = |id: &str, text: &str| {
        threads
            .start_turn(
                &thread.thread_id,
                ash_core::StartTurnRequest {
                    advisor: None,
                    command_id: CommandId::new(id).unwrap(),
                    expected_sequence: core_api::SequenceExpectation::Any,
                    model: None,
                    kind: Default::default(),
                    instructions: ash_protocol::TurnInstructions::new(
                        "memory-test",
                        "memory-test",
                        "1",
                        "Answer the user.",
                    )
                    .unwrap(),
                    policy_revision: "test".into(),
                    approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: vec![],
                    input: vec![ash_protocol::UserInput::Text { text: text.into() }],
                },
            )
            .unwrap()
            .turn_id
    };
    let seed = start("seed", "old request");
    threads
        .complete_turn(&thread.thread_id, &seed, "a".repeat(32_000))
        .unwrap();
    let current = start("current", "Rust current input");
    let mut builder = ExtensionRegistryBuilder::new();
    memories_extension::install(
        &mut builder,
        memories.clone(),
        Arc::new(MemoryScopes {
            config: Some(enabled_memories(root.path())),
            projects: None,
            dirs: Arc::new(DirGrants::default()),
        }),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
    );
    let model = Arc::new(RevokingModel {
        memories,
        measured: Default::default(),
        invoked: Default::default(),
    });
    ash_core::TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_extensions(Arc::new(builder.build()))
        .start(&thread.thread_id, &current)
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let snapshot = threads.read_thread(&thread.thread_id).unwrap();
        let turn = snapshot.turns.last().unwrap();
        if turn.status == ash_protocol::TurnStatus::Completed {
            break;
        }
        assert!(
            !matches!(
                turn.status,
                ash_protocol::TurnStatus::Failed | ash_protocol::TurnStatus::Interrupted
            ),
            "{:?}",
            turn.failure
        );
        assert!(
            std::time::Instant::now() < deadline,
            "Memory compaction test timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let measured = model.measured.lock().unwrap();
    assert_eq!(measured.len(), 2);
    assert!(measured[0].contains("MEMORY_REVOKED_DURING_PREPARATION"));
    assert!(!measured[1].contains("MEMORY_REVOKED_DURING_PREPARATION"));
    assert_eq!(
        threads
            .read_thread(&thread.thread_id)
            .unwrap()
            .context_checkpoints
            .len(),
        1
    );
    assert!(
        model
            .invoked
            .lock()
            .unwrap()
            .iter()
            .all(|request| !request.contains("MEMORY_REVOKED_DURING_PREPARATION"))
    );
}

fn enabled_memories(path: &std::path::Path) -> Arc<ash_config::ConfigStore> {
    let config =
        Arc::new(ash_config::ConfigStore::open(path.join("memory-config.sqlite")).unwrap());
    config
        .apply(ash_config::ConfigCommandRequest {
            command_id: ash_protocol::CommandId::new("enable-memories").unwrap(),
            expected_revision: config.read_snapshot().unwrap().revision,
            command: ash_config::UserConfigCommand::UpdatePreferences(
                ash_config::PreferencesUpdate {
                    features: ash_protocol::Patch::Value(
                        [(features::Feature::Memories, true)].into_iter().collect(),
                    ),
                    ..Default::default()
                },
            ),
        })
        .unwrap();
    config
}

#[test]
fn config_master_switch_stops_model_access_and_keeps_scope_permissions() {
    let root = tempfile::tempdir().unwrap();
    let config = enabled_memories(root.path());
    let scopes = MemoryScopes {
        config: Some(config.clone()),
        projects: None,
        dirs: Arc::new(DirGrants::default()),
    };
    let session = SessionId::new("s").unwrap();
    let thread = ThreadId::new("t").unwrap();
    assert_eq!(
        scopes.scopes(&session, &thread).unwrap(),
        [MemoryScope::Profile]
    );
    for (id, enabled) in [("off", false), ("on", true)] {
        config
            .apply(ash_config::ConfigCommandRequest {
                command_id: CommandId::new(id).unwrap(),
                expected_revision: config.read_snapshot().unwrap().revision,
                command: ash_config::UserConfigCommand::UpdatePreferences(
                    ash_config::PreferencesUpdate {
                        features: ash_protocol::Patch::Value(
                            [(features::Feature::Memories, enabled)]
                                .into_iter()
                                .collect(),
                        ),
                        ..Default::default()
                    },
                ),
            })
            .unwrap();
        assert_eq!(
            scopes.scopes(&session, &thread).unwrap().is_empty(),
            !enabled
        );
        assert_eq!(
            scopes.available_scopes(&session, &thread).unwrap(),
            [MemoryScope::Profile]
        );
    }
}
