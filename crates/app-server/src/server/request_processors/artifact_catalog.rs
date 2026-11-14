use super::ConnectionAuthority;
use super::RpcError;
use super::UpdateBroker;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactCatalogChanged;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactCatalogListParams;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactCatalogListResult;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactCatalogRegisterParams;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactCatalogRegisterResult;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactResourceDto;
use ash_app_server_protocol::protocol::artifact_catalog::ArtifactSourceDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_artifact_catalog::ArtifactCatalogError;
use ash_artifact_catalog::ArtifactRecord;
use ash_artifact_catalog::ArtifactRegistration;
use ash_artifact_catalog::ArtifactRegistrationOutcome;
use ash_artifact_catalog::ArtifactSource;
use ash_artifact_catalog::NATIVE_ARTIFACT_CLIENT;
use ash_artifact_catalog::SqliteArtifactCatalog;
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, Default)]
pub(super) struct ArtifactCatalogRequestProcessor {
    store: Option<Arc<SqliteArtifactCatalog>>,
    documents: Option<Arc<ash_documents::Documents>>,
}

impl ArtifactCatalogRequestProcessor {
    pub(super) fn new(
        store: Arc<SqliteArtifactCatalog>,
        documents: Option<Arc<ash_documents::Documents>>,
    ) -> Self {
        Self {
            store: Some(store),
            documents,
        }
    }

    pub(super) fn is_available(&self, authority: ConnectionAuthority) -> bool {
        self.store.is_some()
            && (authority == ConnectionAuthority::ProductHost
                || authority == ConnectionAuthority::Browser && self.documents.is_some())
    }

    pub(super) fn register(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
        updates: &UpdateBroker,
    ) -> Result<Value, RpcError> {
        let params: ArtifactCatalogRegisterParams = decode(params)?;
        if authority != ConnectionAuthority::ProductHost {
            return Err(permission_required());
        }
        let store = self.store.as_deref().ok_or_else(unavailable)?;
        if params.client_id == NATIVE_ARTIFACT_CLIENT {
            return Err(permission_required());
        }
        let file = params.file;
        let registration = ArtifactRegistration {
            id: file.id,
            resource: file.resource,
            title: file.title,
            content_type: file.content_type,
            source: ArtifactSource {
                provider_id: file.source.provider_id,
                account_id: file.source.account_id,
                session_id: file.source.session_id,
                thread_id: file.source.thread_id,
                item_id: file.source.item_id,
                part_id: file.source.part_id,
            },
        };
        let file = match store
            .register(&params.client_id, &registration)
            .map_err(artifact_catalog_error)?
        {
            ArtifactRegistrationOutcome::Created(file) => {
                updates.publish_artifact_catalog_changed(ArtifactCatalogChanged {
                    client_id: params.client_id,
                });
                file
            }
            ArtifactRegistrationOutcome::Existing(file) => file,
        };
        result(&ArtifactCatalogRegisterResult { file: record(file) })
    }

    pub(super) fn list(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ArtifactCatalogListParams = decode(params)?;
        let (client_id, browser_directory) = match authority {
            ConnectionAuthority::ProductHost => (params.client_id.as_str(), None),
            ConnectionAuthority::Browser => (
                NATIVE_ARTIFACT_CLIENT,
                Some(self.documents.as_deref().ok_or_else(permission_required)?),
            ),
            ConnectionAuthority::Client | ConnectionAuthority::RemoteHost => {
                return Err(permission_required());
            }
        };
        let store = self.store.as_deref().ok_or_else(unavailable)?;
        let files = store
            .list(client_id, params.account_ids.as_deref().unwrap_or_default())
            .map_err(artifact_catalog_error)?
            .into_iter()
            .filter_map(|entry| {
                let mut dto = record(entry);
                if let Some(directory) = browser_directory {
                    let resource = url::Url::from_file_path(directory.file_path(&dto.id)?).ok()?;
                    dto.resource = resource.to_string();
                }
                Some(dto)
            })
            .collect();
        result(&ArtifactCatalogListResult { files })
    }
}

fn permission_required() -> RpcError {
    RpcError::new(-32001, AppServerErrorName::PermissionRequired)
}

fn unavailable() -> RpcError {
    RpcError::new(-32002, AppServerErrorName::ArtifactCatalogUnavailable)
}

fn record(record: ArtifactRecord) -> ArtifactResourceDto {
    let file = record.file;
    ArtifactResourceDto {
        id: file.id,
        resource: file.resource,
        title: file.title,
        content_type: file.content_type,
        source: ArtifactSourceDto {
            provider_id: file.source.provider_id,
            account_id: file.source.account_id,
            session_id: file.source.session_id,
            thread_id: file.source.thread_id,
            item_id: file.source.item_id,
            part_id: file.source.part_id,
        },
        created_at: record.created_at,
    }
}

fn artifact_catalog_error(error: ArtifactCatalogError) -> RpcError {
    match error {
        ArtifactCatalogError::Invalid => {
            RpcError::new(-32602, AppServerErrorName::ArtifactCatalogInvalid)
        }
        ArtifactCatalogError::Conflict => {
            RpcError::new(-32003, AppServerErrorName::ArtifactCatalogConflict)
        }
        ArtifactCatalogError::Storage(detail) => RpcError::with_details(
            -32000,
            AppServerErrorName::ArtifactCatalogOperationFailed,
            detail,
        ),
    }
}

#[cfg(test)]
#[path = "artifact_catalog_tests.rs"]
mod tests;
