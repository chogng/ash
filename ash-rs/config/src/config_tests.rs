use super::*;
use ash_file_access::{Permission, Permissions};
use ash_model_provider_config::{ModelProviderConfig, ProviderConfigRegistry};
use ash_protocol::{CommandId, Patch, ProviderId};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn config_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-config-{label}-{}-{}.sqlite3",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn dir_config_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-dir-config-{label}-{}-{}.toml",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn remove_config_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("toml"));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
}

fn persisted_config_document(path: &Path) -> String {
    std::fs::read_to_string(path.with_extension("toml")).unwrap()
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}

fn model_ref(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(
        provider_id(provider),
        ash_protocol::ModelId::new(model).unwrap(),
    )
}

#[test]
fn desktop_worktree_settings_survive_resolution() {
    let document = toml::from_str::<UserConfigDocument>(
        r#"
[desktop]
git-worktree-root = "/tmp/ash-worktrees"
worktree-auto-cleanup-enabled = false
worktree-keep-count = 4
"#,
    )
    .unwrap();
    let resolved = ResolvedConfig::from(&document);

    assert_eq!(
        resolved.desktop.get("git-worktree-root"),
        Some(&serde_json::json!("/tmp/ash-worktrees"))
    );
    assert_eq!(
        resolved.desktop.get("worktree-auto-cleanup-enabled"),
        Some(&serde_json::json!(false))
    );
    assert_eq!(
        resolved.desktop.get("worktree-keep-count"),
        Some(&serde_json::json!(4))
    );
}

#[test]
fn tool_search_defaults_to_lexical_and_requires_a_configured_embedding_model() {
    let default_document = toml::from_str::<UserConfigDocument>("").unwrap();
    assert_eq!(
        default_document.tool_search.mode,
        ToolSearchModeConfig::Lexical
    );

    let invalid_hybrid =
        toml::from_str::<UserConfigDocument>("[toolSearch]\nmode = \"hybridEmbedding\"\n").unwrap();
    assert!(invalid_hybrid.validate().is_err());

    let provider = provider_id("ollama");
    let embedding_model = model_ref("ollama", "nomic-embed-text");
    let mut hybrid_document = UserConfigDocument::default();
    hybrid_document
        .providers
        .insert(provider.clone(), ModelProviderConfig::new(provider));
    hybrid_document.tool_search = ToolSearchConfig {
        mode: ToolSearchModeConfig::HybridEmbedding,
        embedding_model: Some(embedding_model.clone()),
    };
    hybrid_document.validate().unwrap();
    assert_eq!(
        ResolvedConfig::from(&hybrid_document).tool_search,
        ToolSearchConfig {
            mode: ToolSearchModeConfig::HybridEmbedding,
            embedding_model: Some(embedding_model),
        }
    );
}

#[test]
fn tool_search_command_persists_the_exact_embedding_model() {
    let path = config_path("tool-search-command");
    let store = ConfigStore::open(&path).unwrap();
    let provider = configure_provider(&store, 0, "ollama");
    let embedding_model = model_ref("ollama", "nomic-embed-text");

    let configured = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-tool-search").unwrap(),
            expected_revision: provider.revision,
            command: UserConfigCommand::ConfigureToolSearch {
                config: ToolSearchConfig {
                    mode: ToolSearchModeConfig::HybridEmbedding,
                    embedding_model: Some(embedding_model.clone()),
                },
            },
        })
        .unwrap();

    assert_eq!(configured.revision, ConfigRevision::new(2));
    assert_eq!(
        store.read_snapshot().unwrap().values.tool_search,
        ToolSearchConfig {
            mode: ToolSearchModeConfig::HybridEmbedding,
            embedding_model: Some(embedding_model),
        }
    );
    drop(store);
    remove_config_files(&path);
}

fn configure_provider(store: &ConfigStore, revision: u64, provider: &str) -> ConfigCommandResult {
    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new(format!("configure-{provider}-{revision}")).unwrap(),
            expected_revision: ConfigRevision::new(revision),
            command: UserConfigCommand::ConfigureProvider {
                provider: provider_id(provider),
                config: ModelProviderConfig::new(provider_id(provider)),
            },
        })
        .unwrap()
}

#[test]
fn configuring_provider_selects_its_first_api_model_and_preserves_selection_after_restart() {
    let path = config_path("provider-default-model");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let expected = model_ref("openai", "gpt-6-astra");
    assert_eq!(
        store.read_snapshot().unwrap().values.model,
        Some(expected.clone())
    );
    configure_provider(&store, configured.revision.get(), "anthropic");
    drop(store);
    let reopened = ConfigStore::open(&path).unwrap();
    assert_eq!(
        reopened.read_snapshot().unwrap().values.model,
        Some(expected)
    );
    drop(reopened);
    remove_config_files(&path);
}

#[test]
fn saving_existing_provider_restores_missing_model_but_preserves_explicit_choice() {
    let path = config_path("provider-existing-model");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "anthropic");
    let cleared = store
        .apply(update_preferences(
            "clear",
            configured.revision.get(),
            Patch::Null,
        ))
        .unwrap();
    let saved = configure_provider(&store, cleared.revision.get(), "anthropic");
    assert_eq!(
        store.read_snapshot().unwrap().values.model,
        Some(model_ref("anthropic", "claude-sonnet-4-20250514"))
    );
    let explicit = model_ref("anthropic", "custom-deployment");
    let selected = store
        .apply(update_preferences(
            "select",
            saved.revision.get(),
            Patch::Value(explicit.clone()),
        ))
        .unwrap();
    configure_provider(&store, selected.revision.get(), "anthropic");
    assert_eq!(store.read_snapshot().unwrap().values.model, Some(explicit));
    drop(store);
    remove_config_files(&path);
}

#[test]
fn configuring_provider_without_builtin_models_does_not_invent_a_model() {
    let path = config_path("provider-no-default");
    let store = ConfigStore::open(&path).unwrap();
    configure_provider(&store, 0, "ollama");
    assert_eq!(store.read_snapshot().unwrap().values.model, None);
    drop(store);
    remove_config_files(&path);
}

#[test]
fn issue_refresh_settings_survive_restart_and_reject_stale_writes() {
    let path = config_path("issues");
    let store = ConfigStore::open(&path).unwrap();
    assert_eq!(
        store
            .read_snapshot()
            .unwrap()
            .values
            .issues
            .auto_refresh_minutes,
        10
    );
    let outcome = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("issue-refresh").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureIssues {
                config: IssueConfig {
                    auto_refresh_minutes: 30,
                },
            },
        })
        .unwrap();
    assert!(
        store
            .apply(ConfigCommandRequest {
                command_id: CommandId::new("stale-refresh").unwrap(),
                expected_revision: ConfigRevision::INITIAL,
                command: UserConfigCommand::ConfigureIssues {
                    config: IssueConfig::default()
                },
            })
            .is_err()
    );
    drop(store);
    let reopened = ConfigStore::open(&path).unwrap();
    assert_eq!(reopened.read_snapshot().unwrap().revision, outcome.revision);
    assert_eq!(
        reopened
            .read_snapshot()
            .unwrap()
            .values
            .issues
            .auto_refresh_minutes,
        30
    );
    drop(reopened);
    remove_config_files(&path);
}

#[test]
fn issue_execution_settings_are_removed_once_from_versioned_configuration() {
    let source = "schemaVersion = 1\n[issues]\nautoRefreshMinutes = 30\nrecommendMerge = true\n[issues.analysisModel]\nprovider = 'old'\nmodel = 'old'\n[issues.repositories.legacy]\nworker_agent = 'worker'\n";
    let decoded = crate::document_migration::decode(source).unwrap();
    assert!(decoded.rewrite_required);
    assert_eq!(decoded.document.issues.auto_refresh_minutes, 30);
    let encoded = crate::document_migration::encode(&decoded.document).unwrap();
    for removed in [
        "recommendMerge",
        "analysisModel",
        "repositories",
        "worker_agent",
    ] {
        assert!(!encoded.contains(removed));
    }
    assert!(encoded.contains("schemaVersion = 3"));
    assert!(
        !crate::document_migration::decode(&encoded)
            .unwrap()
            .rewrite_required
    );
    assert!(
        crate::document_migration::decode("schemaVersion = 2\n[issues]\nrecommendMerge = true\n")
            .is_err()
    );
}

