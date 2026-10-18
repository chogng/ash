use std::sync::Arc;

use ash_config::ConfigStore;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretStoreErrorKind;
use ash_secrets::SecretValue;
use serde_json::json;

use crate::tests::initialize;
use crate::tests::server;

struct FailedStore(SecretStoreErrorKind);

impl SecretStore for FailedStore {
    fn check_availability(&self) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::new(
            self.0,
            "fake storage detail must not reach clients",
        ))
    }

    fn load(&self, _: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        self.check_availability().map(|_| None)
    }

    fn store(&self, _: &SecretKey, _: &SecretValue) -> Result<(), SecretStoreError> {
        self.check_availability()
    }

    fn delete(&self, _: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        self.check_availability()
            .map(|_| DeleteSecretOutcome::NotFound)
    }
}

#[test]
fn encrypted_storage_rpc_reports_each_state_and_sanitized_operation_error() {
    for (kind, status, error_name) in [
        (
            SecretStoreErrorKind::BackendUnavailable,
            "unavailable",
            "SecretStorageUnavailable",
        ),
        (
            SecretStoreErrorKind::AccessDenied,
            "accessDenied",
            "SecretStorageAccessDenied",
        ),
        (
            SecretStoreErrorKind::BackendFailure,
            "failure",
            "SecretStorageOperationFailed",
        ),
        (
            SecretStoreErrorKind::KeyMissing,
            "keyMissing",
            "SecretStorageKeyMissing",
        ),
        (
            SecretStoreErrorKind::InvalidData,
            "corrupted",
            "SecretStorageCorrupted",
        ),
        (
            SecretStoreErrorKind::MigrationFailed,
            "migrationFailed",
            "SecretStorageMigrationFailed",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store: Arc<dyn SecretStore> = Arc::new(FailedStore(kind));
        let config = Arc::new(ConfigStore::open(root.path().join("config.sqlite3")).unwrap());
        config
            .apply(ash_config::ConfigCommandRequest {
                command_id: ash_protocol::CommandId::new("configure-storage-test").unwrap(),
                expected_revision: ash_config::ConfigRevision::INITIAL,
                command: ash_config::UserConfigCommand::ConfigureConnection {
                    connection: ash_protocol::ModelConnectionId::new("openai").unwrap(),
                    config: model_provider_info::ModelProviderConfig::new(
                        ash_protocol::ProviderId::new("openai").unwrap(),
                    ),
                },
            })
            .unwrap();
        let server = server()
            .with_secret_store(store.clone())
            .with_config_store(config)
            .with_provider_runtime(Arc::new(
                ash_model_provider::ModelProviderRuntime::with_secrets(
                    model_provider_info::ProviderConfigRegistry::builtin(),
                    store.clone(),
                ),
            ))
            .with_provider_credentials(Arc::new(
                ash_model_provider::ProviderCredentialService::new(
                    model_provider_info::ProviderConfigRegistry::builtin(),
                    store,
                ),
            ));
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let reply = server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0", "id":2, "method":"secrets/status", "params":{}}).to_string(),
        );
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["result"], json!({"status":status}));
        let reply = server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0", "id":6, "method":"config/read", "params":{}}).to_string(),
        );
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert!(reply.get("error").is_none(), "{reply}");
        // A failed keyring excludes credential-backed routes. The credential-free local
        // provider remains selectable; the failure must not disable unrelated capabilities.
        assert_eq!(
            reply["result"]["providers"],
            json!({"ollama":{"connection":"ollama","provider":"ollama"}})
        );
        assert_eq!(
            reply["result"]["activeConnections"],
            json!({"ollama":"ollama"})
        );
        assert_eq!(
            reply["result"]["connections"]["openai"]["provider"],
            "openai"
        );
        let reply = server.handle_json(&mut connection, &json!({"jsonrpc":"2.0", "id":3, "method":"provider/apiKey/set", "params":{"connection":"openai", "apiKey":"fake-unique-sensitive-value"}}).to_string());
        assert!(!reply.contains("fake-unique-sensitive-value"));
        assert!(!reply.contains("fake storage detail"));
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["error"]["data"]["kind"], error_name);
        // Failed reads stay failures; the client must never receive a false configured status.
        let reply = server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0", "id":4, "method":"provider/list", "params":{}}).to_string(),
        );
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["error"]["data"]["kind"], error_name);
        let reply = server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0", "id":5, "method":"model/list", "params":{}}).to_string(),
        );
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["error"]["data"]["kind"], error_name);
    }
}

#[test]
fn encrypted_storage_rpc_reports_available_without_exposing_values() {
    let server = server().with_secret_store(Arc::new(ash_secrets::MemorySecretStore::default()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let reply = server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"secrets/status","params":{}}"#,
    );
    let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["result"], json!({"status":"available"}));
}

#[test]
fn encrypted_storage_rpc_changes_mode_through_the_shared_store_and_preserves_values() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(
        ash_secrets::ProfileSecretStore::open(
            root.path(),
            Arc::new(ash_secrets::MemorySecretStore::default()),
        )
        .unwrap(),
    );
    let name = SecretKey::new("provider/test-token").unwrap();
    store
        .store(&name, &SecretValue::new(b"never-in-rpc-output".to_vec()))
        .unwrap();
    let server = server().with_secret_store(store.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (index, (method, params, mode)) in [
        ("secrets/status", json!({}), "encrypted"),
        ("secrets/authorize", json!({}), "encrypted"),
        ("secrets/storageMode/set", json!({"mode":"file"}), "file"),
        (
            "secrets/storageMode/set",
            json!({"mode":"encrypted"}),
            "encrypted",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let reply = server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0","id":index + 2,"method":method,"params":params}).to_string(),
        );
        assert!(!reply.contains("never-in-rpc-output"));
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(
            reply["result"],
            json!({"status":"available","mode":mode}),
            "{reply}"
        );
        assert_eq!(
            store.load(&name).unwrap().unwrap().expose(),
            b"never-in-rpc-output"
        );
    }
    for (index, params) in [
        json!({"mode":"invalid"}),
        json!({"mode":"file","extra":true}),
        json!({}),
    ]
    .into_iter()
    .enumerate()
    {
        let reply = server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0","id":index + 6,"method":"secrets/storageMode/set","params":params})
                .to_string(),
        );
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["error"]["code"], -32602);
    }
}
