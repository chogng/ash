use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::config_operations::config_command_result;
use super::config_operations::config_operation_error;
use super::decode;
use super::operations::resource_rpc_error;
use super::result;
use ash_app_server_protocol::protocol::config::ConfigCommandResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::resources::ResourceMetadataResult;
use ash_app_server_protocol::protocol::skills::SkillCatalogReloadDto;
use ash_app_server_protocol::protocol::skills::SkillCompatibilityDto;
use ash_app_server_protocol::protocol::skills::SkillDiagnosticCodeDto;
use ash_app_server_protocol::protocol::skills::SkillDiagnosticDto;
use ash_app_server_protocol::protocol::skills::SkillDto;
use ash_app_server_protocol::protocol::skills::SkillEnablementDto;
use ash_app_server_protocol::protocol::skills::SkillListParams;
use ash_app_server_protocol::protocol::skills::SkillListResult;
use ash_app_server_protocol::protocol::skills::SkillResourceKindDto;
use ash_app_server_protocol::protocol::skills::SkillResourceOpenParams;
use ash_app_server_protocol::protocol::skills::SkillResourceOpenResult;
use ash_app_server_protocol::protocol::skills::SkillSetEnablementParams;
use ash_app_server_protocol::protocol::skills::SkillSourceKindDto;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::SkillEnablement;
use ash_config::UserConfigCommand;
use ash_protocol::SkillRef;
use ash_skills::SkillResourceKind;
use ash_skills::SkillResourcePath;
use ash_skills_extension::SkillCatalogReload;
use ash_skills_extension::SkillCompatibility;
use ash_skills_extension::SkillDiagnosticCode;
use ash_skills_extension::SkillRuntimeDiagnostic;
use ash_skills_extension::SkillRuntimeSnapshot;
use ash_skills_extension::SkillSourceKind;
use serde_json::Value;
use std::time::Duration;

impl AppServer {
    pub(super) fn skill_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SkillListParams = decode(params)?;
        let runtime = self.skills.as_ref().ok_or_else(skills_unavailable)?;
        let reload = match params.reload {
            SkillCatalogReloadDto::Cached => SkillCatalogReload::Cached,
            SkillCatalogReloadDto::Refresh => SkillCatalogReload::Refresh,
        };
        let snapshot = params
            .session_id
            .as_ref()
            .map_or_else(
                || runtime.list(reload),
                |session_id| runtime.list_for_session(session_id),
            )
            .map_err(skills_failed)?;
        result(&skill_list_result(snapshot.as_ref()))
    }

    pub(super) fn skill_set_enablement(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SkillSetEnablementParams = decode(params)?;
        let runtime = self.skills.as_ref().ok_or_else(skills_unavailable)?;
        let snapshot = runtime
            .list(SkillCatalogReload::Cached)
            .map_err(skills_failed)?;
        if !snapshot
            .entries
            .iter()
            .any(|entry| entry.catalog_entry.id() == &params.skill_id)
        {
            return Err(RpcError::new(-32052, AppServerErrorName::SkillNotFound));
        }
        let store = self
            .config
            .clone()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
        let outcome = store
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::SetSkillEnablement {
                    skill_id: params.skill_id,
                    enablement: enablement_from_dto(params.enablement),
                },
            })
            .map_err(config_operation_error)?;
        runtime
            .list(SkillCatalogReload::Cached)
            .map_err(skills_failed)?;
        result::<ConfigCommandResult>(&config_command_result(outcome))
    }

    pub(super) fn skill_resource_open(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SkillResourceOpenParams = decode(params)?;
        let path = SkillResourcePath::new(&params.path)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let runtime = self.skills.as_ref().ok_or_else(skills_unavailable)?;
        let selected = SkillRef::pinned(params.skill_id, params.skill_content_digest);
        let resource = params
            .session_id
            .as_ref()
            .map_or_else(
                || runtime.read_resource(&selected, &path),
                |session_id| runtime.read_resource_for_session(session_id, &selected, &path),
            )
            .map_err(skills_failed)?;
        let kind = skill_resource_kind_dto(resource.kind());
        let path = resource.path().display();
        let mime_type = skill_resource_mime_type(resource.path(), resource.bytes());
        let metadata = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .create(
                connection.connection_id,
                mime_type,
                resource.bytes().to_vec(),
                Duration::from_secs(300),
            )
            .map_err(resource_rpc_error)?;
        result(&SkillResourceOpenResult {
            path,
            kind,
            resource: ResourceMetadataResult {
                resource_id: metadata.resource_id,
                mime_type: metadata.mime_type,
                size: metadata.size,
                sha256: metadata.sha256,
            },
        })
    }
}

fn skill_resource_kind_dto(kind: SkillResourceKind) -> SkillResourceKindDto {
    match kind {
        SkillResourceKind::Instructions => SkillResourceKindDto::Instructions,
        SkillResourceKind::Reference => SkillResourceKindDto::Reference,
        SkillResourceKind::Script => SkillResourceKindDto::Script,
        SkillResourceKind::Asset => SkillResourceKindDto::Asset,
        SkillResourceKind::AgentMetadata => SkillResourceKindDto::AgentMetadata,
        SkillResourceKind::Other => SkillResourceKindDto::Other,
    }
}