#[test]
fn model_settings_are_migrated_once_from_version_two() {
    let database_path = config_path("model-settings-migration");
    let config_path = database_path.with_extension("toml");
    let mut document = UserConfigDocument::default();
    document.providers.insert(
        provider_id("openai"),
        ModelProviderConfig::new(provider_id("openai")),
    );
    document.agent.model = Some(model_ref("openai", "gpt-6-astra"));
    document.agent.model_reasoning_effort = Some(ash_protocol::ReasoningEffort::High);
    let mut legacy: toml::Value =
        toml::from_str(&crate::document_migration::encode(&document).unwrap()).unwrap();
    let root = legacy.as_table_mut().unwrap();
    root.insert("schemaVersion".into(), toml::Value::Integer(2));
    let agent = root.get_mut("agent").unwrap().as_table_mut().unwrap();
    let model = agent.remove("model").unwrap();
    agent.insert("preferredModel".into(), model);
    let effort = agent.remove("modelReasoningEffort").unwrap();
    agent.insert("preferredReasoningEffort".into(), effort);
    std::fs::write(&config_path, toml::to_string_pretty(&legacy).unwrap()).unwrap();

    let store = ConfigStore::open(&database_path).unwrap();
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(snapshot.values.model, document.agent.model);
    assert_eq!(
        snapshot.values.model_reasoning_effort,
        document.agent.model_reasoning_effort
    );
    let persisted = std::fs::read_to_string(&config_path).unwrap();
    assert!(persisted.contains("schemaVersion = 3"));
    assert!(!persisted.contains("preferredModel"));
    assert!(!persisted.contains("preferredReasoningEffort"));
    drop(store);

    let reopened = ConfigStore::open(&database_path).unwrap();
    assert_eq!(
        reopened.read_snapshot().unwrap().values.model,
        document.agent.model
    );
    assert_eq!(std::fs::read_to_string(&config_path).unwrap(), persisted);
    drop(reopened);
    remove_config_files(&database_path);
}

#[test]
fn model_setting_migration_rejects_conflicting_names() {
    let error = crate::document_migration::decode(
        "schemaVersion = 2\n[agent]\nmodelReasoningEffort = 'low'\npreferredReasoningEffort = 'high'\n",
    )
    .err()
    .unwrap();
    assert!(
        error
            .0
            .contains("both agent.preferredReasoningEffort and agent.modelReasoningEffort")
    );
    assert!(
        crate::document_migration::decode(
            "schemaVersion = 3\n[agent]\npreferredReasoningEffort = 'high'\n"
        )
        .is_err()
    );
}

#[test]
fn custom_provider_survives_restart_and_rejects_stale_update() {
    let path = config_path("custom-provider");
    let store = ConfigStore::open(&path).unwrap();
    let mut config = ModelProviderConfig::new(provider_id("custom-test"));
    config.base_url = Some("https://example.test/v1".into());
    config.custom = Some(ash_model_provider_config::CustomProviderConfig {
        context_window: 272_000,
        order: 0,
        model: None,
        name: "Example".into(),
        protocol: ash_model_provider_config::CustomProviderProtocol::Responses,
    });
    let command = |id: &str, config: ModelProviderConfig| ConfigCommandRequest {
        command_id: CommandId::new(id).unwrap(),
        expected_revision: ConfigRevision::INITIAL,
        command: UserConfigCommand::ConfigureProvider {
            provider: config.provider.clone(),
            config,
        },
    };
    store.apply(command("create", config.clone())).unwrap();
    let mut changed = config.clone();
    changed.custom.as_mut().unwrap().protocol =
        ash_model_provider_config::CustomProviderProtocol::ChatCompletions;
    assert!(store.apply(command("stale", changed)).is_err());
    drop(store);
    config.custom.as_mut().unwrap().order = 1;
    let reopened = ConfigStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .read_snapshot()
            .unwrap()
            .values
            .providers
            .get(&config.provider),
        Some(&config)
    );
    assert!(!persisted_config_document(&path).contains("api_key"));
    drop(reopened);
    remove_config_files(&path);
}

fn update_preferences(
    command_id: &str,
    revision: u64,
    model: Patch<ModelRef>,
) -> ConfigCommandRequest {
    ConfigCommandRequest {
        command_id: CommandId::new(command_id).unwrap(),
        expected_revision: ConfigRevision::new(revision),
        command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
            time_context: ash_protocol::Patch::Missing,
            features: Default::default(),
            model,
            model_reasoning_effort: Patch::Missing,
            approval_review_model: Patch::Missing,
            commit_message_model: Patch::Missing,
            tool_mode: Patch::Missing,
            grep_backend: Patch::Missing,
            gui: Patch::Missing,
            tui: Patch::Missing,
        }),
    }
}

fn dir_permissions_id() -> DirId {
    format!("sha256:{}", "12".repeat(32)).parse().unwrap()
}

#[test]
fn unversioned_config_is_migrated_and_rewritten_once() {
    let database_path = config_path("unversioned-file-migration");
    let document_path = database_path.with_extension("toml");
    let trusted_dir = database_path.with_extension("trusted-dir");
    std::fs::create_dir(&trusted_dir).unwrap();
    let trusted_path = ash_file_access::Dir::open_local(&trusted_dir)
        .unwrap()
        .canonical_path()
        .to_path_buf();
    let trusted = crate::document_migration::legacy_id_for_path(&trusted_path);
    let mismatched_dir = database_path.with_extension("mismatched-dir");
    std::fs::create_dir(&mismatched_dir).unwrap();
    let mismatched_path = ash_file_access::Dir::open_local(&mismatched_dir)
        .unwrap()
        .canonical_path()
        .to_path_buf();
    let mismatched = format!("sha256:{}", "56".repeat(32));
    let restricted = format!("sha256:{}", "34".repeat(32));
    std::fs::write(
        &document_path,
        format!(
            r#"
[semanticCodeIndex]
automaticContext = "firstInvocation"

[semanticCodeIndex.selection]
type = "disabled"

[workspaceTrust.roots]
"{trusted}" = "trusted"
"{mismatched}" = "trusted"
"{restricted}" = "restricted"

[workspaceTrust.rootPaths]
"{trusted}" = {}
"{mismatched}" = {}
"{restricted}" = "/tmp/restricted"
"#,
            toml::Value::String(trusted_path.to_string_lossy().into_owned()),
            toml::Value::String(mismatched_path.to_string_lossy().into_owned())
        ),
    )
    .unwrap();

    let store = ConfigStore::open(&database_path).unwrap();
    let snapshot = store.read_snapshot().unwrap();
    let trusted_id = ash_file_access::Dir::open_local(&trusted_path)
        .unwrap()
        .id();
    let mismatched_id = ash_file_access::Dir::open_local(&mismatched_path)
        .unwrap()
        .id();
    let restricted_id = restricted.parse::<DirId>().unwrap();
    let permissions = snapshot
        .values
        .dir_permissions
        .explicit_permissions_for(&trusted_id)
        .unwrap();

    assert_eq!(
        snapshot.values.codebase.automatic_context,
        CodebaseAutomaticContext::FirstInvocation
    );
    assert_eq!(permissions.entries().count(), 15);
    assert!(permissions.allows(Permission::LoadConfig));
    assert!(permissions.allows(Permission::MutateRepository));
    assert!(
        snapshot
            .values
            .dir_permissions
            .explicit_permissions_for(&restricted_id)
            .is_none()
    );
    assert!(
        snapshot
            .values
            .dir_permissions
            .explicit_permissions_for(&mismatched_id)
            .is_none()
    );
    assert_eq!(
        snapshot.values.dir_permissions.path_for(&trusted_id),
        Some(trusted_path.as_path())
    );

    let persisted = persisted_config_document(&database_path);
    assert!(persisted.contains("schemaVersion = 3"));
    assert!(persisted.contains("[codebase]"));
    assert!(persisted.contains("[dirPermissions.entries]"));
    assert!(!persisted.contains("semanticCodeIndex"));
    assert!(!persisted.contains("workspaceTrust"));
    assert!(!persisted.contains("/tmp/restricted"));
    assert!(!persisted.contains(&mismatched_path.display().to_string()));

    drop(store);
    remove_config_files(&database_path);
    std::fs::remove_dir(trusted_dir).unwrap();
    std::fs::remove_dir(mismatched_dir).unwrap();
}

