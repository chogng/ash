use super::CLIENT_METHODS;
use super::ClientRequestSerializationScope;
use super::SerializationAccess;
use schemars::JsonSchema;

#[test]
fn git_file_history_pages_roundtrip_and_keep_legacy_first_page_requests() {
    use crate::protocol::git::GitFileHistoryParams;
    use crate::protocol::git::GitFileHistoryResult;
    let first: GitFileHistoryParams =
        serde_json::from_value(serde_json::json!({"repositoryId":"repo","path":"file.txt"}))
            .unwrap();
    assert_eq!(first.limit, None);
    assert_eq!(first.cursor, None);
    let value = serde_json::json!({"repositoryId":"repo","path":"file.txt","limit":7,"cursor":"opaque-snapshot"});
    let next: GitFileHistoryParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(next).unwrap(), value);
    assert!(
        serde_json::from_value::<GitFileHistoryParams>(
            serde_json::json!({"path":"file.txt","limit":-1})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<GitFileHistoryParams>(
            serde_json::json!({"path":"file.txt","cursor":42})
        )
        .is_err()
    );
    let done = GitFileHistoryResult {
        items: Vec::new(),
        next_cursor: None,
    };
    assert_eq!(
        serde_json::to_value(done).unwrap(),
        serde_json::json!({"items":[],"nextCursor":null})
    );
}

#[test]
fn github_managed_settings_is_account_bound_read_only_and_cancellable() {
    use crate::protocol::github::GitHubManagedSettingsParams;
    let definition = super::client_method_definition("github/account/managedSettings").unwrap();
    let params = serde_json::json!({"operationId":"read-policy", "accountId":"primary"});
    let request: GitHubManagedSettingsParams = serde_json::from_value(params.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), params);
    assert_eq!(
        definition.cancellation_operation_id(&params).unwrap(),
        Some("read-policy".into())
    );
    assert_eq!(
        definition.serialization_scope(&params).unwrap(),
        Some(ClientRequestSerializationScope::HostedAccount {
            account_id: "primary".into(),
            access: SerializationAccess::SharedRead,
        })
    );
    assert!(
        serde_json::from_value::<GitHubManagedSettingsParams>(
            serde_json::json!({"operationId":"read-policy"})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<GitHubManagedSettingsParams>(serde_json::json!({"operationId":"read-policy", "accountId":"primary", "token":"forbidden"})).is_err());
}

#[test]
fn built_in_provider_enablement_roundtrips_and_uses_global_serialization() {
    use crate::protocol::extension_packages::ExtensionsBuiltInProviderEnablementParams;
    use crate::protocol::extension_packages::ExtensionsBuiltInProvidersResult;
    let read = super::client_method_definition("extensions/builtInProviders").unwrap();
    assert_eq!(
        read.serialization_scope(&serde_json::json!({})).unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::SharedRead
        })
    );
    let write = super::client_method_definition("extensions/setBuiltInProviderEnablement").unwrap();
    let value = serde_json::json!({"id":"ash.github-authentication", "enabled":false, "expectedRevision":7});
    let request: ExtensionsBuiltInProviderEnablementParams =
        serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    let snapshot = serde_json::json!({
        "revision":7, "canChangeEnablement":false,
        "providers":[{"id":"ash.git", "enabled":true, "running":false}]
    });
    let response: ExtensionsBuiltInProvidersResult =
        serde_json::from_value(snapshot.clone()).unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), snapshot);
    assert_eq!(
        write.serialization_scope(&value).unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::Exclusive
        })
    );
    for invalid in [
        serde_json::json!({"id":"ash.github-authentication", "enabled":false}),
        serde_json::json!({"id":"ash.github-authentication", "enabled":"false", "expectedRevision":7}),
        serde_json::json!({"id":"ash.github-authentication", "enabled":false, "expectedRevision":7, "grant":true}),
    ] {
        assert!(
            serde_json::from_value::<ExtensionsBuiltInProviderEnablementParams>(invalid).is_err()
        );
    }
}

#[test]
fn extension_packages_execution_policy_roundtrips_and_serializes_global_mutations() {
    use crate::protocol::extension_packages::ExtensionsEditorExtensionPolicyParams;
    let read = super::client_method_definition("extensions/editorExtensions").unwrap();
    assert_eq!(
        read.serialization_scope(&serde_json::json!({})).unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::SharedRead
        })
    );
    let write = super::client_method_definition("extensions/setEditorExtensionPolicy").unwrap();
    for action in ["enable", "disable", "grant", "revoke"] {
        let value = serde_json::json!({"installationId":"installed", "packageDigest":"sha256:exact", "expectedRevision":7, "action":action});
        let request: ExtensionsEditorExtensionPolicyParams =
            serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
        assert_eq!(
            write.serialization_scope(&value).unwrap(),
            Some(ClientRequestSerializationScope::Global {
                access: SerializationAccess::Exclusive
            })
        );
    }
    assert!(serde_json::from_value::<ExtensionsEditorExtensionPolicyParams>(serde_json::json!({"installationId":"installed", "packageDigest":"digest", "expectedRevision":1, "action":"automatic"})).is_err());
}

