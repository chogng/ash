use super::RpcError;
use super::UpdateBroker;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactCatalogChanged;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::fs::FsDirectoryTarget;
use ash_app_server_protocol::protocol::fs::FsResolvePathResult;
use ash_artifact_catalog::NATIVE_ARTIFACT_CLIENT;
use ash_documents::Documents;
use ash_file_system::FileSystem;
use ash_state::SqliteThreadStore;
use std::path::Path;
use std::sync::Arc;

pub(super) const WEB_FILE_ROUTE: &str = "document:";

/// Dispatches committed completions to Docs; catalog reads never create documents.
#[derive(Clone, Default)]
pub(super) struct DocumentPublication {
    documents: Option<Arc<Documents>>,
    completions: Option<Arc<SqliteThreadStore>>,
}

impl DocumentPublication {
    pub(super) fn new(
        documents: Arc<Documents>,
        completions: Option<Arc<SqliteThreadStore>>,
    ) -> Self {
        Self {
            documents: Some(documents),
            completions,
        }
    }

    pub(super) fn publish_native(&self, updates: &UpdateBroker) {
        let Some(documents) = &self.documents else {
            return;
        };
        let mut changed = false;
        if let Some(completions) = &self.completions {
            let mut after_id = 0;
            loop {
                let pending = match completions.pending_turn_completions(after_id) {
                    Ok(pending) => pending,
                    Err(error) => {
                        eprintln!("Could not read committed completions: {error}");
                        break;
                    }
                };
                if pending.is_empty() {
                    break;
                }
                for completion in pending {
                    after_id = completion.id;
                    match documents.accept_completed_turn(
                        &completion.session_id,
                        &completion.thread_id,
                        &completion.turn,
                    ) {
                        Ok(inserted) => {
                            changed |= inserted;
                            if let Err(error) =
                                completions.acknowledge_turn_completion(completion.id)
                            {
                                eprintln!(
                                    "Could not acknowledge completion {}: {error}",
                                    completion.id
                                );
                            }
                        }
                        Err(error) => eprintln!(
                            "Could not create document for completion {}: {error}",
                            completion.id
                        ),
                    }
                }
            }
        }
        if changed {
            updates.publish_artifact_catalog_changed(ArtifactCatalogChanged {
                client_id: NATIVE_ARTIFACT_CLIENT.into(),
            });
        }
    }

    pub(super) fn web_file_route(&self, path: &Path) -> Option<FsResolvePathResult> {
        let id = self.documents.as_ref()?.resource_id(path)?;
        Some(FsResolvePathResult {
            root: path.parent()?.to_owned(),
            exact_file: Some(true),
            target: FsDirectoryTarget::Environment {
                dir_id: format!("{WEB_FILE_ROUTE}{id}"),
            },
        })
    }

    pub(super) fn web_file_system(
        &self,
        route: Option<&str>,
    ) -> Result<Option<Arc<dyn FileSystem>>, RpcError> {
        let Some(id) = route.and_then(|route| route.strip_prefix(WEB_FILE_ROUTE)) else {
            return Ok(None);
        };
        self.documents
            .as_ref()
            .ok_or_else(permission_required)?
            .file_system(id)
            .map(Some)
            .map_err(|_| permission_required())
    }
}

fn permission_required() -> RpcError {
    RpcError::new(-32001, AppServerErrorName::PermissionRequired)
}