#[test]
fn config_migration_support_window_has_no_expired_compatibility() {
    let expired = crate::document_migration::expired_migrations();

    assert!(
        expired.is_empty(),
        "remove expired user configuration migrations: {}",
        expired.join(", ")
    );
}

#[test]
fn semantic_index_migration_keeps_models_but_removes_egress_grants() {
    let database_path = config_path("semantic-index-file-migration");
    let grant = format!("sha256:{}", "12".repeat(32));
    std::fs::write(
        database_path.with_extension("toml"),
        format!(
            r#"
[providers.ollama]
provider = "ollama"

[semanticCodeIndex]
automaticContext = "firstInvocation"

[semanticCodeIndex.selection]
type = "remote"

[semanticCodeIndex.selection.models.embeddingModel]
provider = "ollama"
model = "embed"

[semanticCodeIndex.sourceEgressGrants."{grant}".models.embeddingModel]
provider = "ollama"
model = "embed"

[semanticCodeIndex.sourceEgressGrants."{grant}".providers.ollama]
provider = "ollama"
"#
        ),
    )
    .unwrap();

    let store = ConfigStore::open(&database_path).unwrap();
    let codebase = store.read_snapshot().unwrap().values.codebase;

    assert_eq!(
        codebase.models.unwrap().embedding_model,
        model_ref("ollama", "embed")
    );
    assert_eq!(
        codebase.automatic_context,
        CodebaseAutomaticContext::FirstInvocation
    );
    let persisted = persisted_config_document(&database_path);
    assert!(!persisted.contains("sourceEgressGrants"));
    assert!(!persisted.contains(&grant));

    drop(store);
    remove_config_files(&database_path);
}

#[test]
fn file_migration_rejects_ambiguous_legacy_and_current_fields() {
    let database_path = config_path("ambiguous-file-migration");
    std::fs::write(
        database_path.with_extension("toml"),
        "[semanticCodeIndex]\n[codebase]\n",
    )
    .unwrap();

    let error = ConfigStore::open(&database_path).err().unwrap();

    assert!(
        error
            .0
            .contains("contains both semanticCodeIndex and codebase")
    );
    remove_config_files(&database_path);
}

#[test]
fn versioned_config_keeps_unknown_fields_strict() {
    let database_path = config_path("strict-versioned-file");
    std::fs::write(
        database_path.with_extension("toml"),
        "schemaVersion = 1\nunknownField = true\n",
    )
    .unwrap();

    let error = ConfigStore::open(&database_path).err().unwrap();

    assert!(error.0.contains("unknown field `unknownField`"));
    remove_config_files(&database_path);
}

#[test]
fn newer_file_schema_is_rejected_explicitly() {
    let database_path = config_path("newer-file-schema");
    std::fs::write(database_path.with_extension("toml"), "schemaVersion = 4\n").unwrap();

    let error = ConfigStore::open(&database_path).err().unwrap();

    assert!(error.0.contains("newer than supported version 3"));
    remove_config_files(&database_path);
}

#[test]
fn gui_section_is_read_without_interpreting_frontend_fields() {
    let database_path = config_path("gui");
    std::fs::write(
        database_path.with_extension("toml"),
        r#"schemaVersion = 1

[gui]
theme = "ash-dark"
interfaceFontFamily = "Inter"
interfaceFontSize = 15
editorFontFamily = "JetBrains Mono"
editorFontSize = 15
editorLineHeight = 24
"#,
    )
    .unwrap();

    let store = ConfigStore::open(&database_path).unwrap();

    assert_eq!(
        store.read_snapshot().unwrap().values.gui,
        BTreeMap::from([
            ("interfaceFontFamily".into(), serde_json::json!("Inter")),
            ("interfaceFontSize".into(), serde_json::json!(15)),
            (
                "editorFontFamily".into(),
                serde_json::json!("JetBrains Mono")
            ),
            ("editorFontSize".into(), serde_json::json!(15)),
            ("editorLineHeight".into(), serde_json::json!(24)),
            ("theme".into(), serde_json::json!("ash-dark")),
        ])
    );
    drop(store);
    remove_config_files(&database_path);
}

#[test]
fn frontend_section_patch_is_durable_and_null_clears_the_section() {
    let database_path = config_path("gui-patch");
    let store = ConfigStore::open(&database_path).unwrap();
    let configured = BTreeMap::from([
        ("interfaceFontFamily".into(), serde_json::json!("Inter")),
        ("interfaceFontSize".into(), serde_json::json!(15)),
        (
            "editorFontFamily".into(),
            serde_json::json!("JetBrains Mono"),
        ),
        ("editorFontSize".into(), serde_json::json!(15)),
        ("editorLineHeight".into(), serde_json::json!(24)),
        ("theme".into(), serde_json::json!("ash-dark")),
    ]);

    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-gui").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                gui: Patch::Value(configured.clone()),
                ..PreferencesUpdate::default()
            }),
        })
        .unwrap();
    assert_eq!(store.read_snapshot().unwrap().values.gui, configured);

    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("reset-gui").unwrap(),
            expected_revision: ConfigRevision::new(1),
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                gui: Patch::Null,
                ..PreferencesUpdate::default()
            }),
        })
        .unwrap();
    assert!(store.read_snapshot().unwrap().values.gui.is_empty());
    drop(store);
    remove_config_files(&database_path);
}

#[test]
fn frontend_sections_preserve_fields_the_backend_does_not_understand() {
    let document = toml::from_str::<UserConfigDocument>(
        "[gui]\neditorFontSize = 16\neditorLineHeight = 15\nfutureOption = true\n",
    )
    .unwrap();

    assert_eq!(document.gui["futureOption"], serde_json::json!(true));
    assert!(document.validate().is_ok());
}

#[test]
fn tool_mode_defaults_to_direct_and_updates_durably() {
    let database_path = config_path("tool-mode");
    let store = ConfigStore::open(&database_path).unwrap();
    assert_eq!(
        store.read_snapshot().unwrap().values.tool_mode,
        ash_protocol::ToolMode::Direct
    );
    assert_eq!(
        store.read_snapshot().unwrap().values.agent_grep_backend,
        AgentGrepBackend::Ripgrep
    );

    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-code-mode-only").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                model: Patch::Missing,
                model_reasoning_effort: Patch::Missing,
                approval_review_model: Patch::Missing,
                commit_message_model: Patch::Missing,
                tool_mode: Patch::Value(ash_protocol::ToolMode::CodeModeOnly),
                grep_backend: Patch::Value(AgentGrepBackend::FastRegex),
                gui: Patch::Missing,
                tui: Patch::Missing,
            }),
        })
        .unwrap();

    assert_eq!(
        store.read_snapshot().unwrap().values.tool_mode,
        ash_protocol::ToolMode::CodeModeOnly
    );
    assert_eq!(
        store.read_snapshot().unwrap().values.agent_grep_backend,
        AgentGrepBackend::FastRegex
    );
    let persisted = persisted_config_document(&database_path);
    assert!(!persisted.contains("[gui]"));
    drop(store);
    remove_config_files(&database_path);
}

#[test]
fn tui_section_is_persisted_in_the_tui_table() {
    let path = config_path("tui-theme");
    let store = ConfigStore::open(&path).unwrap();

    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-tui-theme").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                tui: Patch::Value(BTreeMap::from([(
                    "theme".into(),
                    serde_json::json!("ash-code-light"),
                )])),
                ..PreferencesUpdate::default()
            }),
        })
        .unwrap();

    assert_eq!(
        store.read_snapshot().unwrap().values.tui["theme"],
        serde_json::json!("ash-code-light")
    );
    let document = persisted_config_document(&path);
    assert!(document.contains("[tui]\n"));
    assert!(document.contains("theme = \"ash-code-light\""));
    remove_config_files(&path);
}

