use crate::ConnectorAccount;
use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorConnectionState;
use crate::ConnectorConnectionUpdate;
use crate::ConnectorCredentialRef;
use crate::ConnectorDefinition;
use crate::ConnectorDefinitionDigest;
use crate::ConnectorErrorKind;
use crate::ConnectorId;
use crate::ConnectorRuntimeBinding;
use crate::ConnectorSnapshot;
use crate::ConnectorSnapshotGeneration;

fn definition(id: &str) -> ConnectorDefinition {
    ConnectorDefinition::new(
        ConnectorId::new(id).unwrap(),
        "GitHub",
        "Connect a GitHub account.",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap()
}

fn connected_account(generation: ConnectorConnectionGeneration) -> ConnectorAccount {
    ConnectorAccount::new(
        ConnectorAccountId::new("octocat").unwrap(),
        "Octocat",
        ConnectorCredentialRef::new("secret:github-octocat").unwrap(),
        generation,
    )
    .unwrap()
}

#[test]
fn snapshot_rejects_duplicate_connector_identity() {
    let error = ConnectorSnapshot::new(
        ConnectorSnapshotGeneration::new(1),
        [definition("acme:github"), definition("acme:github")],
    )
    .unwrap_err();

    assert_eq!(error.kind(), ConnectorErrorKind::DuplicateIdentity);
}

#[test]
fn definition_digest_is_stable_and_runtime_sensitive() {
    let original = definition("acme:github");
    let same = definition("acme:github");
    let changed = ConnectorDefinition::new(
        ConnectorId::new("acme:github").unwrap(),
        "GitHub",
        "Connect a GitHub account.",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github-v2").unwrap(),
    )
    .unwrap();

    assert_eq!(original.digest(), same.digest());
    assert_ne!(original.digest(), changed.digest());
    assert!(original.digest().as_str().starts_with("sha256:"));

    let display_only = ConnectorDefinition::new(
        ConnectorId::new("acme:github").unwrap(),
        "GitHub renamed",
        "Updated marketing copy.",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap();
    assert_eq!(original.digest(), display_only.digest());

    let revised = original
        .clone()
        .with_authorization_revision("sha256:runtime-v2")
        .unwrap();
    assert_ne!(original.digest(), revised.digest());
}

#[test]
fn connection_requires_begin_and_matching_generation() {
    let snapshot = ConnectorSnapshot::new(
        ConnectorSnapshotGeneration::new(1),
        [definition("acme:github")],
    )
    .unwrap();
    let id = ConnectorId::new("acme:github").unwrap();
    let connection_generation = ConnectorConnectionGeneration::new(1);

    let direct_connect_error = snapshot
        .with_connection_update(
            ConnectorSnapshotGeneration::new(2),
            &id,
            ConnectorConnectionUpdate::Connected {
                account: connected_account(connection_generation),
            },
        )
        .unwrap_err();
    assert_eq!(
        direct_connect_error.kind(),
        ConnectorErrorKind::InvalidTransition
    );

    let connecting = snapshot
        .with_connection_update(
            ConnectorSnapshotGeneration::new(2),
            &id,
            ConnectorConnectionUpdate::Begin {
                generation: connection_generation,
            },
        )
        .unwrap();
    let connected = connecting
        .with_connection_update(
            ConnectorSnapshotGeneration::new(3),
            &id,
            ConnectorConnectionUpdate::Connected {
                account: connected_account(connection_generation),
            },
        )
        .unwrap();

    assert!(connected.entry(&id).unwrap().is_ready());
    assert_eq!(connected.ready_entries().count(), 1);
}

#[test]
fn stale_snapshot_or_connection_updates_fail_closed() {
    let id = ConnectorId::new("acme:github").unwrap();
    let snapshot = ConnectorSnapshot::new(
        ConnectorSnapshotGeneration::new(5),
        [definition(id.as_str())],
    )
    .unwrap();

    let stale_snapshot = snapshot
        .with_connection_update(
            ConnectorSnapshotGeneration::new(5),
            &id,
            ConnectorConnectionUpdate::Begin {
                generation: ConnectorConnectionGeneration::new(1),
            },
        )
        .unwrap_err();
    assert_eq!(stale_snapshot.kind(), ConnectorErrorKind::StaleGeneration);

    let connecting = snapshot
        .with_connection_update(
            ConnectorSnapshotGeneration::new(6),
            &id,
            ConnectorConnectionUpdate::Begin {
                generation: ConnectorConnectionGeneration::new(2),
            },
        )
        .unwrap();
    let stale_connection = connecting
        .with_connection_update(
            ConnectorSnapshotGeneration::new(7),
            &id,
            ConnectorConnectionUpdate::Connected {
                account: connected_account(ConnectorConnectionGeneration::new(1)),
            },
        )
        .unwrap_err();
    assert_eq!(stale_connection.kind(), ConnectorErrorKind::StaleGeneration);
}

#[test]
fn disconnect_revokes_runtime_readiness_under_new_generations() {
    let id = ConnectorId::new("acme:github").unwrap();
    let connection_generation = ConnectorConnectionGeneration::new(1);
    let snapshot = ConnectorSnapshot::new(
        ConnectorSnapshotGeneration::new(1),
        [definition(id.as_str())],
    )
    .unwrap()
    .with_connection_update(
        ConnectorSnapshotGeneration::new(2),
        &id,
        ConnectorConnectionUpdate::Begin {
            generation: connection_generation,
        },
    )
    .unwrap()
    .with_connection_update(
        ConnectorSnapshotGeneration::new(3),
        &id,
        ConnectorConnectionUpdate::Connected {
            account: connected_account(connection_generation),
        },
    )
    .unwrap();

    let disconnected = snapshot
        .with_connection_update(
            ConnectorSnapshotGeneration::new(4),
            &id,
            ConnectorConnectionUpdate::Disconnect {
                generation: ConnectorConnectionGeneration::new(2),
            },
        )
        .unwrap();

    assert!(matches!(
        disconnected.entry(&id).unwrap().connection().state(),
        ConnectorConnectionState::Disconnected
    ));
    assert_eq!(disconnected.ready_entries().count(), 0);
}

#[test]
fn definition_change_requires_reauthorization_and_revokes_readiness() {
    let id = ConnectorId::new("acme:github").unwrap();
    let definition = definition(id.as_str());
    let previous_definition: ConnectorDefinitionDigest = definition.digest();
    let connection_generation = ConnectorConnectionGeneration::new(1);
    let connected = ConnectorSnapshot::new(ConnectorSnapshotGeneration::new(1), [definition])
        .unwrap()
        .with_connection_update(
            ConnectorSnapshotGeneration::new(2),
            &id,
            ConnectorConnectionUpdate::Begin {
                generation: connection_generation,
            },
        )
        .unwrap()
        .with_connection_update(
            ConnectorSnapshotGeneration::new(3),
            &id,
            ConnectorConnectionUpdate::Connected {
                account: connected_account(connection_generation),
            },
        )
        .unwrap();

    let reauthorization = connected
        .with_connection_update(
            ConnectorSnapshotGeneration::new(4),
            &id,
            ConnectorConnectionUpdate::DefinitionChanged {
                previous_definition: previous_definition.clone(),
            },
        )
        .unwrap();

    assert!(!reauthorization.entry(&id).unwrap().is_ready());
    assert!(matches!(
        reauthorization.entry(&id).unwrap().connection().state(),
        ConnectorConnectionState::ReauthorizationRequired {
            previous_definition: actual,
            ..
        } if actual == &previous_definition
    ));
}