#[test]
fn context_inspection_uses_environment_or_session_read_serialization() {
    let method = super::client_method_definition("context/read").unwrap();
    assert_eq!(
        method
            .serialization_scope(
                &serde_json::json!({"detail":"usage","scope":{"type":"environment"}})
            )
            .unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::SharedRead
        })
    );
    assert_eq!(method.serialization_scope(&serde_json::json!({"detail":"diagnostics","scope":{"type":"thread","sessionId":"session","threadId":"thread"}})).unwrap(), Some(ClientRequestSerializationScope::Session { session_id: "session".into(), access: SerializationAccess::SharedRead }));
    assert!(
        method
            .serialization_scope(
                &serde_json::json!({"scope":{"type":"thread","sessionId":"session"}})
            )
            .is_err()
    );
}

#[test]
fn github_admission_uses_case_insensitive_hosted_repository_identity_and_connection_operations() {
    let params = serde_json::json!({"operationId":"operation", "repository":{"host":"GitHub.com", "owner":"Team", "name":"Repo"}});
    let read = super::client_method_definition("github/pullRequest/read").unwrap();
    let commit_read = super::client_method_definition("github/commit/read").unwrap();
    let write = super::client_method_definition("github/pullRequest/merge").unwrap();
    for (method, access) in [
        (read, SerializationAccess::SharedRead),
        (commit_read, SerializationAccess::SharedRead),
        (write, SerializationAccess::Exclusive),
        (
            super::client_method_definition("github/pullRequest/diff").unwrap(),
            SerializationAccess::SharedRead,
        ),
        (
            super::client_method_definition("github/file/read").unwrap(),
            SerializationAccess::SharedRead,
        ),
        (
            super::client_method_definition("github/pullRequest/threads").unwrap(),
            SerializationAccess::SharedRead,
        ),
        (
            super::client_method_definition("github/pullRequest/thread/read").unwrap(),
            SerializationAccess::SharedRead,
        ),
        (
            super::client_method_definition("github/pullRequest/thread/reply").unwrap(),
            SerializationAccess::Exclusive,
        ),
        (
            super::client_method_definition("github/pullRequest/thread/resolve").unwrap(),
            SerializationAccess::Exclusive,
        ),
    ] {
        assert_eq!(
            method.serialization_scope(&params).unwrap(),
            Some(ClientRequestSerializationScope::HostedRepository {
                host: "github.com".into(),
                owner: "team".into(),
                name: "repo".into(),
                access,
            })
        );
        assert_eq!(
            method
                .cancellation_operation_id(&params)
                .unwrap()
                .as_deref(),
            Some("operation")
        );
        assert!(
            method
                .cancellation_operation_id(&serde_json::json!({"operationId":""}))
                .is_err()
        );
        assert!(
            method
                .serialization_scope(&serde_json::json!({"repository":{}}))
                .is_err()
        );
    }
}

#[test]
fn review_comments_round_trip_and_thread_writes_preserve_remote_outcomes() {
    use super::super::github::GitHubPullRequestReviewParams;
    let value = serde_json::json!({"operationId":"review", "repository":{"host":"github.com","owner":"team","name":"repo"}, "number":7,"commit":"a".repeat(40),"event":"comment","body":"","comments":[{"path":"a.rs","line":5,"side":"LEFT","body":"Explain deletion"}]});
    let request: GitHubPullRequestReviewParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    for method in [
        "github/pullRequest/comment/update",
        "github/pullRequest/comment/delete",
        "github/pullRequest/reviewers/change",
        "github/pullRequest/thread/reply",
        "github/pullRequest/thread/resolve",
        "github/pullRequest/review",
    ] {
        assert!(matches!(
            super::client_method_definition(method)
                .unwrap()
                .cancellation,
            super::CancellationDefinition::OperationIdPreserveOutcome("operationId")
        ));
    }
}

#[test]
fn file_transfer_selectors_round_trip_for_workspace_and_session_directories() {
    use super::super::fs::{FsCopyParams, FsPasteSystemFilesParams};
    for value in [
        serde_json::json!({"sourceDirId":"source","targetDirId":"target","source":"a","target":"b"}),
        serde_json::json!({"sessionDirectory":{"sessionId":"session","path":"/work"},"source":"a","target":"b"}),
    ] {
        let request: FsCopyParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }
    for value in [
        serde_json::json!({"dirId":"target","path":"destination","moveRequested":true}),
        serde_json::json!({"sessionDirectory":{"sessionId":"session","path":"/work"},"path":"destination","moveRequested":false}),
    ] {
        let request: FsPasteSystemFilesParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }
}