#[test]
fn tui_section_values_are_not_interpreted_by_the_backend() {
    let path = config_path("opaque-tui-theme");
    let store = ConfigStore::open(&path).unwrap();

    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-frontend-owned-theme").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                tui: Patch::Value(BTreeMap::from([(
                    "theme".into(),
                    serde_json::json!("Not A Theme"),
                )])),
                ..PreferencesUpdate::default()
            }),
        })
        .unwrap();

    assert_eq!(
        store.read_snapshot().unwrap().values.tui["theme"],
        serde_json::json!("Not A Theme")
    );
    remove_config_files(&path);
}

#[test]
fn codebase_config_persists_model_selection_without_runtime_state() {
    let models = CodebaseModelSelection {
        embedding_model: model_ref("openai-compatible", "embed-v1"),
        rerank_model: Some(model_ref("openai-compatible", "rerank-v1")),
    };
    let mut config = CodebaseConfig::default();
    config.replace_models(Some(models.clone()));
    assert_eq!(config.models, Some(models));
    config.replace_models(None);
    assert_eq!(config.models, None);
}

#[test]
fn commit_message_egress_grant_is_bound_to_dir_model_and_endpoint() {
    let dir = dir_permissions_id();
    let provider = provider_id("openai-compatible");
    let mut provider_config = ModelProviderConfig::new(provider.clone());
    provider_config.base_url = Some("https://models.example.test/v1".into());
    let mut providers = BTreeMap::from([(provider.clone(), provider_config.clone())]);
    let first_model = model_ref("openai-compatible", "summary-v1");
    let second_model = model_ref("openai-compatible", "summary-v2");
    let mut config = CommitMessageConfig::default();

    config
        .authorize(dir.clone(), Some(&first_model), &providers)
        .unwrap();
    assert_eq!(
        config.authorized_model(&dir, Some(&first_model), &providers),
        Some(&first_model)
    );
    assert_eq!(
        config.authorized_model(&dir, Some(&second_model), &providers),
        None
    );

    providers.get_mut(&provider).unwrap().base_url =
        Some("https://different.example.test/v1".into());
    assert_eq!(
        config.authorized_model(&dir, Some(&first_model), &providers),
        None
    );

    providers.insert(provider, provider_config);
    config
        .authorize(dir.clone(), Some(&second_model), &providers)
        .unwrap();
    assert_eq!(
        config.authorized_model(&dir, Some(&second_model), &providers),
        Some(&second_model)
    );
    config.revoke(&dir);
    assert_eq!(
        config.authorized_model(&dir, Some(&second_model), &providers),
        None
    );
}

fn mcp_server() -> McpServerConfig {
    McpServerConfig {
        id: McpServerId::new("user:mcp:github").unwrap(),
        display_name: "GitHub".into(),
        transport: McpTransportConfig::StreamableHttp {
            url: "https://mcp.github.example".into(),
        },
        credential: McpCredentialBinding::Reference {
            credential_ref: "user:credential:github".into(),
        },
        enablement: McpServerEnablement::Disabled,
    }
}

fn skill_source() -> SkillSourceConfig {
    SkillSourceConfig {
        id: SkillSourceId::new("user:skill-source:personal").unwrap(),
        root_reference: "user:skill-root:personal".into(),
        enablement: SkillSourceEnablement::Disabled,
    }
}

fn plugin_request() -> PluginRequest {
    PluginRequest {
        plugin_id: PluginPackageId::new("acme/code-review").unwrap(),
        version: PluginVersion::new("1.2.3").unwrap(),
        enablement: PluginRequestEnablement::Disabled,
    }
}

fn hook(id: &str) -> HookConfig {
    HookConfig {
        id: HookId::new(id).unwrap(),
        event: HookEvent::BeforeTool,
        matcher: HookMatcher {
            tool_names: BTreeSet::from(["shell_command".into()]),
        },
        action: HookAction::Process {
            program: "review-hook".into(),
            args: vec!["--check".into()],
        },
        enablement: HookEnablement::Disabled,
    }
}

fn built_in_skill() -> SkillId {
    SkillId::new(
        SkillSourceId::new("builtin:skill-source:ash-release").unwrap(),
        SkillName::new("skill-creator").unwrap(),
    )
}

fn dir_scope() -> DirConfigScope {
    DirConfigScope::new(dir_permissions_id())
}

fn dir_document(model: Option<ModelRef>) -> DirConfigDocument {
    let namespace = format!("dir:{}", dir_permissions_id());
    let mcp_id = format!("{namespace}:mcp:github");
    let skill_id = format!("{namespace}:skill-source:review");
    let hook_id = format!("{namespace}:hook:review");
    let mcp_server = DirMcpServerConfig {
        id: McpServerId::new(mcp_id).unwrap(),
        display_name: "Project GitHub".into(),
        transport: McpTransportConfig::Stdio {
            command: "github-mcp".into(),
            args: Vec::new(),
        },
        enablement: McpServerEnablement::Enabled,
    };
    let skill_source = SkillSourceConfig {
        id: SkillSourceId::new(skill_id).unwrap(),
        root_reference: "dir:skill-root:review".into(),
        enablement: SkillSourceEnablement::Enabled,
    };
    let plugin_id = PluginPackageId::new("acme/code-review").unwrap();
    DirConfigDocument {
        agent: DirAgentConfig {
            model,
            model_reasoning_effort: None,
        },
        mcp: DirMcpConfig {
            servers: BTreeMap::from([(mcp_server.id.clone(), mcp_server)]),
        },
        plugin_requests: DirPluginRequests {
            requests: BTreeMap::from([(
                plugin_id.clone(),
                DirPluginRequest {
                    plugin_id,
                    version: PluginVersion::new("1.2.3").unwrap(),
                    requested_scope: DirPluginRequestScope::Directory,
                },
            )]),
        },
        skills: DirSkillsConfig {
            sources: BTreeMap::from([(skill_source.id.clone(), skill_source)]),
        },
        hooks: HooksConfig {
            hooks: BTreeMap::from([(HookId::new(&hook_id).unwrap(), hook(&hook_id))]),
        },
        exec_policy: DirExecPolicyConfig::default(),
    }
}

