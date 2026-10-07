use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use crate::ConnectorAccountId;
use crate::ConnectorConnectionState;
use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorRuntimeBinding;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretStoreErrorKind;
use ash_secrets::SecretValue;

use crate::ConnectorApiTokenConnectRequest;
use crate::ConnectorAuthority;
use crate::ConnectorCommandDisposition;
use crate::ConnectorCommandId;
use crate::ConnectorCredentialCleanup;
use crate::ConnectorCredentialService;

fn definition() -> ConnectorDefinition {
    ConnectorDefinition::new(
        ConnectorId::new("acme/github:connector:account").unwrap(),
        "GitHub account",
        "Connect one GitHub account.",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap()
}

struct FailingDeleteSecretStore {
    inner: MemorySecretStore,
    fail_delete: AtomicBool,
}

impl FailingDeleteSecretStore {
    fn new() -> Self {
        Self {
            inner: MemorySecretStore::default(),
            fail_delete: AtomicBool::new(true),
        }
    }
}

impl SecretStore for FailingDeleteSecretStore {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        self.inner.load(key)
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.inner.store(key, value)
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        if self.fail_delete.load(Ordering::SeqCst) {
            Err(SecretStoreError::new(
                SecretStoreErrorKind::BackendUnavailable,
                "test secret store unavailable",
            ))
        } else {
            self.inner.delete(key)
        }
    }
}

