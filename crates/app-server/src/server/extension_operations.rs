use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::marketplace_operations::marketplace_error;
use super::operations::resource_rpc_error;
use super::result;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::extensions::ExtensionCatalogReloadDto;
use ash_app_server_protocol::protocol::extensions::ExtensionDiagnosticCodeDto;
use ash_app_server_protocol::protocol::extensions::ExtensionDiagnosticDto;
use ash_app_server_protocol::protocol::extensions::ExtensionDto;
use ash_app_server_protocol::protocol::extensions::ExtensionGalleryResourceOpenParams;
use ash_app_server_protocol::protocol::extensions::ExtensionGalleryResult;
use ash_app_server_protocol::protocol::extensions::ExtensionListParams;
use ash_app_server_protocol::protocol::extensions::ExtensionListResult;
use ash_app_server_protocol::protocol::extensions::ExtensionResourceOpenParams;
use ash_app_server_protocol::protocol::extensions::ExtensionResourceOpenResult;
use ash_app_server_protocol::protocol::extensions::ExtensionSourceKindDto;
use ash_app_server_protocol::protocol::resources::ResourceMetadataResult;
use ash_external_ext::packages::ExtensionDescriptor;
use ash_external_ext::packages::ExtensionDiagnostic;
use ash_external_ext::packages::ExtensionDiagnosticCode;
use ash_external_ext::packages::ExtensionPackagesError;
use ash_external_ext::packages::ExtensionPackagesReload;
use ash_external_ext::packages::ExtensionSourceKind;
use serde_json::Value;
use std::time::Duration;

impl AppServer {
    pub(super) fn extension_gallery(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let template = self
            .plugins_manager
            .as_ref()
            .map(|manager| manager.extension_gallery_resource_url_template())
            .transpose()
            .map_err(marketplace_error)?
            .flatten();
        result(&ExtensionGalleryResult {
            resource_url_template: template,
        })
    }

    pub(super) fn extension_gallery_resource_open(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionGalleryResourceOpenParams = decode(params)?;
        let manager = self
            .plugins_manager
            .as_ref()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::PluginsUnavailable))?;
        if manager
            .extension_gallery_resource_url_template()
            .map_err(marketplace_error)?
            .as_deref()
            != Some(params.resource_url_template.as_str())
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let bytes = manager
            .read_extension_gallery_resource(
                &params.publisher,
                &params.name,
                &params.version,
                &params.path,
            )
            .map_err(marketplace_error)?;
        let metadata = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .create(
                connection.connection_id,
                "application/octet-stream".into(),
                bytes,
                Duration::from_secs(300),
            )
            .map_err(resource_rpc_error)?;
        result(&ExtensionResourceOpenResult {
            resource: ResourceMetadataResult {
                resource_id: metadata.resource_id,
                mime_type: metadata.mime_type,
                size: metadata.size,
                sha256: metadata.sha256,
            },
        })
    }

    pub(super) fn extension_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionListParams = decode(params)?;
        let reload = match params.reload {
            ExtensionCatalogReloadDto::Cached => ExtensionPackagesReload::Cached,
            ExtensionCatalogReloadDto::Refresh => ExtensionPackagesReload::Refresh,
        };
        let snapshot = self
            .extensions
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .list(reload);
        result(&ExtensionListResult {
            generation: snapshot.generation,
            extensions: snapshot
                .extensions
                .into_iter()
                .map(extension_descriptor)
                .collect(),
            diagnostics: snapshot
                .diagnostics
                .into_iter()
                .map(extension_diagnostic)
                .collect(),
        })
    }

    pub(super) fn extension_resource_open(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionResourceOpenParams = decode(params)?;
        let resource = self
            .extensions
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .open_resource(params.generation, &params.extension_id, &params.path)
            .map_err(extension_catalog_error)?;
        let metadata = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .create(
                connection.connection_id,
                resource.mime_type,
                resource.bytes,
                Duration::from_secs(300),
            )
            .map_err(resource_rpc_error)?;
        result(&ExtensionResourceOpenResult {
            resource: ResourceMetadataResult {
                resource_id: metadata.resource_id,
                mime_type: metadata.mime_type,
                size: metadata.size,
                sha256: metadata.sha256,
            },
        })
    }
}

fn extension_descriptor(value: ExtensionDescriptor) -> ExtensionDto {
    ExtensionDto {
        id: value.id,
        name: value.name,
        publisher: value.publisher,
        version: value.version,
        display_name: value.display_name,
        extension_location: url::Url::from_file_path(value.extension_location)
            .ok()
            .map(String::from),
        target_platform: Some(format!(
            "{}-{}",
            match std::env::consts::OS {
                "windows" => "win32",
                "macos" => "darwin",
                operating_system => operating_system,
            },
            match std::env::consts::ARCH {
                "x86_64" => "x64",
                "x86" => "ia32",
                "aarch64" => "arm64",
                "arm" => "armhf",
                architecture => architecture,
            }
        )),
        source_kind: match value.source_kind {
            ExtensionSourceKind::BuiltIn => ExtensionSourceKindDto::BuiltIn,
            ExtensionSourceKind::Plugin => ExtensionSourceKindDto::Plugin,
            ExtensionSourceKind::Marketplace => ExtensionSourceKindDto::Marketplace,
            ExtensionSourceKind::User => ExtensionSourceKindDto::User,
        },
        manifest_json: value.manifest_json,
        manifest_sha256: value.manifest_sha256,
        package_sha256: value.package_sha256,
    }
}

fn extension_diagnostic(value: ExtensionDiagnostic) -> ExtensionDiagnosticDto {
    ExtensionDiagnosticDto {
        source: value.source,
        subject: value.subject,
        code: match value.code {
            ExtensionDiagnosticCode::SourceUnavailable => {
                ExtensionDiagnosticCodeDto::SourceUnavailable
            }
            ExtensionDiagnosticCode::InvalidManifest => ExtensionDiagnosticCodeDto::InvalidManifest,
            ExtensionDiagnosticCode::DuplicateExtension => {
                ExtensionDiagnosticCodeDto::DuplicateExtension
            }
            ExtensionDiagnosticCode::PathEscapesRoot => ExtensionDiagnosticCodeDto::PathEscapesRoot,
            ExtensionDiagnosticCode::ResourceNotFound => {
                ExtensionDiagnosticCodeDto::ResourceNotFound
            }
            ExtensionDiagnosticCode::ResourceTooLarge => {
                ExtensionDiagnosticCodeDto::ResourceTooLarge
            }
        },
        message: value.message,
    }
}

fn extension_catalog_error(error: ExtensionPackagesError) -> RpcError {
    let message = match error {
        ExtensionPackagesError::GenerationConflict => {
            AppServerErrorName::ExtensionGenerationConflict
        }
        ExtensionPackagesError::NotFound => AppServerErrorName::ExtensionNotFound,
        ExtensionPackagesError::InvalidPath => AppServerErrorName::ExtensionResourceInvalidPath,
        ExtensionPackagesError::ResourceNotFound => AppServerErrorName::ExtensionResourceNotFound,
        ExtensionPackagesError::ResourceTooLarge => AppServerErrorName::ExtensionOperationFailed,
        ExtensionPackagesError::OperationFailed => AppServerErrorName::ExtensionOperationFailed,
    };
    RpcError::new(-32040, message)
}

#[cfg(test)]
#[path = "extension_operations_tests.rs"]
mod tests;