#[test]
fn toml_authority_and_sqlite_metadata_survive_reopen() {
    let path = config_path("single-authority");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let updated = store
        .apply(update_preferences(
            "select-model",
            configured.revision.get(),
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap();

    let reopened = ConfigStore::open(&path).unwrap();
    let snapshot = reopened.read_snapshot().unwrap();
    assert_eq!(updated.revision, ConfigRevision::new(2));
    assert_eq!(snapshot.revision, updated.revision);
    assert_eq!(snapshot.generation.get(), 2);
    assert_eq!(snapshot.values.model, Some(model_ref("openai", "model")));
    assert_eq!(
        snapshot.values.selected_provider().unwrap().provider,
        provider_id("openai")
    );
    assert!(path.with_extension("toml").exists());
    let columns: Vec<String> = rusqlite::Connection::open(&path)
        .unwrap()
        .prepare("PRAGMA table_info(config_metadata)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(!columns.iter().any(|column| column == "document_json"));
    remove_config_files(&path);
}

#[test]
fn legacy_sqlite_document_is_migrated_once_into_toml() {
    let path = config_path("legacy-document-migration");
    let provider = ModelProviderConfig::new(provider_id("openai"));
    let document = UserConfigDocument {
        providers: BTreeMap::from([(provider_id("openai"), provider)]),
        ..UserConfigDocument::default()
    };
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE ash_schema_migrations (
                 component TEXT PRIMARY KEY,
                 version INTEGER NOT NULL
             );
             INSERT INTO ash_schema_migrations (component, version) VALUES ('config', 1);
             CREATE TABLE config_authority (
                 authority_id INTEGER PRIMARY KEY,
                 schema_version INTEGER NOT NULL,
                 revision INTEGER NOT NULL,
                 generation INTEGER NOT NULL,
                 document_json TEXT NOT NULL
             );
             CREATE TABLE config_command_receipts (
                 command_id TEXT PRIMARY KEY,
                 expected_revision INTEGER NOT NULL,
                 command_json TEXT NOT NULL,
                 result_revision INTEGER NOT NULL,
                 result_generation INTEGER NOT NULL
             );",
        )
        .unwrap();
    let mut legacy_document = serde_json::to_value(&document).unwrap();
    legacy_document
        .as_object_mut()
        .unwrap()
        .remove("languageServers");
    connection
        .execute(
            "INSERT INTO config_authority VALUES (1, 7, 7, 9, ?1)",
            [serde_json::to_string(&legacy_document).unwrap()],
        )
        .unwrap();
    drop(connection);

    let store = ConfigStore::open(&path).unwrap();
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(snapshot.revision, ConfigRevision::new(7));
    assert_eq!(snapshot.generation, ConfigGeneration::new(9));
    assert!(
        snapshot
            .values
            .providers
            .contains_key(&provider_id("openai"))
    );
    assert!(store.config_path().exists());
    let old_table: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'config_authority'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_table, 0);
    drop(store);
    remove_config_files(&path);
}

#[test]
fn additive_document_schema_upgrade_keeps_revision_and_generation() {
    let path = config_path("document-schema-upgrade");
    let config_path = path.with_extension("toml");
    std::fs::write(
        &config_path,
        toml::to_string_pretty(&UserConfigDocument::default()).unwrap(),
    )
    .unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE ash_schema_migrations (
                 component TEXT PRIMARY KEY,
                 version INTEGER NOT NULL
             );
             INSERT INTO ash_schema_migrations (component, version) VALUES ('config', 2);
             CREATE TABLE config_metadata (
                 authority_id INTEGER PRIMARY KEY,
                 document_schema_version INTEGER NOT NULL,
                 revision INTEGER NOT NULL,
                 generation INTEGER NOT NULL,
                 content_digest TEXT NOT NULL
             );
             INSERT INTO config_metadata VALUES (1, 7, 7, 9, 'legacy-digest');
             CREATE TABLE config_command_receipts (
                 command_id TEXT PRIMARY KEY,
                 expected_revision INTEGER NOT NULL,
                 command_json TEXT NOT NULL,
                 result_revision INTEGER NOT NULL,
                 result_generation INTEGER NOT NULL
             );",
        )
        .unwrap();
    drop(connection);

    let store = ConfigStore::open(&path).unwrap();
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(snapshot.revision, ConfigRevision::new(7));
    assert_eq!(snapshot.generation, ConfigGeneration::new(9));
    let document_schema_version: u32 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT document_schema_version FROM config_metadata WHERE authority_id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(document_schema_version, 10);
    drop(store);
    remove_config_files(&path);
}

#[test]
fn preference_patches_preserve_missing_fields_and_clear_null_fields() {
    let path = config_path("patch-semantics");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let first = store
        .apply(update_preferences(
            "initial",
            configured.revision.get(),
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap();
    store
        .apply(update_preferences(
            "clear-model",
            first.revision.get(),
            Patch::Null,
        ))
        .unwrap();

    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(snapshot.values.model, None);
    remove_config_files(&path);
}

#[test]
fn dir_permissions_commands_persist_user_owned_decisions() {
    let path = config_path("dir-permissions");
    let store = ConfigStore::open(&path).unwrap();
    let dir = dir_permissions_id();
    let display_path = std::path::PathBuf::from("/tmp/ash-dir-permissions");
    let permissions = Permissions::new([Permission::ReadFiles, Permission::SearchFiles]);
    let configured = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("set-dir-permissions").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetDirPermissions {
                dir: dir.clone(),
                permissions: permissions.clone(),
                display_path: Some(display_path.clone()),
            },
        })
        .unwrap();

    assert_eq!(
        store
            .read_snapshot()
            .unwrap()
            .values
            .dir_permissions
            .explicit_permissions_for(&dir),
        Some(&permissions)
    );
    assert_eq!(
        store
            .read_snapshot()
            .unwrap()
            .values
            .dir_permissions
            .path_for(&dir),
        Some(display_path.as_path())
    );
    assert!(persisted_config_document(&path).contains("[dirPermissions.entries]"));

    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("forget-dir-permissions").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::ForgetDirPermissions { dir: dir.clone() },
        })
        .unwrap();
    assert_eq!(
        store
            .read_snapshot()
            .unwrap()
            .values
            .dir_permissions
            .explicit_permissions_for(&dir),
        None
    );
    assert_eq!(
        store
            .read_snapshot()
            .unwrap()
            .values
            .dir_permissions
            .path_for(&dir),
        None
    );
    remove_config_files(&path);
}

#[test]
fn selected_model_must_reference_a_configured_provider() {
    let path = config_path("selected-provider");
    let store = ConfigStore::open(&path).unwrap();
    let error = store
        .apply(update_preferences(
            "select-missing-provider",
            0,
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap_err();

    assert!(matches!(error, ConfigCommandError::Config(_)));
    assert_eq!(
        store.read_snapshot().unwrap().revision,
        ConfigRevision::INITIAL
    );
    remove_config_files(&path);
}

#[test]
fn approval_review_model_is_explicit_and_keeps_its_provider_configured() {
    let path = config_path("approval-review-model");
    let store = ConfigStore::open(&path).unwrap();
    assert_eq!(
        store.read_snapshot().unwrap().values.approval_review_model,
        ApprovalReviewModelSelection::Automatic
    );

    let missing_provider = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-missing-review-provider").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                model: Patch::Missing,
                model_reasoning_effort: Patch::Missing,
                commit_message_model: Patch::Missing,
                tool_mode: Patch::Missing,
                grep_backend: Patch::Missing,
                gui: Patch::Missing,
                tui: Patch::Missing,
                approval_review_model: Patch::Value(ApprovalReviewModelSelection::Explicit {
                    model: model_ref("openai", "codex-auto-review"),
                }),
            }),
        })
        .unwrap_err();
    assert!(matches!(missing_provider, ConfigCommandError::Config(_)));

    let configured = configure_provider(&store, 0, "openai");
    let selected = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-review-model").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                model: Patch::Missing,
                model_reasoning_effort: Patch::Missing,
                commit_message_model: Patch::Missing,
                tool_mode: Patch::Missing,
                grep_backend: Patch::Missing,
                gui: Patch::Missing,
                tui: Patch::Missing,
                approval_review_model: Patch::Value(ApprovalReviewModelSelection::Explicit {
                    model: model_ref("openai", "codex-auto-review"),
                }),
            }),
        })
        .unwrap();
    assert_eq!(
        store.read_snapshot().unwrap().values.approval_review_model,
        ApprovalReviewModelSelection::Explicit {
            model: model_ref("openai", "codex-auto-review")
        }
    );

    let remove_error = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("remove-review-provider").unwrap(),
            expected_revision: selected.revision,
            command: UserConfigCommand::RemoveProvider {
                provider: provider_id("openai"),
            },
        })
        .unwrap_err();
    assert!(matches!(remove_error, ConfigCommandError::Config(_)));
    remove_config_files(&path);
}

#[test]
fn automatic_approval_review_follows_the_selected_model_provider() {
    let resolved = ResolvedConfig {
        model: Some(model_ref("anthropic", "claude-main")),
        providers: BTreeMap::from([(
            provider_id("anthropic"),
            ModelProviderConfig::new(provider_id("anthropic")),
        )]),
        ..ResolvedConfig::default()
    };

    assert_eq!(
        resolved
            .selected_approval_review_provider()
            .map(|provider| provider.provider.clone()),
        Some(provider_id("anthropic"))
    );
    assert_eq!(
        resolved
            .resolve_approval_review_model(&ProviderConfigRegistry::builtin())
            .unwrap(),
        model_ref("anthropic", "claude-sonnet-4-20250514")
    );
}

#[test]
fn provider_entries_validate_their_key_and_static_settings() {
    let path = config_path("provider-validation");
    let store = ConfigStore::open(&path).unwrap();
    let error = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("bad-provider").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: provider_id("openai"),
                config: ModelProviderConfig {
                    custom: None,
                    provider: provider_id("anthropic"),
                    base_url: Some("file:///tmp/provider".into()),
                    max_output_tokens: Some(0),
                    model_context: BTreeMap::new(),
                },
            },
        })
        .unwrap_err();

    assert!(matches!(error, ConfigCommandError::Config(_)));
    assert_eq!(
        store.read_snapshot().unwrap().revision,
        ConfigRevision::INITIAL
    );
    remove_config_files(&path);
}