#[test]
fn shared_method_schema_matches_derived_tagged_payloads() {
    #[derive(serde::Serialize, JsonSchema)]
    struct Payload {
        value: bool,
    }

    #[derive(serde::Serialize, JsonSchema)]
    #[serde(tag = "method", content = "params")]
    enum Reference {
        #[serde(rename = "value")]
        Value(Payload),
        #[serde(rename = "null")]
        Null(()),
        #[serde(rename = "optional")]
        Optional(Option<Payload>),
        #[serde(rename = "boxed")]
        Boxed(Box<Payload>),
    }

    let mut derived = schemars::SchemaGenerator::default();
    let expected = Reference::json_schema(&mut derived);
    let mut shared = schemars::SchemaGenerator::default();
    let actual = super::method_schema(
        &mut shared,
        "params",
        &[
            ("value", schemars::SchemaGenerator::subschema_for::<Payload>),
            ("null", schemars::SchemaGenerator::subschema_for::<()>),
            (
                "optional",
                schemars::SchemaGenerator::subschema_for::<Option<Payload>>,
            ),
            (
                "boxed",
                schemars::SchemaGenerator::subschema_for::<Box<Payload>>,
            ),
        ],
    );
    assert_eq!(actual, expected);
    assert_eq!(shared.definitions(), derived.definitions());

    let examples = [
        Reference::Value(Payload { value: true }),
        Reference::Null(()),
        Reference::Optional(None),
        Reference::Boxed(Box::new(Payload { value: false })),
    ];
    let schema = serde_json::to_value(actual).unwrap();
    for (variant, example) in schema["oneOf"].as_array().unwrap().iter().zip(examples) {
        let wire = serde_json::to_value(example).unwrap();
        assert_eq!(variant["properties"]["method"]["const"], wire["method"]);
        assert!(wire.get("params").is_some());
        assert_eq!(variant["required"], serde_json::json!(["method", "params"]));
    }
}

#[test]
fn method_schema_markers_preserve_derived_names_and_ids() {
    assert_eq!(
        super::ClientRequestSchema::schema_name(),
        "ClientRequestSchema"
    );
    assert_eq!(
        super::ClientRequestSchema::schema_id(),
        "ash_app_server_protocol::protocol::registry::ClientRequestSchema"
    );
    assert_eq!(
        super::ClientResultSchema::schema_name(),
        "ClientResultSchema"
    );
    assert_eq!(super::HostRequestSchema::schema_name(), "HostRequestSchema");
    assert_eq!(super::HostResultSchema::schema_name(), "HostResultSchema");
    assert_eq!(
        super::ServerNotificationSchema::schema_name(),
        "ServerNotificationSchema"
    );
}

fn definition(method: &str) -> &'static super::ClientMethodDefinition {
    CLIENT_METHODS
        .iter()
        .find(|definition| definition.method == method)
        .unwrap()
}

#[test]
fn language_requests_allow_configuration_and_revocation_while_a_server_is_pending() {
    for definition in CLIENT_METHODS
        .iter()
        .filter(|definition| definition.method.starts_with("language/"))
    {
        assert_eq!(
            definition
                .serialization_scope(&serde_json::json!({}))
                .unwrap(),
            None,
            "{} must not hold a profile-wide permit during server I/O",
            definition.method
        );
    }
    assert_eq!(
        definition("languageServer/configure")
            .serialization_scope(&serde_json::json!({}))
            .unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::Exclusive
        })
    );
}

#[test]
fn session_scope_uses_the_declared_session_identity() {
    let scope = definition("session/request")
        .serialization_scope(&serde_json::json!({ "sessionId": "session-1" }))
        .unwrap();

    assert_eq!(
        scope,
        Some(ClientRequestSerializationScope::Session {
            session_id: "session-1".into(),
            access: SerializationAccess::Exclusive,
        })
    );
}

#[test]
fn git_operations_declare_repository_access_and_validate_selectors() {
    for method in [
        "git/command",
        "git/catalog",
        "git/indexDiff",
        "git/indexEdit",
        "git/fetch",
        "git/pull",
        "git/push",
        "git/stage",
        "git/checkIgnore",
        "git/worktree/create",
    ] {
        assert_eq!(
            definition(method)
                .serialization_scope(&serde_json::json!({}))
                .unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: None,
                access: SerializationAccess::Exclusive
            })
        );
        assert_eq!(
            definition(method)
                .serialization_scope(&serde_json::json!({"repositoryId":"repo-1"}))
                .unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: Some("repo-1".into()),
                access: SerializationAccess::Exclusive
            })
        );
        assert!(
            definition(method)
                .serialization_scope(&serde_json::json!({"repositoryId":12}))
                .is_err()
        );
    }
    for method in [
        "git/commitChanges",
        "git/compareChanges",
        "git/commitMessage",
        "git/commitDetails",
        "git/commitFile",
    ] {
        assert_eq!(
            definition(method)
                .serialization_scope(&serde_json::json!({"repositoryId":"repo-1"}))
                .unwrap(),
            None,
            "{method} must not wait for repository mutation admission"
        );
    }
    assert_eq!(
        definition("git/status")
            .serialization_scope(&serde_json::json!({"repositoryId":null}))
            .unwrap(),
        Some(ClientRequestSerializationScope::Repository {
            repository_id: None,
            access: SerializationAccess::Exclusive
        })
    );
}

