use super::ConnectionAuthority;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::backup::BackupContentDto;
use ash_app_server_protocol::protocol::backup::BackupDiscardParams;
use ash_app_server_protocol::protocol::backup::BackupListPageParams;
use ash_app_server_protocol::protocol::backup::BackupListPageResult;
use ash_app_server_protocol::protocol::backup::BackupListParams;
use ash_app_server_protocol::protocol::backup::BackupListResult;
use ash_app_server_protocol::protocol::backup::BackupRecordDto;
use ash_app_server_protocol::protocol::backup::BackupWorkspaceDto;
use ash_app_server_protocol::protocol::backup::BackupWorkspacesParams;
use ash_app_server_protocol::protocol::backup::BackupWorkspacesResult;
use ash_app_server_protocol::protocol::backup::BackupWriteParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_state::BackupContent;
use ash_state::BackupError;
use ash_state::BackupRecord;
use ash_state::BackupWorkspace;
use ash_state::SqliteBackupStore;
use serde_json::Value;
use std::sync::Arc;

/// Adapts recovery RPCs to the profile's backup store. Backup namespaces survive
/// connection closure and are never derived from a window or connection ID.
#[derive(Default)]
pub(super) struct BackupRequestProcessor {
    store: Option<Arc<SqliteBackupStore>>,
}

impl BackupRequestProcessor {
    pub(super) fn new(store: Arc<SqliteBackupStore>) -> Self {
        Self { store: Some(store) }
    }

    fn store(&self, authority: ConnectionAuthority) -> Result<&SqliteBackupStore, RpcError> {
        if authority != ConnectionAuthority::ProductHost {
            return Err(RpcError::new(
                -32001,
                AppServerErrorName::PermissionRequired,
            ));
        }
        self.store
            .as_deref()
            .ok_or_else(|| RpcError::new(-32002, AppServerErrorName::BackupUnavailable))
    }

    pub(super) fn workspaces(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupWorkspacesParams = decode(params)?;
        let workspaces = self
            .store(authority)?
            .workspaces(&params.client_id)
            .map_err(backup_error)?;
        result(&BackupWorkspacesResult {
            workspaces: workspaces
                .into_iter()
                .map(|workspace| BackupWorkspaceDto {
                    id: workspace.id,
                    folders: workspace.folders,
                    configuration: workspace.configuration,
                    remote_authority: workspace.remote_authority,
                })
                .collect(),
        })
    }

    pub(super) fn list(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupListParams = decode(params)?;
        let backups = self
            .store(authority)?
            .list(&params.client_id, &params.workspace_id)
            .map_err(backup_error)?;
        result(&BackupListResult {
            backups: backups.into_iter().map(record).collect(),
        })
    }

    pub(super) fn list_page(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupListPageParams = decode(params)?;
        let page = self
            .store(authority)?
            .list_page(
                &params.client_id,
                &params.workspace_id,
                params.after_resource.as_deref(),
                8 * 1024 * 1024,
            )
            .map_err(backup_error)?;
        result(&BackupListPageResult {
            backups: page.backups.into_iter().map(record).collect(),
            next_resource: page.next_resource,
        })
    }

    pub(super) fn write(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupWriteParams = decode(params)?;
        let store = self.store(authority)?;
        for resource in params
            .workspace
            .folders
            .iter()
            .chain(params.workspace.configuration.iter())
            .chain(std::iter::once(&params.content.resource))
        {
            url::Url::parse(resource)
                .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        }
        let workspace = BackupWorkspace {
            id: params.workspace.id,
            folders: params.workspace.folders,
            configuration: params.workspace.configuration,
            remote_authority: params.workspace.remote_authority,
        };
        let content = BackupContent {
            resource: params.content.resource,
            format: params.content.format,
            content: params.content.content,
        };
        result(&record(
            store
                .write(
                    &params.client_id,
                    &workspace,
                    &content,
                    params.expected_revision.as_deref(),
                )
                .map_err(backup_error)?,
        ))
    }

    pub(super) fn discard(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupDiscardParams = decode(params)?;
        self.store(authority)?
            .discard(
                &params.client_id,
                &params.workspace_id,
                &params.resource,
                &params.expected_revision,
            )
            .map_err(backup_error)?;
        result(&())
    }
}

fn record(record: BackupRecord) -> BackupRecordDto {
    BackupRecordDto {
        content: BackupContentDto {
            resource: record.content.resource,
            format: record.content.format,
            content: record.content.content,
        },
        revision: record.revision,
        updated_at: record.updated_at,
    }
}

fn backup_error(error: BackupError) -> RpcError {
    match error {
        BackupError::Invalid => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        BackupError::Conflict => RpcError::new(-32003, AppServerErrorName::BackupRevisionConflict),
        BackupError::Storage(detail) => RpcError {
            code: -32000,
            message: AppServerErrorName::BackupOperationFailed,
            detail: Some(detail),
        },
    }
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
