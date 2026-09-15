use std::num::NonZeroU64;

use ash_app_server_protocol::protocol::codebase::CloudCodebaseAuthorizeParams;
use ash_app_server_protocol::protocol::codebase::CloudCodebaseDestinationDto;
use ash_app_server_protocol::protocol::codebase::CloudCodebaseGrantDto;
use ash_app_server_protocol::protocol::codebase::CloudCodebasePreviewParams;
use ash_app_server_protocol::protocol::codebase::CloudCodebasePreviewResult;
use ash_app_server_protocol::protocol::codebase::CloudCodebaseSelectionDto;
use ash_app_server_protocol::protocol::codebase::CloudCodebaseStateDto;
use ash_app_server_protocol::protocol::codebase::CloudCodebaseStatusResult;
use ash_app_server_protocol::protocol::codebase::CodebaseDeploymentModeDto;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_cloud_codebase::CloudCodebaseDestination;
use ash_cloud_codebase::CloudCodebaseError;
use ash_cloud_codebase::CloudCodebaseGrant;
use ash_cloud_codebase::CloudCodebaseGrantId;
use ash_cloud_codebase::CloudCodebaseId;
use ash_cloud_codebase::CloudCodebaseLimitDisposition;
use ash_cloud_codebase::CloudCodebasePreview;
use ash_cloud_codebase::CloudCodebaseProviderId;
use ash_cloud_codebase::CloudCodebaseSelection;
use ash_cloud_codebase::CloudCodebaseState;
use ash_cloud_codebase::CloudCodebaseStatus;
use ash_cloud_codebase::CodebaseDeploymentMode;
use serde_json::Value;

use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;

impl AppServer {
    pub(super) fn cloud_codebase_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let controller = self.cloud_codebase_service()?;
        let status = controller.status().map_err(cloud_codebase_error)?;
        result(&project_status(&status, controller.root_id().as_str()))
    }

    pub(super) fn cloud_codebase_preview(&self, params: &Value) -> Result<Value, RpcError> {
        let params: CloudCodebasePreviewParams = decode(params)?;
        let selection = selection(params.selection)?;
        let max_egress_bytes = NonZeroU64::new(params.max_egress_bytes)
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let controller = self.cloud_codebase_service()?;
        let preview = controller
            .preview(&selection, max_egress_bytes)
            .map_err(cloud_codebase_error)?;
        result(&project_preview(preview))
    }

    pub(super) fn cloud_codebase_authorize(&self, params: &Value) -> Result<Value, RpcError> {
        let params: CloudCodebaseAuthorizeParams = decode(params)?;
        let controller = self.cloud_codebase_service()?;
        let max_egress_bytes = NonZeroU64::new(params.grant.max_egress_bytes)
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let destination = CloudCodebaseDestination::new(
            CloudCodebaseProviderId::new(params.grant.destination.provider)
                .map_err(cloud_codebase_error)?,
            params.grant.destination.tenant,
            params.grant.destination.collection,
        )
        .map_err(cloud_codebase_error)?;
        let grant = CloudCodebaseGrant {
            id: CloudCodebaseGrantId::new(params.grant.grant_id).map_err(cloud_codebase_error)?,
            codebase_id: CloudCodebaseId::new(params.grant.codebase_id)
                .map_err(cloud_codebase_error)?,
            root_id: controller.root_id().as_str().to_owned(),
            destination,
            selection: selection(params.grant.selection)?,
            max_egress_bytes,
        };
        let status = controller.authorize(grant).map_err(cloud_codebase_error)?;
        result(&project_status(&status, controller.root_id().as_str()))
    }

    pub(super) fn cloud_codebase_sync(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let controller = self.cloud_codebase_service()?;
        let status = controller.sync().map_err(cloud_codebase_error)?;
        result(&project_status(&status, controller.root_id().as_str()))
    }

    pub(super) fn cloud_codebase_revoke(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let controller = self.cloud_codebase_service()?;
        let status = controller.revoke().map_err(cloud_codebase_error)?;
        result(&project_status(&status, controller.root_id().as_str()))
    }
}

fn selection(value: CloudCodebaseSelectionDto) -> Result<CloudCodebaseSelection, RpcError> {
    match value {
        CloudCodebaseSelectionDto::EntireIndex => Ok(CloudCodebaseSelection::EntireIndex),
        CloudCodebaseSelectionDto::PathPrefixes { prefixes } => {
            CloudCodebaseSelection::path_prefixes(prefixes).map_err(cloud_codebase_error)
        }
    }
}

