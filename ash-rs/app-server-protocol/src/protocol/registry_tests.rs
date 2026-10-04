use super::CLIENT_METHODS;
use super::ClientRequestSerializationScope;
use super::SerializationAccess;
use schemars::JsonSchema;

#[test]
fn github_admission_uses_case_insensitive_hosted_repository_identity_and_connection_operations() {
    let params = serde_json::json!({"operationId":"operation", "repository":{"host":"GitHub.com", "owner":"Team", "name":"Repo"}});
    let read = super::client_method_definition("github/pullRequest/read").unwrap();
    let write = super::client_method_definition("github/pullRequest/merge").unwrap();
    for (method, access) in [
        (read, SerializationAccess::SharedRead),
        (write, SerializationAccess::Exclusive),
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
        "git/compareChanges",
        "git/commitMessage",
        "git/commitDetails",
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
fn marketplace_catalog_queries_do_not_hold_the_global_mutation_lock() {
    for method in ["marketplace/search", "marketplace/get"] {
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
fn marketplace_search_supports_capabilities_and_exact_language_routes() {
    let mut capabilities = super::ServerCapabilities {
        marketplace: true,
        ..Default::default()
    };
    capabilities.advertise_contracts();
    assert_eq!(capabilities.contracts["marketplaceSearch"].version, 1);
    let wire = serde_json::json!({
        "query": "tsx",
        "packageType": null,
        "capabilityKind": "executable",
        "languageId": "typescriptreact",
        "limit": 20
    });
    let params: super::MarketplaceSearchParams = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), wire);
    let unfiltered: super::MarketplaceSearchParams =
        serde_json::from_value(serde_json::json!({ "query": "review" })).unwrap();
    assert!(unfiltered.capability_kind.is_none());
    assert!(unfiltered.language_id.is_none());
    assert!(
        serde_json::from_value::<super::MarketplaceSearchParams>(serde_json::json!({
            "query": "", "capabilityKind": "lsp"
        }))
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
