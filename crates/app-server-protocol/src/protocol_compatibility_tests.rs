use crate::protocol::common::SchemaHash;
use crate::protocol::common::ServerInfo;
use crate::protocol::common::ServerOperatingSystem;
use crate::protocol::git::GitCommitParams;
use crate::protocol::initialize::APP_SERVER_PROTOCOL_MAJOR;
use crate::protocol::initialize::CapabilityContract;
use crate::protocol::initialize::CapabilityRequirement;
use crate::protocol::initialize::InitializeResult;
use crate::protocol::initialize::ProtocolCompatibilityError;
use crate::protocol::initialize::ProtocolVersion;
use crate::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use crate::protocol::initialize::ServerCapabilities;
use crate::protocol::initialize::ensure_protocol_compatible;

#[test]
fn language_server_configuration_preserves_generic_json_and_legacy_defaults() {
    use crate::protocol::config::LanguageServerConfigDto;
    let legacy = serde_json::json!({"mode":"enabled"});
    let decoded: LanguageServerConfigDto = serde_json::from_value(legacy.clone()).unwrap();
    assert!(decoded.language_ids.is_empty());
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    let configured = serde_json::json!({
        "mode":"enabled", "executable":"/usr/bin/demo-lsp", "languageIds":["demo"],
        "args":["--stdio", "with spaces"], "environment":{"DEMO":"enabled"},
        "initializationOptions":{"nested":[null, true, "text"]},
        "settings":{"demo":{"strict":true,"optional":null}}
    });
    let decoded: LanguageServerConfigDto = serde_json::from_value(configured.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), configured);
}

#[test]
fn language_save_requires_exact_content_and_signature_retrigger_defaults_to_false() {
    use crate::protocol::language::LanguageSaveParams;
    use crate::protocol::language::LanguageSignatureHelpParams;
    let saved = serde_json::json!({"path":"demo.txt","text":"saved\ncontent"});
    let decoded: LanguageSaveParams = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), saved);
    for invalid in [
        serde_json::json!({"path":"demo.txt"}),
        serde_json::json!({"path":"demo.txt","text":42}),
        serde_json::json!({"path":"demo.txt","text":"saved","revision":3}),
    ] {
        assert!(serde_json::from_value::<LanguageSaveParams>(invalid).is_err());
    }
    let mut signature = serde_json::json!({
        "document":{"path":"demo.txt","languageId":"demo","revision":1,"text":"["},
        "position":{"lineIndex":0,"columnIndex":1}, "triggerKind":"triggerCharacter", "triggerCharacter":"["
    });
    let decoded: LanguageSignatureHelpParams = serde_json::from_value(signature.clone()).unwrap();
    assert!(!decoded.is_retrigger);
    signature["isRetrigger"] = serde_json::json!(true);
    let decoded: LanguageSignatureHelpParams = serde_json::from_value(signature.clone()).unwrap();
    assert!(decoded.is_retrigger);
    assert_eq!(serde_json::to_value(decoded).unwrap(), signature);
}

#[test]
fn repository_discovery_can_request_watched_status_without_changing_legacy_responses() {
    use crate::protocol::git::GitDiscoveryParams;
    use crate::protocol::git::GitRepositoriesResult;
    let legacy: GitDiscoveryParams = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(legacy.include_status, None);
    assert_eq!(serde_json::to_value(legacy).unwrap(), serde_json::json!({}));
    let requested: GitDiscoveryParams =
        serde_json::from_value(serde_json::json!({"includeStatus": true})).unwrap();
    assert_eq!(requested.include_status, Some(true));
    let legacy: GitRepositoriesResult =
        serde_json::from_value(serde_json::json!({"repositories": []})).unwrap();
    assert_eq!(legacy.statuses, None);
    assert_eq!(
        serde_json::to_value(legacy).unwrap(),
        serde_json::json!({"repositories": []})
    );
    let watched: GitRepositoriesResult =
        serde_json::from_value(serde_json::json!({"repositories": [], "statuses": []})).unwrap();
    assert_eq!(watched.statuses, Some(Vec::new()));
}

