use crate::BuiltInSkillSource;
use crate::SkillCatalogReload;
use crate::SkillConfigSnapshotProvider;
use crate::SkillRuntime;
use crate::runtime::NoSkillRuntimeEvents;
use crate::watcher::event_affects_catalog;
use ash_config::SkillEnablement;
use ash_config::SkillsConfig;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::PromptFragmentRetention;
use ash_extension_api::SkillActivationContext;
use ash_extension_api::TurnInputContext;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use ash_tools::EnvId;
use ash_tools::ToolBinding;
use ash_tools::ToolBindingId;
use ash_tools::ToolExecutionContext;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolOperationId;
use ash_tools::ToolPayload;
use ash_tools::ToolRegistryGeneration;
use ash_tools::ToolRuntimeAuthority;
use ash_tools::ToolRuntimeKey;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(crate) struct TestConfig {
    skills: Mutex<SkillsConfig>,
}

impl TestConfig {
    pub(crate) fn new() -> Self {
        Self {
            skills: Mutex::new(SkillsConfig::default()),
        }
    }

    fn set_enablement(&self, skill_id: &SkillId, enablement: SkillEnablement) {
        self.skills
            .lock()
            .unwrap()
            .enablement
            .entry(skill_id.source.clone())
            .or_default()
            .insert(skill_id.name.clone(), enablement);
    }
}

impl SkillConfigSnapshotProvider for TestConfig {
    fn snapshot(&self) -> Result<SkillsConfig, String> {
        Ok(self.skills.lock().unwrap().clone())
    }
}

#[test]
fn catalog_refreshes_and_preserves_monotonic_runtime_generation() {
    let root = test_directory("built-in-refresh");
    write_skill(&root, "skill-creator", "Create skills");
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );

    let initial = runtime.list(SkillCatalogReload::Cached).unwrap();
    assert_eq!(initial.generation, 1);
    write_skill(&root, "skill-creator", "Create and improve skills");
    let refreshed = runtime.list(SkillCatalogReload::Refresh).unwrap();
    assert_eq!(refreshed.generation, 2);
    assert_eq!(
        refreshed.entries[0].catalog_entry.metadata().description(),
        "Create and improve skills"
    );
    assert_eq!(
        runtime
            .list(SkillCatalogReload::Refresh)
            .unwrap()
            .generation,
        2
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_built_in_root_is_visible_as_a_diagnostic() {
    let runtime = runtime(BuiltInSkillSource::Missing, Arc::new(TestConfig::new()));

    let snapshot = runtime.list(SkillCatalogReload::Cached).unwrap();

    assert!(snapshot.entries.is_empty());
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].source,
        "builtin:skill-source:ash-release"
    );
}

