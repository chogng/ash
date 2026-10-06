use super::*;
use ash_prompts::PromptArtifact;
use ash_protocol::ModelId;
use ash_protocol::ProviderId;
use std::collections::HashSet;

const GUIDANCE: PromptArtifact = PromptArtifact::new(
    "models-manager",
    "model/test-guidance",
    "test-v1",
    "Use concise tool arguments.\n",
);

fn model(provider: &str, name: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(name).unwrap(),
    )
}

#[test]
fn specialization_is_exact_and_does_not_cross_provider_or_model_identity() {
    let target = model("a", "model-v1");
    let catalog = ModelInstructionCatalog::new([ModelInstructionProfile {
        model: target.clone(),
        instructions: GUIDANCE.freeze().as_text(),
    }])
    .unwrap();
    let ModelInstructionSelection::Specialized {
        model: selected,
        instructions,
        digest,
    } = catalog.resolve(Some(&target))
    else {
        panic!("exact profile was not selected")
    };
    assert_eq!(selected, target);
    assert_eq!(instructions.body, GUIDANCE.body());
    assert_eq!(instructions.revision, "test-v1");
    assert_eq!(digest, ContentDigest::sha256(GUIDANCE.body().as_bytes()));
    for other in [model("b", "model-v1"), model("a", "model-v10")] {
        assert_eq!(
            catalog.resolve(Some(&other)),
            ModelInstructionSelection::Generic { model: Some(other) }
        );
    }
    assert_eq!(
        catalog.resolve(None),
        ModelInstructionSelection::Generic { model: None }
    );
}

#[test]
fn duplicate_model_profiles_fail_before_any_instruction_is_used() {
    let profile = ModelInstructionProfile {
        model: model("a", "model-v1"),
        instructions: GUIDANCE.freeze().as_text(),
    };
    assert!(
        ModelInstructionCatalog::new([profile.clone(), profile])
            .unwrap_err()
            .to_string()
            .contains("duplicate model instructions")
    );
}

#[test]
fn invalid_guidance_is_rejected_without_silently_selecting_generic() {
    let profile = ModelInstructionProfile {
        model: model("a", "model-v1"),
        instructions: InstructionText {
            owner: "models-manager".into(),
            id: "model/invalid".into(),
            revision: "test-v1".into(),
            body: " ".into(),
        },
    };
    assert!(matches!(
        ModelInstructionCatalog::new([profile]),
        Err(ModelInstructionError::InvalidProfile { .. })
    ));
}

#[test]
fn built_in_guidance_covers_the_static_catalog_with_valid_exact_registrations() {
    let catalog = ModelInstructionCatalog::built_in();
    assert!(Arc::ptr_eq(&catalog, &ModelInstructionCatalog::built_in()));
    let models = &*model_provider_info::STATIC_MODEL_CATALOG;
    assert_eq!(
        catalog.profiles.keys().cloned().collect::<HashSet<_>>(),
        models
            .iter()
            .map(|spec| spec.model_ref())
            .collect::<HashSet<_>>()
    );
    for spec in models {
        let model = spec.model_ref();
        let selected = catalog.resolve(Some(&model));
        let ModelInstructionSelection::Specialized {
            model: frozen_model,
            instructions,
            digest,
        } = &selected
        else {
            panic!("missing initial guidance for {model:?}");
        };
        assert_eq!(frozen_model, &model);
        assert_eq!(instructions.owner, "models-manager");
        assert_eq!(digest, &ContentDigest::sha256(instructions.body.as_bytes()));
        assert!(!instructions.body.contains("{{"));
        ash_prompts::AGENT_INSTRUCTIONS
            .freeze()
            .with_model_guidance(selected)
            .validate()
            .unwrap();
    }
}

#[test]
fn exact_json_entry_supplies_the_complete_base_prompt_with_automatic_revision() {
    let catalog = ModelInstructionCatalog::built_in();
    for spec in model_provider_info::STATIC_MODEL_CATALOG.iter() {
        let ModelInstructionSelection::Specialized { instructions, .. } =
            catalog.resolve(Some(&spec.model_ref()))
        else {
            panic!("missing prompt");
        };
        assert_eq!(
            instructions.id,
            format!("model/{}/{}", spec.provider_id, spec.model_id)
        );
        assert_eq!(
            instructions.revision,
            ContentDigest::sha256(spec.model_messages.system_instructions.as_bytes()).as_str()
        );
        assert_eq!(instructions.body, spec.model_messages.system_instructions);
    }
}

