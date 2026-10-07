use super::*;
use crate::ToolInputSchema;
use crate::ToolLoading;
use crate::ToolName;
use crate::ToolOutputSchema;
use crate::ToolRegistryBuilder;
use crate::ToolRegistryGeneration;
use crate::ToolRegistryRegistration;
use crate::ToolRuntimeKey;
use crate::ToolSchemaMode;
use crate::ToolSearchMetadata;
use serde_json::json;

fn registration(name: &str, exposure: ToolExposure) -> ToolRegistryRegistration {
    let loading = if exposure == ToolExposure::Deferred {
        ToolLoading::Deferred
    } else {
        ToolLoading::Eager
    };
    let definition = crate::ToolDefinition::function(
        ToolName::new(name).unwrap(),
        format!("Call {name}"),
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {"value": {"type": "string"}}
        }))
        .unwrap(),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        loading,
    )
    .unwrap();
    ToolRegistryRegistration::new(
        definition,
        ToolRuntimeKey::new(format!("runtime:{name}")).unwrap(),
        exposure,
        ToolSearchMetadata::new("test code-mode projection").unwrap(),
    )
    .unwrap()
}

#[test]
fn projection_is_stable_and_excludes_model_only_and_hidden_tools() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(9));
    builder
        .register(registration("github-create-pr", ToolExposure::Deferred))
        .unwrap();
    builder
        .register(registration("read_file", ToolExposure::Direct))
        .unwrap();
    builder
        .register(registration("approval", ToolExposure::DirectModelOnly))
        .unwrap();
    builder
        .register(registration("migration", ToolExposure::Hidden))
        .unwrap();

    let projection = CodeModeProjection::from_registry(&builder.build().unwrap()).unwrap();

    assert_eq!(projection.registry_generation(), 9);
    assert_eq!(
        projection
            .bindings()
            .iter()
            .map(|binding| binding.code_name.as_str())
            .collect::<Vec<_>>(),
        vec!["github__create__pr", "read_file"]
    );
}

#[test]
fn projection_rejects_normalized_name_collisions() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(1));
    builder
        .register(registration("github-create", ToolExposure::Deferred))
        .unwrap();
    builder
        .register(registration("github__create", ToolExposure::Deferred))
        .unwrap();

    assert!(
        CodeModeProjection::from_registry(&builder.build().unwrap())
            .unwrap_err()
            .to_string()
            .contains("collision")
    );
}
