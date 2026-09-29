use std::sync::Arc;
use std::sync::Mutex;

use ash_cloud_codebase::CloudCodebaseCandidate;
use ash_cloud_codebase::CloudCodebaseCapabilities;
use ash_cloud_codebase::CloudCodebaseDeletionSupport;
use ash_cloud_codebase::CloudCodebaseGrant;
use ash_cloud_codebase::CloudCodebaseProvider;
use ash_cloud_codebase::CloudCodebaseProviderError;
use ash_cloud_codebase::CloudCodebaseProviderId;
use ash_cloud_codebase::CloudCodebaseProviderRegistry;
use ash_cloud_codebase::CloudCodebasePublication;
use ash_cloud_codebase::CloudCodebasePublicationRequest;
use ash_cloud_codebase::CloudCodebaseQueryRequest;
use ash_cloud_codebase::CloudCodebaseQueryResult;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_file_access::GrantSource;
use ash_model_provider::EchoModel;

use crate::local::ProviderModelService;
use crate::server::DirGrantPolicy;

use super::*;

struct RecordingProvider {
    id: CloudCodebaseProviderId,
    publications: Mutex<usize>,
    candidates: Mutex<Vec<ash_codebase::ChunkReference>>,
    deletions: Mutex<usize>,
}

impl RecordingProvider {
    fn new() -> Self {
        Self {
            id: CloudCodebaseProviderId::new("recording").expect("provider id"),
            publications: Mutex::new(0),
            candidates: Mutex::new(Vec::new()),
            deletions: Mutex::new(0),
        }
    }
}

impl CloudCodebaseProvider for RecordingProvider {
    fn id(&self) -> &CloudCodebaseProviderId {
        &self.id
    }

    fn capabilities(&self) -> CloudCodebaseCapabilities {
        CloudCodebaseCapabilities {
            deletion: CloudCodebaseDeletionSupport::IdempotentGrantDeletion,
        }
    }

    fn publish(
        &self,
        request: CloudCodebasePublicationRequest,
    ) -> Result<CloudCodebasePublication, CloudCodebaseProviderError> {
        assert!(!request.chunks.is_empty());
        *self.candidates.lock().expect("candidates") = request
            .chunks
            .iter()
            .map(|chunk| chunk.reference.clone())
            .collect();
        *self.publications.lock().expect("publication count") += 1;
        Ok(CloudCodebasePublication {
            remote_generation: format!("dir-projection-{}", request.local_generation),
        })
    }

    fn query(
        &self,
        request: CloudCodebaseQueryRequest,
    ) -> Result<CloudCodebaseQueryResult, CloudCodebaseProviderError> {
        let candidates = self
            .candidates
            .lock()
            .expect("candidates")
            .iter()
            .take(request.query.result_limit().get())
            .cloned()
            .map(|reference| CloudCodebaseCandidate { reference })
            .collect();
        Ok(CloudCodebaseQueryResult {
            remote_generation: request.remote_generation,
            candidates,
        })
    }

    fn delete_grant(&self, _grant: &CloudCodebaseGrant) -> Result<(), CloudCodebaseProviderError> {
        *self.deletions.lock().expect("deletion count") += 1;
        Ok(())
    }
}

