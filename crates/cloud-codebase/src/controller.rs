use std::collections::BTreeSet;
use std::path::Component;
use std::sync::Arc;
use std::sync::Mutex;

use ash_codebase::Codebase;
use ash_codebase::CodebaseEnhancement;
use ash_codebase::CodebaseEnhancementError;
use ash_codebase::CodebaseManifest;
use ash_codebase::IndexedChunkReference;

use crate::CloudCodebaseCapabilities;
use crate::CloudCodebaseDeletionSupport;
use crate::CloudCodebaseError;
use crate::CloudCodebaseGrant;
use crate::CloudCodebaseLimitDisposition;
use crate::CloudCodebasePreview;
use crate::CloudCodebaseProvider;
use crate::CloudCodebaseProviderRegistry;
use crate::CloudCodebasePublicationRequest;
use crate::CloudCodebaseQuery;
use crate::CloudCodebaseQueryRequest;
use crate::CloudCodebaseQueryResult;
use crate::CloudCodebaseState;
use crate::CloudCodebaseStatus;
use crate::CloudCodebaseStorage;
use crate::CodebaseDeploymentMode;
use crate::store::CloudStateStore;
use crate::store::DurableCloudState;

/// Coordinates explicit cloud grants with one revision-authoritative local Codebase.
pub struct CloudCodebaseController {
    index: Arc<Codebase>,
    providers: CloudCodebaseProviderRegistry,
    operation: Mutex<()>,
    store: CloudStateStore,
}

impl CloudCodebaseController {
    pub fn open(
        index: Arc<Codebase>,
        providers: CloudCodebaseProviderRegistry,
        storage: CloudCodebaseStorage,
    ) -> Result<Arc<Self>, CloudCodebaseError> {
        let store = CloudStateStore::open(&storage, index.root_id().as_str())?;
        let controller = Arc::new(Self {
            index,
            providers,
            operation: Mutex::new(()),
            store,
        });
        controller.recover_interrupted_sync()?;
        Ok(controller)
    }

    pub fn preview(
        &self,
        selection: &crate::CloudCodebaseSelection,
        max_egress_bytes: std::num::NonZeroU64,
    ) -> Result<CloudCodebasePreview, CloudCodebaseError> {
        preview_manifest(&self.index.manifest()?, selection, max_egress_bytes)
    }

    pub fn root_id(&self) -> &ash_codebase::IndexRootId {
        self.index.root_id()
    }