fn skill_resource_mime_type(path: &SkillResourcePath, bytes: &[u8]) -> String {
    let extension = path
        .as_path()
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let mime_type = match extension.as_deref() {
        Some("png") if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        Some("jpg" | "jpeg") if bytes.starts_with(&[0xff, 0xd8, 0xff]) => "image/jpeg",
        Some("gif") if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => "image/gif",
        Some("webp")
            if bytes.len() >= 12
                && bytes.starts_with(b"RIFF")
                && bytes.get(8..12) == Some(b"WEBP") =>
        {
            "image/webp"
        }
        Some("pdf") if bytes.starts_with(b"%PDF-") => "application/pdf",
        Some("md" | "markdown") if std::str::from_utf8(bytes).is_ok() => {
            "text/markdown; charset=utf-8"
        }
        Some(
            "txt" | "json" | "yaml" | "yml" | "toml" | "csv" | "rs" | "py" | "sh" | "ts" | "tsx"
            | "js" | "jsx",
        ) if std::str::from_utf8(bytes).is_ok() => "text/plain; charset=utf-8",
        // Active content is intentionally not advertised as previewable. A future Renderer adapter
        // must sanitize or sandbox it before assigning an active media type.
        Some("svg" | "html" | "htm") => "application/octet-stream",
        _ => "application/octet-stream",
    };
    mime_type.into()
}

fn skill_list_result(snapshot: &SkillRuntimeSnapshot) -> SkillListResult {
    SkillListResult {
        generation: snapshot.generation,
        skills: snapshot
            .entries
            .iter()
            .map(|entry| {
                let catalog = &entry.catalog_entry;
                SkillDto {
                    id: catalog.id().clone(),
                    description: catalog.metadata().description().to_owned(),
                    source_kind: match catalog.source().kind() {
                        SkillSourceKind::BuiltIn => SkillSourceKindDto::BuiltIn,
                        SkillSourceKind::User => SkillSourceKindDto::User,
                        SkillSourceKind::Directory => SkillSourceKindDto::Directory,
                        SkillSourceKind::Plugin => SkillSourceKindDto::Plugin,
                        SkillSourceKind::Marketplace => SkillSourceKindDto::Marketplace,
                    },
                    content_digest: catalog.content_digest().clone(),
                    enablement: enablement_dto(entry.enablement),
                    compatibility: match catalog.compatibility() {
                        SkillCompatibility::Compatible => SkillCompatibilityDto::Compatible,
                        SkillCompatibility::Unknown { note } => {
                            SkillCompatibilityDto::Unknown { note: note.clone() }
                        }
                    },
                }
            })
            .collect(),
        diagnostics: snapshot.diagnostics.iter().map(diagnostic_dto).collect(),
    }
}

fn diagnostic_dto(diagnostic: &SkillRuntimeDiagnostic) -> SkillDiagnosticDto {
    SkillDiagnosticDto {
        source: diagnostic.source.clone(),
        subject: diagnostic.subject.clone(),
        code: match diagnostic.code {
            SkillDiagnosticCode::SourceUnavailable => SkillDiagnosticCodeDto::SourceUnavailable,
            SkillDiagnosticCode::SourceLimitExceeded => SkillDiagnosticCodeDto::SourceLimitExceeded,
            SkillDiagnosticCode::SkillNotFound => SkillDiagnosticCodeDto::SkillNotFound,
            SkillDiagnosticCode::InvalidFrontmatter => SkillDiagnosticCodeDto::InvalidFrontmatter,
            SkillDiagnosticCode::InvalidSkillName => SkillDiagnosticCodeDto::InvalidSkillName,
            SkillDiagnosticCode::DescriptionInvalid => SkillDiagnosticCodeDto::DescriptionInvalid,
            SkillDiagnosticCode::PathEscapesRoot => SkillDiagnosticCodeDto::PathEscapesRoot,
            SkillDiagnosticCode::UnsupportedFileType => SkillDiagnosticCodeDto::UnsupportedFileType,
            SkillDiagnosticCode::ContentTooLarge => SkillDiagnosticCodeDto::ContentTooLarge,
        },
        message: diagnostic.message.clone(),
    }
}

fn enablement_dto(enablement: SkillEnablement) -> SkillEnablementDto {
    match enablement {
        SkillEnablement::Disabled => SkillEnablementDto::Disabled,
        SkillEnablement::Enabled => SkillEnablementDto::Enabled,
    }
}

fn enablement_from_dto(enablement: SkillEnablementDto) -> SkillEnablement {
    match enablement {
        SkillEnablementDto::Disabled => SkillEnablement::Disabled,
        SkillEnablementDto::Enabled => SkillEnablement::Enabled,
    }
}

fn skills_unavailable() -> RpcError {
    RpcError::new(-32050, AppServerErrorName::SkillsUnavailable)
}

fn skills_failed(_: String) -> RpcError {
    RpcError::new(-32051, AppServerErrorName::SkillOperationFailed)
}

#[cfg(test)]
#[path = "skill_operations_tests.rs"]
mod tests;