#[test]
fn git_fetch_modes_preserve_existing_requests_and_add_one_named_remote() {
    use crate::protocol::git::GitCatalogResult;
    use crate::protocol::git::GitFetchModeDto;
    use crate::protocol::git::GitFetchParams;
    for (mode, expected) in [
        (None, None),
        (
            Some(serde_json::json!("default")),
            Some(GitFetchModeDto::Default),
        ),
        (Some(serde_json::json!("all")), Some(GitFetchModeDto::All)),
        (
            Some(serde_json::json!({"remote":"team/backup"})),
            Some(GitFetchModeDto::Remote("team/backup".into())),
        ),
    ] {
        let mut request = serde_json::json!({"repositoryId":"repo-1"});
        if let Some(mode) = mode {
            request["mode"] = mode;
        }
        let params: GitFetchParams = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(params.mode, expected);
        assert_eq!(serde_json::to_value(params).unwrap(), request);
        assert_eq!(
            definition("git/fetch")
                .serialization_scope(&request)
                .unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: Some("repo-1".into()),
                access: SerializationAccess::Exclusive,
            })
        );
    }
    for mode in [
        serde_json::json!("backup"),
        serde_json::json!({"remote":null}),
        serde_json::json!({"remote":12}),
        serde_json::json!({"remote":"backup","all":null}),
        serde_json::json!({"unknown":"backup"}),
    ] {
        assert!(
            serde_json::from_value::<GitFetchParams>(serde_json::json!({"mode":mode})).is_err()
        );
    }
    let previous =
        serde_json::json!({"tags":[],"stashes":[],"remotes":["origin"],"operation":null});
    let mut catalog: GitCatalogResult = serde_json::from_value(previous.clone()).unwrap();
    assert_eq!(catalog.upstream_remote, None);
    assert!(!catalog.upstream_read_only);
    let mut expected = previous;
    expected["upstreamReadOnly"] = serde_json::json!(false);
    assert_eq!(serde_json::to_value(&catalog).unwrap(), expected);
    catalog.upstream_remote = Some("team/backup".into());
    let updated = serde_json::to_value(catalog).unwrap();
    assert_eq!(updated["upstreamRemote"], "team/backup");
}

#[test]
fn session_directory_move_is_session_exclusive() {
    let scope = definition("session/dirs/move")
        .serialization_scope(&serde_json::json!({ "sessionId": "session-1", "path": "/workspace", "permissions": [] }))
        .unwrap();

    assert_eq!(
        scope,
        Some(ClientRequestSerializationScope::Session {
            session_id: "session-1".into(),
            access: SerializationAccess::Exclusive,
        })
    );
    assert!(
        !CLIENT_METHODS
            .iter()
            .any(|method| matches!(method.method, "env/cwd/set" | "env/workspace/set"))
    );
}
#[test]
fn extension_packages_catalog_queries_do_not_hold_the_global_mutation_lock() {
    for method in ["extensions/search", "extensions/get"] {
        assert_eq!(
            definition(method)
                .serialization_scope(&serde_json::json!({}))
                .unwrap(),
            None,
        );
    }
}

#[test]
fn account_usage_queries_do_not_hold_the_global_mutation_lock() {
    assert_eq!(
        definition("account/read")
            .serialization_scope(&serde_json::json!({}))
            .unwrap(),
        None
    );
    let method = definition("account/rateLimits/read");
    assert_eq!(
        method
            .serialization_scope(&serde_json::json!({
                "provider":"chatgpt-subscription", "accountId":"account-1"
            }))
            .unwrap(),
        None
    );
    let result: crate::protocol::account::AccountRateLimitsReadResult = serde_json::from_value(serde_json::json!({
        "provider":"chatgpt-subscription", "accountId":"account-1", "plan":"plus",
        "limits":[{"id":"codex","name":null,"model":null,"allowed":null,"limitReached":null,"primary":null,"secondary":null}],
        "credits":null
    })).unwrap();
    let encoded = serde_json::to_value(result).unwrap();
    assert_eq!(encoded["accountId"], "account-1");
    assert!(encoded["limits"][0]["allowed"].is_null());
    assert!(encoded["limits"][0]["primary"].is_null());
    assert!(encoded["credits"].is_null());
    assert!(encoded.get("xai").is_none());
    let result: crate::protocol::account::AccountRateLimitsReadResult = serde_json::from_value(serde_json::json!({
        "provider":"xai-subscription", "accountId":"login-a", "plan":null,
        "limits":[], "credits":null, "xai":{"usedPercent":12.125,"prepaidCents":"9007199254740993","allowed":false}
    })).unwrap();
    let encoded = serde_json::to_value(result).unwrap();
    assert!(encoded["plan"].is_null());
    assert_eq!(encoded["xai"]["usedPercent"], 12.125);
    assert_eq!(encoded["xai"]["prepaidCents"], "9007199254740993");
    assert_eq!(encoded["xai"]["allowed"], false);
}

