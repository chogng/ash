use super::*;

#[test]
fn frozen_model_messages_restore_all_assets_and_reject_changed_text() {
    let asset = |name: &str| InstructionText {
        owner: "models-manager".into(),
        id: name.into(),
        revision: crate::ContentDigest::sha256(name.as_bytes()).to_string(),
        body: name.into(),
    };
    let base = TurnInstructions::new("models-manager", "model/test", "v1", "BASE").unwrap();
    let selection = ModelInstructionSelection::Specialized {
        model: crate::ModelRef::new(
            crate::ProviderId::new("test").unwrap(),
            crate::ModelId::new("model").unwrap(),
        ),
        instructions: base.as_text(),
        digest: crate::ContentDigest::sha256(base.body().as_bytes()),
        messages: Some(ModelInstructionMessages {
            tools: [(crate::ToolName::new("spawn_agent").unwrap(), asset("TOOL"))].into(),
            collaboration_modes: [(crate::CollaborationMode::Plan, asset("PLAN"))].into(),
            root: Some(asset("ROOT")),
            subagent: Some(asset("WORKER")),
        }),
    };
    let original = base.with_model_guidance(selection);
    let encoded = serde_json::to_value(&original).unwrap();
    let restored: TurnInstructions = serde_json::from_value(encoded.clone()).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored, original);
    for path in [
        "/modelGuidance/messages/tools/spawn_agent/body",
        "/modelGuidance/messages/collaborationModes/plan/body",
        "/modelGuidance/messages/root/body",
        "/modelGuidance/messages/subagent/body",
    ] {
        let mut corrupted = encoded.clone();
        *corrupted.pointer_mut(path).unwrap() = "CHANGED".into();
        assert!(
            serde_json::from_value::<TurnInstructions>(corrupted)
                .unwrap()
                .validate()
                .is_err(),
            "{path}"
        );
    }
}

#[test]
fn composed_instructions_preserve_sources_and_survive_serialization() {
    let shared =
        TurnInstructions::new("prompts", "agent/common", "common-v1", "common rules").unwrap();
    let model = crate::ModelRef::new(
        crate::ProviderId::new("test").unwrap(),
        crate::ModelId::new("model").unwrap(),
    );
    let guidance = InstructionText {
        owner: "models-manager".into(),
        id: "model/guidance".into(),
        revision: "guidance-v1".into(),
        body: "model guidance".into(),
    };
    let instructions = TurnInstructions::new("prompts", "review/code", "review-v1", "review task")
        .unwrap()
        .with_shared(&shared)
        .with_shared(&shared)
        .with_model_guidance(ModelInstructionSelection::Specialized {
            model,
            digest: crate::ContentDigest::sha256(guidance.body.as_bytes()),
            instructions: guidance,
            messages: None,
        });
    assert_eq!(instructions.shared().len(), 1);
    assert_eq!(instructions.shared()[0].body, "common rules");
    let encoded = serde_json::to_value(&instructions).unwrap();
    let restored: TurnInstructions = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(restored, instructions);
    restored.validate().unwrap();
    let mut corrupted = encoded;
    corrupted["modelGuidance"]["instructions"]["body"] = "changed after selection".into();
    assert!(
        serde_json::from_value::<TurnInstructions>(corrupted)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn legacy_single_asset_remains_a_single_recorded_asset() {
    let instructions: TurnInstructions = serde_json::from_value(serde_json::json!({"owner":"prompts", "id":"old", "revision":"v1", "body":"recorded instructions"})).unwrap();
    instructions.validate().unwrap();
    assert!(instructions.shared().is_empty());
    assert!(instructions.model_guidance().is_none());
    assert_eq!(instructions.body(), "recorded instructions");
}

#[test]
fn replacing_mode_retains_common_rules_and_model_selection() {
    let shared = TurnInstructions::new("prompts", "common", "v1", "shared rules").unwrap();
    let parent_mode = TurnInstructions::new("modes", "multitask", "v2", "coordinate").unwrap();
    let worker_mode = TurnInstructions::new("modes", "agent", "v2", "execute").unwrap();
    let base = TurnInstructions::new("prompts", "task", "v1", "task rules")
        .unwrap()
        .with_shared(&shared)
        .with_model_guidance(ModelInstructionSelection::Generic { model: None })
        .with_mode(&parent_mode);
    let worker = base.clone().with_mode(&worker_mode);
    assert_eq!(worker.id(), base.id());
    assert_eq!(worker.body(), base.body());
    assert_eq!(worker.shared(), base.shared());
    assert_eq!(worker.model_guidance(), base.model_guidance());
    assert_eq!(worker.mode_instructions(), Some(&worker_mode.as_text()));
    let restored: TurnInstructions =
        serde_json::from_value(serde_json::to_value(&worker).unwrap()).unwrap();
    assert_eq!(restored, worker);
    restored.validate().unwrap();
}