#[test]
fn enablement_overlay_changes_projection_without_changing_content() {
    let root = test_directory("enablement");
    write_skill(&root, "skill-creator", "Create skills");
    let config = Arc::new(TestConfig::new());
    let runtime = runtime(BuiltInSkillSource::Root(root.clone()), config.clone());
    let skill_id = built_in_skill_id("skill-creator");

    config.set_enablement(&skill_id, SkillEnablement::Disabled);
    let disabled = runtime.list(SkillCatalogReload::Cached).unwrap();

    assert_eq!(disabled.generation, 2);
    assert_eq!(disabled.entries[0].enablement, SkillEnablement::Disabled);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn extension_owns_explicit_activation_and_model_fragment_contribution() {
    let root = test_directory("extension-flow");
    write_skill(&root, "skill-creator", "Create skills");
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );
    let selected = SkillRef::follow_latest(built_in_skill_id("skill-creator"));
    let input = vec![
        UserInput::Skill {
            skill: selected.clone(),
        },
        UserInput::Text {
            text: "create one".into(),
        },
    ];
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime.clone());
    let registry = builder.build();

    let activations = registry
        .contribute_skill_activations(SkillActivationContext::new(&input))
        .unwrap();
    assert_eq!(activations.len(), 1);
    assert_eq!(activations[0].reason, SkillActivationReason::Explicit);
    let fragments = registry
        .contribute_turn_input(TurnInputContext::new(
            &ThreadId::new("thread").unwrap(),
            &TurnId::new("turn").unwrap(),
            &activations,
        ))
        .unwrap();
    assert_eq!(fragments.len(), 2);
    assert_eq!(
        fragments[0].retention(),
        PromptFragmentRetention::BestEffort
    );
    assert!(fragments[0].body().contains("<available-skills"));
    assert!(!fragments[0].body().contains("Instructions."));
    assert_eq!(fragments[1].retention(), PromptFragmentRetention::Required);
    assert!(fragments[1].body().contains("Instructions."));
    assert!(fragments[1].body().contains("<skill-instructions"));

    write_skill(&root, "skill-creator", "Changed description and body");
    assert!(
        registry
            .contribute_turn_input(TurnInputContext::new(
                &ThreadId::new("thread").unwrap(),
                &TurnId::new("turn").unwrap(),
                &activations,
            ))
            .is_err()
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn automatic_and_explicit_use_the_same_injection_path_with_distinct_retention() {
    let root = test_directory("activation-retention");
    write_skill(&root, "skill-creator", "Create skills");
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );
    let explicit = runtime
        .activate_explicit(&SkillRef::follow_latest(built_in_skill_id("skill-creator")))
        .unwrap();
    let mut automatic = explicit.activation().clone();
    automatic.reason = SkillActivationReason::Automatic;
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let registry = builder.build();

    let explicit_fragment = registry
        .contribute_turn_input(TurnInputContext::new(
            &ThreadId::new("thread").unwrap(),
            &TurnId::new("turn").unwrap(),
            std::slice::from_ref(explicit.activation()),
        ))
        .unwrap();
    let automatic_fragment = registry
        .contribute_turn_input(TurnInputContext::new(
            &ThreadId::new("thread").unwrap(),
            &TurnId::new("turn").unwrap(),
            &[automatic],
        ))
        .unwrap();

    assert_eq!(
        explicit_fragment[1].retention(),
        PromptFragmentRetention::Required
    );
    assert_eq!(
        automatic_fragment[1].retention(),
        PromptFragmentRetention::BestEffort
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn catalog_prompt_is_metadata_only_bounded_and_filters_disabled_skills() {
    let root = test_directory("catalog-prompt");
    write_skill(&root, "enabled", &"a".repeat(700));
    write_skill(&root, "disabled", "Do not expose this entry");
    for index in 0..40 {
        write_skill(&root, &format!("skill-{index:02}"), &"b".repeat(700));
    }
    let config = Arc::new(TestConfig::new());
    config.set_enablement(&built_in_skill_id("disabled"), SkillEnablement::Disabled);
    let runtime = runtime(BuiltInSkillSource::Root(root.clone()), config);
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let fragments = builder
        .build()
        .contribute_turn_input(TurnInputContext::new(
            &ThreadId::new("thread").unwrap(),
            &TurnId::new("turn").unwrap(),
            &[],
        ))
        .unwrap();

    assert_eq!(fragments.len(), 1);
    assert!(fragments[0].body().len() <= crate::catalog_prompt::MAX_SKILL_CATALOG_PROMPT_BYTES);
    assert!(fragments[0].body().contains("name=\"enabled\""));
    assert!(!fragments[0].body().contains("name=\"disabled\""));
    assert!(fragments[0].body().contains("<omitted count="));
    assert!(!fragments[0].body().contains("Instructions."));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn skills_read_tool_loads_exact_enabled_skill_body_for_the_model() {
    let root = test_directory("skills-read");
    write_skill(&root, "review", "Review code");
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let registry = builder.build();
    let executor = registry.contribute_read_only_tools().unwrap().remove(0);
    let definition = executor.definition();
    let protocol = ash_tools::to_protocol_tool_definition(&definition).unwrap();
    let target = &protocol.parameters["properties"]["target"];
    assert!(target.get("oneOf").is_none());
    let variants = target["anyOf"].as_array().unwrap();
    assert_eq!(variants.len(), 2);
    assert_eq!(
        variants[0]["properties"]["type"]["enum"],
        serde_json::json!(["instructions"])
    );
    assert_eq!(
        variants[1]["properties"]["type"]["enum"],
        serde_json::json!(["resource"])
    );
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(1),
        ToolBindingId::new("skills-read-binding").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("extension:skills-read").unwrap(),
    );
    let invocation = ash_tools::ToolInvocation::new(
        ToolOperationId::new("skills-read-operation").unwrap(),
        ash_protocol::ToolCallId::new("call").unwrap(),
        TurnId::new("turn").unwrap(),
        binding,
        ToolPayload::FunctionArguments(serde_json::json!({
            "source": "builtin:skill-source:ash-release",
            "name": "review",
            "target": {"type": "instructions"}
        })),
        ToolExecutionContext::new(
            EnvId::new("agent-extension").unwrap(),
            ash_async_utils::CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    );

    let outcome = pollster::block_on(executor.execute(invocation));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("skills-read did not return a model-visible output");
    };
    assert_eq!(output.status(), ash_tools::ToolOutputStatus::Success);
    let ash_tools::ToolContent::Text(text) = &output.content()[0] else {
        panic!("skills-read did not return text");
    };
    assert!(text.contains("Instructions."));
    assert!(text.contains("content_digest"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn skills_read_tool_rejects_disabled_or_unknown_catalog_identity() {
    let root = test_directory("skills-read-policy");
    write_skill(&root, "disabled", "Disabled Skill");
    let config = Arc::new(TestConfig::new());
    config.set_enablement(&built_in_skill_id("disabled"), SkillEnablement::Disabled);
    let runtime = runtime(BuiltInSkillSource::Root(root.clone()), config);
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let executor = builder
        .build()
        .contribute_read_only_tools()
        .unwrap()
        .remove(0);

    for name in ["disabled", "unknown"] {
        let outcome = execute_skill_read(executor.as_ref(), name);
        let ToolExecutionOutcome::Returned(output) = outcome else {
            panic!("skills-read did not return a bounded error");
        };
        assert_eq!(output.status(), ash_tools::ToolOutputStatus::Error);
        let ash_tools::ToolContent::Text(text) = &output.content()[0] else {
            panic!("skills-read error was not text");
        };
        assert!(!text.contains(root.to_string_lossy().as_ref()));
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn skills_read_tool_uses_pinned_identity_for_text_package_resources() {
    let root = test_directory("skills-read-resource");
    write_skill(&root, "review", "Review code");
    fs::create_dir_all(root.join("review/references/guides")).unwrap();
    fs::write(
        root.join("review/references/guides/checks.md"),
        "Check race conditions.\n",
    )
    .unwrap();
    let skill_body = fs::read(root.join("review/SKILL.md")).unwrap();
    let skill_digest = ash_protocol::ContentDigest::sha256(&skill_body);
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let executor = builder
        .build()
        .contribute_read_only_tools()
        .unwrap()
        .remove(0);
    let definition = executor.definition();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(1),
        ToolBindingId::new("skills-read-resource-binding").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("extension:skills-read-resource").unwrap(),
    );
    let invocation = ash_tools::ToolInvocation::new(
        ToolOperationId::new("skills-read-resource-operation").unwrap(),
        ash_protocol::ToolCallId::new("reference-call").unwrap(),
        TurnId::new("turn").unwrap(),
        binding,
        ToolPayload::FunctionArguments(serde_json::json!({
            "source": "builtin:skill-source:ash-release",
            "name": "review",
            "target": {
                "type": "resource",
                "skill_content_digest": skill_digest.as_str(),
                "path": "references/guides/checks.md"
            }
        })),
        ToolExecutionContext::new(
            EnvId::new("agent-extension").unwrap(),
            ash_async_utils::CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    );

    let outcome = pollster::block_on(executor.execute(invocation));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("skills-read resource did not return a model-visible output");
    };
    assert_eq!(output.status(), ash_tools::ToolOutputStatus::Success);
    let ash_tools::ToolContent::Text(text) = &output.content()[0] else {
        panic!("skills-read resource did not return text");
    };
    assert!(text.contains("Check race conditions."));
    assert!(text.contains("references/guides/checks.md"));
    assert!(text.contains("resource_content_digest"));
    assert!(!text.contains(root.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn skills_read_tool_rejects_binary_resources_without_exposing_bytes_as_text() {
    let root = test_directory("skills-read-binary-resource");
    write_skill(&root, "review", "Review code");
    fs::create_dir_all(root.join("review/assets")).unwrap();
    fs::write(root.join("review/assets/template.bin"), [0, 159, 146, 150]).unwrap();
    let skill_body = fs::read(root.join("review/SKILL.md")).unwrap();
    let skill_digest = ash_protocol::ContentDigest::sha256(&skill_body);
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let executor = builder
        .build()
        .contribute_read_only_tools()
        .unwrap()
        .remove(0);
    let definition = executor.definition();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(1),
        ToolBindingId::new("skills-read-binary-binding").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("extension:skills-read-binary").unwrap(),
    );
    let invocation = ash_tools::ToolInvocation::new(
        ToolOperationId::new("skills-read-binary-operation").unwrap(),
        ash_protocol::ToolCallId::new("binary-call").unwrap(),
        TurnId::new("turn").unwrap(),
        binding,
        ToolPayload::FunctionArguments(serde_json::json!({
            "source": "builtin:skill-source:ash-release",
            "name": "review",
            "target": {
                "type": "resource",
                "skill_content_digest": skill_digest.as_str(),
                "path": "assets/template.bin"
            }
        })),
        ToolExecutionContext::new(
            EnvId::new("agent-extension").unwrap(),
            ash_async_utils::CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    );

    let outcome = pollster::block_on(executor.execute(invocation));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("skills-read binary resource did not return a model-visible output");
    };
    assert_eq!(output.status(), ash_tools::ToolOutputStatus::Error);
    let ash_tools::ToolContent::Text(text) = &output.content()[0] else {
        panic!("skills-read binary resource error was not text");
    };
    assert!(text.contains("binary"));
    assert!(text.contains("assets/template.bin"));
    assert!(!text.contains(root.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn skills_read_tool_keeps_skill_md_on_the_instruction_target() {
    let root = test_directory("skills-read-instructions-target");
    write_skill(&root, "review", "Review code");
    let skill_body = fs::read(root.join("review/SKILL.md")).unwrap();
    let skill_digest = ash_protocol::ContentDigest::sha256(&skill_body);
    let runtime = runtime(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
    );
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let executor = builder
        .build()
        .contribute_read_only_tools()
        .unwrap()
        .remove(0);
    let definition = executor.definition();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(1),
        ToolBindingId::new("skills-read-instructions-target-binding").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("extension:skills-read-instructions-target").unwrap(),
    );
    let invocation = ash_tools::ToolInvocation::new(
        ToolOperationId::new("skills-read-instructions-target-operation").unwrap(),
        ash_protocol::ToolCallId::new("instructions-target-call").unwrap(),
        TurnId::new("turn").unwrap(),
        binding,
        ToolPayload::FunctionArguments(serde_json::json!({
            "source": "builtin:skill-source:ash-release",
            "name": "review",
            "target": {
                "type": "resource",
                "skill_content_digest": skill_digest.as_str(),
                "path": "SKILL.md"
            }
        })),
        ToolExecutionContext::new(
            EnvId::new("agent-extension").unwrap(),
            ash_async_utils::CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    );

    let outcome = pollster::block_on(executor.execute(invocation));

    let ToolExecutionOutcome::NotStarted(error) = outcome else {
        panic!("SKILL.md resource target should be rejected before execution");
    };
    assert!(error.message().contains("instructions target"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn dir_source_and_watcher_filter_are_runtime_owned() {
    let dir = test_directory("dir-source");
    let root = dir.join(".ash/skills");
    write_skill(&root, "dir-review", "Reviews Directory code");
    let runtime = runtime(BuiltInSkillSource::Omitted, Arc::new(TestConfig::new()));

    let snapshot = runtime.bind_dir_root(dir.clone()).unwrap();

    assert_eq!(snapshot.entries.len(), 1);
    assert!(!event_affects_catalog(
        &runtime,
        &ash_file_watcher::FileWatcherEvent::PathsChanged {
            paths: vec![dir.join(".ash/streams/thread/runtime.rollout")],
        },
    ));
    assert!(event_affects_catalog(
        &runtime,
        &ash_file_watcher::FileWatcherEvent::PathsChanged {
            paths: vec![dir.join(".ash/skills/dir-review/SKILL.md")],
        },
    ));
    let _ = fs::remove_dir_all(dir);
}

fn runtime(source: BuiltInSkillSource, config: Arc<TestConfig>) -> Arc<SkillRuntime> {
    SkillRuntime::new(source, config, Arc::new(NoSkillRuntimeEvents)).unwrap()
}

fn built_in_skill_id(name: &str) -> SkillId {
    SkillId::new(
        SkillSourceId::new("builtin:skill-source:ash-release").unwrap(),
        SkillName::new(name).unwrap(),
    )
}

pub(crate) fn test_directory(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "ash-skills-extension-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

pub(crate) fn write_skill(root: &Path, name: &str, description: &str) {
    let directory = root.join(name);
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\nInstructions.\n"),
    )
    .unwrap();
}

fn execute_skill_read(executor: &dyn ash_tools::ToolExecutor, name: &str) -> ToolExecutionOutcome {
    let definition = executor.definition();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(1),
        ToolBindingId::new("skills-read-policy-binding").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("extension:skills-read-policy").unwrap(),
    );
    let invocation = ash_tools::ToolInvocation::new(
        ToolOperationId::new(format!("skills-read-{name}")).unwrap(),
        ash_protocol::ToolCallId::new(format!("call-{name}")).unwrap(),
        TurnId::new("turn").unwrap(),
        binding,
        ToolPayload::FunctionArguments(serde_json::json!({
            "source": "builtin:skill-source:ash-release",
            "name": name,
            "target": {"type": "instructions"}
        })),
        ToolExecutionContext::new(
            EnvId::new("agent-extension").unwrap(),
            ash_async_utils::CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    );
    pollster::block_on(executor.execute(invocation))
}
