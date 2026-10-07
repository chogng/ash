use super::ToolBinding;
use crate::{
    ToolBindingId, ToolDefinition, ToolInputSchema, ToolLoading, ToolName, ToolOutputSchema,
    ToolRegistryGeneration, ToolRuntimeKey, ToolSchemaMode,
};
use serde_json::json;

#[test]
fn binding_keeps_name_digest_and_runtime_separate() {
    let definition = ToolDefinition::function(
        ToolName::new("search").expect("valid tool name"),
        "Search documents.",
        ToolInputSchema::parse(json!({"type": "object", "properties": {}})).expect("valid schema"),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .expect("valid definition");
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(7),
        ToolBindingId::new("binding_1").expect("valid binding ID"),
        ToolName::new("search_docs").expect("valid exposed name"),
        definition.digest(),
        ToolRuntimeKey::new("builtin:search").expect("valid runtime key"),
    );

    assert_eq!(binding.exposed_name().as_str(), "search_docs");
    assert_eq!(binding.registry_generation().get(), 7);
    assert_eq!(binding.runtime_key().as_str(), "builtin:search");
    assert_ne!(
        binding.definition_digest().as_str(),
        binding.runtime_key().as_str()
    );
}
