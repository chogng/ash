//! Reusable typed app-server client boundary and contract-test entry point.

mod infrastructure;
mod memories;
mod memory;
pub use memory::MemoryRecording;

#[cfg(any(test, feature = "in-process"))]
mod in_process;
mod notification;
mod session;

use ash_app_server_protocol::protocol::account::AccountLoginCancelParams;
use ash_app_server_protocol::protocol::account::AccountLoginCancelResult;
use ash_app_server_protocol::protocol::account::AccountLoginStartParams;
use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
use ash_app_server_protocol::protocol::account::AccountLogoutParams;
use ash_app_server_protocol::protocol::account::AccountLogoutResult;
use ash_app_server_protocol::protocol::account::AccountRateLimitsReadParams;
use ash_app_server_protocol::protocol::account::AccountRateLimitsReadResult;
use ash_app_server_protocol::protocol::account::AccountReadResult;
use ash_app_server_protocol::protocol::attachments::AttachmentImportRemoteParams;
use ash_app_server_protocol::protocol::attachments::AttachmentMaterializeResult;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadCancelParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadFinishParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadStartParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadStartResult;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadWriteParams;
use ash_app_server_protocol::protocol::attachments::AttachmentUploadWriteResult;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::config::{
    ConfigCommandResult, ConfigReadResult, ConfigUpdateParams, LanguageServerConfigureParams,
    LanguageServerRemoveParams, McpServerRemoveParams, McpServerSetEnablementParams,
    McpServerUpsertParams, ProviderConfigureParams, ProviderRemoveParams, SkillSourceAddParams,
    SkillSourceRemoveParams, SkillSourceSetEnablementParams,
};
use ash_app_server_protocol::protocol::connectors::ConnectorCommandResultDto;
use ash_app_server_protocol::protocol::connectors::ConnectorCredentialCleanupDto;
use ash_app_server_protocol::protocol::connectors::ConnectorCredentialCleanupParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthPollParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthPollResult;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthStartParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDeviceOAuthStartResult;
use ash_app_server_protocol::protocol::connectors::ConnectorDisconnectParams;
use ash_app_server_protocol::protocol::connectors::ConnectorDisconnectResultDto;
use ash_app_server_protocol::protocol::connectors::ConnectorListResult;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthCancelParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthRefreshParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthStartParams;
use ash_app_server_protocol::protocol::connectors::ConnectorOAuthStartResult;
use ash_app_server_protocol::protocol::diff::DiffComputeParams;
use ash_app_server_protocol::protocol::diff::DiffComputeResult;
use ash_app_server_protocol::protocol::document::{TypstCompileParams, TypstCompileResult};
use ash_app_server_protocol::protocol::environment::{
    DirPermissionsReadParams, DirPermissionsReadResult, EnvCwdSetParams, EnvCwdSetResult,
    EnvDirsSetParams, EnvDirsSetResult, SessionDirAddParams, SessionDirAddResult,
    SessionDirListParams, SessionDirListResult, SessionDirMutationResult,
    SessionDirPermissionsSetParams, SessionDirRemoveParams,
};
use ash_app_server_protocol::protocol::fs::{
    FsGetMetadataParams, FsGetMetadataResult, FsReadBinaryFileParams, FsReadBinaryFileResult,
    FsReadDirectoryParams, FsReadDirectoryResult, FsReadFileParams, FsReadFileResult,
    FsWriteFileParams, FsWriteFileResult,
};
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_app_server_protocol::protocol::git::{
    GitBranchCreateParams, GitBranchListResult, GitBranchSwitchParams, GitCommitParams,
    GitCommitResult, GitOperationResult, GitPathsParams, GitRepositoriesResult,
    GitRepositoryParams, GitTextDiffResult, GitWorktreeCreateParams, GitWorktreeCreateResult,
};
use ash_app_server_protocol::protocol::initialize::{InitializeParams, InitializeResult};
use ash_app_server_protocol::protocol::language::LanguageCloseParams;
use ash_app_server_protocol::protocol::language::LanguageCompletionsParams;
use ash_app_server_protocol::protocol::language::LanguageCompletionsResult;
use ash_app_server_protocol::protocol::language::LanguageHoverParams;
use ash_app_server_protocol::protocol::language::LanguageHoverResult;
use ash_app_server_protocol::protocol::language::LanguageLocationsParams;
use ash_app_server_protocol::protocol::language::LanguageLocationsResult;
use ash_app_server_protocol::protocol::language::LanguageServersParams;
use ash_app_server_protocol::protocol::language::LanguageServersResult;
use ash_app_server_protocol::protocol::language::LanguageSynchronizeParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceAcquireCapabilityParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceAcquiredCapabilityDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceArtifactHandleDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceDownloadParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceGetParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstallParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstalledPackageDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceListInstalledResult;
use ash_app_server_protocol::protocol::marketplace::MarketplaceOpenResourceParams;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageDetailsDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceReleaseCapabilityParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceResourceContentDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchResult;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUninstallParams;
use ash_app_server_protocol::protocol::marketplace::MarketplaceUpdateParams;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_app_server_protocol::protocol::plugins::PluginCommandResultDto;
use ash_app_server_protocol::protocol::plugins::PluginListResult;
use ash_app_server_protocol::protocol::plugins::PluginPackageCommandParams;
use ash_app_server_protocol::protocol::projects::ProjectCreateParams;
use ash_app_server_protocol::protocol::projects::ProjectListParams;
use ash_app_server_protocol::protocol::projects::ProjectListResult;
use ash_app_server_protocol::protocol::projects::ProjectMutationResult;
use ash_app_server_protocol::protocol::projects::ProjectReadParams;
use ash_app_server_protocol::protocol::projects::ProjectReadResult;
use ash_app_server_protocol::protocol::projects::ProjectRootAddParams;
use ash_app_server_protocol::protocol::projects::ProjectSessionMutationParams;
use ash_app_server_protocol::protocol::provider::{ProviderApiKeySetResult, ProviderListResult};
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_app_server_protocol::protocol::resources::{
    ResourceMetadataParams, ResourceMetadataResult, ResourceReadParams, ResourceReadResult,
    ResourceReleaseParams,
};
use ash_app_server_protocol::protocol::search::{
    ContentSearchCancelParams, ContentSearchReadParams, ContentSearchReadResult,
    ContentSearchStartParams, ContentSearchStartResult,
};
use ash_app_server_protocol::protocol::session::{
    SessionCreateParams, SessionListResult, SessionReadParams, SessionRequestParams,
    SessionRequestResult, SessionResult, SessionSubscribeParams, SessionSubscribeResult,
    SessionThreadReadParams, SessionThreadReadResult, SessionThreadSubscribeParams,
    SessionThreadSubscribeResult, SessionThreadUnsubscribeParams, SessionUnsubscribeParams,
};
use ash_app_server_protocol::protocol::skills::{
    SkillListParams, SkillListResult, SkillResourceOpenParams, SkillResourceOpenResult,
    SkillSetEnablementParams,
};
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeParams;
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeResult;
use ash_app_server_protocol::protocol::syntax::SyntaxCloseParams;
use ash_app_server_protocol::protocol::syntax::SyntaxOpenParams;
use ash_app_server_protocol::protocol::syntax::SyntaxUpdateParams;
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
use ash_app_server_protocol::protocol::terminal::TerminalAttachResult;
use ash_app_server_protocol::protocol::terminal::TerminalCloseParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateInSessionDirectoryParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateResult;
use ash_app_server_protocol::protocol::terminal::TerminalProfileListResult;
use ash_app_server_protocol::protocol::terminal::TerminalReadParams;
use ash_app_server_protocol::protocol::terminal::TerminalReadResult;
use ash_app_server_protocol::protocol::terminal::TerminalResizeParams;
use ash_app_server_protocol::protocol::terminal::TerminalWriteParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesCommitParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesListParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesListResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesMutationParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesMutationResult;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadResult;
use ash_app_server_protocol::rpc::{JsonRpcId, JsonRpcRequest, JsonRpcResponse};
use serde::Serialize;
use serde::Serializer;
use serde::ser::SerializeStruct;
use serde_json::Value;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use zeroize::Zeroize;
use zeroize::Zeroizing;