#[test]
fn resource_scope_keeps_resource_families_separate() {
    let resource = definition("resource/read")
        .serialization_scope(&serde_json::json!({ "resourceId": "same" }))
        .unwrap();
    let upload = definition("attachment/upload/write")
        .serialization_scope(&serde_json::json!({ "uploadId": "same" }))
        .unwrap();

    assert_ne!(resource, upload);
}

#[test]
fn declared_key_is_required_before_dispatch() {
    assert!(
        definition("session/read")
            .serialization_scope(&serde_json::json!({}))
            .is_err()
    );
}

#[test]
fn cancellable_method_resolves_its_declared_operation_identity() {
    assert_eq!(
        definition("git/checkIgnore")
            .cancellation_operation_id(
                &serde_json::json!({"operationId":"ignore-1","paths":["cache"]})
            )
            .unwrap()
            .as_deref(),
        Some("ignore-1")
    );
    assert!(
        definition("git/checkIgnore")
            .cancellation_operation_id(&serde_json::json!({"paths":["cache"]}))
            .is_err()
    );
    assert_eq!(
        definition("git/checkIgnore/cancel")
            .serialization_scope(&serde_json::json!({"operationId":"ignore-1"}))
            .unwrap(),
        None
    );
    let operation_id = definition("language/hover")
        .cancellation_operation_id(&serde_json::json!({
            "operationId": "hover-1",
            "request": {
                "resourceId": "resource-1",
                "position": { "line": 0, "character": 0 }
            }
        }))
        .unwrap();

    assert_eq!(operation_id.as_deref(), Some("hover-1"));
    assert!(
        definition("language/hover")
            .cancellation_operation_id(&serde_json::json!({ "request": {} }))
            .is_err()
    );
}

#[test]
fn non_cancellable_method_has_no_operation_identity() {
    assert_eq!(
        definition("language/synchronize")
            .cancellation_operation_id(&serde_json::json!({}))
            .unwrap(),
        None
    );
}

#[test]
fn screen_controls_round_trip_and_reject_ambiguous_targets() {
    use super::super::call::CallControlParams;
    let value = serde_json::json!({ "resourceId": "call-window", "control": { "type": "shareScreen", "target": { "type": "window", "id": "42" } } });
    let request: CallControlParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    for target in [
        serde_json::json!({"type":"window"}),
        serde_json::json!({"type":"window","id":"42","display":"7"}),
    ] {
        assert!(serde_json::from_value::<CallControlParams>(serde_json::json!({ "resourceId": "call-window", "control": { "type":"shareScreen", "target": target } })).is_err());
    }
}

#[test]
fn extension_packages_search_supports_capabilities_and_exact_language_routes() {
    let mut capabilities = super::ServerCapabilities {
        extension_management: true,
        extensions: true,
        ..Default::default()
    };
    capabilities.advertise_contracts();
    assert_eq!(capabilities.contracts["extensionsSearch"].version, 1);
    assert_eq!(capabilities.contracts["extensionsPaging"].version, 1);
    assert_eq!(
        capabilities.contracts["extensionRecommendations"].version,
        1
    );
    assert!(
        !capabilities
            .contracts
            .contains_key("extensionGalleryResources")
    );
    let wire = serde_json::json!({
        "query": "tsx",
        "packageType": null,
        "capabilityKind": "executable",
        "languageId": "typescriptreact",
        "limit": 20
    });
    let params: super::ExtensionsSearchParams = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), wire);
    let unfiltered: super::ExtensionsSearchParams =
        serde_json::from_value(serde_json::json!({ "query": "review" })).unwrap();
    assert!(unfiltered.capability_kind.is_none());
    assert!(unfiltered.language_id.is_none());
    assert!(
        serde_json::from_value::<super::ExtensionsSearchParams>(serde_json::json!({
            "query": "", "capabilityKind": "lsp"
        }))
        .is_err()
    );
}