#[test]
fn command_replay_returns_its_original_revision_without_copying_a_snapshot() {
    let path = config_path("command-replay");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let first = update_preferences(
        "first",
        configured.revision.get(),
        Patch::Value(model_ref("openai", "model-a")),
    );
    let first_result = store.apply(first.clone()).unwrap();
    let second = store
        .apply(update_preferences(
            "second",
            first_result.revision.get(),
            Patch::Value(model_ref("openai", "model-b")),
        ))
        .unwrap();

    let replayed = ConfigStore::open(&path).unwrap().apply(first).unwrap();
    assert_eq!(first_result.disposition, ConfigCommandDisposition::Updated);
    assert_eq!(replayed.disposition, ConfigCommandDisposition::Replayed);
    assert_eq!(replayed.revision, first_result.revision);
    assert_eq!(second.revision, ConfigRevision::new(3));
    assert_eq!(
        store.read_snapshot().unwrap().values.model,
        Some(model_ref("openai", "model-b"))
    );

    let receipt_count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM config_command_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(receipt_count, 3);
    remove_config_files(&path);
}

#[test]
fn no_op_command_keeps_the_resolved_snapshot_generation() {
    let path = config_path("no-op-generation");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let first = store
        .apply(update_preferences(
            "set-model",
            configured.revision.get(),
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap();
    let no_op = store
        .apply(update_preferences(
            "set-model-again",
            first.revision.get(),
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap();

    assert_eq!(no_op.disposition, ConfigCommandDisposition::Updated);
    assert_eq!(no_op.revision, first.revision);
    assert_eq!(no_op.generation, first.generation);
    assert_eq!(store.read_snapshot().unwrap().generation, first.generation);
    remove_config_files(&path);
}

#[test]
fn committed_changes_publish_after_the_sqlite_snapshot_advances() {
    let path = config_path("change-subscription");
    let store = ConfigStore::open(&path).unwrap();
    let changes = store.subscribe_changes();
    let configured = configure_provider(&store, 0, "openai");
    let _ = changes.recv_timeout(std::time::Duration::from_secs(1));
    let changed = store
        .apply(update_preferences(
            "set-model-and-notify",
            configured.revision.get(),
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap();
    let notification = changes
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();

    assert_eq!(notification.revision, changed.revision);
    assert_eq!(notification.generation, changed.generation);
    assert_eq!(
        store.read_snapshot().unwrap().values.model,
        Some(model_ref("openai", "model"))
    );
    remove_config_files(&path);
}

#[test]
fn changes_committed_by_another_connection_publish_to_local_subscribers() {
    let path = config_path("cross-connection-subscription");
    let observing_store = ConfigStore::open(&path).unwrap();
    let writing_store = ConfigStore::open(&path).unwrap();
    let changes = observing_store.subscribe_changes();

    let changed = configure_provider(&writing_store, 0, "openai");
    let notification = changes
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();

    assert_eq!(notification.revision, changed.revision);
    assert_eq!(notification.generation, changed.generation);
    assert_eq!(
        observing_store
            .read_snapshot()
            .unwrap()
            .values
            .providers
            .len(),
        1
    );
    drop(writing_store);
    drop(observing_store);
    remove_config_files(&path);
}

#[test]
fn valid_external_toml_edits_advance_revision_and_publish() {
    let path = config_path("external-toml-edit");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let changes = store.subscribe_changes();
    let config_path = store.config_path().to_path_buf();
    let mut document =
        crate::document_migration::decode(&std::fs::read_to_string(&config_path).unwrap())
            .unwrap()
            .document;
    document.agent.model = Some(model_ref("openai", "external-model"));
    std::fs::write(
        &config_path,
        crate::document_migration::encode(&document).unwrap(),
    )
    .unwrap();

    let change = changes
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert_eq!(change.revision, configured.revision.next());
    assert_eq!(
        store.read_snapshot().unwrap().values.model,
        Some(model_ref("openai", "external-model"))
    );
    drop(store);
    remove_config_files(&path);
}

#[test]
fn invalid_external_toml_does_not_replace_the_last_valid_metadata() {
    let path = config_path("invalid-external-toml");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    std::fs::write(store.config_path(), "unknown = true").unwrap();

    assert!(store.read_snapshot().is_err());
    let metadata_revision: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT revision FROM config_metadata WHERE authority_id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(metadata_revision as u64, configured.revision.get());
    drop(store);
    remove_config_files(&path);
}

#[test]
fn concurrent_open_installs_one_config_schema() {
    let path = config_path("concurrent-open");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let threads = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let store = ConfigStore::open(path).unwrap();
                store.read_snapshot().unwrap().revision
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();

    for thread in threads {
        assert_eq!(thread.join().unwrap(), ConfigRevision::INITIAL);
    }
    remove_config_files(&path);
}

#[test]
fn command_rejects_stale_revisions_and_conflicting_retries() {
    let path = config_path("revision-conflict");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let first = update_preferences(
        "first",
        configured.revision.get(),
        Patch::Value(model_ref("openai", "model-a")),
    );
    store.apply(first.clone()).unwrap();

    assert_eq!(
        store
            .apply(update_preferences(
                "stale",
                configured.revision.get(),
                Patch::Value(model_ref("openai", "model-b")),
            ))
            .unwrap_err(),
        ConfigCommandError::RevisionConflict {
            expected: ConfigRevision::new(1),
            actual: ConfigRevision::new(2),
        }
    );
    assert_eq!(
        store
            .apply(update_preferences(
                "first",
                2,
                Patch::Value(model_ref("openai", "model-b")),
            ))
            .unwrap_err(),
        ConfigCommandError::CommandConflict
    );
    remove_config_files(&path);
}

#[test]
fn a_model_provider_cannot_be_removed_until_the_model_is_cleared() {
    let path = config_path("remove-provider");
    let store = ConfigStore::open(&path).unwrap();
    let configured = configure_provider(&store, 0, "openai");
    let selected = store
        .apply(update_preferences(
            "select",
            configured.revision.get(),
            Patch::Value(model_ref("openai", "model")),
        ))
        .unwrap();
    assert!(matches!(
        store.apply(ConfigCommandRequest {
            command_id: CommandId::new("remove-in-use").unwrap(),
            expected_revision: selected.revision,
            command: UserConfigCommand::RemoveProvider {
                provider: provider_id("openai"),
            },
        }),
        Err(ConfigCommandError::Config(_))
    ));
    let cleared = store
        .apply(update_preferences(
            "clear-model",
            selected.revision.get(),
            Patch::Null,
        ))
        .unwrap();
    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("remove-after-clear").unwrap(),
            expected_revision: cleared.revision,
            command: UserConfigCommand::RemoveProvider {
                provider: provider_id("openai"),
            },
        })
        .unwrap();
    assert!(store.read_snapshot().unwrap().values.providers.is_empty());
    remove_config_files(&path);
}

#[test]
fn mcp_and_skill_declarations_are_durable_desired_config() {
    let path = config_path("mcp-and-skills");
    let store = ConfigStore::open(&path).unwrap();
    let mcp = mcp_server();
    let added_mcp = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("add-mcp").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpsertMcpServer {
                server: mcp.clone(),
            },
        })
        .unwrap();
    let source = skill_source();
    let added_source = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("add-skill-source").unwrap(),
            expected_revision: added_mcp.revision,
            command: UserConfigCommand::AddSkillSource {
                source: source.clone(),
            },
        })
        .unwrap();
    let enabled = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-mcp").unwrap(),
            expected_revision: added_source.revision,
            command: UserConfigCommand::SetMcpServerEnablement {
                server_id: mcp.id.clone(),
                enablement: McpServerEnablement::Enabled,
            },
        })
        .unwrap();

    let snapshot = ConfigStore::open(&path).unwrap().read_snapshot().unwrap();
    assert_eq!(snapshot.revision, enabled.revision);
    assert_eq!(
        snapshot.values.mcp.servers[&mcp.id].enablement,
        McpServerEnablement::Enabled
    );
    assert_eq!(
        snapshot.values.skills.sources[&source.id].root_reference,
        "user:skill-root:personal"
    );
    let persisted = persisted_config_document(&path);
    assert!(persisted.contains("credentialRef"));
    assert!(!persisted.contains("secretValue"));
    remove_config_files(&path);
}

