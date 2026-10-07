use std::num::NonZeroU64;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_file_access::Dir;
use tempfile::TempDir;

use super::*;

#[derive(Default)]
struct PublicationFacts {
    publication_contents: Vec<Vec<String>>,
    publication_references: Vec<ash_codebase::ChunkReference>,
}

struct RecordingProvider {
    id: CloudCodebaseProviderId,
    facts: Mutex<PublicationFacts>,
    delete_calls: AtomicUsize,
    fail_delete: AtomicBool,
    return_unpublished_chunk: AtomicBool,
}

struct UnsafeDeletionProvider {
    id: CloudCodebaseProviderId,
}

impl UnsafeDeletionProvider {
    fn new() -> Self {
        Self {
            id: CloudCodebaseProviderId::new("unsafe-deletion").expect("provider id"),
        }
    }
}

impl CloudCodebaseProvider for UnsafeDeletionProvider {
    fn id(&self) -> &CloudCodebaseProviderId {
        &self.id
    }

    fn capabilities(&self) -> CloudCodebaseCapabilities {
        CloudCodebaseCapabilities {
            deletion: CloudCodebaseDeletionSupport::Unsupported,
        }
    }

    fn publish(
        &self,
        _request: CloudCodebasePublicationRequest,
    ) -> Result<CloudCodebasePublication, CloudCodebaseProviderError> {
        Err(CloudCodebaseProviderError::new("must not publish"))
    }

    fn query(
        &self,
        _request: CloudCodebaseQueryRequest,
    ) -> Result<CloudCodebaseQueryResult, CloudCodebaseProviderError> {
        Err(CloudCodebaseProviderError::new("must not query"))
    }

    fn delete_grant(&self, _grant: &CloudCodebaseGrant) -> Result<(), CloudCodebaseProviderError> {
        Err(CloudCodebaseProviderError::new("deletion unsupported"))
    }
}

