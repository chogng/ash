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
fn commit_options_preserve_legacy_requests_and_reject_unknown_intents() {
    let legacy = serde_json::json!({ "repositoryId": "repository", "message": "staged commit" });
    let decoded: GitCommitParams = serde_json::from_value(legacy.clone()).unwrap();
    assert!(decoded.scope.is_none());
    assert!(decoded.mode.is_none());
    assert!(decoded.signoff.is_none());
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
    for (field, value) in [("scope", "all"), ("mode", "reset"), ("signoff", "gpg")] {
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