#[test]
fn rpc_exposes_dir_index_preview_consent_sync_and_revoke() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git marker");
    std::fs::write(
        dir.path().join("lib.rs"),
        "pub fn cloud_mode_selection() -> bool { true }\n",
    )
    .expect("source");
    let provider = Arc::new(RecordingProvider::new());
    let provider_trait: Arc<dyn CloudCodebaseProvider> = provider.clone();
    let providers = CloudCodebaseProviderRegistry::new([provider_trait]).expect("providers");
    let server = server()
        .with_cloud_codebase_providers(providers)
        .with_local_env_host(
            None,
            DirGrantPolicy::HostSelectedDirs(GrantSource::HostConfiguration),
        )
        .expect("host");
    server
        .switch_local_dir_root(dir.path().to_path_buf())
        .expect("switch");
    let Ok(local_index) = server.codebase_service() else {
        panic!("local index should be installed");
    };
    local_index.rebuild().expect("rebuild");
    let mut connection = server.connection();
    let initialize = call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    assert_eq!(initialize["result"]["capabilities"]["cloudCodebase"], true);

    let status = call(
        &server,
        &mut connection,
        2,
        "codebase/cloud/status",
        serde_json::json!({}),
    );
    assert_eq!(status["result"]["deploymentMode"], "localOnly");

    let preview = call(
        &server,
        &mut connection,
        3,
        "codebase/cloud/preview",
        serde_json::json!({
            "selection": {"type": "entireIndex"},
            "maxEgressBytes": 1048576
        }),
    );
    assert_eq!(preview["result"]["withinLimit"], true);
    assert_eq!(preview["result"]["fileCount"], 1);
    assert_eq!(
        preview["result"]["uploadUnitCount"],
        preview["result"]["chunkCount"]
    );

    let legacy_preview = call(
        &server,
        &mut connection,
        4,
        "codebase/cloud/preview",
        serde_json::json!({
            "mode": "managed",
            "selection": {"type": "entireIndex"},
            "maxEgressBytes": 1048576
        }),
    );
    assert_eq!(legacy_preview["error"]["message"], "InvalidParams");

    let cloud_grant = grant_json("cloud-grant");
    let authorized = call(
        &server,
        &mut connection,
        5,
        "codebase/cloud/authorize",
        serde_json::json!({"grant": cloud_grant}),
    );
    assert_eq!(authorized["result"]["state"], "granted");

    let legacy_grant = call(
        &server,
        &mut connection,
        51,
        "codebase/cloud/authorize",
        serde_json::json!({"grant": {
            "grantId": "legacy-managed-grant",
            "codebaseId": "legacy-managed-codebase",
            "mode": "managed",
            "destination": {
                "provider": "recording",
                "tenant": "tenant-a",
                "collection": "dir-index"
            },
            "selection": {"type": "entireIndex"},
            "maxEgressBytes": 1048576
        }}),
    );
    assert_eq!(legacy_grant["error"]["message"], "InvalidParams");
    let synced = call(
        &server,
        &mut connection,
        6,
        "codebase/cloud/sync",
        serde_json::json!({}),
    );
    assert_eq!(synced["result"]["deploymentMode"], "cloud");
    assert_eq!(synced["result"]["state"], "ready");

    let retrieval = call(
        &server,
        &mut connection,
        7,
        "codebase/retrieve",
        serde_json::json!({"query": "cloud_mode_selection", "maxResults": 10}),
    );
    assert!(retrieval["result"]["hits"][0].get("origins").is_none());
    assert_eq!(retrieval["result"]["degradations"], serde_json::json!([]));

    let conflict = call(
        &server,
        &mut connection,
        8,
        "codebase/cloud/authorize",
        serde_json::json!({"grant": grant_json("conflicting-grant")}),
    );
    assert_eq!(conflict["error"]["message"], "CloudCodebaseConsentConflict");

    let revoked = call(
        &server,
        &mut connection,
        9,
        "codebase/cloud/revoke",
        serde_json::json!({}),
    );
    assert_eq!(revoked["result"]["deploymentMode"], "localOnly");

    assert_eq!(*provider.publications.lock().unwrap(), 1);
    assert_eq!(*provider.deletions.lock().unwrap(), 1);
}

#[test]
fn standard_local_composition_can_install_cloud_provider_registry_before_activation() {
    let profile = tempfile::tempdir().expect("profile");
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(dir.path().join("lib.rs"), "pub fn indexed() {}\n").expect("source");
    let provider: Arc<dyn CloudCodebaseProvider> = Arc::new(RecordingProvider::new());
    let providers = CloudCodebaseProviderRegistry::new([provider]).expect("providers");
    let options = crate::AppServerOptions::new(profile.path())
        .with_dir_root(dir.path())
        .without_built_in_skills();
    let server =
        crate::open_app_server_with_cloud_providers(options, providers).expect("local server");
    let mut connection = server.connection();

    let initialize = call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );

    assert_eq!(initialize["result"]["capabilities"]["cloudCodebase"], true);
    assert!(server.cloud_codebase_service().is_ok());
}

fn grant_json(id: &str) -> serde_json::Value {
    serde_json::json!({
        "grantId": id,
        "codebaseId": format!("codebase-{id}"),
        "destination": {
            "provider": "recording",
            "tenant": "tenant-a",
            "collection": "dir-index"
        },
        "selection": {"type": "entireIndex"},
        "maxEgressBytes": 1048576
    })
}

fn server() -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_ephemeral_env_state()
}

fn call(
    server: &AppServer,
    connection: &mut super::super::ConnectionState,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(
        &server.handle_json(
            connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            })
            .to_string(),
        ),
    )
    .expect("response")
}
