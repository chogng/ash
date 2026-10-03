use crate::protocol::common::SchemaHash;
use crate::protocol::common::ServerInfo;
use crate::protocol::initialize::APP_SERVER_CAPABILITY_VERSION;
use crate::protocol::initialize::APP_SERVER_PROTOCOL_MAJOR;
use crate::protocol::initialize::CapabilityContract;
use crate::protocol::initialize::InitializeResult;
use crate::protocol::initialize::ProtocolCompatibilityError;
use crate::protocol::initialize::ProtocolVersion;
use crate::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use crate::protocol::initialize::ServerCapabilities;
use crate::protocol::initialize::ensure_protocol_compatible;
use std::collections::BTreeMap;

fn initialization() -> InitializeResult {
    InitializeResult {
        server_info: ServerInfo {
            name: "ash-app-server".into(),
            version: "test".into(),
        },
        protocol_version: ProtocolVersion::current(),
        schema_hash: SchemaHash("different-schema-is-diagnostic-only".into()),
        capabilities: ServerCapabilities {
            sessions: true,
            threads: true,
            turns: true,
            contracts: BTreeMap::from([
                ("sessions".into(), CapabilityContract::current()),
                ("threads".into(), CapabilityContract::current()),
                ("turns".into(), CapabilityContract::current()),
            ]),
            ..ServerCapabilities::default()
        },
        slash_commands: Vec::new(),
    }
}

#[test]
fn schema_drift_does_not_make_a_compatible_protocol_fatal() {
    assert_eq!(
        ensure_protocol_compatible(&initialization(), REQUIRED_SESSION_CAPABILITIES),
        Ok(())
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
fn missing_or_disabled_required_capability_is_fatal() {
    let mut missing = initialization();
    missing.capabilities.contracts.remove("turns");
    assert!(matches!(
        ensure_protocol_compatible(&missing, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::MissingCapability { name: "turns", .. })
    ));

    let mut disabled = initialization();
    disabled.capabilities.turns = false;
    assert!(matches!(
        ensure_protocol_compatible(&disabled, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::MissingCapability { name: "turns", .. })
    ));
}

#[test]
fn unsupported_required_capability_version_is_fatal() {
    let mut initialized = initialization();
    let unsupported = APP_SERVER_CAPABILITY_VERSION + 1;
    initialized.capabilities.contracts.insert(
        "turns".into(),
        CapabilityContract {
            version: unsupported,
        },
    );

    assert!(matches!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::CapabilityVersion {
            name: "turns",
            received,
            ..
        }) if received == unsupported
    ));
}

#[test]
fn an_old_backend_cannot_silently_ignore_a_requested_root_role() {
    let mut initialized = initialization();
    initialized.protocol_version.major = 1;
    assert!(matches!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::MajorVersion { .. })
    ));
}

#[test]
fn an_older_turn_contract_cannot_silently_ignore_time_context_policy() {
    let mut initialized = initialization();
    initialized.capabilities.contracts.insert(
        "turns".into(),
        CapabilityContract {
            version: APP_SERVER_CAPABILITY_VERSION - 1,
        },
    );
    assert!(matches!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::CapabilityVersion { name: "turns", .. })
    ));
}
#[test]
fn permission_id_contract_rejects_a_server_using_the_previous_ids() {
    let mut initialized = initialization();
    initialized
        .capabilities
        .contracts
        .insert("turns".into(), CapabilityContract { version: 11 });
    assert!(matches!(
        ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES),
        Err(ProtocolCompatibilityError::CapabilityVersion {
            name: "turns",
            received: 11,
            ..
        })
    ));
}