impl RecordingProvider {
    fn new() -> Self {
        Self {
            id: CloudCodebaseProviderId::new("recording").expect("provider id"),
            facts: Mutex::new(PublicationFacts::default()),
            delete_calls: AtomicUsize::new(0),
            fail_delete: AtomicBool::new(false),
            return_unpublished_chunk: AtomicBool::new(false),
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
        let mut facts = self.facts.lock().expect("facts");
        facts.publication_references = request
            .chunks
            .iter()
            .map(|chunk| chunk.reference.clone())
            .collect();
        facts.publication_contents.push(
            request
                .chunks
                .into_iter()
                .map(|chunk| chunk.content)
                .collect(),
        );
        Ok(CloudCodebasePublication {
            remote_generation: format!("dir-projection-{}", request.local_generation),
        })
    }

    fn query(
        &self,
        request: CloudCodebaseQueryRequest,
    ) -> Result<CloudCodebaseQueryResult, CloudCodebaseProviderError> {
        let mut references = self
            .facts
            .lock()
            .expect("facts")
            .publication_references
            .clone();
        if self.return_unpublished_chunk.load(Ordering::Relaxed) {
            let reference = references.first_mut().expect("published reference");
            reference.key = ash_codebase::ChunkKey::parse(format!("sha256:{}", "0".repeat(64)))
                .expect("synthetic chunk key");
        }
        let candidates = references
            .into_iter()
            .take(request.query.result_limit().get())
            .map(|reference| CloudCodebaseCandidate { reference })
            .collect();
        Ok(CloudCodebaseQueryResult {
            remote_generation: request.remote_generation,
            candidates,
        })
    }

    fn delete_grant(&self, _grant: &CloudCodebaseGrant) -> Result<(), CloudCodebaseProviderError> {
        self.delete_calls.fetch_add(1, Ordering::Relaxed);
        if self.fail_delete.load(Ordering::Relaxed) {
            Err(CloudCodebaseProviderError::new("delete unavailable"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn dir_chunks_are_the_only_cloud_publication_unit() {
    let dir = dir();
    std::fs::create_dir(dir.path().join("src")).expect("src");
    std::fs::write(
        dir.path().join("src/lib.rs"),
        "pub fn selected_source() -> bool { true }\n",
    )
    .expect("source");
    std::fs::write(dir.path().join("README.md"), "outside_selection_marker\n").expect("readme");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let controller = controller(Arc::clone(&index), Arc::clone(&provider));
    let selection = CloudCodebaseSelection::path_prefixes(vec!["src".into()]).expect("scope");
    let ceiling = NonZeroU64::new(1024 * 1024).expect("ceiling");

    let preview = controller.preview(&selection, ceiling).expect("preview");
    assert_eq!(preview.file_count, 1);
    assert_eq!(preview.upload_unit_count, preview.chunk_count);

    controller
        .authorize(grant(&index, "cloud-grant", selection.clone(), ceiling))
        .expect("authorize cloud projection");
    let cloud = controller.sync().expect("sync cloud projection");
    assert_eq!(cloud.deployment_mode, CodebaseDeploymentMode::Cloud);
    assert_eq!(cloud.state, CloudCodebaseState::Ready);
    let queried = controller
        .query(
            &CloudCodebaseQuery::new(
                "selected_source",
                NonZeroUsize::new(10).expect("result limit"),
            )
            .expect("query"),
        )
        .expect("cloud query");
    assert!(!queried.candidates.is_empty());
    {
        let facts = provider.facts.lock().expect("facts");
        assert_eq!(facts.publication_contents.len(), 1);
        assert!(facts.publication_contents[0][0].contains("selected_source"));
        assert!(
            facts.publication_contents[0]
                .iter()
                .all(|content| !content.contains("outside_selection_marker"))
        );
    }

    let local = controller.revoke().expect("revoke cloud projection");
    assert_eq!(local.deployment_mode, CodebaseDeploymentMode::LocalOnly);
    assert_eq!(local.state, CloudCodebaseState::LocalOnly);
}

#[test]
fn cloud_query_rejects_a_chunk_not_published_by_the_dir() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn dir_owned_chunk() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let controller = controller(Arc::clone(&index), Arc::clone(&provider));
    controller
        .authorize(grant(
            &index,
            "exact-chunk-grant",
            CloudCodebaseSelection::EntireIndex,
            NonZeroU64::new(1024).expect("limit"),
        ))
        .expect("authorize");
    controller.sync().expect("sync");
    provider
        .return_unpublished_chunk
        .store(true, Ordering::Relaxed);

    assert!(matches!(
        controller.query(
            &CloudCodebaseQuery::new(
                "dir_owned_chunk",
                NonZeroUsize::new(10).expect("result limit"),
            )
            .expect("query"),
        ),
        Err(CloudCodebaseError::InvalidProviderResult(
            "candidate is not an exact chunk from the published directory generation"
        ))
    ));
}

#[test]
fn legacy_managed_grant_is_migrated_to_deletion_only_state() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn legacy() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let state = tempfile::tempdir().expect("state");
    let database = state.path().join("cloud.sqlite3");
    write_legacy_state(&database, &index, "Managed");
    let controller = CloudCodebaseController::open(
        Arc::clone(&index),
        registry(Arc::clone(&provider)),
        CloudCodebaseStorage::Persistent(database),
    )
    .expect("migrate legacy state");

    let status = controller.status().expect("status");
    assert_eq!(status.state, CloudCodebaseState::Revoking);
    assert!(matches!(
        controller.sync(),
        Err(CloudCodebaseError::InvalidState)
    ));
    assert_eq!(
        controller.revoke().expect("delete legacy grant").state,
        CloudCodebaseState::LocalOnly
    );
    assert_eq!(provider.delete_calls.load(Ordering::Relaxed), 1);
}

#[test]
fn legacy_uploaded_grant_preserves_its_ready_generation() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn legacy() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let state = tempfile::tempdir().expect("state");
    let database = state.path().join("cloud.sqlite3");
    write_legacy_state(&database, &index, "Projection");
    let controller = CloudCodebaseController::open(
        index,
        registry(provider),
        CloudCodebaseStorage::Persistent(database),
    )
    .expect("migrate legacy state");

    let status = controller.status().expect("status");
    assert_eq!(status.state, CloudCodebaseState::Ready);
    assert_eq!(status.remote_generation.as_deref(), Some("legacy-remote-1"));
}

#[test]
fn schema_two_grant_uses_the_existing_collection_as_its_cloud_codebase_id() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn legacy() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let state = tempfile::tempdir().expect("state");
    let database = state.path().join("cloud.sqlite3");
    write_schema_two_state(&database, &index);
    let controller = CloudCodebaseController::open(
        index,
        registry(Arc::new(RecordingProvider::new())),
        CloudCodebaseStorage::Persistent(database),
    )
    .expect("migrate schema two state");

    let status = controller.status().expect("status");
    assert_eq!(
        status.grant.expect("grant").codebase_id.as_str(),
        "existing-cloud-codebase"
    );
}

#[test]
fn cloud_preview_requires_a_published_local_generation() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn not_ready() {}\n").expect("source");
    let index = index(&dir);
    let provider = Arc::new(RecordingProvider::new());
    let controller = controller(index, provider);

    assert!(matches!(
        controller.preview(
            &CloudCodebaseSelection::EntireIndex,
            NonZeroU64::new(1024).expect("limit"),
        ),
        Err(CloudCodebaseError::LocalIndexNotReady)
    ));
}

#[test]
fn consent_is_bounded_and_cannot_be_silently_widened() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn bounded() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let controller = controller(Arc::clone(&index), provider);
    let too_small = NonZeroU64::new(1).expect("limit");
    let preview = controller
        .preview(&CloudCodebaseSelection::EntireIndex, too_small)
        .expect("preview");
    assert_eq!(preview.limit, CloudCodebaseLimitDisposition::ExceedsLimit);
    assert!(matches!(
        controller.authorize(grant(
            &index,
            "too-small",
            CloudCodebaseSelection::EntireIndex,
            too_small,
        )),
        Err(CloudCodebaseError::EgressLimitExceeded)
    ));

