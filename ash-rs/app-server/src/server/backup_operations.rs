use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::backup::BackupContentDto;
use ash_app_server_protocol::protocol::backup::BackupDiscardParams;
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

impl AppServer {
    fn backup_store(&self, connection: &ConnectionState) -> Result<&SqliteBackupStore, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32001,
                AppServerErrorName::PermissionRequired,
            ));
        }
        self.backups
            .as_deref()
            .ok_or_else(|| RpcError::new(-32002, AppServerErrorName::BackupUnavailable))
    }

    pub(super) fn backup_workspaces(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupWorkspacesParams = decode(params)?;
        let workspaces = self
            .backup_store(connection)?
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

    pub(super) fn backup_list(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupListParams = decode(params)?;
        let backups = self
            .backup_store(connection)?
            .list(&params.client_id, &params.workspace_id)
            .map_err(backup_error)?;
        result(&BackupListResult {
            backups: backups.into_iter().map(record).collect(),
        })
    }

    pub(super) fn backup_write(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupWriteParams = decode(params)?;
        let store = self.backup_store(connection)?;
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

    pub(super) fn backup_discard(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: BackupDiscardParams = decode(params)?;
        self.backup_store(connection)?
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
