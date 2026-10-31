use super::selected_message_model;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_protocol::CommandId;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use core_api::SequenceExpectation;
use std::sync::Arc;

fn start(
    threads: &ThreadController,
    thread_id: &ThreadId,
    key: &str,
    model: Option<ModelRef>,
) -> TurnId {
    threads
        .start_turn(
            thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                command_id: CommandId::new(key).unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model,
                reasoning_effort: None,
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                mode: Default::default(),
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                policy_revision: "test".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![ash_protocol::UserInput::Text {
                    text: "Synthetic change".into(),
                }],
            },
        )
        .unwrap()
        .turn_id
}

#[test]
fn commit_message_inherits_the_originating_turn_across_model_changes_and_reload() {
    for provider in ["openai", "anthropic", "gemini", "glm", "kimi", "xai"] {
        let store = Arc::new(InMemoryThreadStore::default());
        let threads = ThreadController::with_store(store.clone());
        let thread_id = ThreadId::new("source-thread").unwrap();
        threads
            .create_thread(CreateThreadRequest {
                agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("source-session").unwrap(),
                thread_id: thread_id.clone(),
                title: "Synthetic".into(),
                execution_target: None,
            })
            .unwrap();
        let source_model = ModelRef::new(
            ProviderId::new(provider).unwrap(),
            ModelId::new("source-model").unwrap(),
        );
        let other = ModelRef::new(
            ProviderId::new("openai").unwrap(),
            ModelId::new("later-model").unwrap(),
        );
        let source_turn = start(&threads, &thread_id, "source", Some(source_model.clone()));
        threads
            .complete_turn(&thread_id, &source_turn, "Done".into())
            .unwrap();
        let later_turn = start(&threads, &thread_id, "later", Some(other.clone()));
        threads
            .complete_turn(&thread_id, &later_turn, "Done".into())
            .unwrap();
        drop(threads);
        let reopened = ThreadController::with_store(store);
        let mut config = ash_config::ResolvedConfig {
            model: Some(other.clone()),
            ..Default::default()
        };
        assert_eq!(
            selected_message_model(&reopened, &config, &thread_id, &source_turn).unwrap(),
            source_model
        );
        config.commit_message_model = Some(other.clone());
        assert_eq!(
            selected_message_model(&reopened, &config, &thread_id, &source_turn).unwrap(),
            other
        );
        config.commit_message_model = None;
        let no_model = start(&reopened, &thread_id, "no-model", None);
        assert!(selected_message_model(&reopened, &config, &thread_id, &no_model).is_err());
    }
}

#[test]
fn commit_message_context_redacts_credentials_line_by_line() {
    assert_eq!(
        super::redact_sensitive_text("safe\nAuthorization: Bearer value\nstill safe"),
        "safe\n[redacted sensitive line]\nstill safe"
    );
}