#[test]
fn backup_page_and_legacy_list_contracts_round_trip() {
    use crate::protocol::backup::BackupListPageParams;
    use crate::protocol::backup::BackupListPageResult;
    use crate::protocol::backup::BackupListParams;
    let legacy = serde_json::json!({"clientId":"editor", "workspaceId":"workspace"});
    let decoded: BackupListParams = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    for after in [serde_json::Value::Null, serde_json::json!("untitled:note")] {
        let page = serde_json::json!({"clientId":"editor", "workspaceId":"workspace", "afterResource":after});
        let decoded: BackupListPageParams = serde_json::from_value(page.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), page);
    }
    let empty = serde_json::json!({"backups":[], "nextResource":null});
    let decoded: BackupListPageResult = serde_json::from_value(empty.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), empty);
}

#[test]
fn commit_options_preserve_legacy_requests_and_reject_unknown_intents() {
    let legacy = serde_json::json!({ "repositoryId": "repository", "message": "staged commit" });
    let decoded: GitCommitParams = serde_json::from_value(legacy.clone()).unwrap();
    assert!(decoded.scope.is_none());
    assert!(decoded.mode.is_none());
    assert!(decoded.signoff.is_none());
    assert!(decoded.signing.is_none());
    assert!(decoded.empty.is_none());
    assert!(decoded.expected_head.is_none());
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    for scope in ["staged", "tracked", "includeUntracked"] {
        for mode in ["create", "amend"] {
            for signoff in ["none", "add"] {
                let request = serde_json::json!({ "repositoryId": "repository", "message": "complete body", "scope": scope, "mode": mode, "signoff": signoff });
                let decoded: GitCommitParams = serde_json::from_value(request.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), request);
            }
        }
    }
    for signing in ["configured", "required"] {
        for empty in ["reject", "allow"] {
            let request = serde_json::json!({ "message": "explicit intent", "signing": signing, "empty": empty });
            let decoded: GitCommitParams = serde_json::from_value(request.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), request);
        }
    }
    for (field, value) in [
        ("scope", "all"),
        ("mode", "reset"),
        ("signoff", "gpg"),
        ("signing", "unsignedFallback"),
        ("empty", "automatic"),
    ] {
        let mut invalid = legacy.clone();
        invalid[field] = serde_json::json!(value);
        assert!(serde_json::from_value::<GitCommitParams>(invalid).is_err());
    }
}

#[test]
fn amend_target_round_trips_branch_and_detached_identity() {
    for head in [
        serde_json::json!({"type":"branch","name":"main","objectId":"a".repeat(40),"upstream":null}),
        serde_json::json!({"type":"branch","name":"main","objectId":"a".repeat(40),"upstream":{"name":"origin/main","ahead":3,"behind":2}}),
        serde_json::json!({"type":"detached","objectId":"a".repeat(40)}),
    ] {
        let request =
            serde_json::json!({"message":"Full message","mode":"amend","expectedHead":head});
        let decoded: GitCommitParams = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), request);
    }
    let invalid = serde_json::json!({"message":"message","mode":"amend","expectedHead":{"type":"tag","objectId":"a".repeat(40)}});
    assert!(serde_json::from_value::<GitCommitParams>(invalid).is_err());
}

fn initialization() -> InitializeResult {
    InitializeResult {
        server_info: ServerInfo {
            name: "ash-app-server".into(),
            version: "test".into(),
            operating_system: None,
            user_home: None,
        },
        protocol_version: ProtocolVersion::current(),
        schema_hash: SchemaHash(crate::schema_hash()),
        capabilities: ServerCapabilities {
            sessions: true,
            threads: true,
            turns: true,
            ..ServerCapabilities::default()
        },
        slash_commands: Vec::new(),
    }
}

