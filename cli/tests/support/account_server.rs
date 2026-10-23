//! Offline account-test host. Only this test executable accepts the fixture environment;
//! product binaries continue to use the OS keyring and never fall back to this store.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_app_server::AppServerOptions;
use ash_app_server::open_app_server;
use ash_app_server_daemon::ManagedConnectionContract;
use ash_app_server_daemon::ManagedEndpoint;
use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::MemorySecretStore;
use ash_secrets::ProfileSecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretStoreErrorKind;
use ash_secrets::SecretValue;
use ash_secrets::UnavailableSecretStore;
use core_plugins::PluginActivationAuthority;

pub enum KeyringMode {
    Available,
    Unavailable,
    Failed,
}

impl KeyringMode {
    pub fn argument(&self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
        }
    }
}

pub fn run() {
    let keyring: Arc<dyn SecretStore> =
        match std::env::var("ASH_CLI_ACCOUNT_FIXTURE_KEYRING").as_deref() {
            Ok("available") => Arc::new(MemorySecretStore::default()),
            Ok("unavailable") => Arc::new(UnavailableSecretStore),
            Ok("failed") => Arc::new(FailedKeyring),
            _ => panic!("account fixture must be launched with an explicit test keyring"),
        };
    let profile = PathBuf::from(std::env::var_os("ASH_HOME").expect("isolated fixture profile"));
    let home = PathBuf::from(std::env::var_os("HOME").expect("isolated fixture home"));
    let secrets = Arc::new(ProfileSecretStore::open(profile.join("secrets"), keyring).unwrap());
    let plugins = PluginActivationAuthority::open(profile.join("plugins")).unwrap();
    let server = Arc::new(
        open_app_server(
            AppServerOptions::new(&profile)
                .with_codex_home(home.join("codex"))
                .with_grok_auth_file(home.join("grok/auth.json"))
                .without_built_in_skills()
                .with_plugin_authority(plugins, secrets)
                .unwrap(),
        )
        .unwrap(),
    );
    let mut endpoint = ManagedEndpoint::bind(
        &profile,
        ManagedConnectionContract::Agent {
            protocol_version: ProtocolVersion::current(),
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut workers = Vec::new();
    let shutdown_streams = Arc::new(Mutex::new(BTreeMap::new()));
    let mut connection_id = 0_u64;
    while !endpoint.is_stopping() {
        assert!(
            Instant::now() < deadline,
            "account fixture exceeded its lifetime"
        );
        if let Some(connection) = endpoint.poll_connection().unwrap() {
            let id = connection_id;
            connection_id += 1;
            shutdown_streams
                .lock()
                .unwrap()
                .insert(id, connection.writer.try_clone().unwrap());
            let streams = shutdown_streams.clone();
            let server = server.clone();
            workers.push(thread::spawn(move || {
                let result = server.serve_product_host_jsonl(connection.reader, connection.writer);
                // Release the shutdown lease with its worker so the CLI proxy observes output EOF.
                streams.lock().unwrap().remove(&id);
                result
            }));
        } else {
            thread::sleep(Duration::from_millis(10));
        }
    }
    // Close and join every connection before dropping the application and endpoint authorities.
    for stream in shutdown_streams.lock().unwrap().values() {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
    for worker in workers {
        let _ = worker.join().unwrap();
    }
}

struct FailedKeyring;
impl SecretStore for FailedKeyring {
    fn load(&self, _: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        Err(keyring_failure())
    }
    fn store(&self, _: &SecretKey, _: &SecretValue) -> Result<(), SecretStoreError> {
        Err(keyring_failure())
    }
    fn delete(&self, _: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        Err(keyring_failure())
    }
}
fn keyring_failure() -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::BackendFailure,
        "fixture keyring operation failed",
    )
}