#[test]
fn commit_message_generation_uses_the_inherited_or_explicit_model_and_exact_diff() {
    use ash_config::ConfigCommandRequest;
    use ash_config::PreferencesUpdate;
    use ash_config::UserConfigCommand;
    use ash_protocol::Patch;
    use git_turn_changes::TurnChangeStore;
    use std::sync::Mutex;

    struct RecordingModel(Mutex<Vec<ModelRef>>);
    impl core_api::ModelService for RecordingModel {
        fn invoke(
            &self,
            selection: core_api::ModelSelection<'_>,
            request: &ash_protocol::ModelRequest,
            _: &ash_async_utils::CancellationToken,
        ) -> Result<ash_protocol::ModelResponse, core_api::CoreError> {
            let core_api::ModelSelection::Session(model) = selection else {
                panic!("commit messages must not fall back to the global model");
            };
            self.0.lock().unwrap().push(model.clone());
            let input = format!("{:?}", request.input);
            assert!(input.contains("+Synthetic source change"));
            assert!(!input.contains("Later unrelated conversation"));
            Ok(ash_protocol::ModelResponse {
                output: vec![ash_protocol::ResponseItem::Text(
                    "feat: synthetic source change".into(),
                )],
                usage: None,
                billing: None,
                stop_reason: ash_protocol::StopReason::Completed,
            })
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    };
    git(&["init"]);
    let before = git(&["write-tree"]);
    std::fs::write(
        directory.path().join("source.txt"),
        "Synthetic source change\n",
    )
    .unwrap();
    git(&["add", "source.txt"]);
    let after = git(&["write-tree"]);
    let blob = git(&["rev-parse", ":source.txt"]);
    let dir = ash_file_access::Dir::open_local(directory.path())
        .unwrap()
        .id()
        .clone();
    let threads = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
    let thread_id = ThreadId::new("message-source").unwrap();
    let session_id = ash_protocol::SessionId::new("message-session").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Synthetic source".into(),
            execution_target: None,
        })
        .unwrap();
    let source_model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("source-model").unwrap(),
    );
    let override_model = ModelRef::new(
        source_model.provider.clone(),
        ModelId::new("override-model").unwrap(),
    );
    let source_turn = start(
        &threads,
        &thread_id,
        "generate-source",
        Some(source_model.clone()),
    );
    threads
        .complete_turn(&thread_id, &source_turn, "Source change complete".into())
        .unwrap();
    let later = start(
        &threads,
        &thread_id,
        "generate-later",
        Some(override_model.clone()),
    );
    threads
        .complete_turn(&thread_id, &later, "Later unrelated conversation".into())
        .unwrap();
    let config = ash_config::ConfigStore::open(directory.path().join("config.sqlite3")).unwrap();
    let apply = |id: &str, command| {
        config
            .apply(ConfigCommandRequest {
                command_id: CommandId::new(id).unwrap(),
                expected_revision: config.read_snapshot().unwrap().revision,
                command,
            })
            .unwrap();
    };
    let provider = model_provider_info::ModelProviderConfig::new(source_model.provider.clone());
    apply(
        "message-provider",
        UserConfigCommand::SaveConnection {
            connection: provider.connection.clone(),
            config: provider,
        },
    );
    let store =
        ash_state::SqliteTurnChangeStore::open(directory.path().join("changes.sqlite3")).unwrap();
    let model = RecordingModel(Mutex::new(Vec::new()));
    for (key, selected, expected) in [
        ("inherit", None, &source_model),
        ("explicit", Some(override_model.clone()), &override_model),
    ] {
        apply(
            key,
            UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                model: Patch::Value(override_model.clone()),
                commit_message_model: selected.map_or(Patch::Null, Patch::Value),
                ..Default::default()
            }),
        );
        let mut record =
            git_turn_changes::TurnChangeSet::open(git_turn_changes::TurnChangeSetDraft {
                change_set_id: git_turn_changes::ChangeSetId::new(key).unwrap(),
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                turn_id: source_turn.clone(),
                repository_id: "synthetic".into(),
                worktree_root: directory.path().to_path_buf(),
                git_common_dir: directory.path().join(".git"),
                target_branch: None,
                base_object_id: None,
                before_tree: before.clone(),
                baseline_dependency_paths: Default::default(),
                message_state: git_turn_changes::MessageState::Queued,
            })
            .unwrap();
        record
            .seal(
                after.clone(),
                git_turn_changes::TerminalTurnState::Completed,
                vec![git_turn_changes::ChangeFile {
                    path: "source.txt".into(),
                    previous_path: None,
                    kind: git_turn_changes::ChangeFileKind::Added,
                    before_object_id: None,
                    after_object_id: Some(blob.clone()),
                    before_mode: None,
                    after_mode: Some("100644".into()),
                    binary: false,
                    additions: 1,
                    deletions: 0,
                }],
                Default::default(),
            )
            .unwrap();
        store.insert(&record).unwrap();
        let updates = super::super::update_broker::UpdateBroker::default();
        // Switching the selection revokes the previous grant, including in inheritance mode.
        assert!(
            super::generate_message(
                &store,
                &threads,
                &model,
                &config,
                &dir,
                &updates,
                &record.change_set_id
            )
            .is_err()
        );
        apply(
            &format!("authorize-{key}"),
            UserConfigCommand::AuthorizeCommitMessageEgress {
                dir: dir.clone(),
                model: Some(expected.clone()),
            },
        );
        super::generate_message(
            &store,
            &threads,
            &model,
            &config,
            &dir,
            &updates,
            &record.change_set_id,
        )
        .unwrap();
        let saved = store.load(&record.change_set_id).unwrap();
        assert_eq!(saved.message_state, git_turn_changes::MessageState::Ready);
        assert_eq!(
            saved.generated_message.as_deref(),
            Some("feat: synthetic source change")
        );
    }
    assert_eq!(*model.0.lock().unwrap(), vec![source_model, override_model]);
}
