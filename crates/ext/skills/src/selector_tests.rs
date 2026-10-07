use std::sync::Arc;

use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::SkillActivationContext;
use ash_protocol::SkillActivationReason;
use ash_protocol::UserInput;

use super::super::runtime::NoSkillRuntimeEvents;
use super::super::tests::TestConfig;
use super::super::tests::test_directory;
use super::super::tests::write_skill;
use crate::BuiltInSkillSource;
use crate::SkillRuntime;

#[test]
fn selector_input_remains_within_its_byte_ceiling_across_text_items() {
    let text = "a".repeat(super::MAX_SELECTOR_INPUT_BYTES - 1);
    let normalized = super::selector_text(&[
        UserInput::Text { text },
        UserInput::Text {
            text: "second".into(),
        },
    ]);

    assert!(normalized.len() <= super::MAX_SELECTOR_INPUT_BYTES);
}

#[test]
fn unique_high_confidence_builtin_metadata_freezes_an_automatic_activation() {
    let root = test_directory("selector-builtin");
    write_skill(
        &root,
        "skill-creator",
        "Creates Agent Skills. Use to design, scaffold, validate, or revise reusable Skill workflows.",
    );
    let runtime = SkillRuntime::new(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
        Arc::new(NoSkillRuntimeEvents),
    )
    .unwrap();
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);
    let registry = builder.build();

    let activations = registry
        .contribute_skill_activations(SkillActivationContext::new(&[UserInput::Text {
            text: "Please design and scaffold a reusable Skill workflow".into(),
        }]))
        .unwrap();

    assert_eq!(activations.len(), 1);
    assert_eq!(activations[0].id.name.as_str(), "skill-creator");
    assert_eq!(activations[0].catalog_generation, 1);
    assert_eq!(activations[0].reason, SkillActivationReason::Automatic);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn tied_builtin_candidates_are_not_activated() {
    let root = test_directory("selector-ambiguous");
    write_skill(
        &root,
        "review-alpha",
        "Review and validate source code changes",
    );
    write_skill(
        &root,
        "review-beta",
        "Review and validate source code changes",
    );
    let runtime = SkillRuntime::new(
        BuiltInSkillSource::Root(root.clone()),
        Arc::new(TestConfig::new()),
        Arc::new(NoSkillRuntimeEvents),
    )
    .unwrap();
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);

    let activations = builder
        .build()
        .contribute_skill_activations(SkillActivationContext::new(&[UserInput::Text {
            text: "Review and validate these source code changes".into(),
        }]))
        .unwrap();

    assert!(activations.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn dir_skill_metadata_is_never_automatically_activated() {
    let dir = test_directory("selector-dir");
    write_skill(
        &dir.join(".ash/skills"),
        "deploy-service",
        "Deploy and publish the service to production",
    );
    let runtime = SkillRuntime::new(
        BuiltInSkillSource::Omitted,
        Arc::new(TestConfig::new()),
        Arc::new(NoSkillRuntimeEvents),
    )
    .unwrap();
    runtime.bind_dir_root(dir.clone()).unwrap();
    let mut builder = ExtensionRegistryBuilder::new();
    crate::install(&mut builder, runtime);

    let activations = builder
        .build()
        .contribute_skill_activations(SkillActivationContext::new(&[UserInput::Text {
            text: "Deploy and publish the service to production".into(),
        }]))
        .unwrap();

    assert!(activations.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}