#[test]
fn retired_gallery_methods_are_not_part_of_the_protocol() {
    for method in ["extensions/gallery", "extensions/gallery/resource/open"] {
        assert!(super::client_method_definition(method).is_none());
    }
    assert!(
        serde_json::from_value::<super::super::extension_packages::ExtensionRegistryKindDto>(
            serde_json::json!("openVsx")
        )
        .is_err()
    );
}

#[test]
fn hook_catalog_request_and_sources_round_trip_without_granting_execution() {
    use crate::protocol::config::{HookListParams, HookListResult};
    for wire in [
        serde_json::json!({}),
        serde_json::json!({"sessionId": "session-1"}),
    ] {
        let params: HookListParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), wire);
        assert_eq!(
            definition("hook/list").serialization_scope(&wire).unwrap(),
            Some(ClientRequestSerializationScope::Global {
                access: SerializationAccess::SharedRead
            })
        );
    }
    assert!(
        serde_json::from_value::<HookListParams>(serde_json::json!({"path": "/untrusted"}))
            .is_err()
    );
    let wire = serde_json::json!({"sources": [{"namespace": "user", "configPath": "/profile/config.toml", "hooks": [{
        "id": "user:hook:check", "event": "preToolUse", "matcher": {"toolNames": []},
        "action": {"type": "process", "program": "check", "args": ["--verify"]}, "enablement": "disabled"
    }]}]});
    let result: HookListResult = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), wire);
}

#[test]
fn git_intents_round_trip_reviewed_identities_and_reject_open_ended_commands() {
    use super::super::git::GitCommandParams;
    for value in [
        serde_json::json!({"repositoryId":"repo","command":{"kind":"renameBranch","name":"topic","newName":"review"}}),
        serde_json::json!({"command":{"kind":"stash","message":"review","mode":"includeUntracked"}}),
        serde_json::json!({"command":{"kind":"popStash","objectId":"a".repeat(40)}}),
        serde_json::json!({"command":{"kind":"continue","operation":"cherryPick"}}),
        serde_json::json!({"command":{"kind":"undoCommit","expectedHead":"a".repeat(40)}}),
        serde_json::json!({"repositoryId":"selected","command":{"kind":"createBranchAt","name":"review","objectId":"a".repeat(40)}}),
        serde_json::json!({"command":{"kind":"checkoutDetached","objectId":"a".repeat(40)}}),
        serde_json::json!({"command":{"kind":"checkoutRemoteBranch","name":"review","reference":"origin/topic"}}),
        serde_json::json!({"command":{"kind":"cherryPick","reference":"a".repeat(40)}}),
        serde_json::json!({"command":{"kind":"cherryPick","reference":"a".repeat(40),"mainline":2}}),
    ] {
        let decoded: GitCommandParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    for command in [
        serde_json::json!({"kind":"exec","arguments":["reset","--hard"]}),
        serde_json::json!({"kind":"continue","operation":"reset"}),
        serde_json::json!({"kind":"stash","message":"review","mode":"all"}),
        serde_json::json!({"kind":"undoCommit"}),
        serde_json::json!({"kind":"cherryPick","reference":"a".repeat(40),"mainline":-1}),
    ] {
        assert!(
            serde_json::from_value::<GitCommandParams>(serde_json::json!({"command":command}))
                .is_err()
        );
    }
}

#[test]
fn github_notification_and_fork_admission_preserves_write_outcomes() {
    for name in [
        "github/notifications/read",
        "github/notifications/readAll",
        "github/repository/fork",
    ] {
        let method = super::client_method_definition(name).unwrap();
        assert_eq!(
            method
                .cancellation_operation_id(&serde_json::json!({"operationId":"write"}))
                .unwrap()
                .as_deref(),
            Some("write")
        );
        assert_eq!(
            method.cancellation,
            super::CancellationDefinition::OperationIdPreserveOutcome("operationId")
        );
    }
    let method: crate::protocol::account::AccountLoginMethodDto = serde_json::from_value(
        serde_json::json!({"type":"gitHubEnterpriseBrowser","host":"git.example.com"}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(method).unwrap(),
        serde_json::json!({"type":"gitHubEnterpriseBrowser","host":"git.example.com"})
    );
}

#[test]
fn file_glob_round_trips_explicit_directory_and_declares_connection_cancellation() {
    use super::super::search::FileGlobParams;
    let wire = serde_json::json!({
        "operationId":"glob-query", "target":{"type":"workspace","dirId":"workspace-folder"},
        "includePatterns":["src/**/*.rs"], "excludePatterns":["**/*.test.rs"], "maxResults":100
    });
    let decoded: FileGlobParams = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    let method = definition("file/search/glob");
    assert_eq!(method.serialization_scope(&wire).unwrap(), None);
    assert_eq!(
        method.cancellation_operation_id(&wire).unwrap().as_deref(),
        Some("glob-query")
    );
    let mut unexpected = wire.clone();
    unexpected["path"] = serde_json::json!("/ungranted");
    assert!(serde_json::from_value::<FileGlobParams>(unexpected).is_err());
    let mut missing = wire;
    missing.as_object_mut().unwrap().remove("target");
    assert!(serde_json::from_value::<FileGlobParams>(missing).is_err());
    for operation in ["".to_owned(), "x".repeat(129)] {
        assert!(
            method
                .cancellation_operation_id(&serde_json::json!({"operationId":operation}))
                .is_err()
        );
    }
    assert_eq!(
        definition("file/search/glob/cancel")
            .serialization_scope(&serde_json::json!({"operationId":"glob-query"}))
            .unwrap(),
        None
    );
}

#[test]
fn file_fuzzy_round_trips_unicode_and_declares_connection_cancellation() {
    use super::super::search::FileFuzzyParams;
    use super::super::search::FileFuzzyResult;
    let result = serde_json::json!({"matches":[{"path":"中文.png","score":42}],"totalMatches":1,"freshness":"indexed"});
    let decoded: FileFuzzyResult = serde_json::from_value(result.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), result);
    let wire = serde_json::json!({"operationId":"fuzzy-query", "target":{"type":"session","sessionId":"session","path":"/workspace"}, "query":"中文 SRC", "maxResults":100});
    let params: FileFuzzyParams = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), wire);
    let mut filtered = wire.clone();
    filtered["includePatterns"] = serde_json::json!(["src/**"]);
    filtered["excludePatterns"] = serde_json::json!(["**/*.test.ts"]);
    let params: FileFuzzyParams = serde_json::from_value(filtered.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), filtered);
    let method = definition("file/search/fuzzy");
    assert_eq!(method.serialization_scope(&wire).unwrap(), None);
    assert_eq!(
        method.cancellation_operation_id(&wire).unwrap().as_deref(),
        Some("fuzzy-query")
    );
    let mut unexpected = wire;
    unexpected["unrecognizedFilter"] = serde_json::json!(["*"]);
    assert!(serde_json::from_value::<FileFuzzyParams>(unexpected).is_err());
    assert_eq!(
        definition("file/search/fuzzy/cancel")
            .serialization_scope(&serde_json::json!({"operationId":"fuzzy-query"}))
            .unwrap(),
        None
    );
}