#[test]
fn editing_catalog_text_changes_new_turn_revision_without_rewriting_frozen_history() {
    let target = model("openai", "gpt-6-astra");
    let mut spec = model_provider_info::find_static_model(&target)
        .unwrap()
        .clone();
    let original = ModelInstructionCatalog::built_in()
        .for_turn(ash_prompts::AGENT_INSTRUCTIONS.freeze(), Some(&target));
    let saved = serde_json::to_string(&original).unwrap();

    spec.model_messages.system_instructions = "Updated instructions for this exact model.\n".into();
    let updated =
        ModelInstructionCatalog::new([ModelInstructionProfile::from_spec(&spec)]).unwrap();
    let restored: TurnInstructions = serde_json::from_str(&saved).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored, original);

    let next = updated.for_turn(restored.clone(), Some(&target));
    assert_eq!(next.id(), original.id());
    assert_eq!(next.body(), spec.model_messages.system_instructions);
    assert_ne!(next.revision(), restored.revision());
    assert_eq!(
        next.revision(),
        ContentDigest::sha256(next.body().as_bytes()).as_str()
    );
    assert_eq!(serde_json::to_string(&restored).unwrap(), saved);
}

#[test]
fn built_in_guidance_does_not_guess_aliases_or_apply_to_another_provider() {
    let catalog = ModelInstructionCatalog::built_in();
    for model in [
        model("openai", "gpt-6-astra-custom"),
        model("custom-openai", "gpt-6-astra"),
        model("anthropic", "claude-sonnet-4-latest"),
        model("plugin", "unknown-model"),
        model("zai", "glm-5.3"),
        model("anthropic", "claude-sonnet-4-20250514"),
    ] {
        assert_eq!(
            catalog.resolve(Some(&model)),
            ModelInstructionSelection::Generic { model: Some(model) }
        );
    }
    assert_eq!(
        catalog.resolve(None),
        ModelInstructionSelection::Generic { model: None }
    );
    let model = model("openai", "gpt-6-astra");
    assert_eq!(
        ModelInstructionCatalog::default().resolve(Some(&model)),
        ModelInstructionSelection::Generic { model: Some(model) }
    );
}

#[test]
fn each_model_has_its_own_instruction_identity_even_with_the_same_initial_body() {
    let catalog = ModelInstructionCatalog::new(["first", "second"].map(|name| {
        let mut instructions = GUIDANCE.freeze().as_text();
        instructions.id = format!("model/test/{name}");
        ModelInstructionProfile {
            model: model("test", name),
            instructions,
        }
    }))
    .unwrap();
    let first = model("test", "first");
    let second = model("test", "second");
    let ModelInstructionSelection::Specialized {
        model: first_model,
        instructions: first_text,
        digest: first_digest,
    } = catalog.resolve(Some(&first))
    else {
        panic!("first model instructions missing");
    };
    let ModelInstructionSelection::Specialized {
        model: second_model,
        instructions: second_text,
        digest: second_digest,
    } = catalog.resolve(Some(&second))
    else {
        panic!("second model instructions missing");
    };
    assert_eq!((first_model, second_model), (first, second));
    assert_ne!(first_text.id, second_text.id);
    assert_eq!(first_text.body, second_text.body);
    assert_eq!(first_digest, second_digest);
}

#[test]
fn turn_freezes_the_selected_base_and_preserves_tasks_modes_and_custom_bases() {
    let catalog = ModelInstructionCatalog::built_in();
    let first = model("openai", "gpt-6-astra");
    let second = model("anthropic", "claude-sonnet-5-5");
    let unknown = model("openai", "unregistered-model");
    let mode = ash_protocol::TurnInstructions::new("mode", "mode", "v1", "MODE").unwrap();
    let default = ash_prompts::AGENT_INSTRUCTIONS.freeze().with_mode(&mode);
    let frozen = catalog.for_turn(default.clone(), Some(&first));
    assert_eq!(frozen.id(), "model/openai/gpt-6-astra");
    assert_eq!(
        frozen.body(),
        model_provider_info::find_static_model(&first)
            .unwrap()
            .model_messages
            .system_instructions
    );
    assert_eq!(frozen.mode_instructions(), default.mode_instructions());
    assert_eq!(
        frozen.model_guidance(),
        Some(&catalog.resolve(Some(&first)))
    );
    let switched = catalog.for_turn(frozen.clone(), Some(&second));
    assert_eq!(switched.id(), "model/anthropic/claude-sonnet-5-5");
    assert_eq!(
        switched.body(),
        model_provider_info::find_static_model(&second)
            .unwrap()
            .model_messages
            .system_instructions
    );
    let generic = catalog.for_turn(switched, Some(&unknown));
    assert_eq!(generic.body(), ash_prompts::AGENT_INSTRUCTIONS.body());
    assert!(matches!(
        generic.model_guidance(),
        Some(ModelInstructionSelection::Generic { .. })
    ));
    let task = ash_protocol::TurnInstructions::new("host", "task", "v1", "TASK")
        .unwrap()
        .with_shared(&default);
    let task = catalog.for_turn(task, Some(&first));
    assert_eq!(task.body(), "TASK");
    assert_eq!(task.shared().len(), 1);
    assert_eq!(task.shared()[0], frozen.as_text());
    let custom = ash_protocol::TurnInstructions::new("host", "custom", "v1", "CUSTOM").unwrap();
    let custom = catalog.for_turn(custom, Some(&first));
    assert_eq!(custom.body(), "CUSTOM");
    assert!(matches!(
        custom.model_guidance(),
        Some(ModelInstructionSelection::Generic { .. })
    ));
}
