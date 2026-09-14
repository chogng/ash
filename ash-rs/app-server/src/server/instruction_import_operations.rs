use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::instructions::InstructionImportApplyParams;
use ash_app_server_protocol::protocol::instructions::InstructionImportApplyResult;
use ash_app_server_protocol::protocol::instructions::InstructionImportDiagnosticCodeDto;
use ash_app_server_protocol::protocol::instructions::InstructionImportDiagnosticDto;
use ash_app_server_protocol::protocol::instructions::InstructionImportPreviewParams;
use ash_app_server_protocol::protocol::instructions::InstructionImportPreviewResult;
use ash_app_server_protocol::protocol::instructions::InstructionImportScopeDto;
use ash_app_server_protocol::protocol::instructions::InstructionImportSourceDto;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::FileSystem;
use ash_file_system::FileSystemError;
use ash_file_system::FileWriteCondition;
use ash_file_system::LocalFileSystem;
use external_agent_migration::AgentImportDiagnosticCode;
use external_agent_migration::AgentImportLocation;
use external_agent_migration::read_claude_instructions;
use serde_json::Value;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const TARGET: &str = "ASH.md";

struct ImportAccess {
    source: AgentImportLocation,
    target: PathBuf,
    read: Arc<dyn FileSystem>,
}

impl AppServer {
    pub(super) fn instruction_import_preview(&self, params: &Value) -> Result<Value, RpcError> {
        let params: InstructionImportPreviewParams = decode(params)?;
        let access = self.instruction_import_access(&params.scope)?;
        let read = read_claude_instructions(access.source).map_err(import_failed)?;
        let source = read
            .selected()
            .map(|selected| {
                let content = selected.content();
                if content.len() > ash_instructions::MAX_INSTRUCTION_BYTES {
                    return Err(import_failed(()));
                }
                Ok(InstructionImportSourceDto {
                    relative_path: selected.relative_path().to_path_buf(),
                    content: content.to_owned(),
                    sha256: ash_file_system::file_revision(content.as_bytes()),
                })
            })
            .transpose()?;
        let diagnostics = read
            .diagnostics()
            .iter()
            .map(|diagnostic| InstructionImportDiagnosticDto {
                relative_path: diagnostic.relative_path().to_path_buf(),
                code: diagnostic_code(diagnostic.code()),
            })
            .collect();
        let target_conflict = match access
            .read
            .read_file(Path::new(TARGET), ash_instructions::MAX_INSTRUCTION_BYTES)
        {
            Ok(content) => !content.is_empty(),
            Err(FileSystemError::NotFound(_)) => false,
            Err(FileSystemError::ReadLimitExceeded { .. }) => true,
            Err(error) => return Err(import_failed(error)),
        };
        result(&InstructionImportPreviewResult {
            source,
            target: access.target,
            target_conflict,
            diagnostics,
        })
    }

    pub(super) fn instruction_import_apply(&self, params: &Value) -> Result<Value, RpcError> {
        let params: InstructionImportApplyParams = decode(params)?;
        let access = self.instruction_import_access(&params.scope)?;
        if access.target != params.expected_target {
            return Err(import_conflict());
        }
        let read = read_claude_instructions(access.source).map_err(import_failed)?;
        let selected = read.selected().ok_or_else(import_not_found)?;
        let content = selected.content();
        if content.len() > ash_instructions::MAX_INSTRUCTION_BYTES {
            return Err(import_failed(()));
        }
        let digest = ash_file_system::file_revision(content.as_bytes());
        if selected.relative_path() != params.relative_path || digest != params.expected_sha256 {
            return Err(import_conflict());
        }
        self.instruction_import_writer(&params.scope)?
            .write_file_with_condition(
                Path::new(TARGET),
                content.as_bytes(),
                ash_instructions::MAX_INSTRUCTION_BYTES,
                &FileWriteCondition::MissingOrEmpty,
            )
            .map_err(|error| match error {
                FileSystemError::AlreadyExists(_) => import_conflict(),
                other => import_failed(other),
            })?;
        result(&InstructionImportApplyResult {
            target: access.target,
            sha256: digest,
        })
    }