#[test]
fn server_path_platform_round_trips_and_rejects_unknown_values() {
    for (os, wire) in [
        (ServerOperatingSystem::Windows, "windows"),
        (ServerOperatingSystem::Mac, "mac"),
        (ServerOperatingSystem::Linux, "linux"),
    ] {
        let value =
            serde_json::json!({"name":"ash-app-server","version":"test","operatingSystem":wire});
        let decoded: ServerInfo = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(decoded.operating_system, Some(os));
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    let legacy = serde_json::json!({"name":"ash-app-server","version":"test"});
    let decoded: ServerInfo = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(decoded.operating_system, None);
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    assert!(serde_json::from_value::<ServerInfo>(serde_json::json!({"name":"ash-app-server","version":"test","operatingSystem":"unknown"})).is_err());
}

#[test]
fn server_user_home_round_trips_independently_of_the_data_root() {
    let value = serde_json::json!({"name":"ash-app-server","version":"test","operatingSystem":"windows","userHome":"C:\\Users\\ash"});
    let decoded: ServerInfo = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(decoded.user_home.as_deref(), Some("C:\\Users\\ash"));
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    assert!(
        serde_json::from_value::<ServerInfo>(
            serde_json::json!({"name":"ash-app-server","version":"test","userHome":42})
        )
        .is_err()
    );
}

#[test]
fn a_matching_schema_requires_no_manual_session_contract_versions() {
    assert_eq!(
        ensure_protocol_compatible(&initialization(), REQUIRED_SESSION_CAPABILITIES),
        Ok(())
    );
}

#[test]
fn schema_mismatch_rejects_an_old_backend_before_it_can_ignore_request_fields() {
    let mut initialized = initialization();
    let old_schema = format!("sha256:{}", "0".repeat(64));
    initialized.schema_hash = SchemaHash(old_schema.clone());
    assert_eq!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::SchemaHash {
            expected: crate::schema_hash(),
            received: old_schema
        })
    );
}

#[test]
fn protocol_major_mismatch_is_fatal() {
    let mut initialized = initialization();
    initialized.protocol_version.major = APP_SERVER_PROTOCOL_MAJOR + 1;
    assert!(matches!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::MajorVersion { .. })
    ));
}

#[test]
fn disabled_required_capability_is_fatal_even_with_a_matching_schema() {
    let mut initialized = initialization();
    initialized.capabilities.turns = false;
    assert_eq!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::MissingCapability { name: "turns" })
    );
}

#[test]
fn optional_contracts_keep_their_independent_version_and_availability_checks() {
    let mut initialized = initialization();
    let requirements = &[CapabilityRequirement::exact("taskDelivery", 1)];
    assert_eq!(
        ensure_protocol_compatible(&initialized, requirements),
        Err(ProtocolCompatibilityError::MissingCapability {
            name: "taskDelivery"
        })
    );
    initialized
        .capabilities
        .contracts
        .insert("taskDelivery".into(), CapabilityContract { version: 1 });
    assert_eq!(
        ensure_protocol_compatible(&initialized, requirements),
        Ok(())
    );
    initialized
        .capabilities
        .contracts
        .insert("taskDelivery".into(), CapabilityContract { version: 2 });
    assert_eq!(
        ensure_protocol_compatible(&initialized, requirements),
        Err(ProtocolCompatibilityError::CapabilityVersion {
            name: "taskDelivery",
            min_version: 1,
            max_version: 1,
            received: 2
        })
    );
    initialized
        .capabilities
        .contracts
        .insert("github".into(), CapabilityContract { version: 1 });
    assert_eq!(
        ensure_protocol_compatible(&initialized, &[CapabilityRequirement::exact("github", 1)]),
        Err(ProtocolCompatibilityError::MissingCapability { name: "github" })
    );
}

#[test]
fn explicit_unlock_options_preserve_existing_byte_write_requests() {
    use crate::protocol::fs::FsFileWriteOptions;
    let legacy = serde_json::json!({"mode":"replace", "expectedRevision":"revision"});
    let decoded: FsFileWriteOptions = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(decoded.unlock, None);
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    let unlock =
        serde_json::json!({"mode":"replace", "expectedRevision":"revision", "unlock":true});
    let decoded: FsFileWriteOptions = serde_json::from_value(unlock.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), unlock);
    assert!(
        serde_json::from_value::<FsFileWriteOptions>(
            serde_json::json!({"mode":"replace", "unlock":"yes"})
        )
        .is_err()
    );
}

#[test]
fn terminal_prompt_type_remains_optional_and_round_trips_output_order() {
    use crate::protocol::terminal::TerminalShellIntegration;
    let mut value = serde_json::json!({
        "commandDetection": false, "cwdDetection": false,
        "hasRichCommandDetection": false, "commandStorageDisabled": false,
        "commands": [], "afterOutputSequence": 7,
    });
    let legacy: TerminalShellIntegration = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(legacy.prompt_type, None);
    assert_eq!(serde_json::to_value(legacy).unwrap(), value);
    value["promptType"] = serde_json::json!("starship");
    let current: TerminalShellIntegration = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(current.prompt_type.as_deref(), Some("starship"));
    assert_eq!(current.after_output_sequence, 7);
    assert_eq!(serde_json::to_value(current).unwrap(), value);
}

