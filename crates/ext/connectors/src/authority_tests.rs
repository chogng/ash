use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::ConnectorAccount;
use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorConnectionState;
use crate::ConnectorCredentialRef;
use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorRuntimeBinding;
use tempfile::tempdir;

use crate::ConnectorAuthority;
use crate::ConnectorAuthorityCommand;
use crate::ConnectorAuthorityErrorKind;
use crate::ConnectorCommandDisposition;
use crate::ConnectorCommandId;
use crate::ConnectorCommandRequest;

fn definition(server: &str) -> ConnectorDefinition {
    ConnectorDefinition::new(
        ConnectorId::new("acme/github:connector:account").unwrap(),
        "GitHub account",
        "Connect one GitHub account.",
        ConnectorRuntimeBinding::mcp_server(server).unwrap(),
    )
    .unwrap()
}

fn account(generation: ConnectorConnectionGeneration) -> ConnectorAccount {
    ConnectorAccount::new(
        ConnectorAccountId::new("octocat").unwrap(),
        "Octocat",
        ConnectorCredentialRef::new("connector/acme-github/1").unwrap(),
        generation,
    )
    .unwrap()
}

fn request(
    authority: &ConnectorAuthority,
    command_id: &str,
    command: ConnectorAuthorityCommand,
) -> ConnectorCommandRequest {
    ConnectorCommandRequest {
        command_id: ConnectorCommandId::new(command_id).unwrap(),
        expected_generation: authority.snapshot().generation(),
        connector_id: ConnectorId::new("acme/github:connector:account").unwrap(),
        command,
    }
}

fn connect(authority: &ConnectorAuthority) -> ConnectorConnectionGeneration {
    let generation = ConnectorConnectionGeneration::new(1);
    authority
        .apply(request(
            authority,
            "begin-connect",
            ConnectorAuthorityCommand::BeginConnect { generation },
        ))
        .unwrap();
    authority
        .apply(request(
            authority,
            "complete-connect",
            ConnectorAuthorityCommand::CompleteConnect {
                account: account(generation),
            },
        ))
        .unwrap();
    generation
}

#[test]
fn memory_authority_replays_exact_commands_and_rejects_conflicts() {
    let authority =
        ConnectorAuthority::in_memory([definition("plugin:acme/github:mcp:github")]).unwrap();
    let generation = ConnectorConnectionGeneration::new(1);
    let request = request(
        &authority,
        "begin-connect",
        ConnectorAuthorityCommand::BeginConnect { generation },
    );

    let updated = authority.apply(request.clone()).unwrap();
    let replayed = authority.apply(request.clone()).unwrap();
    assert_eq!(updated.disposition, ConnectorCommandDisposition::Updated);
    assert_eq!(replayed.disposition, ConnectorCommandDisposition::Replayed);
    assert_eq!(updated.generation, replayed.generation);

    let conflict = authority
        .apply(ConnectorCommandRequest {
            command: ConnectorAuthorityCommand::Disconnect {
                generation: ConnectorConnectionGeneration::new(2),
            },
            ..request
        })
        .unwrap_err();
    assert_eq!(
        conflict.kind(),
        ConnectorAuthorityErrorKind::CommandConflict
    );
}

#[test]
fn authority_publishes_generation_and_fences_disconnected_bindings() {
    let connector = definition("plugin:acme/github:mcp:github");
    let definition_digest = connector.digest();
    let connector_id = connector.id().clone();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    let subscription = authority.subscribe();
    let connection_generation = connect(&authority);

    assert_eq!(
        subscription
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .get(),
        2
    );
    assert!(authority.authorizes(&connector_id, connection_generation, &definition_digest));

    authority
        .apply(request(
            &authority,
            "disconnect",
            ConnectorAuthorityCommand::Disconnect {
                generation: ConnectorConnectionGeneration::new(2),
            },
        ))
        .unwrap();
    assert!(!authority.authorizes(&connector_id, connection_generation, &definition_digest));
}