#[test]
fn plugin_and_hook_declarations_are_durable_desired_config() {
    let path = config_path("plugin-and-hooks");
    let store = ConfigStore::open(&path).unwrap();
    let plugin = plugin_request();
    let added_plugin = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("request-plugin").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpsertPluginRequest {
                request: plugin.clone(),
            },
        })
        .unwrap();
    let hook = hook("user:hook:review");
    let added_hook = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("add-hook").unwrap(),
            expected_revision: added_plugin.revision,
            command: UserConfigCommand::UpsertHook { hook: hook.clone() },
        })
        .unwrap();
    let enabled_plugin = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-plugin-request").unwrap(),
            expected_revision: added_hook.revision,
            command: UserConfigCommand::SetPluginRequestEnablement {
                plugin_id: plugin.plugin_id.clone(),
                enablement: PluginRequestEnablement::Enabled,
            },
        })
        .unwrap();
    let enabled_hook = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-hook").unwrap(),
            expected_revision: enabled_plugin.revision,
            command: UserConfigCommand::SetHookEnablement {
                hook_id: hook.id.clone(),
                enablement: HookEnablement::Enabled,
            },
        })
        .unwrap();

    let snapshot = ConfigStore::open(&path).unwrap().read_snapshot().unwrap();
    assert_eq!(snapshot.revision, enabled_hook.revision);
    assert_eq!(
        snapshot.values.plugins.requests[&plugin.plugin_id].enablement,
        PluginRequestEnablement::Enabled
    );
    assert_eq!(
        snapshot.values.hooks.hooks[&hook.id].enablement,
        HookEnablement::Enabled
    );
    let persisted = persisted_config_document(&path);
    assert!(persisted.contains("[plugins.requests"));
    assert!(persisted.contains("[hooks.hooks"));
    drop(store);
    remove_config_files(&path);
}

#[test]
fn plugin_and_hook_commands_reject_missing_targets_and_unsafe_shapes() {
    assert!(PluginVersion::new("latest").is_err());
    assert!(HookId::new("review").is_err());

    let path = config_path("plugin-hook-validation");
    let store = ConfigStore::open(&path).unwrap();
    let missing_plugin = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-missing-plugin").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetPluginRequestEnablement {
                plugin_id: PluginPackageId::new("acme/review").unwrap(),
                enablement: PluginRequestEnablement::Enabled,
            },
        })
        .unwrap_err();
    assert!(matches!(missing_plugin, ConfigCommandError::Config(_)));

    let invalid_hook = HookConfig {
        id: HookId::new("user:hook:complete").unwrap(),
        event: HookEvent::TurnCompleted,
        matcher: HookMatcher {
            tool_names: BTreeSet::from(["shell_command".into()]),
        },
        action: HookAction::Process {
            program: "notify".into(),
            args: Vec::new(),
        },
        enablement: HookEnablement::Enabled,
    };
    let error = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("invalid-hook").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpsertHook { hook: invalid_hook },
        })
        .unwrap_err();
    assert!(matches!(error, ConfigCommandError::Config(_)));
    drop(store);
    remove_config_files(&path);
}

#[test]
fn per_skill_enablement_is_durable_and_enabled_removes_the_override() {
    let path = config_path("skill-enablement");
    let store = ConfigStore::open(&path).unwrap();
    let skill_id = built_in_skill();
    let disabled = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("disable-built-in-skill").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetSkillEnablement {
                skill_id: skill_id.clone(),
                enablement: SkillEnablement::Disabled,
            },
        })
        .unwrap();

    let reopened = ConfigStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .read_snapshot()
            .unwrap()
            .values
            .skills
            .skill_enablement(&skill_id),
        SkillEnablement::Disabled
    );
    reopened
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-built-in-skill").unwrap(),
            expected_revision: disabled.revision,
            command: UserConfigCommand::SetSkillEnablement {
                skill_id: skill_id.clone(),
                enablement: SkillEnablement::Enabled,
            },
        })
        .unwrap();

    let skills = ConfigStore::open(&path)
        .unwrap()
        .read_snapshot()
        .unwrap()
        .values
        .skills;
    assert_eq!(skills.skill_enablement(&skill_id), SkillEnablement::Enabled);
    assert!(skills.enablement.is_empty());
    remove_config_files(&path);
}

#[test]
fn mcp_and_skill_declarations_reject_invalid_identity_or_missing_target() {
    assert!(McpServerId::new("github").is_err());
    assert!(SkillSourceId::new("personal").is_err());

    let path = config_path("mcp-and-skills-validation");
    let store = ConfigStore::open(&path).unwrap();
    let error = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-missing-mcp").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetMcpServerEnablement {
                server_id: McpServerId::new("user:mcp:missing").unwrap(),
                enablement: McpServerEnablement::Enabled,
            },
        })
        .unwrap_err();

    assert!(matches!(error, ConfigCommandError::Config(_)));
    assert_eq!(
        store.read_snapshot().unwrap().revision,
        ConfigRevision::INITIAL
    );
    remove_config_files(&path);
}

#[test]
fn dir_document_is_namespaced_and_cannot_bind_credentials() {
    let path = dir_config_path("declared-intent");
    std::fs::write(
        &path,
        toml::to_string_pretty(&dir_document(Some(model_ref("openai", "gpt-5.6")))).unwrap(),
    )
    .unwrap();

    let scope = dir_scope();
    let document = DirConfigStore::open(&path, scope).read_document().unwrap();
    assert_eq!(document.mcp.servers.len(), 1);
    assert_eq!(document.skills.sources.len(), 1);
    assert_eq!(document.plugin_requests.requests.len(), 1);
    assert_eq!(document.hooks.hooks.len(), 1);
    assert_eq!(
        document
            .plugin_requests
            .requests
            .values()
            .next()
            .unwrap()
            .version
            .to_string(),
        "1.2.3"
    );
    remove_config_files(&path);
}

#[test]
fn dir_document_rejects_foreign_namespace_and_unknown_fields() {
    let path = dir_config_path("invalid");
    let scope = dir_scope();
    std::fs::write(
        &path,
        r#"
[mcp.servers."dir:other:mcp:github"]
id = "dir:other:mcp:github"
displayName = "Other GitHub"
enablement = "disabled"

[mcp.servers."dir:other:mcp:github".transport]
type = "stdio"
command = "github-mcp"
args = []
"#,
    )
    .unwrap();
    assert!(
        DirConfigStore::open(&path, scope.clone())
            .read_document()
            .is_err()
    );

    std::fs::write(&path, "unknown = true").unwrap();
    assert!(
        DirConfigStore::open(&path, scope.clone())
            .read_document()
            .is_err()
    );

    std::fs::write(
        &path,
        format!(
            "[workspaceTrust.roots]\n\"{}\" = \"trusted\"\n",
            dir_permissions_id()
        ),
    )
    .unwrap();
    assert!(
        DirConfigStore::open(&path, scope.clone())
            .read_document()
            .is_err()
    );

    std::fs::write(
        &path,
        r#"
[hooks.hooks."dir:other:hook:review"]
id = "dir:other:hook:review"
event = "beforeTool"
enablement = "disabled"

[hooks.hooks."dir:other:hook:review".matcher]
toolNames = []

[hooks.hooks."dir:other:hook:review".action]
type = "process"
program = "review-hook"
args = []
shell = true
"#,
    )
    .unwrap();
    assert!(DirConfigStore::open(&path, scope).read_document().is_err());
    remove_config_files(&path);
}