#[test]
fn api_token_connection_stores_only_a_reference_and_disconnect_deletes_secret() {
    let definition = definition();
    let connector_id = definition.id().clone();
    let authority = ConnectorAuthority::in_memory([definition]).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConnectorCredentialService::new(authority, secrets.clone());

    service
        .connect_api_token(ConnectorApiTokenConnectRequest {
            command_id: ConnectorCommandId::new("connect-github").unwrap(),
            expected_generation: service.authority().snapshot().generation(),
            connector_id: connector_id.clone(),
            connection_generation: crate::ConnectorConnectionGeneration::new(1),
            account_id: ConnectorAccountId::new("octocat").unwrap(),
            account_display_name: "Octocat".into(),
            token: SecretValue::new(b"secret-token".to_vec()),
        })
        .unwrap();

    let snapshot = service.authority().snapshot();
    let credential_reference = match snapshot.entry(&connector_id).unwrap().connection().state() {
        ConnectorConnectionState::Connected(account) => {
            account.credential_reference().as_str().to_string()
        }
        state => panic!("expected connected account, got {state:?}"),
    };
    let key = SecretKey::new(credential_reference).unwrap();
    assert_eq!(
        secrets.load(&key).unwrap().unwrap().expose(),
        b"secret-token"
    );

    let disconnected = service
        .disconnect(
            ConnectorCommandId::new("disconnect-github").unwrap(),
            snapshot.generation(),
            connector_id.clone(),
        )
        .unwrap();
    assert_eq!(
        disconnected.credential_cleanup,
        ConnectorCredentialCleanup::Deleted
    );
    assert!(secrets.load(&key).unwrap().is_none());
    assert!(matches!(
        service
            .authority()
            .snapshot()
            .entry(&connector_id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::Disconnected
    ));
}

#[test]
fn secret_backend_failure_never_publishes_connected_state() {
    let definition = definition();
    let connector_id = definition.id().clone();
    let authority = ConnectorAuthority::in_memory([definition]).unwrap();
    let service =
        ConnectorCredentialService::new(authority, Arc::new(ash_secrets::UnavailableSecretStore));

    assert!(
        service
            .connect_api_token(ConnectorApiTokenConnectRequest {
                command_id: ConnectorCommandId::new("connect-github").unwrap(),
                expected_generation: service.authority().snapshot().generation(),
                connector_id: connector_id.clone(),
                connection_generation: crate::ConnectorConnectionGeneration::new(1),
                account_id: ConnectorAccountId::new("octocat").unwrap(),
                account_display_name: "Octocat".into(),
                token: SecretValue::new(b"secret-token".to_vec()),
            })
            .is_err()
    );
    assert!(matches!(
        service
            .authority()
            .snapshot()
            .entry(&connector_id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::Unavailable { .. }
    ));
}

#[test]
fn connect_and_disconnect_requests_replay_without_restoring_readiness() {
    let definition = definition();
    let connector_id = definition.id().clone();
    let authority = ConnectorAuthority::in_memory([definition]).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConnectorCredentialService::new(authority, secrets.clone());
    let expected_generation = service.authority().snapshot().generation();

    for expected_disposition in [
        ConnectorCommandDisposition::Updated,
        ConnectorCommandDisposition::Replayed,
    ] {
        let outcome = service
            .connect_api_token(ConnectorApiTokenConnectRequest {
                command_id: ConnectorCommandId::new("retry-connect").unwrap(),
                expected_generation,
                connector_id: connector_id.clone(),
                connection_generation: crate::ConnectorConnectionGeneration::new(1),
                account_id: ConnectorAccountId::new("octocat").unwrap(),
                account_display_name: "Octocat".into(),
                token: SecretValue::new(b"secret-token".to_vec()),
            })
            .unwrap();
        assert_eq!(outcome.disposition, expected_disposition);
    }

    let connected_snapshot = service.authority().snapshot();
    let credential_key = match connected_snapshot
        .entry(&connector_id)
        .unwrap()
        .connection()
        .state()
    {
        ConnectorConnectionState::Connected(account) => {
            SecretKey::new(account.credential_reference().as_str().to_string()).unwrap()
        }
        state => panic!("expected connected state, got {state:?}"),
    };
    let connected_generation = connected_snapshot.generation();
    for expected_disposition in [
        ConnectorCommandDisposition::Updated,
        ConnectorCommandDisposition::Replayed,
    ] {
        let outcome = service
            .disconnect(
                ConnectorCommandId::new("retry-disconnect").unwrap(),
                connected_generation,
                connector_id.clone(),
            )
            .unwrap();
        assert_eq!(outcome.command.disposition, expected_disposition);
    }
    assert!(matches!(
        service
            .authority()
            .snapshot()
            .entry(&connector_id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::Disconnected
    ));

    let replay = service
        .connect_api_token(ConnectorApiTokenConnectRequest {
            command_id: ConnectorCommandId::new("retry-connect").unwrap(),
            expected_generation,
            connector_id,
            connection_generation: crate::ConnectorConnectionGeneration::new(1),
            account_id: ConnectorAccountId::new("octocat").unwrap(),
            account_display_name: "Octocat".into(),
            token: SecretValue::new(b"must-not-be-restored".to_vec()),
        })
        .unwrap();
    assert_eq!(replay.disposition, ConnectorCommandDisposition::Replayed);
    assert!(secrets.load(&credential_key).unwrap().is_none());
}

#[test]
fn failed_disconnect_cleanup_stays_pending_until_an_explicit_retry_succeeds() {
    let definition = definition();
    let connector_id = definition.id().clone();
    let authority = ConnectorAuthority::in_memory([definition]).unwrap();
    let secrets = Arc::new(FailingDeleteSecretStore::new());
    let service = ConnectorCredentialService::new(authority, secrets.clone());
    service
        .connect_api_token(ConnectorApiTokenConnectRequest {
            command_id: ConnectorCommandId::new("connect-retry-cleanup").unwrap(),
            expected_generation: service.authority().snapshot().generation(),
            connector_id: connector_id.clone(),
            connection_generation: crate::ConnectorConnectionGeneration::new(1),
            account_id: ConnectorAccountId::new("octocat").unwrap(),
            account_display_name: "Octocat".into(),
            token: SecretValue::new(b"secret-token".to_vec()),
        })
        .unwrap();
    let snapshot = service.authority().snapshot();
    let disconnected = service
        .disconnect(
            ConnectorCommandId::new("disconnect-retry-cleanup").unwrap(),
            snapshot.generation(),
            connector_id.clone(),
        )
        .unwrap();
    assert_eq!(
        disconnected.credential_cleanup,
        ConnectorCredentialCleanup::RetryRequired
    );
    assert!(
        service
            .authority()
            .credential_cleanup_pending(&connector_id)
    );

    secrets.fail_delete.store(false, Ordering::SeqCst);
    assert_eq!(
        service.retry_credential_cleanup(&connector_id),
        ConnectorCredentialCleanup::Deleted
    );
    assert!(
        !service
            .authority()
            .credential_cleanup_pending(&connector_id)
    );
}
