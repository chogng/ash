use super::*;
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
        instructions: GUIDANCE,
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
        instructions: GUIDANCE,
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
        instructions: PromptArtifact::new("models-manager", "model/invalid", "test-v1", " "),
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
    let models = ash_model_provider_config::STATIC_MODEL_CATALOG;
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
fn built_in_guidance_does_not_guess_aliases_or_apply_to_another_provider() {
    let catalog = ModelInstructionCatalog::built_in();
    for model in [
        model("openai", "gpt-6-astra-custom"),
        model("custom-openai", "gpt-6-astra"),
        model("anthropic", "claude-sonnet-4-latest"),
        model("minimax", "minimax-m3"),
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
fn shared_guidance_keeps_each_selected_model_identity_independent() {
    let catalog = ModelInstructionCatalog::built_in();
    let first = model("openai", "gpt-5.6-sol");
    let second = model("openai", "gpt-6-astra");
    let ModelInstructionSelection::Specialized {
        model: first_model,
        instructions: first_text,
        digest: first_digest,
    } = catalog.resolve(Some(&first))
    else {
        panic!("GPT guidance missing");
    };
    let ModelInstructionSelection::Specialized {
        model: second_model,
        instructions: second_text,
        digest: second_digest,
    } = catalog.resolve(Some(&second))
    else {
        panic!("GPT guidance missing");
    };
    assert_eq!((first_model, second_model), (first, second));
    assert_eq!(first_text, second_text);
    assert_eq!(first_digest, second_digest);
}