#[cfg(any(test, feature = "in-process"))]
pub use ash_app_server::SessionStateMode;
#[cfg(any(test, feature = "in-process"))]
pub use in_process::{
    InProcessAppServer, InProcessClientOptions, InProcessTransport, open_in_process_app_server,
    start_in_process_client,
};
pub use notification::ServerNotification;
pub use session::{
    AppServerEvent, AppServerEvents, AppServerRequestHandle, AppServerSession,
    ConnectionCloseReason, ShutdownError, StdioAppServerCommand, TakeEventsError,
};

/// Exchanges one complete JSON-RPC request with a connected app-server transport.
///
/// Implementations must preserve request/response pairing for a single connection and must not
/// return notifications as if they were responses to this client call. Implementations buffer
/// causally emitted notifications until `drain_notifications` is called.
pub trait JsonRpcTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError>;

    fn drain_notifications(&mut self) -> Result<Vec<String>, ClientError> {
        Ok(Vec::new())
    }
}

pub struct AppServerClient<T> {
    transport: T,
    next_request_id: Arc<AtomicU64>,
    initialization: Arc<OnceLock<InitializeResult>>,
}

/// Client-owned API-token request whose secret and encoded wire buffer are cleared after one call.
pub struct ConnectorApiTokenConnectRequest {
    pub command_id: String,
    pub expected_generation: u64,
    pub connector_id: String,
    pub connection_generation: u64,
    pub account_id: String,
    pub account_display_name: String,
    api_token: Zeroizing<String>,
}

/// Client-owned provider API-key request whose secret and encoded wire buffer are cleared.
pub struct ProviderApiKeySetRequest {
    pub provider: String,
    api_key: Zeroizing<String>,
}

impl ProviderApiKeySetRequest {
    pub fn new(provider: String, api_key: String) -> Self {
        Self {
            provider,
            api_key: Zeroizing::new(api_key),
        }
    }
}

impl fmt::Debug for ProviderApiKeySetRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderApiKeySetRequest")
            .field("provider", &self.provider)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

impl Serialize for ProviderApiKeySetRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut request = serializer.serialize_struct("ProviderApiKeySetRequest", 2)?;
        request.serialize_field("provider", &self.provider)?;
        request.serialize_field("apiKey", self.api_key.as_str())?;
        request.end()
    }
}

impl ConnectorApiTokenConnectRequest {
    pub fn new(
        command_id: String,
        expected_generation: u64,
        connector_id: String,
        connection_generation: u64,
        account_id: String,
        account_display_name: String,
        api_token: String,
    ) -> Self {
        Self {
            command_id,
            expected_generation,
            connector_id,
            connection_generation,
            account_id,
            account_display_name,
            api_token: Zeroizing::new(api_token),
        }
    }
}

impl fmt::Debug for ConnectorApiTokenConnectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectorApiTokenConnectRequest")
            .field("command_id", &self.command_id)
            .field("expected_generation", &self.expected_generation)
            .field("connector_id", &self.connector_id)
            .field("connection_generation", &self.connection_generation)
            .field("account_id", &self.account_id)
            .field("account_display_name", &self.account_display_name)
            .field("api_token", &"[REDACTED]")
            .finish()
    }
}

impl Serialize for ConnectorApiTokenConnectRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut request = serializer.serialize_struct("ConnectorApiTokenConnectRequest", 7)?;
        request.serialize_field("commandId", &self.command_id)?;
        request.serialize_field("expectedGeneration", &self.expected_generation)?;
        request.serialize_field("connectorId", &self.connector_id)?;
        request.serialize_field("connectionGeneration", &self.connection_generation)?;
        request.serialize_field("accountId", &self.account_id)?;
        request.serialize_field("accountDisplayName", &self.account_display_name)?;
        request.serialize_field("apiToken", self.api_token.as_str())?;
        request.end()
    }
}