#[test]
fn extension_source_mutations_have_strict_inputs_and_exclusive_serialization() {
    use super::super::extension_packages::ExtensionsAddSourceParams;
    use super::super::extension_packages::ExtensionsSetSourceEnabledParams;
    let value = serde_json::json!({
        "sourceId": "vendor", "metadataBaseUrl": "https://vendor.example/metadata/",
        "targetsBaseUrl": "https://vendor.example/targets/", "trustedRootJson": "{}",
        "expectedRevision": 4
    });
    let request: ExtensionsAddSourceParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    assert_eq!(
        definition("extensions/sources/add")
            .serialization_scope(&value)
            .unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::Exclusive
        })
    );
    let toggle = serde_json::json!({"sourceId":"vendor", "enabled":false, "expectedRevision":5});
    let request: ExtensionsSetSourceEnabledParams = serde_json::from_value(toggle.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), toggle);
    assert_eq!(
        definition("extensions/sources/setEnabled")
            .serialization_scope(&toggle)
            .unwrap(),
        Some(ClientRequestSerializationScope::Global {
            access: SerializationAccess::Exclusive
        })
    );
    let mut unexpected = value;
    unexpected["replace"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ExtensionsAddSourceParams>(unexpected).is_err());
}

#[test]
fn git_pull_modes_roundtrip_and_keep_repository_serialization() {
    use crate::protocol::config::GitConfigDto;
    use crate::protocol::git::GitPullModeDto;
    use crate::protocol::git::GitPullParams;
    let legacy: GitPullParams =
        serde_json::from_value(serde_json::json!({"repositoryId":"repo"})).unwrap();
    assert_eq!(legacy.mode, None);
    assert_eq!(GitPullModeDto::default(), GitPullModeDto::Configured);
    for mode in ["configured", "rebase", "sync"] {
        let value = serde_json::json!({"repositoryId":"repo", "mode":mode});
        let params: GitPullParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), value);
        assert_eq!(
            definition("git/pull").serialization_scope(&value).unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: Some("repo".into()),
                access: SerializationAccess::Exclusive
            })
        );
    }
    for value in [
        serde_json::json!({"mode":"force"}),
        serde_json::json!({"mode":true}),
        serde_json::json!({"unexpected":true}),
    ] {
        assert!(serde_json::from_value::<GitPullParams>(value).is_err());
    }
    let config: GitConfigDto =
        serde_json::from_value(serde_json::json!({"autofetch":"off","autofetchPeriod":180}))
            .unwrap();
    assert!(!config.rebase_when_sync);
    assert_eq!(
        serde_json::to_value(config).unwrap()["rebaseWhenSync"],
        false
    );
}