#[test]
fn directory_grants_use_canonical_contract_names_and_exact_permissions() {
    use crate::protocol::config::DirectoryGrantsReadResult;
    use crate::protocol::config::DirectoryGrantsSetParams;
    use crate::protocol::registry::ClientMethod;
    use ts_rs::TS;

    assert_eq!(
        ClientMethod::DirectoryGrantsRead.as_str(),
        "config/directoryGrants/read"
    );
    assert_eq!(
        ClientMethod::DirectoryGrantsList.as_str(),
        "config/directoryGrants/list"
    );
    assert_eq!(
        ClientMethod::DirectoryGrantsSet.as_str(),
        "config/directoryGrants/set"
    );
    assert_eq!(
        ClientMethod::DirectoryGrantsForget.as_str(),
        "config/directoryGrants/forget"
    );
    assert_eq!(
        DirectoryGrantsSetParams::name(&ts_rs::Config::default()),
        "DirectoryGrantsSetParams"
    );
    let request = serde_json::json!({"commandId":"directory-grant", "expectedRevision":7, "path":"/tmp/project", "permissions":["readFiles", "useLanguageServices"]});
    let decoded: DirectoryGrantsSetParams = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), request);
    let dir = format!("sha256:{}", "ab".repeat(32));
    for reply in [
        serde_json::json!({"dir":dir}),
        serde_json::json!({"dir":dir, "permissions":[]}),
    ] {
        let decoded: DirectoryGrantsReadResult = serde_json::from_value(reply.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), reply);
    }
    let mut invalid = request;
    invalid["permissions"] = serde_json::json!(["unknownCapability"]);
    assert!(serde_json::from_value::<DirectoryGrantsSetParams>(invalid).is_err());
}

#[test]
fn directory_grants_host_has_one_wire_name_and_old_methods_are_unregistered() {
    use crate::protocol::common::ClientCapabilities;
    use crate::protocol::common::DirectoryGrantsHostCapability;
    use crate::protocol::registry::client_method;
    use crate::protocol::registry::client_method_definition;
    use ts_rs::TS;

    let capabilities = ClientCapabilities {
        directory_grants_host: Some(DirectoryGrantsHostCapability { version: 1 }),
        ..ClientCapabilities::default()
    };
    let encoded = serde_json::to_value(&capabilities).unwrap();
    assert_eq!(
        encoded["directoryGrantsHost"],
        serde_json::json!({"version":1})
    );
    assert!(encoded.get("dirPermissionsHost").is_none());
    assert_eq!(
        serde_json::from_value::<ClientCapabilities>(encoded).unwrap(),
        capabilities
    );
    assert_eq!(
        DirectoryGrantsHostCapability::name(&ts_rs::Config::default()),
        "DirectoryGrantsHostCapability"
    );
    assert!(client_method("session/dirs/permissions/set").is_none());
    assert!(client_method_definition("session/dirs/permissions/set").is_none());
    assert!(client_method("session/directoryGrants/set").is_some());
    // Unknown initialize fields cannot become authority, even on a product connection.
    let legacy: ClientCapabilities =
        serde_json::from_value(serde_json::json!({"dirPermissionsHost":{"version":1}})).unwrap();
    assert!(legacy.directory_grants_host.is_none());
    for action in ["read", "list", "set", "forget"] {
        assert!(client_method(&format!("config/dirPermissions/{action}")).is_none());
        assert!(client_method_definition(&format!("config/dirPermissions/{action}")).is_none());
        assert!(client_method(&format!("config/directoryGrants/{action}")).is_some());
    }
}

#[test]
fn backup_move_contract_uses_revisions_and_rejects_unknown_fields() {
    use crate::protocol::backup::BackupMoveParams;
    use crate::protocol::backup::BackupMoveResult;
    let value = serde_json::json!({"clientId":"editor","sourceWorkspaceId":"old","workspace":{"id":"new","folders":[],"configuration":null,"remoteAuthority":null},"backups":[{"resource":"untitled:/note","revision":"observed"}]});
    let decoded: BackupMoveParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    let mut invalid = value;
    invalid["backups"][0]["content"] = serde_json::json!("untrusted");
    assert!(serde_json::from_value::<BackupMoveParams>(invalid).is_err());
    let response =
        serde_json::json!({"backups":[{"resource":"untitled:/note","revision":"committed"}]});
    let decoded: BackupMoveResult = serde_json::from_value(response.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), response);
}