/// Client-owned OAuth callback whose state, code, and encoded wire buffer are one-shot.
pub struct ConnectorOAuthCompleteRequest {
    pub flow_id: String,
    state: Zeroizing<String>,
    authorization_code: Zeroizing<String>,
}

impl ConnectorOAuthCompleteRequest {
    pub fn new(flow_id: String, state: String, authorization_code: String) -> Self {
        Self {
            flow_id,
            state: Zeroizing::new(state),
            authorization_code: Zeroizing::new(authorization_code),
        }
    }
}

impl fmt::Debug for ConnectorOAuthCompleteRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectorOAuthCompleteRequest")
            .field("flow_id", &self.flow_id)
            .field("state", &"[REDACTED]")
            .field("authorization_code", &"[REDACTED]")
            .finish()
    }
}

impl Serialize for ConnectorOAuthCompleteRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut request = serializer.serialize_struct("ConnectorOAuthCompleteRequest", 3)?;
        request.serialize_field("flowId", &self.flow_id)?;
        request.serialize_field("state", self.state.as_str())?;
        request.serialize_field("authorizationCode", self.authorization_code.as_str())?;
        request.end()
    }
}

impl<T: Clone> Clone for AppServerClient<T> {
    fn clone(&self) -> Self {
        Self {
            transport: self.transport.clone(),
            next_request_id: Arc::clone(&self.next_request_id),
            initialization: Arc::clone(&self.initialization),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientError {
    Transport(String),
    Protocol(String),
    Server { code: i64, message: String },
}

impl<T: JsonRpcTransport> AppServerClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_request_id: Arc::new(AtomicU64::new(1)),
            initialization: Arc::new(OnceLock::new()),
        }
    }

    pub fn initialize(
        &mut self,
        params: InitializeParams,
    ) -> Result<InitializeResult, ClientError> {
        let initialization: InitializeResult = self.call(ClientMethod::Initialize, params)?;
        self.initialization
            .set(initialization.clone())
            .map_err(|_| {
                ClientError::Protocol("App Server client is already initialized".into())
            })?;
        Ok(initialization)
    }

    /// Returns the immutable server snapshot captured by the successful initialize handshake.
    pub fn initialization(&self) -> Result<&InitializeResult, ClientError> {
        self.initialization.get().ok_or_else(|| {
            ClientError::Protocol(
                "App Server client has not completed the initialize handshake".into(),
            )
        })
    }

    pub fn set_env_cwd(&mut self, params: EnvCwdSetParams) -> Result<EnvCwdSetResult, ClientError> {
        self.call(ClientMethod::EnvCwdSet, params)
    }

    pub fn set_env_dirs(
        &mut self,
        params: EnvDirsSetParams,
    ) -> Result<EnvDirsSetResult, ClientError> {
        self.call(ClientMethod::EnvDirsSet, params)
    }

    pub fn list_session_dirs(
        &mut self,
        params: SessionDirListParams,
    ) -> Result<SessionDirListResult, ClientError> {
        self.call(ClientMethod::SessionDirList, params)
    }

    pub fn add_session_dir(
        &mut self,
        params: SessionDirAddParams,
    ) -> Result<SessionDirAddResult, ClientError> {
        self.call(ClientMethod::SessionDirAdd, params)
    }

    pub fn remove_session_dir(
        &mut self,
        params: SessionDirRemoveParams,
    ) -> Result<SessionDirMutationResult, ClientError> {
        self.call(ClientMethod::SessionDirRemove, params)
    }

    pub fn set_session_dir_permissions(
        &mut self,
        params: SessionDirPermissionsSetParams,
    ) -> Result<SessionDirMutationResult, ClientError> {
        self.call(ClientMethod::SessionDirPermissionsSet, params)
    }

    /// Lists enabled, resolved language servers without starting their processes.
    pub fn list_language_servers(
        &mut self,
        params: LanguageServersParams,
    ) -> Result<LanguageServersResult, ClientError> {
        self.call(ClientMethod::LanguageServers, params)
    }

