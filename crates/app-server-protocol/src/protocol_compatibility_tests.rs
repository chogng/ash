use crate::protocol::common::SchemaHash;
use crate::protocol::common::ServerInfo;
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

fn initialization() -> InitializeResult {
    InitializeResult {
        server_info: ServerInfo {
            name: "ash-app-server".into(),
            version: "test".into(),
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