    pub fn authorize(
        &self,
        grant: CloudCodebaseGrant,
    ) -> Result<CloudCodebaseStatus, CloudCodebaseError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if grant.root_id != self.index.root_id().as_str() {
            return Err(CloudCodebaseError::StorageRootMismatch);
        }
        let provider = self.provider_for(&grant)?;
        validate_capabilities(provider.capabilities())?;
        let preview = self.preview(&grant.selection, grant.max_egress_bytes)?;
        if preview.limit == CloudCodebaseLimitDisposition::ExceedsLimit {
            return Err(CloudCodebaseError::EgressLimitExceeded);
        }
        let current = self.store.load()?;
        if let Some(existing) = &current.grant {
            if existing == &grant && current.phase != CloudCodebaseState::Revoking {
                return self.status();
            }
            return Err(CloudCodebaseError::ConsentConflict);
        }
        self.store.save(&DurableCloudState {
            phase: CloudCodebaseState::Granted,
            grant: Some(grant),
            synced_local_generation: None,
            remote_generation: None,
        })?;
        self.status()
    }

    pub fn sync(&self) -> Result<CloudCodebaseStatus, CloudCodebaseError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut durable = self.store.load()?;
        if matches!(
            durable.phase,
            CloudCodebaseState::LocalOnly
                | CloudCodebaseState::Revoking
                | CloudCodebaseState::Syncing
        ) {
            return Err(if durable.grant.is_none() {
                CloudCodebaseError::NoActiveGrant
            } else {
                CloudCodebaseError::InvalidState
            });
        }
        let grant = durable
            .grant
            .clone()
            .ok_or(CloudCodebaseError::NoActiveGrant)?;
        let provider = self.provider_for(&grant)?;
        validate_capabilities(provider.capabilities())?;
        let manifest = self.index.manifest()?;
        let preview = preview_manifest(&manifest, &grant.selection, grant.max_egress_bytes)?;
        if preview.limit == CloudCodebaseLimitDisposition::ExceedsLimit {
            return Err(CloudCodebaseError::EgressLimitExceeded);
        }
        durable.phase = CloudCodebaseState::Syncing;
        self.store.save(&durable)?;
        let publication = (|| -> Result<_, CloudCodebaseError> {
            let chunks = selected_chunks(&manifest, &grant);
            let chunks = self.index.materialize_chunks(&chunks)?;
            Ok(provider.publish(CloudCodebasePublicationRequest {
                grant: grant.clone(),
                local_generation: manifest.snapshot.generation,
                chunks,
            })?)
        })();
        match publication {
            Ok(publication) => {
                if let Err(error) = validate_remote_generation(&publication.remote_generation) {
                    durable.phase = if durable.remote_generation.is_some() {
                        CloudCodebaseState::Stale
                    } else {
                        CloudCodebaseState::Failed
                    };
                    self.store.save(&durable)?;
                    return Err(error);
                }
                durable.phase = CloudCodebaseState::Ready;
                durable.synced_local_generation = Some(manifest.snapshot.generation);
                durable.remote_generation = Some(publication.remote_generation);
                self.store.save(&durable)?;
                self.status()
            }
            Err(error) => {
                durable.phase = if durable.remote_generation.is_some() {
                    CloudCodebaseState::Stale
                } else {
                    CloudCodebaseState::Failed
                };
                self.store.save(&durable)?;
                Err(error)
            }
        }
    }

    pub fn revoke(&self) -> Result<CloudCodebaseStatus, CloudCodebaseError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut durable = self.store.load()?;
        let Some(grant) = durable.grant.clone() else {
            return self.status();
        };
        durable.phase = CloudCodebaseState::Revoking;
        self.store.save(&durable)?;
        let provider = self.provider_for(&grant)?;
        validate_deletion(provider.capabilities())?;
        provider.delete_grant(&grant)?;
        self.store.save(&DurableCloudState::default())?;
        self.status()
    }

    /// Queries the exact ready remote generation and rejects candidates outside its grant.
    pub fn query(
        &self,
        query: &CloudCodebaseQuery,
    ) -> Result<CloudCodebaseQueryResult, CloudCodebaseError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let durable = self.store.load()?;
        let grant = durable
            .grant
            .clone()
            .ok_or(CloudCodebaseError::NoActiveGrant)?;
        let manifest = self.index.manifest()?;
        let local_generation = manifest.snapshot.generation;
        if durable.phase != CloudCodebaseState::Ready
            || durable.synced_local_generation != Some(local_generation)
        {
            return Err(CloudCodebaseError::InvalidState);
        }
        let remote_generation = durable
            .remote_generation
            .clone()
            .ok_or(CloudCodebaseError::InvalidState)?;
        let provider = self.provider_for(&grant)?;
        validate_capabilities(provider.capabilities())?;
        let result = provider.query(CloudCodebaseQueryRequest {
            grant: grant.clone(),
            remote_generation: remote_generation.clone(),
            query: query.clone(),
        })?;
        validate_query_result(&grant, &remote_generation, query, &manifest, &result)?;
        Ok(result)
    }

    pub fn status(&self) -> Result<CloudCodebaseStatus, CloudCodebaseError> {
        let durable = self.store.load()?;
        let local_generation = self.index.snapshot()?.generation;
        let state = if durable.phase == CloudCodebaseState::Ready
            && durable.synced_local_generation != Some(local_generation)
        {
            CloudCodebaseState::Stale
        } else {
            durable.phase
        };
        let deployment_mode = durable
            .grant
            .as_ref()
            .map_or(CodebaseDeploymentMode::LocalOnly, |_| {
                CodebaseDeploymentMode::Cloud
            });
        Ok(CloudCodebaseStatus {
            deployment_mode,
            state,
            grant: durable.grant,
            local_generation,
            synced_local_generation: durable.synced_local_generation,
            remote_generation: durable.remote_generation,
        })
    }

    fn provider_for(
        &self,
        grant: &CloudCodebaseGrant,
    ) -> Result<Arc<dyn CloudCodebaseProvider>, CloudCodebaseError> {
        self.providers
            .get(&grant.destination.provider)
            .ok_or(CloudCodebaseError::ProviderUnavailable)
    }

    fn recover_interrupted_sync(&self) -> Result<(), CloudCodebaseError> {
        let mut durable = self.store.load()?;
        if durable.phase == CloudCodebaseState::Syncing {
            durable.phase = if durable.remote_generation.is_some() {
                CloudCodebaseState::Stale
            } else {
                CloudCodebaseState::Failed
            };
            self.store.save(&durable)?;
        }
        Ok(())
    }
}

impl CodebaseEnhancement for CloudCodebaseController {
    fn root_id(&self) -> &ash_codebase::IndexRootId {
        self.root_id()
    }