#[test]
fn git_transport_pull_keeps_the_reviewed_upstream_and_legacy_requests() {
    use crate::protocol::git::GitTransportOperationDto;
    for expected_head in [
        None,
        Some(
            serde_json::json!({"type":"branch","name":"topic","objectId":"a".repeat(40),"upstream":{"name":"team/upstream/release","ahead":2,"behind":1}}),
        ),
    ] {
        let mut value = serde_json::json!({"kind":"pull","mode":"sync"});
        if let Some(head) = expected_head {
            value["expectedHead"] = head;
        }
        let operation: GitTransportOperationDto = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(operation).unwrap(), value);
    }
    assert!(serde_json::from_value::<GitTransportOperationDto>(serde_json::json!({"kind":"pull","mode":"sync","expectedHead":{"type":"branch","name":"topic"}})).is_err());
}

#[test]
fn git_transport_recovers_tag_conflicts_without_parsing_error_messages() {
    use crate::protocol::git::GitTransportOutcomeDto;
    for value in [
        serde_json::json!({"kind":"completed"}),
        serde_json::json!({"kind":"tagConflict","tags":["release","v2"]}),
    ] {
        let outcome: GitTransportOutcomeDto = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(outcome).unwrap(), value);
    }
    assert!(
        serde_json::from_value::<GitTransportOutcomeDto>(
            serde_json::json!({"kind":"tagConflict","tags":[1]})
        )
        .is_err()
    );
}

#[test]
fn git_installation_distinguishes_missing_supported_and_upgrade_required() {
    use crate::protocol::git::GitVersionResult;
    for value in [
        serde_json::json!({"kind":"missing"}),
        serde_json::json!({"kind":"available","version":"git version 2.40.0"}),
        serde_json::json!({"kind":"unsupported","version":"git version 2.39.9","minimumVersion":"2.40.0"}),
    ] {
        let value = serde_json::json!({"installation": value});
        let result: GitVersionResult = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), value);
    }
    assert!(
        serde_json::from_value::<GitVersionResult>(
            serde_json::json!({"installation":{"kind":"unsupported","version":"git version 2.39.9"}})
        )
        .is_err()
    );
}

#[test]
fn git_observations_share_admission_but_status_publication_and_writes_remain_exclusive() {
    for (method, access) in [
        ("git/changesSummary", SerializationAccess::SharedRead),
        ("git/status", SerializationAccess::Exclusive),
        ("git/textDiff", SerializationAccess::Exclusive),
        ("git/stage", SerializationAccess::Exclusive),
    ] {
        let definition = super::client_method_definition(method).unwrap();
        assert_eq!(
            definition
                .serialization_scope(&serde_json::json!({"repositoryId":"repo"}))
                .unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: Some("repo".into()),
                access
            })
        );
        assert_eq!(
            definition
                .serialization_scope(&serde_json::json!({}))
                .unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: None,
                access
            })
        );
        for invalid in [
            serde_json::json!({"repositoryId":""}),
            serde_json::json!({"repositoryId":4}),
        ] {
            assert!(definition.serialization_scope(&invalid).is_err());
        }
    }
}

#[test]
fn git_file_admission_keeps_staged_order_and_rejects_invalid_comparisons() {
    let definition = super::client_method_definition("git/changeFile").unwrap();
    for (comparison, access) in [
        ("unstaged", SerializationAccess::SharedRead),
        ("staged", SerializationAccess::Exclusive),
    ] {
        assert_eq!(
            definition
                .serialization_scope(&serde_json::json!({"path":"a.txt", "comparison":comparison}))
                .unwrap(),
            Some(ClientRequestSerializationScope::Repository {
                repository_id: None,
                access
            })
        );
    }
    for invalid in [
        serde_json::json!({"path":"a.txt"}),
        serde_json::json!({"path":"a.txt","comparison":"unknown"}),
        serde_json::json!({"path":"a.txt","comparison":"unstaged","repositoryId":""}),
    ] {
        assert!(definition.serialization_scope(&invalid).is_err());
    }
}

#[test]
fn extension_recommendation_environment_round_trips_without_host_paths() {
    use super::super::extension_packages::ExtensionsRecommendationEnvironmentResult;
    let wire = serde_json::json!({ "platform": "linux", "executables": ["python3", "node"] });
    let environment: ExtensionsRecommendationEnvironmentResult =
        serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(environment).unwrap(), wire);
    assert_eq!(
        super::client_method("extensions/recommendations/environment"),
        Some(super::ClientMethod::ExtensionsRecommendationEnvironment)
    );
}
