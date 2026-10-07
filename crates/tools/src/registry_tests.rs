use super::*;
use crate::ToolInputSchema;
use crate::ToolOutputSchema;
use crate::ToolSchemaMode;
use crate::ToolSearchError;
use serde_json::json;

fn registration(name: &str, description: &str, exposure: ToolExposure) -> ToolRegistryRegistration {
    let loading = if exposure == ToolExposure::Deferred {
        ToolLoading::Deferred
    } else {
        ToolLoading::Eager
    };
    let definition = ToolDefinition::function(
        ToolName::new(name).unwrap(),
        description,
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "owner": {"type": "string", "description": "repository owner"}
            }
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
        ToolSearchMetadata::new("github repository operations").unwrap(),
    )
    .unwrap()
}

#[test]
fn snapshot_keeps_direct_tools_visible_and_deferred_tools_loadable() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(7));
    builder
        .register(registration(
            "read_file",
            "Read a accessible file",
            ToolExposure::Direct,
        ))
        .unwrap();
    builder
        .register(registration(
            "github_create_pull_request",
            "Create a GitHub pull request",
            ToolExposure::Deferred,
        ))
        .unwrap();
    let snapshot = builder.build().unwrap();

    let initially_loaded = BTreeSet::new();
    let initial = snapshot
        .model_definitions(&initially_loaded)
        .map(|definition| definition.name().as_str())
        .collect::<Vec<_>>();
    assert_eq!(initial, vec!["read_file"]);

    let loaded = BTreeSet::from([ToolName::new("github_create_pull_request").unwrap()]);
    let next = snapshot
        .model_definitions(&loaded)
        .map(|definition| definition.name().as_str())
        .collect::<Vec<_>>();
    assert_eq!(next, vec!["github_create_pull_request", "read_file"]);
}

#[test]
fn search_is_deterministic_and_returns_frozen_bindings() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(11));
    builder
        .register(registration(
            "github_create_pull_request",
            "Create a pull request for a repository",
            ToolExposure::Deferred,
        ))
        .unwrap();
    builder
        .register(registration(
            "github_list_issues",
            "List repository issues",
            ToolExposure::Deferred,
        ))
        .unwrap();
    let snapshot = builder.build().unwrap();
    let query =
        ToolSearchQuery::new("create github pull request", ToolSearchLimit::default()).unwrap();

    let first = snapshot.search(&query);
    let second = snapshot.search(&query);

    assert_eq!(first.registry_generation(), ToolRegistryGeneration::new(11));
    assert_eq!(first.matches().len(), 2);
    assert_eq!(
        first.matches()[0].loadable().definition().name().as_str(),
        "github_create_pull_request"
    );
    assert_eq!(
        first.matches()[0].loadable().binding(),
        second.matches()[0].loadable().binding()
    );
}

#[test]
fn registry_rejects_reserved_and_duplicate_names() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(1));
    assert!(matches!(
        builder.register(registration(
            TOOL_SEARCH_TOOL_NAME,
            "Shadow the host search tool",
            ToolExposure::Direct,
        )),
        Err(ToolRegistryError::ReservedName(_))
    ));
    builder
        .register(registration(
            "read_file",
            "Read a file",
            ToolExposure::Direct,
        ))
        .unwrap();
    assert!(matches!(
        builder.register(registration(
            "read_file",
            "Read another file",
            ToolExposure::Direct,
        )),
        Err(ToolRegistryError::DuplicateName(_))
    ));
}

#[test]
fn search_inputs_and_metadata_are_bounded() {
    assert!(matches!(
        ToolSearchQuery::new("q".repeat(1_025), ToolSearchLimit::default(),),
        Err(ToolSearchError::QueryTooLarge { .. })
    ));
    assert!(matches!(
        ToolSearchMetadata::new("m".repeat(16 * 1_024 + 1)),
        Err(ToolRegistryError::SearchMetadataTooLarge { .. })
    ));
    assert!(matches!(
        ToolSearchQuery::regex("[", ToolSearchLimit::default()),
        Err(ToolSearchError::InvalidRegex(_))
    ));
}

#[test]
fn regex_search_matches_complete_deferred_documents() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(1));
    builder
        .register(registration(
            "github_create_pull_request",
            "Create a GitHub pull request",
            ToolExposure::Deferred,
        ))
        .unwrap();
    builder
        .register(registration(
            "github_list_issues",
            "List repository issues",
            ToolExposure::Deferred,
        ))
        .unwrap();
    let snapshot = builder.build().unwrap();

    let result = snapshot.search(
        &ToolSearchQuery::regex("github_(create|merge)", ToolSearchLimit::default()).unwrap(),
    );

    assert_eq!(result.matches().len(), 1);
    assert_eq!(
        result.matches()[0].loadable().definition().name().as_str(),
        "github_create_pull_request"
    );
}

#[test]
fn hybrid_search_can_add_a_semantic_only_match() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(1));
    builder
        .register(registration(
            "calendar_list_events",
            "List calendar events",
            ToolExposure::Deferred,
        ))
        .unwrap();
    builder
        .register(registration(
            "github_list_issues",
            "List repository issues",
            ToolExposure::Deferred,
        ))
        .unwrap();
    let snapshot = builder.build().unwrap();
    let query =
        ToolSearchQuery::new("appointments coming up", ToolSearchLimit::new(1).unwrap()).unwrap();

    let result = snapshot.search_hybrid(&query, &[ToolName::new("calendar_list_events").unwrap()]);

    assert_eq!(
        result.matches()[0].loadable().definition().name().as_str(),
        "calendar_list_events"
    );
}