    fn query(
        &self,
        text: &str,
        result_limit: std::num::NonZeroUsize,
    ) -> Result<Vec<ash_codebase::ChunkReference>, CodebaseEnhancementError> {
        let query = CloudCodebaseQuery::new(text, result_limit)
            .map_err(|_| CodebaseEnhancementError::unavailable())?;
        CloudCodebaseController::query(self, &query)
            .map(|result| {
                result
                    .candidates
                    .into_iter()
                    .map(|candidate| candidate.reference)
                    .collect()
            })
            .map_err(|_| CodebaseEnhancementError::unavailable())
    }
}

fn preview_manifest(
    manifest: &CodebaseManifest,
    selection: &crate::CloudCodebaseSelection,
    max_egress_bytes: std::num::NonZeroU64,
) -> Result<CloudCodebasePreview, CloudCodebaseError> {
    if manifest.snapshot.generation == 0 {
        return Err(CloudCodebaseError::LocalIndexNotReady);
    }
    let chunks = manifest
        .chunks
        .iter()
        .filter(|chunk| selection.includes(&chunk.reference.relative_path))
        .collect::<Vec<_>>();
    let egress_bytes = chunks.iter().fold(0u64, |total, chunk| {
        total.saturating_add(
            u64::try_from(
                chunk
                    .reference
                    .span
                    .end_byte
                    .saturating_sub(chunk.reference.span.start_byte),
            )
            .unwrap_or(u64::MAX),
        )
    });
    let file_count = chunks
        .iter()
        .map(|chunk| &chunk.reference.relative_path)
        .collect::<BTreeSet<_>>()
        .len();
    Ok(CloudCodebasePreview {
        local_generation: manifest.snapshot.generation,
        file_count,
        chunk_count: chunks.len(),
        upload_unit_count: chunks.len(),
        egress_bytes,
        limit: if egress_bytes <= max_egress_bytes.get() {
            CloudCodebaseLimitDisposition::WithinLimit
        } else {
            CloudCodebaseLimitDisposition::ExceedsLimit
        },
    })
}

fn selected_chunks(
    manifest: &CodebaseManifest,
    grant: &CloudCodebaseGrant,
) -> Vec<IndexedChunkReference> {
    manifest
        .chunks
        .iter()
        .filter(|chunk| grant.selection.includes(&chunk.reference.relative_path))
        .cloned()
        .collect()
}

fn validate_capabilities(
    capabilities: CloudCodebaseCapabilities,
) -> Result<(), CloudCodebaseError> {
    validate_deletion(capabilities)
}

fn validate_deletion(capabilities: CloudCodebaseCapabilities) -> Result<(), CloudCodebaseError> {
    if capabilities.deletion == CloudCodebaseDeletionSupport::IdempotentGrantDeletion {
        Ok(())
    } else {
        Err(CloudCodebaseError::DeletionUnsupported)
    }
}

fn validate_remote_generation(value: &str) -> Result<(), CloudCodebaseError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(CloudCodebaseError::InvalidInput(
            "remote generation must be bounded non-control text",
        ))
    } else {
        Ok(())
    }
}

fn validate_query_result(
    grant: &CloudCodebaseGrant,
    expected_generation: &str,
    query: &CloudCodebaseQuery,
    manifest: &CodebaseManifest,
    result: &CloudCodebaseQueryResult,
) -> Result<(), CloudCodebaseError> {
    if result.remote_generation != expected_generation {
        return Err(CloudCodebaseError::InvalidProviderResult(
            "remote generation does not match the ready publication",
        ));
    }
    if result.candidates.len() > query.result_limit().get() {
        return Err(CloudCodebaseError::InvalidProviderResult(
            "candidate count exceeds the requested result limit",
        ));
    }
    for candidate in &result.candidates {
        let reference = &candidate.reference;
        if reference.span.start_byte >= reference.span.end_byte
            || reference.span.start_line >= reference.span.end_line_exclusive
        {
            return Err(CloudCodebaseError::InvalidProviderResult(
                "candidate span must cover non-empty source content",
            ));
        }
        if reference.root_id.as_str() != grant.root_id {
            return Err(CloudCodebaseError::InvalidProviderResult(
                "candidate belongs to another directory root",
            ));
        }
        if reference.relative_path.is_absolute()
            || reference.relative_path.as_os_str().is_empty()
            || reference
                .relative_path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || !grant.selection.includes(&reference.relative_path)
        {
            return Err(CloudCodebaseError::InvalidProviderResult(
                "candidate path falls outside the granted source selection",
            ));
        }
        if !manifest
            .chunks
            .iter()
            .any(|chunk| chunk.reference == *reference)
        {
            return Err(CloudCodebaseError::InvalidProviderResult(
                "candidate is not an exact chunk from the published directory generation",
            ));
        }
    }
    Ok(())
}