#[test]
fn disconnect_waits_for_an_authorized_invocation_then_fences_future_calls() {
    let connector = definition("plugin:acme/github:mcp:github");
    let definition_digest = connector.digest();
    let connector_id = connector.id().clone();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    let connection_generation = connect(&authority);
    let expected_generation = authority.snapshot().generation();
    let invocation_authority = authority.clone();
    let invocation_connector_id = connector_id.clone();
    let invocation_digest = definition_digest.clone();
    let (entered_sender, entered_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let invocation = thread::spawn(move || {
        invocation_authority.with_authorized_invocation(
            &invocation_connector_id,
            connection_generation,
            &invocation_digest,
            || {
                entered_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            },
        )
    });
    entered_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("invocation acquired exact Connector authority");

    let disconnect_authority = authority.clone();
    let disconnect_connector_id = connector_id.clone();
    let (disconnected_sender, disconnected_receiver) = mpsc::channel();
    let disconnect = thread::spawn(move || {
        let result = disconnect_authority.apply(ConnectorCommandRequest {
            command_id: ConnectorCommandId::new("draining-disconnect").unwrap(),
            expected_generation,
            connector_id: disconnect_connector_id,
            command: ConnectorAuthorityCommand::Disconnect {
                generation: ConnectorConnectionGeneration::new(2),
            },
        });
        disconnected_sender.send(()).unwrap();
        result
    });
    assert!(matches!(
        disconnected_receiver.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));

    release_sender.send(()).unwrap();
    assert!(invocation.join().unwrap().is_some());
    disconnect.join().unwrap().unwrap();
    disconnected_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("disconnect completes after invocation drain");
    assert!(!authority.authorizes(&connector_id, connection_generation, &definition_digest));
}

#[test]
fn catalog_reconcile_retires_and_restores_exact_connector_state() {
    let connector = definition("plugin:acme/github:mcp:github");
    let connector_id = connector.id().clone();
    let authority = ConnectorAuthority::in_memory([connector.clone()]).unwrap();
    let connection_generation = connect(&authority);

    let removed_generation = authority.reconcile_definitions(std::iter::empty()).unwrap();
    assert!(authority.snapshot().entry(&connector_id).is_none());
    assert!(removed_generation.get() > 1);

    authority.reconcile_definitions([connector]).unwrap();
    let restored = authority.snapshot();
    let entry = restored.entry(&connector_id).unwrap();
    assert_eq!(entry.connection().generation(), connection_generation);
    assert!(matches!(
        entry.connection().state(),
        ConnectorConnectionState::Connected(_)
    ));
}

#[test]
fn catalog_reconcile_requires_reauthorization_for_a_changed_definition() {
    let connector = definition("plugin:acme/github:mcp:github");
    let connector_id = connector.id().clone();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    connect(&authority);

    authority
        .reconcile_definitions([definition("plugin:acme/github:mcp:github-v2")])
        .unwrap();
    assert!(matches!(
        authority
            .snapshot()
            .entry(&connector_id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::ReauthorizationRequired { .. }
    ));
}

#[test]
fn sqlite_authority_restores_connection_and_receipts_after_restart() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("connectors.sqlite3");
    let connector = definition("plugin:acme/github:mcp:github");
    let connector_id = connector.id().clone();
    let definition_digest = connector.digest();
    let generation;
    {
        let authority = ConnectorAuthority::open_sqlite(&path, [connector.clone()]).unwrap();
        generation = connect(&authority);
        assert!(authority.authorizes(&connector_id, generation, &definition_digest));
    }

    let reopened = ConnectorAuthority::open_sqlite(&path, [connector]).unwrap();
    assert!(reopened.authorizes(&connector_id, generation, &definition_digest));
    let replay = reopened
        .apply(ConnectorCommandRequest {
            command_id: ConnectorCommandId::new("complete-connect").unwrap(),
            expected_generation: crate::ConnectorSnapshotGeneration::new(2),
            connector_id,
            command: ConnectorAuthorityCommand::CompleteConnect {
                account: account(generation),
            },
        })
        .unwrap();
    assert_eq!(replay.disposition, ConnectorCommandDisposition::Replayed);
    assert_eq!(replay.generation.get(), 3);
}

#[test]
fn sqlite_authority_persists_catalog_only_generations() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("connectors.sqlite3");
    let generation = {
        let authority = ConnectorAuthority::open_sqlite(&path, [definition("server")]).unwrap();
        authority.reconcile_definitions(std::iter::empty()).unwrap()
    };

    let reopened = ConnectorAuthority::open_sqlite(&path, std::iter::empty()).unwrap();
    assert_eq!(reopened.snapshot().generation(), generation);
}

#[test]
fn sqlite_authority_recovers_an_interrupted_connect_as_unavailable() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("connectors.sqlite3");
    let connector = definition("plugin:acme/github:mcp:github");
    let connector_id = connector.id().clone();
    {
        let authority = ConnectorAuthority::open_sqlite(&path, [connector.clone()]).unwrap();
        authority
            .apply(request(
                &authority,
                "begin-interrupted",
                ConnectorAuthorityCommand::BeginConnect {
                    generation: ConnectorConnectionGeneration::new(1),
                },
            ))
            .unwrap();
    }

    let reopened = ConnectorAuthority::open_sqlite(&path, [connector]).unwrap();
    assert!(matches!(
        reopened
            .snapshot()
            .entry(&connector_id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::Unavailable { reason }
            if reason == "Connector authorization was interrupted"
    ));
}

#[test]
fn sqlite_authority_recovers_pending_credential_cleanup() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("connectors.sqlite3");
    let connector = definition("plugin:acme/github:mcp:github");
    let connector_id = connector.id().clone();
    {
        let authority = ConnectorAuthority::open_sqlite(&path, [connector.clone()]).unwrap();
        connect(&authority);
        authority
            .apply(request(
                &authority,
                "disconnect-pending-cleanup",
                ConnectorAuthorityCommand::Disconnect {
                    generation: ConnectorConnectionGeneration::new(2),
                },
            ))
            .unwrap();
        assert!(authority.credential_cleanup_pending(&connector_id));
    }

    let reopened = ConnectorAuthority::open_sqlite(&path, [connector]).unwrap();
    assert!(reopened.credential_cleanup_pending(&connector_id));
    reopened.complete_credential_cleanup(&connector_id).unwrap();
    drop(reopened);

    let reopened = ConnectorAuthority::open_sqlite(&path, std::iter::empty()).unwrap();
    assert!(!reopened.credential_cleanup_pending(&connector_id));
}

#[test]
fn changed_definition_restores_as_reauthorization_required() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("connectors.sqlite3");
    {
        let authority =
            ConnectorAuthority::open_sqlite(&path, [definition("plugin:acme/github:mcp:github")])
                .unwrap();
        connect(&authority);
    }

    let changed = definition("plugin:acme/github:mcp:github-v2");
    let id = changed.id().clone();
    let authority = ConnectorAuthority::open_sqlite(&path, [changed]).unwrap();

    assert!(matches!(
        authority
            .snapshot()
            .entry(&id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::ReauthorizationRequired { .. }
    ));
}