    let ceiling = NonZeroU64::new(1024).expect("limit");
    controller
        .authorize(grant(
            &index,
            "first",
            CloudCodebaseSelection::EntireIndex,
            ceiling,
        ))
        .expect("first grant");
    assert!(matches!(
        controller.authorize(grant(
            &index,
            "widened",
            CloudCodebaseSelection::EntireIndex,
            ceiling,
        )),
        Err(CloudCodebaseError::ConsentConflict)
    ));
}

#[test]
fn grant_is_rejected_without_idempotent_provider_deletion() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn protected() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider: Arc<dyn CloudCodebaseProvider> = Arc::new(UnsafeDeletionProvider::new());
    let registry = CloudCodebaseProviderRegistry::new([provider]).expect("registry");
    let controller =
        CloudCodebaseController::open(Arc::clone(&index), registry, CloudCodebaseStorage::Memory)
            .expect("controller");
    let grant = CloudCodebaseGrant {
        id: CloudCodebaseGrantId::new("unsafe-grant").expect("grant"),
        codebase_id: CloudCodebaseId::new("unsafe-codebase").expect("codebase"),
        root_id: index.root_id().as_str().to_owned(),
        destination: CloudCodebaseDestination::new(
            CloudCodebaseProviderId::new("unsafe-deletion").expect("provider"),
            "tenant-a",
            "codebase",
        )
        .expect("destination"),
        selection: CloudCodebaseSelection::EntireIndex,
        max_egress_bytes: NonZeroU64::new(1024).expect("limit"),
    };

    assert!(matches!(
        controller.authorize(grant),
        Err(CloudCodebaseError::DeletionUnsupported)
    ));
    assert_eq!(
        controller.status().expect("status").state,
        CloudCodebaseState::LocalOnly
    );
}