    fn instruction_import_access(
        &self,
        scope: &InstructionImportScopeDto,
    ) -> Result<ImportAccess, RpcError> {
        match scope {
            InstructionImportScopeDto::Workspace => {
                let grant = self.selected_import_grant()?;
                let root = grant.dir().canonical_path().to_path_buf();
                Ok(ImportAccess {
                    source: AgentImportLocation::claude_project(&root),
                    target: root.join(TARGET),
                    read: Arc::new(LocalFileSystem::from_authorization(
                        grant
                            .authorize(Permission::ReadFiles)
                            .map_err(import_failed)?,
                    )),
                })
            }
            InstructionImportScopeDto::User => {
                let home = self.home.as_ref().ok_or_else(|| import_failed(()))?;
                let root = home.root();
                let user_home = std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .ok_or_else(|| import_failed(()))?;
                let dir = Dir::open_local(root).map_err(import_failed)?;
                let grant = Grant::for_environment(
                    dir,
                    GrantSource::HostConfiguration,
                    Permissions::new([Permission::ReadFiles]),
                );
                Ok(ImportAccess {
                    source: AgentImportLocation::claude_user(PathBuf::from(user_home)),
                    target: root.join(TARGET),
                    read: Arc::new(LocalFileSystem::new(grant)),
                })
            }
        }
    }

    fn instruction_import_writer(
        &self,
        scope: &InstructionImportScopeDto,
    ) -> Result<Arc<dyn FileSystem>, RpcError> {
        match scope {
            InstructionImportScopeDto::Workspace => {
                let grant = self.selected_import_grant()?;
                Ok(Arc::new(LocalFileSystem::from_authorization(
                    grant
                        .authorize(Permission::WriteFiles)
                        .map_err(import_failed)?,
                )))
            }
            InstructionImportScopeDto::User => {
                let root = self.home.as_ref().ok_or_else(|| import_failed(()))?.root();
                let dir = Dir::open_local(root).map_err(import_failed)?;
                let grant = Grant::for_environment(
                    dir,
                    GrantSource::HostConfiguration,
                    Permissions::new([Permission::WriteFiles]),
                );
                Ok(Arc::new(LocalFileSystem::new(grant)))
            }
        }
    }

    fn selected_import_grant(&self) -> Result<Grant, RpcError> {
        self.env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .selected_grant
            .clone()
            .ok_or_else(|| import_failed(()))
    }
}

fn diagnostic_code(code: AgentImportDiagnosticCode) -> InstructionImportDiagnosticCodeDto {
    match code {
        AgentImportDiagnosticCode::MetadataUnavailable => {
            InstructionImportDiagnosticCodeDto::MetadataUnavailable
        }
        AgentImportDiagnosticCode::UnexpectedFileType => {
            InstructionImportDiagnosticCodeDto::UnexpectedFileType
        }
        AgentImportDiagnosticCode::SymlinkNotAllowed => {
            InstructionImportDiagnosticCodeDto::SymlinkNotAllowed
        }
        AgentImportDiagnosticCode::EscapesSelectedRoot => {
            InstructionImportDiagnosticCodeDto::EscapesSelectedRoot
        }
        AgentImportDiagnosticCode::InvalidContent => {
            InstructionImportDiagnosticCodeDto::InvalidContent
        }
        AgentImportDiagnosticCode::LimitExceeded => {
            InstructionImportDiagnosticCodeDto::LimitExceeded
        }
    }
}

fn import_failed(_: impl std::fmt::Debug) -> RpcError {
    RpcError::new(-32079, AppServerErrorName::InstructionImportFailed)
}

fn import_not_found() -> RpcError {
    RpcError::new(-32080, AppServerErrorName::InstructionImportNotFound)
}

fn import_conflict() -> RpcError {
    RpcError::new(-32081, AppServerErrorName::InstructionImportConflict)
}