fn project_preview(preview: CloudCodebasePreview) -> CloudCodebasePreviewResult {
    CloudCodebasePreviewResult {
        local_generation: preview.local_generation,
        file_count: preview.file_count,
        chunk_count: preview.chunk_count,
        upload_unit_count: preview.upload_unit_count,
        egress_bytes: preview.egress_bytes,
        within_limit: preview.limit == CloudCodebaseLimitDisposition::WithinLimit,
    }
}

fn project_status(status: &CloudCodebaseStatus, root_id: &str) -> CloudCodebaseStatusResult {
    CloudCodebaseStatusResult {
        deployment_mode: match status.deployment_mode {
            CodebaseDeploymentMode::LocalOnly => CodebaseDeploymentModeDto::LocalOnly,
            CodebaseDeploymentMode::Cloud => CodebaseDeploymentModeDto::Cloud,
        },
        state: match status.state {
            CloudCodebaseState::LocalOnly => CloudCodebaseStateDto::LocalOnly,
            CloudCodebaseState::Granted => CloudCodebaseStateDto::Granted,
            CloudCodebaseState::Syncing => CloudCodebaseStateDto::Syncing,
            CloudCodebaseState::Ready => CloudCodebaseStateDto::Ready,
            CloudCodebaseState::Stale => CloudCodebaseStateDto::Stale,
            CloudCodebaseState::Revoking => CloudCodebaseStateDto::Revoking,
            CloudCodebaseState::Failed => CloudCodebaseStateDto::Failed,
        },
        root_id: root_id.to_owned(),
        grant: status.grant.as_ref().map(project_grant),
        local_generation: status.local_generation,
        synced_local_generation: status.synced_local_generation,
        remote_generation: status.remote_generation.clone(),
    }
}

fn project_grant(grant: &CloudCodebaseGrant) -> CloudCodebaseGrantDto {
    CloudCodebaseGrantDto {
        grant_id: grant.id.as_str().to_owned(),
        codebase_id: grant.codebase_id.as_str().to_owned(),
        destination: CloudCodebaseDestinationDto {
            provider: grant.destination.provider.as_str().to_owned(),
            tenant: grant.destination.tenant.clone(),
            collection: grant.destination.collection.clone(),
        },
        selection: match &grant.selection {
            CloudCodebaseSelection::EntireIndex => CloudCodebaseSelectionDto::EntireIndex,
            CloudCodebaseSelection::PathPrefixes(prefixes) => {
                CloudCodebaseSelectionDto::PathPrefixes {
                    prefixes: prefixes.clone(),
                }
            }
        },
        max_egress_bytes: grant.max_egress_bytes.get(),
    }
}

fn cloud_codebase_error(error: CloudCodebaseError) -> RpcError {
    match error {
        CloudCodebaseError::InvalidInput(_) | CloudCodebaseError::StorageRootMismatch => {
            RpcError::new(-32602, AppServerErrorName::CloudCodebaseInvalidGrant)
        }
        CloudCodebaseError::ConsentConflict => {
            RpcError::new(-32094, AppServerErrorName::CloudCodebaseConsentConflict)
        }
        CloudCodebaseError::EgressLimitExceeded => {
            RpcError::new(-32095, AppServerErrorName::CloudCodebaseEgressLimitExceeded)
        }
        CloudCodebaseError::LocalIndexNotReady => {
            RpcError::new(-32091, AppServerErrorName::CodebaseNotReady)
        }
        CloudCodebaseError::ProviderUnavailable | CloudCodebaseError::DeletionUnsupported => {
            RpcError::new(-32096, AppServerErrorName::CloudCodebaseProviderUnavailable)
        }
        CloudCodebaseError::NoActiveGrant
        | CloudCodebaseError::InvalidState
        | CloudCodebaseError::InvalidProviderResult(_)
        | CloudCodebaseError::Provider(_)
        | CloudCodebaseError::LocalIndex(_)
        | CloudCodebaseError::IncompatibleStorage
        | CloudCodebaseError::Storage(_)
        | CloudCodebaseError::DatabaseRuntime(_)
        | CloudCodebaseError::Serialization(_) => {
            RpcError::new(-32097, AppServerErrorName::CloudCodebaseOperationFailed)
        }
    }
}

#[cfg(test)]
#[path = "cloud_codebase_operations_tests.rs"]
mod tests;