#[test]
fn failed_deletion_remains_durable_and_can_resume_after_restart() {
    let dir = dir();
    std::fs::write(dir.path().join("lib.rs"), "pub fn durable_delete() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let registry = registry(Arc::clone(&provider));
    let state = tempfile::tempdir().expect("state");
    let storage = CloudCodebaseStorage::Persistent(state.path().join("cloud.sqlite3"));
    let controller =
        CloudCodebaseController::open(Arc::clone(&index), registry.clone(), storage.clone())
            .expect("controller");
    controller
        .authorize(grant(
            &index,
            "delete-grant",
            CloudCodebaseSelection::EntireIndex,
            NonZeroU64::new(1024).expect("limit"),
        ))
        .expect("authorize");
    controller.sync().expect("sync");
    provider.fail_delete.store(true, Ordering::Relaxed);
    assert!(matches!(
        controller.revoke(),
        Err(CloudCodebaseError::Provider(_))
    ));
    assert_eq!(
        controller.status().expect("status").state,
        CloudCodebaseState::Revoking
    );
    drop(controller);

    provider.fail_delete.store(false, Ordering::Relaxed);
    let reopened = CloudCodebaseController::open(index, registry, storage).expect("reopen");
    let status = reopened.revoke().expect("retry delete");
    assert_eq!(status.state, CloudCodebaseState::LocalOnly);
    assert_eq!(provider.delete_calls.load(Ordering::Relaxed), 2);
}

#[test]
fn a_new_local_generation_marks_the_cloud_projection_stale() {
    let dir = dir();
    let source_path = dir.path().join("lib.rs");
    std::fs::write(&source_path, "pub fn before() {}\n").expect("source");
    let index = index(&dir);
    index.rebuild().expect("rebuild");
    let provider = Arc::new(RecordingProvider::new());
    let controller = controller(Arc::clone(&index), provider);
    controller
        .authorize(grant(
            &index,
            "stale-grant",
            CloudCodebaseSelection::EntireIndex,
            NonZeroU64::new(1024).expect("limit"),
        ))
        .expect("authorize");
    controller.sync().expect("sync");

    std::fs::write(&source_path, "pub fn after() {}\n").expect("change");
    index
        .refresh_observed_paths(std::slice::from_ref(&source_path))
        .expect("refresh");

    assert_eq!(
        controller.status().expect("status").state,
        CloudCodebaseState::Stale
    );
}

fn dir() -> TempDir {
    let directory = tempfile::tempdir().expect("dir");
    std::fs::create_dir(directory.path().join(".git")).expect("git marker");
    directory
}

fn index(dir: &TempDir) -> Arc<Codebase> {
    Arc::new(
        Codebase::open_memory(
            Dir::open_local(dir.path()).expect("root"),
            CodebaseLimits::default(),
        )
        .expect("index"),
    )
}

fn controller(
    index: Arc<Codebase>,
    provider: Arc<RecordingProvider>,
) -> Arc<CloudCodebaseController> {
    CloudCodebaseController::open(index, registry(provider), CloudCodebaseStorage::Memory)
        .expect("controller")
}

fn registry(provider: Arc<RecordingProvider>) -> CloudCodebaseProviderRegistry {
    let provider: Arc<dyn CloudCodebaseProvider> = provider;
    CloudCodebaseProviderRegistry::new([provider]).expect("registry")
}

fn grant(
    index: &Codebase,
    id: &str,
    selection: CloudCodebaseSelection,
    max_egress_bytes: NonZeroU64,
) -> CloudCodebaseGrant {
    CloudCodebaseGrant {
        id: CloudCodebaseGrantId::new(id).expect("grant id"),
        codebase_id: CloudCodebaseId::new("recording-codebase").expect("codebase id"),
        root_id: index.root_id().as_str().to_owned(),
        destination: CloudCodebaseDestination::new(
            CloudCodebaseProviderId::new("recording").expect("provider"),
            "tenant-a",
            "codebase",
        )
        .expect("destination"),
        selection,
        max_egress_bytes,
    }
}

fn write_legacy_state(database: &std::path::Path, index: &Codebase, mode: &str) {
    let connection = rusqlite::Connection::open(database).expect("open legacy state");
    connection
        .execute_batch(
            "CREATE TABLE cloud_codebase_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .expect("legacy schema");
    let state = serde_json::json!({
        "phase": "Ready",
        "grant": {
            "id": "legacy-grant",
            "root_id": index.root_id().as_str(),
            "mode": mode,
            "destination": {
                "provider": "recording",
                "tenant": "tenant-a",
                "collection": "codebase"
            },
            "selection": "EntireIndex",
            "max_egress_bytes": 1024
        },
        "synced_local_generation": index.snapshot().expect("snapshot").generation,
        "remote_generation": "legacy-remote-1"
    });
    for (key, value) in [
        ("root_id", index.root_id().as_str().to_owned()),
        ("schema_version", "1".to_owned()),
        ("state", state.to_string()),
    ] {
        connection
            .execute(
                "INSERT INTO cloud_codebase_metadata(key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )
            .expect("legacy metadata");
    }
}

fn write_schema_two_state(database: &std::path::Path, index: &Codebase) {
    let connection = rusqlite::Connection::open(database).expect("open schema two state");
    connection
        .execute_batch(
            "CREATE TABLE cloud_codebase_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .expect("schema two metadata");
    let state = serde_json::json!({
        "phase": "Ready",
        "grant": {
            "id": "schema-two-grant",
            "root_id": index.root_id().as_str(),
            "destination": {
                "provider": "recording",
                "tenant": "tenant-a",
                "collection": "existing-cloud-codebase"
            },
            "selection": "EntireIndex",
            "max_egress_bytes": 1024
        },
        "synced_local_generation": index.snapshot().expect("snapshot").generation,
        "remote_generation": "schema-two-remote"
    });
    for (key, value) in [
        ("root_id", index.root_id().as_str().to_owned()),
        ("schema_version", "2".to_owned()),
        ("state", state.to_string()),
    ] {
        connection
            .execute(
                "INSERT INTO cloud_codebase_metadata(key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )
            .expect("schema two state");
    }
}
