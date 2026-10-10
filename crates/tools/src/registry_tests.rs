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
fn rebuilt_search_indexes_preserve_ranking_and_isolate_generations() {
    let query =
        ToolSearchQuery::new("repository issues", ToolSearchLimit::new(2).unwrap()).unwrap();
    let build = |generation, names: &[&str]| {
        let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(generation));
        for name in names {
            builder
                .register(registration(
                    name,
                    "List repository issues",
                    ToolExposure::Deferred,
                ))
                .unwrap();
        }
        builder.build().unwrap()
    };
    let first = build(20, &["issue_b", "issue_a"]);
    let rebuilt = build(21, &["issue_a", "issue_b"]);
    let replacement = build(22, &["issue_c"]);
    let matched_names = |snapshot: &ToolRegistrySnapshot| {
        snapshot
            .search(&query)
            .matches()
            .iter()
            .map(|item| item.loadable().definition().name().as_str().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(matched_names(&first), matched_names(&rebuilt));
    assert_eq!(matched_names(&first), ["issue_a", "issue_b"]);
    let single =
        ToolSearchQuery::new("repository issues", ToolSearchLimit::new(1).unwrap()).unwrap();
    for snapshot in [&first, &rebuilt] {
        assert_eq!(
            snapshot.search(&single).matches()[0]
                .loadable()
                .definition()
                .name()
                .as_str(),
            "issue_a"
        );
        assert_eq!(
            snapshot
                .search_excluding(&single, &[ToolName::new("issue_a").unwrap()])
                .matches()[0]
                .loadable()
                .definition()
                .name()
                .as_str(),
            "issue_b"
        );
    }
    assert_eq!(matched_names(&replacement), ["issue_c"]);
    assert_eq!(
        first.search(&query).registry_generation(),
        ToolRegistryGeneration::new(20)
    );
    assert_eq!(
        rebuilt.search(&query).registry_generation(),
        ToolRegistryGeneration::new(21)
    );
    let excluded = [ToolName::new("issue_a").unwrap()];
    assert_eq!(first.search_excluding(&query, &excluded).matches().len(), 1);
    assert_eq!(matched_names(&first), matched_names(&rebuilt));
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

#[test]
fn exclusions_do_not_consume_lexical_regex_or_hybrid_result_slots() {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(19));
    for name in ["github_issue_0", "github_issue_1", "github_issue_2"] {
        builder
            .register(registration(
                name,
                "List GitHub repository issues",
                ToolExposure::Deferred,
            ))
            .unwrap();
    }
    let snapshot = builder.build().unwrap();
    let excluded = [
        ToolName::new("github_issue_0").unwrap(),
        ToolName::new("github_issue_1").unwrap(),
    ];
    let query =
        ToolSearchQuery::new("repository issues", ToolSearchLimit::new(1).unwrap()).unwrap();
    let regex = ToolSearchQuery::regex("github_issue_", ToolSearchLimit::new(1).unwrap()).unwrap();
    let semantic = ["github_issue_0", "github_issue_1", "github_issue_2"]
        .map(|name| ToolName::new(name).unwrap());
    for result in [
        snapshot.search_excluding(&query, &excluded),
        snapshot.search_excluding(&regex, &excluded),
        snapshot.search_hybrid_excluding(&query, &semantic, &excluded),
    ] {
        assert_eq!(result.matches().len(), 1);
        assert_eq!(
            result.matches()[0].loadable().definition().name().as_str(),
            "github_issue_2"
        );
        assert_eq!(result.registry_generation(), snapshot.generation());
    }
}