    /// Synchronizes one authoritative editor snapshot with the App Server language runtime.
    pub fn synchronize_language_document(
        &mut self,
        params: LanguageSynchronizeParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::LanguageSynchronize, params)
    }

    /// Releases one document from the App Server language runtime.
    pub fn close_language_document(
        &mut self,
        params: LanguageCloseParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::LanguageClose, params)
    }

    /// Requests hover content for one exact synchronized document revision.
    pub fn language_hover(
        &mut self,
        params: LanguageHoverParams,
    ) -> Result<LanguageHoverResult, ClientError> {
        self.call(ClientMethod::LanguageHover, params)
    }

    /// Requests completion candidates for one exact synchronized document revision.
    pub fn language_completions(
        &mut self,
        params: LanguageCompletionsParams,
    ) -> Result<LanguageCompletionsResult, ClientError> {
        self.call(ClientMethod::LanguageCompletions, params)
    }

    /// Requests cross-file locations from the App Server language runtime.
    pub fn language_locations(
        &mut self,
        params: LanguageLocationsParams,
    ) -> Result<LanguageLocationsResult, ClientError> {
        self.call(ClientMethod::LanguageLocations, params)
    }

    pub fn read_directory(
        &mut self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResult, ClientError> {
        self.call(ClientMethod::FsReadDirectory, params)
    }

    pub fn get_file_metadata(
        &mut self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResult, ClientError> {
        self.call(ClientMethod::FsGetMetadata, params)
    }

    pub fn read_file(&mut self, params: FsReadFileParams) -> Result<FsReadFileResult, ClientError> {
        self.call(ClientMethod::FsReadFile, params)
    }

    pub fn read_binary_file(
        &mut self,
        params: FsReadBinaryFileParams,
    ) -> Result<FsReadBinaryFileResult, ClientError> {
        self.call(ClientMethod::FsReadBinaryFile, params)
    }

    pub fn write_file(
        &mut self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResult, ClientError> {
        self.call(ClientMethod::FsWriteFile, params)
    }

    /// Lists the trusted shell profiles exposed by this App Server connection.
    pub fn terminal_profile_list(&mut self) -> Result<TerminalProfileListResult, ClientError> {
        self.call(ClientMethod::TerminalProfileList, EmptyParams {})
    }

    /// Creates one App Server-owned interactive terminal at the current directory.
    pub fn terminal_create(
        &mut self,
        params: TerminalCreateParams,
    ) -> Result<TerminalCreateResult, ClientError> {
        self.call(ClientMethod::TerminalCreate, params)
    }

    /// Creates an interactive terminal at one session-authorized directory.
    pub fn terminal_create_in_session_directory(
        &mut self,
        params: TerminalCreateInSessionDirectoryParams,
    ) -> Result<TerminalCreateResult, ClientError> {
        self.call(ClientMethod::TerminalCreateInSessionDirectory, params)
    }

    /// Reattaches a reconnectable terminal and returns its rotated recovery lease.
    pub fn terminal_attach(
        &mut self,
        params: TerminalAttachParams,
    ) -> Result<TerminalAttachResult, ClientError> {
        self.call(ClientMethod::TerminalAttach, params)
    }

    /// Writes one bounded UTF-8 input batch to an App Server-owned terminal.
    pub fn terminal_write(&mut self, params: TerminalWriteParams) -> Result<(), ClientError> {
        self.call(ClientMethod::TerminalWrite, params)
    }

    /// Resizes an App Server-owned terminal.
    pub fn terminal_resize(&mut self, params: TerminalResizeParams) -> Result<(), ClientError> {
        self.call(ClientMethod::TerminalResize, params)
    }

    /// Reads terminal output after the caller's last observed output and command sequences.
    pub fn terminal_read(
        &mut self,
        params: TerminalReadParams,
    ) -> Result<TerminalReadResult, ClientError> {
        self.call(ClientMethod::TerminalRead, params)
    }

    /// Closes an App Server-owned terminal.
    pub fn terminal_close(&mut self, params: TerminalCloseParams) -> Result<(), ClientError> {
        self.call(ClientMethod::TerminalClose, params)
    }

    pub fn git_text_diff(&mut self) -> Result<GitTextDiffResult, ClientError> {
        self.call(ClientMethod::GitTextDiff, GitRepositoryParams::default())
    }

    pub fn configure_issues(
        &mut self,
        params: ash_app_server_protocol::protocol::issues::IssueConfigureParams,
    ) -> Result<ash_app_server_protocol::protocol::config::ConfigCommandResult, ClientError> {
        self.call(ClientMethod::IssueConfigure, params)
    }

    pub fn list_issues(
        &mut self,
        params: ash_app_server_protocol::protocol::issues::IssueListParams,
    ) -> Result<ash_app_server_protocol::protocol::issues::IssueListResult, ClientError> {
        self.call(ClientMethod::IssueList, params)
    }

    pub fn read_issue(
        &mut self,
        params: ash_app_server_protocol::protocol::issues::IssueReadParams,
    ) -> Result<ash_app_server_protocol::protocol::issues::IssueReadResult, ClientError> {
        self.call(ClientMethod::IssueRead, params)
    }

    pub fn git_status(&mut self) -> Result<GitStatusResult, ClientError> {
        self.call(ClientMethod::GitStatus, GitRepositoryParams::default())
    }

    pub fn git_repositories(&mut self) -> Result<GitRepositoriesResult, ClientError> {
        self.call(ClientMethod::GitRepositories, EmptyParams {})
    }

    pub fn compute_diff(
        &mut self,
        params: DiffComputeParams,
    ) -> Result<DiffComputeResult, ClientError> {
        self.call(ClientMethod::DiffCompute, params)
    }

    pub fn analyze_syntax(
        &mut self,
        params: SyntaxAnalyzeParams,
    ) -> Result<SyntaxAnalyzeResult, ClientError> {
        self.call(ClientMethod::SyntaxAnalyze, params)
    }

    pub fn open_syntax(&mut self, params: SyntaxOpenParams) -> Result<(), ClientError> {
        self.call(ClientMethod::SyntaxOpen, params)
    }

    pub fn update_syntax(&mut self, params: SyntaxUpdateParams) -> Result<(), ClientError> {
        self.call(ClientMethod::SyntaxUpdate, params)
    }

    pub fn close_syntax(&mut self, params: SyntaxCloseParams) -> Result<(), ClientError> {
        self.call(ClientMethod::SyntaxClose, params)
    }

    pub fn list_git_branches(&mut self) -> Result<GitBranchListResult, ClientError> {
        self.call(ClientMethod::GitBranchList, GitRepositoryParams::default())
    }

    pub fn switch_git_branch(
        &mut self,
        params: GitBranchSwitchParams,
    ) -> Result<GitOperationResult, ClientError> {
        self.call(ClientMethod::GitBranchSwitch, params)
    }

    pub fn create_git_branch(
        &mut self,
        params: GitBranchCreateParams,
    ) -> Result<GitBranchListResult, ClientError> {
        self.call(ClientMethod::GitBranchCreate, params)
    }

    pub fn create_git_worktree(
        &mut self,
        params: GitWorktreeCreateParams,
    ) -> Result<GitWorktreeCreateResult, ClientError> {
        self.call(ClientMethod::GitWorktreeCreate, params)
    }

    pub fn list_projects(&mut self) -> Result<ProjectListResult, ClientError> {
        self.call(ClientMethod::ProjectList, ProjectListParams::default())
    }

    pub fn read_dir_permissions(
        &mut self,
        params: DirPermissionsReadParams,
    ) -> Result<DirPermissionsReadResult, ClientError> {
        self.call(ClientMethod::DirPermissionsRead, params)
    }

    pub fn read_project(
        &mut self,
        params: ProjectReadParams,
    ) -> Result<ProjectReadResult, ClientError> {
        self.call(ClientMethod::ProjectRead, params)
    }

    pub fn create_project(
        &mut self,
        params: ProjectCreateParams,
    ) -> Result<ProjectMutationResult, ClientError> {
        self.call(ClientMethod::ProjectCreate, params)
    }

    pub fn add_project_root(
        &mut self,
        params: ProjectRootAddParams,
    ) -> Result<ProjectMutationResult, ClientError> {
        self.call(ClientMethod::ProjectRootAdd, params)
    }

    pub fn link_project_session(
        &mut self,
        params: ProjectSessionMutationParams,
    ) -> Result<ProjectMutationResult, ClientError> {
        self.call(ClientMethod::ProjectSessionLink, params)
    }

    pub fn stage_git_paths(
        &mut self,
        params: GitPathsParams,
    ) -> Result<GitOperationResult, ClientError> {
        self.call(ClientMethod::GitStage, params)
    }

    pub fn unstage_git_paths(
        &mut self,
        params: GitPathsParams,
    ) -> Result<GitOperationResult, ClientError> {
        self.call(ClientMethod::GitUnstage, params)
    }

    pub fn discard_git_paths(
        &mut self,
        params: GitPathsParams,
    ) -> Result<GitOperationResult, ClientError> {
        self.call(ClientMethod::GitDiscardWorktree, params)
    }

    pub fn commit_git(&mut self, params: GitCommitParams) -> Result<GitCommitResult, ClientError> {
        self.call(ClientMethod::GitCommit, params)
    }

    pub fn push_git(&mut self) -> Result<GitOperationResult, ClientError> {
        self.call(ClientMethod::GitPush, GitRepositoryParams::default())
    }

    pub fn list_turn_changes(
        &mut self,
        params: TurnChangesListParams,
    ) -> Result<TurnChangesListResult, ClientError> {
        self.call(ClientMethod::TurnChangesList, params)
    }

    pub fn read_turn_changes(
        &mut self,
        params: TurnChangesReadParams,
    ) -> Result<TurnChangesReadResult, ClientError> {
        self.call(ClientMethod::TurnChangesRead, params)
    }

    pub fn generate_turn_commit_message(
        &mut self,
        params: TurnChangesMutationParams,
    ) -> Result<TurnChangesMutationResult, ClientError> {
        self.call(ClientMethod::TurnChangesGenerateMessage, params)
    }

    pub fn commit_turn_changes(
        &mut self,
        params: TurnChangesCommitParams,
    ) -> Result<TurnChangesMutationResult, ClientError> {
        self.call(ClientMethod::TurnChangesCommit, params)
    }

    pub fn create_session(
        &mut self,
        params: SessionCreateParams,
    ) -> Result<SessionResult, ClientError> {
        self.call(ClientMethod::SessionCreate, params)
    }

    pub fn read_session(
        &mut self,
        params: SessionReadParams,
    ) -> Result<SessionResult, ClientError> {
        self.call(ClientMethod::SessionRead, params)
    }

    pub fn list_sessions(&mut self) -> Result<SessionListResult, ClientError> {
        self.call(ClientMethod::SessionList, EmptyParams {})
    }

    pub fn subscribe_session(
        &mut self,
        params: SessionSubscribeParams,
    ) -> Result<SessionSubscribeResult, ClientError> {
        self.call(ClientMethod::SessionSubscribe, params)
    }

    /// Sends the canonical typed mutation request scoped to one product Session.
    pub fn request_session(
        &mut self,
        params: SessionRequestParams,
    ) -> Result<SessionRequestResult, ClientError> {
        self.call(ClientMethod::SessionRequest, params)
    }

    pub fn unsubscribe_session(
        &mut self,
        params: SessionUnsubscribeParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::SessionUnsubscribe, params)
    }

    pub fn message_checkpoints(
        &mut self,
        params: ash_app_server_protocol::protocol::session::MessageCheckpointsParams,
    ) -> Result<ash_app_server_protocol::protocol::session::MessageCheckpointsResult, ClientError>
    {
        self.call(ClientMethod::MessageCheckpoints, params)
    }

    pub fn read_session_thread(
        &mut self,
        params: SessionThreadReadParams,
    ) -> Result<SessionThreadReadResult, ClientError> {
        self.call(ClientMethod::SessionThreadRead, params)
    }

    pub fn subscribe_session_thread(
        &mut self,
        params: SessionThreadSubscribeParams,
    ) -> Result<SessionThreadSubscribeResult, ClientError> {
        self.call(ClientMethod::SessionThreadSubscribe, params)
    }

    pub fn unsubscribe_session_thread(
        &mut self,
        params: SessionThreadUnsubscribeParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::SessionThreadUnsubscribe, params)
    }

    /// Reads redacted provider accounts without exposing credentials to the client.
    pub fn read_accounts(&mut self) -> Result<AccountReadResult, ClientError> {
        self.call(ClientMethod::AccountRead, EmptyParams {})
    }

    /// Reads current quota for the selected provider account.
    pub fn read_account_rate_limits(
        &mut self,
        params: AccountRateLimitsReadParams,
    ) -> Result<AccountRateLimitsReadResult, ClientError> {
        self.call(ClientMethod::AccountRateLimitsRead, params)
    }

    /// Starts the provider-owned interactive sign-in flow.
    pub fn start_account_login(
        &mut self,
        params: AccountLoginStartParams,
    ) -> Result<AccountLoginStartResult, ClientError> {
        self.call(ClientMethod::AccountLoginStart, params)
    }

    /// Cancels a pending sign-in by its backend-issued identity.
    pub fn cancel_account_login(
        &mut self,
        params: AccountLoginCancelParams,
    ) -> Result<AccountLoginCancelResult, ClientError> {
        self.call(ClientMethod::AccountLoginCancel, params)
    }

    /// Removes only the selected provider's credentials from the Ash profile.
    pub fn logout_account(
        &mut self,
        params: AccountLogoutParams,
    ) -> Result<AccountLogoutResult, ClientError> {
        self.call(ClientMethod::AccountLogout, params)
    }

    pub fn read_config(&mut self) -> Result<ConfigReadResult, ClientError> {
        self.call(ClientMethod::ConfigRead, EmptyParams {})
    }

    pub fn list_connectors(&mut self) -> Result<ConnectorListResult, ClientError> {
        self.call(ClientMethod::ConnectorList, EmptyParams {})
    }

    pub fn connect_connector_api_token(
        &mut self,
        params: ConnectorApiTokenConnectRequest,
    ) -> Result<ConnectorCommandResultDto, ClientError> {
        self.call_secret(ClientMethod::ConnectorApiTokenConnect, params)
    }

    pub fn start_connector_oauth(
        &mut self,
        params: ConnectorOAuthStartParams,
    ) -> Result<ConnectorOAuthStartResult, ClientError> {
        self.call(ClientMethod::ConnectorOAuthStart, params)
    }

    pub fn complete_connector_oauth(
        &mut self,
        params: ConnectorOAuthCompleteRequest,
    ) -> Result<ConnectorCommandResultDto, ClientError> {
        self.call_secret(ClientMethod::ConnectorOAuthComplete, params)
    }

    pub fn cancel_connector_oauth(
        &mut self,
        params: ConnectorOAuthCancelParams,
    ) -> Result<ConnectorCommandResultDto, ClientError> {
        self.call(ClientMethod::ConnectorOAuthCancel, params)
    }

    pub fn start_connector_device_oauth(
        &mut self,
        params: ConnectorDeviceOAuthStartParams,
    ) -> Result<ConnectorDeviceOAuthStartResult, ClientError> {
        self.call(ClientMethod::ConnectorDeviceOAuthStart, params)
    }

    pub fn poll_connector_device_oauth(
        &mut self,
        params: ConnectorDeviceOAuthPollParams,
    ) -> Result<ConnectorDeviceOAuthPollResult, ClientError> {
        self.call(ClientMethod::ConnectorDeviceOAuthPoll, params)
    }

    pub fn cancel_connector_device_oauth(
        &mut self,
        params: ConnectorOAuthCancelParams,
    ) -> Result<ConnectorCommandResultDto, ClientError> {
        self.call(ClientMethod::ConnectorDeviceOAuthCancel, params)
    }

    pub fn refresh_connector_oauth(
        &mut self,
        params: ConnectorOAuthRefreshParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::ConnectorOAuthRefresh, params)
    }

    pub fn revoke_connector_oauth(
        &mut self,
        params: ConnectorDisconnectParams,
    ) -> Result<ConnectorDisconnectResultDto, ClientError> {
        self.call(ClientMethod::ConnectorOAuthRevoke, params)
    }

    pub fn disconnect_connector(
        &mut self,
        params: ConnectorDisconnectParams,
    ) -> Result<ConnectorDisconnectResultDto, ClientError> {
        self.call(ClientMethod::ConnectorDisconnect, params)
    }

    pub fn retry_connector_credential_cleanup(
        &mut self,
        params: ConnectorCredentialCleanupParams,
    ) -> Result<ConnectorCredentialCleanupDto, ClientError> {
        self.call(ClientMethod::ConnectorCredentialCleanupRetry, params)
    }

    pub fn search_marketplace(
        &mut self,
        params: MarketplaceSearchParams,
    ) -> Result<MarketplaceSearchResult, ClientError> {
        self.call(ClientMethod::MarketplaceSearch, params)
    }

    pub fn get_marketplace_package(
        &mut self,
        params: MarketplaceGetParams,
    ) -> Result<MarketplacePackageDetailsDto, ClientError> {
        self.call(ClientMethod::MarketplaceGet, params)
    }

    pub fn download_marketplace_package(
        &mut self,
        params: MarketplaceDownloadParams,
    ) -> Result<MarketplaceArtifactHandleDto, ClientError> {
        self.call(ClientMethod::MarketplaceDownload, params)
    }

    pub fn install_marketplace_package(
        &mut self,
        params: MarketplaceInstallParams,
    ) -> Result<MarketplaceInstalledPackageDto, ClientError> {
        self.call(ClientMethod::MarketplaceInstall, params)
    }

    pub fn update_marketplace_package(
        &mut self,
        params: MarketplaceUpdateParams,
    ) -> Result<MarketplaceInstalledPackageDto, ClientError> {
        self.call(ClientMethod::MarketplaceUpdate, params)
    }

    pub fn uninstall_marketplace_package(
        &mut self,
        params: MarketplaceUninstallParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::MarketplaceUninstall, params)
    }

    pub fn list_installed_marketplace_packages(
        &mut self,
    ) -> Result<MarketplaceListInstalledResult, ClientError> {
        self.call(ClientMethod::MarketplaceListInstalled, EmptyParams {})
    }

    pub fn acquire_marketplace_capability(
        &mut self,
        params: MarketplaceAcquireCapabilityParams,
    ) -> Result<MarketplaceAcquiredCapabilityDto, ClientError> {
        self.call(ClientMethod::MarketplaceAcquireCapability, params)
    }

    pub fn release_marketplace_capability(
        &mut self,
        params: MarketplaceReleaseCapabilityParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::MarketplaceReleaseCapability, params)
    }

    pub fn open_marketplace_resource(
        &mut self,
        params: MarketplaceOpenResourceParams,
    ) -> Result<MarketplaceResourceContentDto, ClientError> {
        self.call(ClientMethod::MarketplaceOpenResource, params)
    }

    pub fn list_plugins(&mut self) -> Result<PluginListResult, ClientError> {
        self.call(ClientMethod::PluginList, EmptyParams {})
    }

    pub fn enable_plugin(
        &mut self,
        params: PluginPackageCommandParams,
    ) -> Result<PluginCommandResultDto, ClientError> {
        self.call(ClientMethod::PluginEnable, params)
    }

    pub fn disable_plugin(
        &mut self,
        params: PluginPackageCommandParams,
    ) -> Result<PluginCommandResultDto, ClientError> {
        self.call(ClientMethod::PluginDisable, params)
    }

    pub fn grant_plugin(
        &mut self,
        params: PluginPackageCommandParams,
    ) -> Result<PluginCommandResultDto, ClientError> {
        self.call(ClientMethod::PluginGrant, params)
    }

    pub fn revoke_plugin_grant(
        &mut self,
        params: PluginPackageCommandParams,
    ) -> Result<PluginCommandResultDto, ClientError> {
        self.call(ClientMethod::PluginRevokeGrant, params)
    }

    pub fn uninstall_plugin(
        &mut self,
        params: PluginPackageCommandParams,
    ) -> Result<PluginCommandResultDto, ClientError> {
        self.call(ClientMethod::PluginUninstall, params)
    }

    pub fn list_models(&mut self) -> Result<ModelListResult, ClientError> {
        self.call(ClientMethod::ModelList, EmptyParams {})
    }

    pub fn list_provider_models(
        &mut self,
        provider: String,
    ) -> Result<ash_app_server_protocol::protocol::provider::ProviderModelsListResult, ClientError>
    {
        self.call(
            ClientMethod::ProviderModelsList,
            ash_app_server_protocol::protocol::provider::ProviderModelsListParams { provider },
        )
    }

    pub fn list_providers(&mut self) -> Result<ProviderListResult, ClientError> {
        self.call(ClientMethod::ProviderList, EmptyParams {})
    }

    pub fn set_provider_api_key(
        &mut self,
        params: ProviderApiKeySetRequest,
    ) -> Result<ProviderApiKeySetResult, ClientError> {
        self.call_secret(ClientMethod::ProviderApiKeySet, params)
    }

    pub fn update_config(
        &mut self,
        params: ConfigUpdateParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::ConfigUpdate, params)
    }

    pub fn configure_language_server(
        &mut self,
        params: LanguageServerConfigureParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::LanguageServerConfigure, params)
    }

    pub fn remove_language_server_configuration(
        &mut self,
        params: LanguageServerRemoveParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::LanguageServerRemove, params)
    }

    pub fn configure_provider(
        &mut self,
        params: ProviderConfigureParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::ProviderConfigure, params)
    }

    /// Probes the current form without saving it. Secret serialization is outbound-only.
    pub fn probe_provider(
        &mut self,
        config: ash_app_server_protocol::protocol::config::ProviderConfigDto,
        api_key: Option<String>,
        model: Option<String>,
    ) -> Result<ash_app_server_protocol::protocol::provider::ProviderProbeResult, ClientError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Probe<'a> {
            config: ash_app_server_protocol::protocol::config::ProviderConfigDto,
            api_key: Option<&'a str>,
            model: Option<String>,
        }
        let key = api_key.map(zeroize::Zeroizing::new);
        self.call_secret(
            ClientMethod::ProviderProbe,
            Probe {
                config,
                api_key: key.as_ref().map(|key| key.as_str()),
                model,
            },
        )
    }

    pub fn remove_provider(
        &mut self,
        params: ProviderRemoveParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::ProviderRemove, params)
    }

    pub fn upsert_mcp_server(
        &mut self,
        params: McpServerUpsertParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::McpServerUpsert, params)
    }

    pub fn remove_mcp_server(
        &mut self,
        params: McpServerRemoveParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::McpServerRemove, params)
    }

    pub fn set_mcp_server_enablement(
        &mut self,
        params: McpServerSetEnablementParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::McpServerSetEnablement, params)
    }

    pub fn add_skill_source(
        &mut self,
        params: SkillSourceAddParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::SkillSourceAdd, params)
    }

    pub fn remove_skill_source(
        &mut self,
        params: SkillSourceRemoveParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::SkillSourceRemove, params)
    }

    pub fn set_skill_source_enablement(
        &mut self,
        params: SkillSourceSetEnablementParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::SkillSourceSetEnablement, params)
    }

    pub fn list_skills(&mut self, params: SkillListParams) -> Result<SkillListResult, ClientError> {
        self.call(ClientMethod::SkillList, params)
    }

    pub fn set_skill_enablement(
        &mut self,
        params: SkillSetEnablementParams,
    ) -> Result<ConfigCommandResult, ClientError> {
        self.call(ClientMethod::SkillSetEnablement, params)
    }

    pub fn open_skill_resource(
        &mut self,
        params: SkillResourceOpenParams,
    ) -> Result<SkillResourceOpenResult, ClientError> {
        self.call(ClientMethod::SkillResourceOpen, params)
    }

    pub fn compile_typst(
        &mut self,
        params: TypstCompileParams,
    ) -> Result<TypstCompileResult, ClientError> {
        self.call(ClientMethod::TypstCompile, params)
    }

    pub fn start_memory_diagnostics(
        &mut self,
        params: ash_memory_diagnostics::MemoryStart,
    ) -> Result<ash_memory_diagnostics::MemoryReport, ClientError> {
        self.call(ClientMethod::MemoryDiagnosticsStart, params)
    }

    pub fn read_memory_diagnostics(
        &mut self,
        params: ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams,
    ) -> Result<ash_memory_diagnostics::MemoryReport, ClientError> {
        self.call(ClientMethod::MemoryDiagnosticsRead, params)
    }

    pub fn stop_memory_diagnostics(
        &mut self,
        params: ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams,
    ) -> Result<ash_memory_diagnostics::MemoryReport, ClientError> {
        self.call(ClientMethod::MemoryDiagnosticsStop, params)
    }

    pub fn submit_memory_diagnostics(
        &mut self,
        params: ash_memory_diagnostics::MemoryEvidence,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::MemoryDiagnosticsSubmit, params)
    }

    pub fn export_memory_diagnostics(
        &mut self,
        params: ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams,
    ) -> Result<ResourceMetadataResult, ClientError> {
        self.call(ClientMethod::MemoryDiagnosticsExport, params)
    }

    pub fn export_memory_bytes(&mut self, session_id: String) -> Result<Vec<u8>, String> {
        use base64::Engine;
        let metadata = self
            .export_memory_diagnostics(
                ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams {
                    session_id,
                },
            )
            .map_err(|error| error.to_string())?;
        let result = (|| {
            let mut bytes = Vec::new();
            while bytes.len() < metadata.size {
                let chunk = self
                    .read_resource(ResourceReadParams {
                        resource_id: metadata.resource_id.clone(),
                        offset: bytes.len(),
                        max_bytes: 262144,
                    })
                    .map_err(|error| error.to_string())?;
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(chunk.data_base64)
                    .map_err(|error| error.to_string())?;
                if decoded.is_empty()
                    || decoded.len() != chunk.decoded_length
                    || bytes.len() + decoded.len() > metadata.size
                {
                    return Err("invalid diagnostic report chunk".into());
                }
                bytes.extend(decoded);
            }
            Ok(bytes)
        })();
        let released = self
            .release_resource(ResourceReleaseParams {
                resource_id: metadata.resource_id,
            })
            .map_err(|error| error.to_string());
        match (result, released) {
            (Ok(bytes), Ok(())) => Ok(bytes),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }

    pub fn resource_metadata(
        &mut self,
        params: ResourceMetadataParams,
    ) -> Result<ResourceMetadataResult, ClientError> {
        self.call(ClientMethod::ResourceMetadata, params)
    }

    pub fn read_resource(
        &mut self,
        params: ResourceReadParams,
    ) -> Result<ResourceReadResult, ClientError> {
        self.call(ClientMethod::ResourceRead, params)
    }

    pub fn release_resource(&mut self, params: ResourceReleaseParams) -> Result<(), ClientError> {
        self.call(ClientMethod::ResourceRelease, params)
    }

    pub fn start_attachment_upload(
        &mut self,
        params: AttachmentUploadStartParams,
    ) -> Result<AttachmentUploadStartResult, ClientError> {
        self.call(ClientMethod::AttachmentUploadStart, params)
    }

    pub fn write_attachment_upload(
        &mut self,
        params: AttachmentUploadWriteParams,
    ) -> Result<AttachmentUploadWriteResult, ClientError> {
        self.call(ClientMethod::AttachmentUploadWrite, params)
    }

    pub fn finish_attachment_upload(
        &mut self,
        params: AttachmentUploadFinishParams,
    ) -> Result<AttachmentMaterializeResult, ClientError> {
        self.call(ClientMethod::AttachmentUploadFinish, params)
    }

    pub fn cancel_attachment_upload(
        &mut self,
        params: AttachmentUploadCancelParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::AttachmentUploadCancel, params)
    }

    pub fn import_remote_attachment(
        &mut self,
        params: AttachmentImportRemoteParams,
    ) -> Result<AttachmentMaterializeResult, ClientError> {
        self.call(ClientMethod::AttachmentImportRemote, params)
    }

    pub fn start_content_search(
        &mut self,
        params: ContentSearchStartParams,
    ) -> Result<ContentSearchStartResult, ClientError> {
        self.call(ClientMethod::ContentSearchStart, params)
    }

    pub fn read_content_search(
        &mut self,
        params: ContentSearchReadParams,
    ) -> Result<ContentSearchReadResult, ClientError> {
        self.call(ClientMethod::ContentSearchRead, params)
    }

    pub fn cancel_content_search(
        &mut self,
        params: ContentSearchCancelParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::ContentSearchCancel, params)
    }

    pub fn drain_notifications(&mut self) -> Result<Vec<ServerNotification>, ClientError> {
        self.transport
            .drain_notifications()?
            .into_iter()
            .map(|raw| notification::decode(&raw))
            .collect()
    }

    pub fn into_transport(self) -> T {
        self.transport
    }

    fn call<P: serde::Serialize, R: for<'a> serde::Deserialize<'a>>(
        &mut self,
        method: ClientMethod,
        params: P,
    ) -> Result<R, ClientError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let params = serde_json::to_value(params)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        let request = JsonRpcRequest::new(
            JsonRpcId::Number(request_id),
            method.as_str().into(),
            params,
        );
        let encoded_request = serde_json::to_string(&request)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        let raw_response = self.transport.round_trip(&encoded_request)?;
        let response: JsonRpcResponse<Value, Value> = serde_json::from_str(&raw_response)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        let response_id = match &response {
            JsonRpcResponse::Success(response) => &response.id,
            JsonRpcResponse::Failure(response) => &response.id,
        };
        if response_id != &JsonRpcId::Number(request_id) {
            return Err(ClientError::Protocol(
                "response id did not match request".into(),
            ));
        }
        match response {
            JsonRpcResponse::Success(response) => serde_json::from_value(response.result)
                .map_err(|error| ClientError::Protocol(error.to_string())),
            JsonRpcResponse::Failure(response) => Err(ClientError::Server {
                code: response
                    .error
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(-32000),
                message: response
                    .error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .into(),
            }),
        }
    }

    fn call_secret<P: Serialize, R: for<'a> serde::Deserialize<'a>>(
        &mut self,
        method: ClientMethod,
        params: P,
    ) -> Result<R, ClientError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request = JsonRpcRequest::new(
            JsonRpcId::Number(request_id),
            method.as_str().into(),
            params,
        );
        let mut encoded_request = Zeroizing::new(
            serde_json::to_string(&request)
                .map_err(|error| ClientError::Protocol(error.to_string()))?,
        );
        let raw_response = self.transport.round_trip(encoded_request.as_str())?;
        encoded_request.zeroize();
        decode_call_response(request_id, &raw_response)
    }
}

fn decode_call_response<R: for<'a> serde::Deserialize<'a>>(
    request_id: u64,
    raw_response: &str,
) -> Result<R, ClientError> {
    let response: JsonRpcResponse<Value, Value> = serde_json::from_str(raw_response)
        .map_err(|error| ClientError::Protocol(error.to_string()))?;
    let response_id = match &response {
        JsonRpcResponse::Success(response) => &response.id,
        JsonRpcResponse::Failure(response) => &response.id,
    };
    if response_id != &JsonRpcId::Number(request_id) {
        return Err(ClientError::Protocol(
            "response id did not match request".into(),
        ));
    }
    match response {
        JsonRpcResponse::Success(response) => serde_json::from_value(response.result)
            .map_err(|error| ClientError::Protocol(error.to_string())),
        JsonRpcResponse::Failure(response) => Err(ClientError::Server {
            code: response
                .error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(-32000),
            message: response
                .error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_owned(),
        }),
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(message) => write!(formatter, "transport error: {message}"),
            Self::Protocol(message) => write!(formatter, "protocol error: {message}"),
            Self::Server { code, message } => {
                write!(formatter, "server error {code}: {message}")
            }
        }
    }
}

impl std::error::Error for ClientError {}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