#[test]
fn dir_document_requires_current_model_names_without_rewriting_the_file() {
    let path = dir_config_path("model-names");
    let scope = dir_scope();
    let source = "[agent]\npreferredReasoningEffort = 'high'\n";
    std::fs::write(&path, source).unwrap();

    assert!(DirConfigStore::open(&path, scope).read_document().is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn dir_resolution_overrides_only_a_user_configured_model_provider() {
    let path = config_path("dir-resolution");
    let store = ConfigStore::open(&path).unwrap();
    configure_provider(&store, 0, "openai");
    let user = store.read_snapshot().unwrap();
    let scope = dir_scope();
    let document = dir_document(Some(model_ref("openai", "gpt-6-astra")));

    let resolved = resolve_scoped_config(
        &user,
        Some(DirConfigInput::new(
            &scope,
            DirConfigRevision::new(7),
            &document,
        )),
    )
    .unwrap();

    assert_eq!(resolved.user_revision, user.revision);
    assert_eq!(resolved.dir_revision, Some(DirConfigRevision::new(7)));
    assert_eq!(
        resolved.values.model,
        Some(model_ref("openai", "gpt-6-astra"))
    );
    assert_eq!(
        resolved.provenance.model,
        Some(ConfigValueSource::Dir(dir_permissions_id()))
    );
    assert_eq!(
        resolved
            .values
            .dir_config
            .as_ref()
            .unwrap()
            .plugin_requests
            .requests
            .len(),
        1
    );
    assert!(resolved.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == ConfigDiagnosticCode::DirMcpCapabilityRequired
            && diagnostic.subject.ends_with(":mcp:github")
    }));
    assert!(resolved.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == ConfigDiagnosticCode::DirPluginCapabilityRequired
            && diagnostic.subject == "acme/code-review"
    }));
    assert!(resolved.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == ConfigDiagnosticCode::DirHookCapabilityRequired
            && diagnostic.subject.ends_with(":hook:review")
    }));
    assert!(resolved.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == ConfigDiagnosticCode::DirSkillCapabilityRequired
            && diagnostic.subject.ends_with(":skill-source:review")
    }));
    remove_config_files(&path);
}

#[test]
fn dir_resolution_keeps_user_model_when_the_dir_provider_is_unconfigured() {
    let path = config_path("dir-model-rejected");
    let store = ConfigStore::open(&path).unwrap();
    let user = store.read_snapshot().unwrap();
    let scope = dir_scope();
    let document = dir_document(Some(model_ref("anthropic", "claude")));

    let resolved = resolve_scoped_config(
        &user,
        Some(DirConfigInput::new(
            &scope,
            DirConfigRevision::INITIAL,
            &document,
        )),
    )
    .unwrap();

    assert_eq!(resolved.values.model, None);
    assert!(resolved.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == ConfigDiagnosticCode::DirModelProviderUnconfigured
            && diagnostic.subject == "anthropic"
    }));
    remove_config_files(&path);
}

#[test]
fn language_server_preferences_are_typed_persisted_and_revision_safe() {
    let path = config_path("language-server-preference");
    let executable = std::env::temp_dir().join("rust-analyzer");
    let store = ConfigStore::open(&path).unwrap();
    let server_id = LanguageServerId::new("rust-analyzer").unwrap();

    let result = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-rust-analyzer").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureLanguageServer {
                server_id: server_id.clone(),
                config: LanguageServerConfig {
                    mode: LanguageServerModeConfig::Enabled,
                    executable: Some(executable.clone()),
                },
            },
        })
        .unwrap();

    assert_eq!(result.revision, ConfigRevision::new(1));
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(
        snapshot.values.language_servers.servers.get(&server_id),
        Some(&LanguageServerConfig {
            mode: LanguageServerModeConfig::Enabled,
            executable: Some(executable),
        })
    );
    assert!(persisted_config_document(&path).contains("rust-analyzer"));

    let invalid = store.apply(ConfigCommandRequest {
        command_id: CommandId::new("configure-relative-rust-analyzer").unwrap(),
        expected_revision: ConfigRevision::new(1),
        command: UserConfigCommand::ConfigureLanguageServer {
            server_id,
            config: LanguageServerConfig {
                mode: LanguageServerModeConfig::Enabled,
                executable: Some("relative/rust-analyzer".into()),
            },
        },
    });
    assert!(matches!(invalid, Err(ConfigCommandError::Config(_))));
    remove_config_files(&path);
}

#[test]
fn language_server_mode_accepts_only_enabled_or_disabled() {
    assert_eq!(
        LanguageServerConfig::default().mode,
        LanguageServerModeConfig::Enabled
    );
    assert!(
        serde_json::from_value::<LanguageServerModeConfig>(serde_json::json!("automatic")).is_err()
    );
}

#[test]
fn issue_refresh_settings_validate_persist_and_reject_stale_writes() {
    let path = config_path("issue-refresh");
    let store = ConfigStore::open(&path).unwrap();
    for minutes in [1, 6, 120, u32::MAX] {
        let mut config = IssueConfig::default();
        config.auto_refresh_minutes = minutes;
        assert!(
            store
                .apply(ConfigCommandRequest {
                    command_id: CommandId::new(format!("bad-{minutes}")).unwrap(),
                    expected_revision: ConfigRevision::INITIAL,
                    command: UserConfigCommand::ConfigureIssues { config }
                })
                .is_err()
        );
    }
    for (index, minutes) in [0, 5, 10, 30, 60].into_iter().enumerate() {
        let revision = store.read_snapshot().unwrap().revision;
        let mut config = IssueConfig::default();
        config.auto_refresh_minutes = minutes;
        store
            .apply(ConfigCommandRequest {
                command_id: CommandId::new(format!("refresh-{index}")).unwrap(),
                expected_revision: revision,
                command: UserConfigCommand::ConfigureIssues {
                    config: config.clone(),
                },
            })
            .unwrap();
        assert_eq!(
            ConfigStore::open(&path)
                .unwrap()
                .read_snapshot()
                .unwrap()
                .values
                .issues,
            config
        );
        assert!(
            store
                .apply(ConfigCommandRequest {
                    command_id: CommandId::new(format!("stale-{index}")).unwrap(),
                    expected_revision: revision,
                    command: UserConfigCommand::ConfigureIssues {
                        config: IssueConfig::default()
                    }
                })
                .is_err()
        );
    }
    assert!(persisted_config_document(&path).contains("autoRefreshMinutes = 60"));
    drop(store);
    remove_config_files(&path);
}

#[test]
fn time_context_policy_validates_persists_and_resets_without_changing_model_preferences() {
    let path = config_path("time-context");
    let store = ConfigStore::open(&path).unwrap();
    assert_eq!(
        store.read_snapshot().unwrap().values.time_context,
        TimeContextConfig::default()
    );
    let policy = TimeContextConfig {
        mode: ash_protocol::TimeContextMode::Time,
        time_zone: Some("Asia/Tokyo".into()),
    };
    let update = |value| {
        UserConfigCommand::UpdatePreferences(PreferencesUpdate {
            time_context: value,
            ..PreferencesUpdate::default()
        })
    };
    let saved = store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("time-save").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: update(Patch::Value(policy.clone())),
        })
        .unwrap();
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(snapshot.values.time_context, policy);
    let invalid = TimeContextConfig {
        mode: ash_protocol::TimeContextMode::Date,
        time_zone: Some("Mars/Base".into()),
    };
    assert!(
        store
            .apply(ConfigCommandRequest {
                command_id: CommandId::new("invalid-time").unwrap(),
                expected_revision: saved.revision,
                command: update(Patch::Value(invalid))
            })
            .is_err()
    );
    assert_eq!(store.read_snapshot().unwrap().revision, saved.revision);
    drop(store);
    let store = ConfigStore::open(&path).unwrap();
    assert_eq!(store.read_snapshot().unwrap().values.time_context, policy);
    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("time-reset").unwrap(),
            expected_revision: saved.revision,
            command: update(Patch::Null),
        })
        .unwrap();
    assert_eq!(
        store.read_snapshot().unwrap().values.time_context,
        TimeContextConfig::default()
    );
    assert_eq!(
        store.read_snapshot().unwrap().values.model,
        snapshot.values.model
    );
    drop(store);
    remove_config_files(&path);
}
