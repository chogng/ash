#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountCreditBalanceDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginCancelResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginCancelStatusDto;
use crate::protocol::account::AccountLoginCompleted;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginCompletionStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginFailureDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginMethodDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLoginStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLogoutParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLogoutResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountLogoutStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountRateLimitDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountRateLimitWindowDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountRateLimitsReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountRateLimitsReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountStatusDto;
use crate::protocol::account::AccountUpdated;
#[cfg(any(test, feature = "export"))]
use crate::protocol::account::AccountXaiUsageDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::agent::AgentReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::agent::AgentReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::agent::AgentThread;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentImportRemoteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentMaterializeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentUploadCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentUploadFinishParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentUploadStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentUploadStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentUploadWriteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::attachments::AttachmentUploadWriteResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationDeleteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationRunParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationRunsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationRunsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationStopParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::automation::AutomationWriteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserBinaryPayload;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserCloseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserCreateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserCreateResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserElementTargetDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserObserveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserObserveResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserPerformActionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserPerformParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserPerformResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::browser::BrowserTextInputTargetDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallControlParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallDeployment;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallEndParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallInvitation;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallInviteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallMemberParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallResourceParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallRoleParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallScreenFrame;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallScreenFrames;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallScreenSource;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallScreenSources;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::CallStartParams;
use crate::protocol::call::CallStatus;
#[cfg(any(test, feature = "export"))]
use crate::protocol::call::ScreenTarget;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebaseAuthorizeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebaseDestinationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebaseGrantDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebasePreviewParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebasePreviewResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebaseSelectionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebaseStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CloudCodebaseStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseChunkSpanDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseDeploymentModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseRetrievalDegradationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseRetrievalHitDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseRetrievalParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseRetrievalResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseSearchHitDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseSearchParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseSearchResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase::CodebaseStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::CodebaseSymbolsSearchHitDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::CodebaseSymbolsSearchParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::CodebaseSymbolsSearchResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::CodebaseSymbolsStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::CodebaseSymbolsStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::DocumentOverlayCloseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::DocumentOverlayStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::DocumentOverlaySynchronizeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::codebase_symbols::SymbolKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationOpenParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationOpenResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationPresence;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationPresenceParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationPresenceReadParams;
use crate::protocol::collaboration::DocumentCollaborationPresenceSnapshot;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationSnapshot;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationSubmitParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::collaboration::DocumentCollaborationSubmitResult;
use crate::protocol::collaboration::DocumentCollaborationUpdate;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::AgentInteractionCapability;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::BrowserCapability;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ClientCapabilities;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ClientInfo;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::CommandId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::DirPermissionsHostCapability;
use crate::protocol::common::EmptyParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ItemId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::RequestId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::SchemaHash;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ServerInfo;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::SessionId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::StreamInstanceId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ThreadId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ToolCallId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::ToolName;
#[cfg(any(test, feature = "export"))]
use crate::protocol::common::TurnId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ApprovalReviewModelSelectionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CodebaseAutomaticContextDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CodebaseConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CodebaseConfigureParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CodebaseModelsDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CommitMessageAuthorizeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CommitMessageRevokeParams;
use crate::protocol::config::ConfigChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ConfigCommandDispositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ConfigCommandResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ConfigReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ConfigUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CustomProviderConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::CustomProviderProtocolDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyActionKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyEffectDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyHostMatcherDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyRuleDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyRuleRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyRuleUpsertParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyScopeMatcherDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicySelectorDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ExecPolicyTokenDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::FrontendConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::GitAutoFetchModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::GitConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::GrepBackendDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookActionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookEnablementDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookEventDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookMatcherDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookSetEnablementParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::HookUpsertParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::LanguageServerConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::LanguageServerConfigureParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::LanguageServerModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::LanguageServerRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpCredentialBindingDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpServerConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpServerEnablementDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpServerRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpServerSetEnablementParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpServerUpsertParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::McpTransportDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ModelContextConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ModelRefDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::PluginRequestDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::PluginRequestEnablementDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::PluginRequestRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::PluginRequestSetEnablementParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::PluginRequestUpsertParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ProviderConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ProviderConfigureParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ProviderRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::SkillSourceAddParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::SkillSourceConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::SkillSourceEnablementDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::SkillSourceRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::SkillSourceSetEnablementParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::TimeContextConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ToolSearchConfigDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ToolSearchConfigureParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ToolSearchEmbeddingStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::config::ToolSearchModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorAccountDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorApiTokenConnectParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorAvailableActionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorCommandDispositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorCommandResultDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorConnectionStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorCredentialCleanupDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorCredentialCleanupParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDeviceOAuthPollParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDeviceOAuthPollResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDeviceOAuthStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDeviceOAuthStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDisconnectParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDisconnectResultDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorOAuthCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorOAuthCompleteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorOAuthMethodDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorOAuthRefreshParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorOAuthStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorOAuthStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::connectors::ConnectorSecretDto;
use crate::protocol::connectors::ConnectorsChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterCloseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterMessageDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterSendParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::debug::DebugAdapterStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diagnostics::FeedbackPrepareParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diagnostics::FeedbackUploadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diff::DiffComputeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diff::DiffComputeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diff::DiffComputeRowDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diff::DiffHunkDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diff::DiffRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::diff::DiffRowKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::document::TypstCompileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::document::TypstCompileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::document::TypstDiagnosticDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::document::TypstDiagnosticSeverityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::document::TypstSourceRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirContributionsDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirGrantDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirPermissionsEntryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirPermissionsForgetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirPermissionsListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirPermissionsReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirPermissionsReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::DirPermissionsSetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::EnvCwdSetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::EnvCwdSetResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::EnvDirDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::EnvDirSetEntry;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::EnvDirsSetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::EnvDirsSetResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::PermissionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirAddParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirAddResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirMutationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirMutationResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirPermissionsSetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::environment::SessionDirSelector;
#[cfg(any(test, feature = "export"))]
use crate::protocol::error::AppServerError;
#[cfg(any(test, feature = "export"))]
use crate::protocol::error::AppServerErrorData;
#[cfg(any(test, feature = "export"))]
use crate::protocol::error::AppServerErrorName;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostCancellationReasonDto;
use crate::protocol::extension_host::ExtensionHostChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostExtensionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostFailureCodeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostFailureDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeCancelDispositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeCancelResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostInvokeStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostLanguageProviderOperationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostLifecycleDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostOutputChannelKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostOutputEventDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostOutputOperationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostOutputSeverityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostReconcileModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostReconcileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostRegistrationDescriptorDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostRegistrationKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_host::ExtensionHostSnapshotDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_items::ExtensionItemsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extension_items::ExtensionItemsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionCatalogReloadDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionDiagnosticCodeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionDiagnosticDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionResourceOpenParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionResourceOpenResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::extensions::ExtensionSourceKindDto;
use crate::protocol::fs::FsChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsCreateFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsDeleteMode;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsDeleteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsExistingTargetBehavior;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsFileType;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsGetMetadataParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsGetMetadataResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsMissingTargetBehavior;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadBinaryFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadBinaryFileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadDirectoryEntry;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadDirectoryParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadDirectoryResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsReadFileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsRenameParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsWriteFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::fs::FsWriteFileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitBranchDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitBranchListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitBranchSwitchParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitChangeFileComparisonDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitChangeFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitChangeFileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitChangeStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitChangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitChangesParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitChangesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitFileContentDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitFileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitCommitSummaryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitDiffStatisticsDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitFetchModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitFetchParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitGraphParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitGraphResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitHeadDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitHistoryResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitOperationResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitPathsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitReferenceDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitReferenceKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRemoteDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRemoteProviderDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRepositoriesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRepositoryChangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRepositoryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRepositoryIdentityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitRepositoryParams;
use crate::protocol::git::GitStatusChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitSubmoduleStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitTextDiffDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitTextDiffResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::git::GitUpstreamDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::goal::ThreadGoalClearParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::goal::ThreadGoalClearResponse;
use crate::protocol::goal::ThreadGoalClearedNotification;
#[cfg(any(test, feature = "export"))]
use crate::protocol::goal::ThreadGoalGetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::goal::ThreadGoalGetResponse;
#[cfg(any(test, feature = "export"))]
use crate::protocol::goal::ThreadGoalSetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::goal::ThreadGoalSetResponse;
use crate::protocol::goal::ThreadGoalUpdatedNotification;
#[cfg(any(test, feature = "export"))]
use crate::protocol::initialize::CapabilityContract;
#[cfg(any(test, feature = "export"))]
use crate::protocol::initialize::InitializeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::initialize::InitializeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::initialize::ProtocolVersion;
#[cfg(any(test, feature = "export"))]
use crate::protocol::initialize::ServerCapabilities;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionDiagnosticDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportItem;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportPreviewParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportPreviewResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportSource;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionImportStatus;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionLoadDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::instructions::InstructionScopeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::issues::IssueConfigureParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::issues::IssueListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::issues::IssueListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::issues::IssueReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::issues::IssueReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCancelResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCancelStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCloseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCodeActionDiagnosticDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCodeActionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCodeActionsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCodeActionsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCodeLensDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCodeLensesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageColorDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageColorPresentationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageColorPresentationsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageColorPresentationsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCommandDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionDetailsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionInsertTextFormatDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionItemDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionItemKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionTriggerKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageCompletionsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDiagnosticReportKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDiagnosticSeverityDto;
use crate::protocol::language::LanguageDiagnosticsNotification;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectoryDiagnosticSnapshotDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectoryDiagnosticsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectoryDiagnosticsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectoryEditDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectoryEditEntryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectorySymbolDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectorySymbolsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDirectorySymbolsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentColorDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentColorsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentDiagnosticsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentDiagnosticsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentFeaturesParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentFormattingParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentLinkDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentLinksResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentSymbolDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageDocumentSymbolsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageExecuteCommandParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageFoldingRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageFoldingRangeKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageFoldingRangesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageFormattingOptionsDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageFormattingResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHierarchyEntryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHierarchyItemDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHierarchyKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHierarchyParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHierarchyResultDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHoverParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageHoverResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageInlayHintDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageInlayHintKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageInlayHintsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageInlayHintsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageLinkedEditingRangesParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageLinkedEditingRangesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageLocationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageLocationKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageLocationsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageLocationsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageOperationParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageParameterInformationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguagePositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguagePrepareRenameParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguagePrepareRenameResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageRangeFormattingParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageRenameParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageRenamePreparationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageResolveCodeActionParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageResolveCodeLensParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageResolveCompletionParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageResolveDocumentLinkParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSemanticTokenDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSemanticTokensParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSemanticTokensResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageServerDescriptorDto;
use crate::protocol::language::LanguageServerMessageNotification;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageServerMessageSeverityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageServerMessageSourceDto;
use crate::protocol::language::LanguageServerProgressNotification;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageServerStateDto;
use crate::protocol::language::LanguageServerStateNotification;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageServersParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageServersResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSignatureHelpParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSignatureHelpResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSignatureHelpTriggerKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSignatureInformationDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageSynchronizeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageTextDocumentEditDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::language::LanguageTextEditDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceAcquireCapabilityParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceAcquiredCapabilityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceArtifactHandleDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceAvailableCapabilityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceCapabilityDescriptorDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceCapabilityKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceCapabilityLeaseDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceCapabilityRefDto;
use crate::protocol::marketplace::MarketplaceChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceConnectorActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceDownloadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceExecutableActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceExecutableRuntimeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceGetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceInstallParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceInstallationStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceInstalledPackageDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceLanguageActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceListInstalledResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceLocalizationActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceMcpActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceMcpTransportDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceOpenResourceParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplacePackageDetailsDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplacePackageRefDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplacePackageSourceDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplacePackageSummaryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceReleaseCapabilityParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceResourceContentDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceResourceRefDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceSearchParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceSearchResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceSkillActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceThemeActivationSpecDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceUninstallModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceUninstallParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceUpstreamReferenceDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::marketplace::MarketplaceUpstreamRegistryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpOAuthCompleteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpOAuthMutationParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpOAuthMutationResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpOAuthStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpOAuthStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpSecretDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpServerRuntimeIntentDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpServerRuntimeIntentParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpServerRuntimeIntentResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpServerRuntimeStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpServerStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::mcp::McpServerStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryAddParams;
use crate::protocol::memory::MemoryChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryCitationReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryDeleteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryPolicyReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryPolicyUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryScopeDescriptor;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryScopesParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryScopesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemorySearchParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory::MemoryUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::model::ModelCatalogEntry;
#[cfg(any(test, feature = "export"))]
use crate::protocol::model::ModelListResult;
use crate::protocol::notification::ThreadTranscriptUpdateEnvelope;
use crate::protocol::notification::ThreadUpdateEnvelope;
#[cfg(any(test, feature = "export"))]
use crate::protocol::plugins::PluginCommandDispositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::plugins::PluginCommandResultDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::plugins::PluginListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::plugins::PluginPackageCommandParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::plugins::PluginPackageDto;
use crate::protocol::plugins::PluginsChanged;
use crate::protocol::projects::ProjectChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectCommandDispositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectCreateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectDetailsUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectLifecycleParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectMutationResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectRootAddParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectRootDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectRootRemoveParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectRootUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectSessionMutationParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectStatusDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::projects::ProjectSummaryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderApiKeyDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderApiKeyPolicyDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderApiKeySetParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderApiKeySetResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderCatalogEntryDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderModelsListFailureCodeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderModelsListFailureDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderModelsListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderModelsListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderProbeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::provider::ProviderProbeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::queue::QueueCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::queue::QueueEditAction;
#[cfg(any(test, feature = "export"))]
use crate::protocol::queue::QueueEditParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::queue::QueueEnqueueParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::queue::QueueListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::queue::QueueListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::resources::ResourceMetadataParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::resources::ResourceMetadataResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::resources::ResourceReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::resources::ResourceReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::resources::ResourceReleaseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchCancelParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchCaseSensitivity;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchFreshness;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchMatch;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchMatchRange;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchPatternKind;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchStartParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::ContentSearchStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::GrepIndexDisableAndDeleteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::GrepIndexDisableAndDeleteResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::GrepIndexStatusResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::search::LocalIndexClearOutcomeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::AdvisorConfigureResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::MessageCheckpointsParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::MessageCheckpointsResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionCatalogReadResult;
use crate::protocol::session::SessionChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionCreateParams;
use crate::protocol::session::SessionDeleted;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionRequest;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionRequestParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionRequestResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionRewriteResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionSubscribeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionSubscribeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadProjection;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadSubscribeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadSubscribeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionThreadUnsubscribeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::SessionUnsubscribeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::ThreadHistoryBoundary;
#[cfg(any(test, feature = "export"))]
use crate::protocol::session::ThreadSnapshotHistory;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillCatalogReloadDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillCompatibilityDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillDiagnosticCodeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillDiagnosticDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillEnablementDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillResourceKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillResourceOpenParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillResourceOpenResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillSetEnablementParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::skills::SkillSourceKindDto;
use crate::protocol::skills::SkillsChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::slash_commands::SlashCommandArgumentModeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::slash_commands::SlashCommandDefinition;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxAnalyzeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxAnalyzeResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxCloseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxDiagnosticDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxDiagnosticKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxEditDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxFoldingRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxLanguageDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxOpenParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxPositionDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxSelectionRangeDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxSelectionRangesParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxSelectionRangesResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxSymbolDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxSymbolKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxTokenDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxTokenKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::syntax::SyntaxUpdateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalAttachParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalAttachResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalCloseParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalCommandStatus;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalCommandStatusEvent;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalCreateInSessionDirectoryParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalCreateParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalCreateResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalLifecycle;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalOutputChunk;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalProfile;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalProfileListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalProfileSelection;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalReconnectLease;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalResizeParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::terminal::TerminalWriteParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::transcript::ThreadTranscriptChange;
#[cfg(any(test, feature = "export"))]
use crate::protocol::transcript::ThreadTranscriptEntry;
#[cfg(any(test, feature = "export"))]
use crate::protocol::transcript::ThreadTranscriptSnapshot;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn::InputItem;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn::TurnInteractionResolveResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn::TurnInterruptResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn::TurnStartResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn::TurnSteerResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::ChangeSetId;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::ThreadDirBinding;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::ThreadWorktreeRepositoryBindingDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeCaptureStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeCommitStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeFileDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeFileKindDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeFileStatisticsDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeMessageStateDto;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeSetSummary;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangeTerminalStateDto;
use crate::protocol::turn_changes::TurnChangesChanged;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesCommitParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesDiscardThreadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesListParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesListResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesMutationParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesMutationResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesReadFileParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesReadFileResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesReadParams;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesReadResult;
#[cfg(any(test, feature = "export"))]
use crate::protocol::turn_changes::TurnChangesUpdateDraftParams;
#[cfg(any(test, feature = "export"))]
use analytics::UsageEvent;
#[cfg(any(test, feature = "export"))]
use analytics::UsageSnapshot;
#[cfg(any(test, feature = "export"))]
use ash_environment::EnvId;
#[cfg(any(test, feature = "export"))]
use ash_file_access::DirId;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryEvidence;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryFinding;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryMetric;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryMetricKind;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryObservation;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryOrigin;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryPhase;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryProduct;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryReport;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryRole;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemorySample;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryStart;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryStatus;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryTargetReport;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryTrend;
#[cfg(any(test, feature = "export"))]
use ash_memory_diagnostics::MemoryUnavailable;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ActionApprovalCapability;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ActionApprovalCapabilityKind;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ActionApprovalDecision;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ActionApprovalRequest;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ActionApprovalResponse;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AdvisorConfig;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AdvisorSelection;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentCapabilityScope;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentContextContent;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentContextMode;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentContextSeed;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentContextSource;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentDefinitionSelectionReason;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentInteractionKind;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentJoin;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentJoinId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentJoinPolicy;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentJoinStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentMaterializedContext;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentMessage;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentMessageContent;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentMessageId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentMessageProvenance;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentRequest;
use ash_protocol::AgentRequestEnvelope;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentResponse;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentRoleSnapshot;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentRoleSource;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentTreeExecutionStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentTreeNodeProjection;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentTreeProjection;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AgentTreeWaitingReason;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ApprovalMode;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AttachmentRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AudioAttachmentRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AudioMediaType;
#[cfg(any(test, feature = "export"))]
use ash_protocol::Automation;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AutomationDefinition;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AutomationRun;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AutomationRunStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AutomationSchedule;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AutomationSession;
#[cfg(any(test, feature = "export"))]
use ash_protocol::AutomationStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::CapabilitySupport;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContentDigest;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContentPart;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContextCheckpoint;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContextCheckpointId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContextCheckpointVerification;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContextSeedDigest;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContextSourceDigest;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ContextSourceRange;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegatedPolicyCeiling;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegatedTask;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegationArtifactRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegationId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegationResult;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegationResultDigest;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DelegationResultStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DynamicToolCall;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DynamicToolOutput;
#[cfg(any(test, feature = "export"))]
use ash_protocol::DynamicToolResponse;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ForkedAgentContext;
#[cfg(any(test, feature = "export"))]
use ash_protocol::FrozenAgentDefinitionRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::FrozenSkillActivation;
#[cfg(any(test, feature = "export"))]
use ash_protocol::HistoryPrefixRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ImageAttachmentRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ImageDetail;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ImageMediaType;
#[cfg(any(test, feature = "export"))]
use ash_protocol::InteractionCancelReason;
#[cfg(any(test, feature = "export"))]
use ash_protocol::InteractionDeadline;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ItemDelta;
#[cfg(any(test, feature = "export"))]
use ash_protocol::MessageBoundary;
#[cfg(any(test, feature = "export"))]
use ash_protocol::MessageCheckpoint;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelAccess;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelBillingEvidence;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelBillingRecord;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelBillingScope;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelCapabilities;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelContextUsage;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelContextUsageSource;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelCostLineItem;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelInputEstimate;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelInvocationId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelInvocationOutcome;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelInvocationRecord;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelMoneyAmount;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelOutputTransport;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelReferenceCostReason;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelReferenceCostRecord;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelReferenceCostSummary;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelUsage;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelUsageSummary;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ModelUsageTotal;
#[cfg(any(test, feature = "export"))]
use ash_protocol::PendingInteraction;
#[cfg(any(test, feature = "export"))]
use ash_protocol::Personality;
#[cfg(any(test, feature = "export"))]
use ash_protocol::PlanStep;
#[cfg(any(test, feature = "export"))]
use ash_protocol::PlanStepStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::PlanUpdate;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ProcessExecutionOutput;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ProcessExitStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ProjectId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::RatedModelCost;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ReasoningEffort;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ReasoningState;
#[cfg(any(test, feature = "export"))]
use ash_protocol::RepositoryCheckpoint;
#[cfg(any(test, feature = "export"))]
use ash_protocol::RequestUserInput;
#[cfg(any(test, feature = "export"))]
use ash_protocol::RequestUserInputResponse;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ReviewTarget;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SandboxDenialOutput;
#[cfg(any(test, feature = "export"))]
use ash_protocol::Session;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SessionManagerActivity;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SessionManagerInfo;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SessionManagerStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SessionStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SessionThread;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SkillActivationReason;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SkillId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SkillName;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SkillRef;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SkillSourceId;
#[cfg(any(test, feature = "export"))]
use ash_protocol::SkillVersionSelector;
#[cfg(any(test, feature = "export"))]
use ash_protocol::StableTurnError;
#[cfg(any(test, feature = "export"))]
use ash_protocol::StableTurnErrorCode;
#[cfg(any(test, feature = "export"))]
use ash_protocol::StreamCursor;
#[cfg(any(test, feature = "export"))]
use ash_protocol::Thread;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadArchiveReason;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadEvent;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadGoal;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadGoalStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadItem;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadOrigin;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadSequenceRange;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ThreadUpdate;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TimeContext;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TimeContextMode;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TimeZoneOrigin;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolCallBinding;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolCallCaller;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolExecutionAuthority;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolMode;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolOutputStream;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolProfileSnapshot;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolReplaySafety;
#[cfg(any(test, feature = "export"))]
use ash_protocol::ToolSourceProvenance;
#[cfg(any(test, feature = "export"))]
use ash_protocol::Turn;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TurnExecutionBinding;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TurnInstructions;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TurnInteraction;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TurnKind;
#[cfg(any(test, feature = "export"))]
use ash_protocol::TurnStatus;
#[cfg(any(test, feature = "export"))]
use ash_protocol::UnixMillis;
#[cfg(any(test, feature = "export"))]
use ash_protocol::UserInput;
#[cfg(any(test, feature = "export"))]
use ash_protocol::UserInputAnswer;
#[cfg(any(test, feature = "export"))]
use ash_protocol::UserInputOption;
#[cfg(any(test, feature = "export"))]
use ash_protocol::UserInputQuestion;
#[cfg(any(test, feature = "export"))]
use ash_protocol::WorkspaceCheckpoint;
#[cfg(any(test, feature = "export"))]
use build_info::BuildInfo;
#[cfg(any(test, feature = "export"))]
use call::CallConnection;
#[cfg(any(test, feature = "export"))]
use call::CallControl;
#[cfg(any(test, feature = "export"))]
use call::CallMember;
#[cfg(any(test, feature = "export"))]
use call::CallParticipant;
#[cfg(any(test, feature = "export"))]
use call::CallRole;
#[cfg(any(test, feature = "export"))]
use call::CallSnapshot;
#[cfg(any(test, feature = "export"))]
use call::MediaState;
#[cfg(any(test, feature = "export"))]
use diagnostics::Activity;
#[cfg(any(test, feature = "export"))]
use diagnostics::ActivitySummary;
#[cfg(any(test, feature = "export"))]
use diagnostics::DiagnosticSnapshot;
#[cfg(any(test, feature = "export"))]
use diagnostics::Observation;
#[cfg(any(test, feature = "export"))]
use diagnostics::Outcome;
#[cfg(any(test, feature = "export"))]
use extension_items::ExtensionItem;
#[cfg(any(test, feature = "export"))]
use extension_items::ExtensionItemContent;
#[cfg(any(test, feature = "export"))]
use extension_items::ExtensionItemStatus;
#[cfg(any(test, feature = "export"))]
use extension_items::SearchSource;
#[cfg(any(test, feature = "export"))]
use features::Feature;
#[cfg(any(test, feature = "export"))]
use features::FeatureSource;
#[cfg(any(test, feature = "export"))]
use features::FeatureStage;
#[cfg(any(test, feature = "export"))]
use features::FeatureState;
#[cfg(any(test, feature = "export"))]
use feedback::PreparedFeedback;
#[cfg(any(test, feature = "export"))]
use queue::QueueInput;
#[cfg(any(test, feature = "export"))]
use queue::QueueMove;
#[cfg(any(test, feature = "export"))]
use queue::QueueStatus;
#[cfg(any(test, feature = "export"))]
use queue::QueuedMessage;
#[cfg(any(test, feature = "export"))]
use response_debug_context::AuthHeader;
#[cfg(any(test, feature = "export"))]
use response_debug_context::AuthRecovery;
#[cfg(any(test, feature = "export"))]
use response_debug_context::DiagnosticOutcome;
#[cfg(any(test, feature = "export"))]
use response_debug_context::RequestAttempt;
#[cfg(any(test, feature = "export"))]
use response_debug_context::RequestOutcome;
#[cfg(any(test, feature = "export"))]
use response_debug_context::ResponseDebugContext;
#[cfg(any(test, feature = "export"))]
use response_debug_context::ResponseDiagnostic;
#[cfg(any(test, feature = "export"))]
use response_debug_context::ResponseOperation;
#[cfg(any(test, feature = "export"))]
use schemars::JsonSchema;
#[cfg(any(test, feature = "export"))]
use ts_rs::Config;
#[cfg(any(test, feature = "export"))]
use ts_rs::TS;

/// Selects whether equal scheduling keys exclude or share execution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SerializationAccess {
    /// Runs alone for its scheduling key.
    Exclusive,
    /// May run with adjacent readers for its scheduling key.
    SharedRead,
}

/// Runtime serialization scope resolved from one typed client-method definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientRequestSerializationScope {
    /// Coordinates App Server-wide state.
    Global { access: SerializationAccess },
    /// Coordinates one durable Session aggregate across connections.
    Session {
        session_id: String,
        access: SerializationAccess,
    },
    /// Coordinates one resource namespace owned by the accepting connection.
    ConnectionResource {
        namespace: &'static str,
        resource_id: String,
        access: SerializationAccess,
    },
}

/// Static serialization declaration stored beside a client method's protocol types.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SerializationScopeDefinition {
    None,
    GlobalExclusive,
    GlobalSharedRead,
    SessionExclusive,
    SessionSharedRead,
    ResourceExclusive(&'static str),
    ConnectionExclusive(&'static str),
}

/// Declares whether a request carries a stable identity for domain cancellation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancellationDefinition {
    None,
    OperationId(&'static str),
}

#[derive(Clone, Copy)]
pub struct ClientMethodDefinition {
    pub kind: ClientMethod,
    pub method: &'static str,
    pub serialization: SerializationScopeDefinition,
    pub cancellation: CancellationDefinition,
    #[cfg(any(test, feature = "export"))]
    params_type: fn(&Config) -> String,
    #[cfg(any(test, feature = "export"))]
    result_type: fn(&Config) -> String,
}

impl ClientMethodDefinition {
    #[cfg(any(test, feature = "export"))]
    pub fn params_type(&self) -> String {
        (self.params_type)(&Config::default())
    }

    #[cfg(any(test, feature = "export"))]
    pub fn result_type(&self) -> String {
        (self.result_type)(&Config::default())
    }

    /// Resolves the client-generated operation identity declared by this method.
    pub fn cancellation_operation_id(
        &self,
        params: &serde_json::Value,
    ) -> Result<Option<String>, CancellationScopeResolutionError> {
        let CancellationDefinition::OperationId(parameter) = self.cancellation else {
            return Ok(None);
        };
        let operation_id = params
            .as_object()
            .and_then(|params| params.get(parameter))
            .and_then(serde_json::Value::as_str)
            .filter(|operation_id| {
                let length = operation_id.chars().count();
                length > 0 && length <= 128
            })
            .ok_or(CancellationScopeResolutionError)?;
        Ok(Some(operation_id.to_owned()))
    }

    /// Resolves this method's scheduling key from its wire parameters.
    ///
    /// Implementations enqueue equal keys together. Exclusive requests run FIFO, while adjacent
    /// shared reads may run concurrently. Connection resources are additionally namespaced by the
    /// accepting connection in the App Server runtime.
    pub fn serialization_scope(
        &self,
        params: &serde_json::Value,
    ) -> Result<Option<ClientRequestSerializationScope>, SerializationScopeResolutionError> {
        let scope = match self.serialization {
            SerializationScopeDefinition::None => None,
            SerializationScopeDefinition::GlobalExclusive => {
                Some(ClientRequestSerializationScope::Global {
                    access: SerializationAccess::Exclusive,
                })
            }
            SerializationScopeDefinition::GlobalSharedRead => {
                Some(ClientRequestSerializationScope::Global {
                    access: SerializationAccess::SharedRead,
                })
            }
            SerializationScopeDefinition::SessionExclusive => {
                Some(ClientRequestSerializationScope::Session {
                    session_id: serialization_parameter(params, "sessionId")?,
                    access: SerializationAccess::Exclusive,
                })
            }
            SerializationScopeDefinition::SessionSharedRead => {
                Some(ClientRequestSerializationScope::Session {
                    session_id: serialization_parameter(params, "sessionId")?,
                    access: SerializationAccess::SharedRead,
                })
            }
            SerializationScopeDefinition::ResourceExclusive(parameter) => {
                Some(ClientRequestSerializationScope::ConnectionResource {
                    namespace: parameter,
                    resource_id: serialization_parameter(params, parameter)?,
                    access: SerializationAccess::Exclusive,
                })
            }
            SerializationScopeDefinition::ConnectionExclusive(namespace) => {
                Some(ClientRequestSerializationScope::ConnectionResource {
                    namespace,
                    resource_id: String::new(),
                    access: SerializationAccess::Exclusive,
                })
            }
        };
        Ok(scope)
    }
}

/// Returned when request parameters omit the key declared by their method metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SerializationScopeResolutionError;

impl std::fmt::Display for SerializationScopeResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("request parameters do not contain the declared serialization key")
    }
}

impl std::error::Error for SerializationScopeResolutionError {}

/// Returned when cancellable request parameters omit or invalidate their operation identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CancellationScopeResolutionError;

impl std::fmt::Display for CancellationScopeResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("request parameters do not contain a valid cancellation operation ID")
    }
}

impl std::error::Error for CancellationScopeResolutionError {}

fn serialization_parameter(
    params: &serde_json::Value,
    parameter: &'static str,
) -> Result<String, SerializationScopeResolutionError> {
    let value = params
        .as_object()
        .and_then(|params| params.get(parameter))
        .ok_or(SerializationScopeResolutionError)?;
    if let Some(value) = value.as_str() {
        return Ok(value.to_string());
    }
    serde_json::to_string(value).map_err(|_| SerializationScopeResolutionError)
}

#[derive(Clone, Copy)]
pub struct HostMethodDefinition {
    pub kind: HostMethod,
    pub method: &'static str,
    #[cfg(any(test, feature = "export"))]
    params_type: fn(&Config) -> String,
    #[cfg(any(test, feature = "export"))]
    result_type: fn(&Config) -> String,
}

impl HostMethodDefinition {
    #[cfg(any(test, feature = "export"))]
    pub fn params_type(&self) -> String {
        (self.params_type)(&Config::default())
    }

    #[cfg(any(test, feature = "export"))]
    pub fn result_type(&self) -> String {
        (self.result_type)(&Config::default())
    }
}

#[derive(Clone, Copy)]
pub struct ServerNotificationDefinition {
    pub kind: ServerNotificationMethod,
    pub method: &'static str,
    #[cfg(any(test, feature = "export"))]
    params_type: fn(&Config) -> String,
}

impl ServerNotificationDefinition {
    #[cfg(any(test, feature = "export"))]
    pub fn params_type(&self) -> String {
        (self.params_type)(&Config::default())
    }
}

#[cfg(any(test, feature = "export"))]
#[derive(Clone, Copy)]
pub(crate) struct TypeScriptBinding {
    declaration: fn(&Config) -> String,
    dependencies: fn(&Config) -> Vec<ts_rs::Dependency>,
    identifier: fn(&Config) -> String,
}

#[cfg(any(test, feature = "export"))]
impl TypeScriptBinding {
    pub(crate) fn declaration(&self) -> String {
        (self.declaration)(&Config::default())
    }

    pub(crate) fn dependencies(&self) -> Vec<String> {
        (self.dependencies)(&Config::default())
            .into_iter()
            .map(|dependency| dependency.ts_name)
            .collect()
    }

    pub(crate) fn identifier(&self) -> String {
        (self.identifier)(&Config::default())
    }
}

#[cfg(any(test, feature = "export"))]
type VariantSchema = (
    &'static str,
    fn(&mut schemars::SchemaGenerator) -> schemars::Schema,
);

// Keep object construction out of the hundreds of registered method instantiations.
// The payload schema functions retain their concrete types; this loop is compiled once.
#[cfg(any(test, feature = "export"))]
#[inline(never)]
fn method_schema(
    generator: &mut schemars::SchemaGenerator,
    content: &str,
    variants: &[VariantSchema],
) -> schemars::Schema {
    let variants = variants
        .iter()
        .map(|(method, payload)| {
            let payload = payload(generator);
            schemars::json_schema!({
                "type": "object",
                "properties": {
                    "method": { "type": "string", "const": method },
                    content: payload,
                },
                "required": ["method", content],
            })
        })
        .collect::<Vec<_>>();
    schemars::json_schema!({ "oneOf": variants })
}

macro_rules! method_schema_type {
    ($name:ident, $content:literal, { $($method:literal => $payload:ty,)+ }) => {
#[cfg(any(test, feature = "export"))]
        pub(crate) struct $name;

#[cfg(any(test, feature = "export"))]
        impl JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                std::borrow::Cow::Borrowed(stringify!($name))
            }

            fn schema_id() -> std::borrow::Cow<'static, str> {
                std::borrow::Cow::Borrowed(concat!(module_path!(), "::", stringify!($name)))
            }

            fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                method_schema(generator, $content, &[
                    $(($method, schemars::SchemaGenerator::subschema_for::<$payload>),)+
                ])
            }
        }
    };
}

macro_rules! client_methods {
    (
        $(
            $variant:ident => $method:literal {
                params: $params:ty,
                response: $response:ty,
                serialization: $serialization:ident $(($serialization_key:literal))?,
                $(cancellation: $cancellation_parameter:literal,)?
            }
        ),+ $(,)?
    ) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum ClientMethod {
            $($variant,)+
        }

        impl ClientMethod {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $method,)+
                }
            }
        }

        pub fn client_method(method: &str) -> Option<ClientMethod> {
            match method {
                $($method => Some(ClientMethod::$variant),)+
                _ => None,
            }
        }

        pub const CLIENT_METHODS: &[ClientMethodDefinition] = &[
            $(
                ClientMethodDefinition {
                    kind: ClientMethod::$variant,
                    method: $method,
                    serialization: SerializationScopeDefinition::$serialization$(($serialization_key))?,
                    cancellation: cancellation_definition!($($cancellation_parameter)?),
                    #[cfg(any(test, feature = "export"))]
                    params_type: <$params as TS>::name,
                    #[cfg(any(test, feature = "export"))]
                    result_type: <$response as TS>::name,
                },
            )+
        ];

        method_schema_type!(ClientRequestSchema, "params", { $($method => $params,)+ });
        method_schema_type!(ClientResultSchema, "result", { $($method => Box<$response>,)+ });
    };
}

macro_rules! cancellation_definition {
    () => {
        CancellationDefinition::None
    };
    ($parameter:literal) => {
        CancellationDefinition::OperationId($parameter)
    };
}

client_methods! {
    QueueEdit => "queue/edit" { params: QueueEditParams, response: QueuedMessage, serialization: None, },
    ExtensionItems => "extension/items/list" { params: ExtensionItemsParams, response: ExtensionItemsResult, serialization: None, },
    QueueEnqueue => "queue/enqueue" {
        params: QueueEnqueueParams, response: QueuedMessage, serialization: None,
    },
    QueueList => "queue/list" {
        params: QueueListParams, response: QueueListResult, serialization: None,
    },
    QueueCancel => "queue/cancel" {
        params: QueueCancelParams, response: QueuedMessage, serialization: None,
    },
    DiagnosticsRead => "diagnostics/read" {
        params: EmptyParams, response: DiagnosticSnapshot, serialization: None,
    },
    FeedbackPrepare => "feedback/prepare" {
        params: FeedbackPrepareParams, response: PreparedFeedback, serialization: ConnectionExclusive("feedback"),
    },
    FeedbackUpload => "feedback/upload" {
        params: FeedbackUploadParams, response: (), serialization: ConnectionExclusive("feedback"), cancellation: "operationId",
    },
    MemoryDiagnosticsStart => "memoryDiagnostics/start" {
        params: MemoryStart, response: MemoryReport, serialization: ConnectionExclusive("memory"),
    },
    MemoryDiagnosticsRead => "memoryDiagnostics/read" {
        params: MemoryDiagnosticsSessionParams, response: MemoryReport, serialization: ConnectionExclusive("memory"),
    },
    MemoryDiagnosticsStop => "memoryDiagnostics/stop" {
        params: MemoryDiagnosticsSessionParams, response: MemoryReport, serialization: ConnectionExclusive("memory"),
    },
    MemoryDiagnosticsSubmit => "memoryDiagnostics/submit" {
        params: MemoryEvidence, response: (), serialization: ConnectionExclusive("memory"),
    },
    MemoryDiagnosticsExport => "memoryDiagnostics/export" {
        params: MemoryDiagnosticsSessionParams, response: ResourceMetadataResult, serialization: ConnectionExclusive("memory"),
    },
    MemoryCitationRead => "memory/citation/read" {
        params: MemoryCitationReadParams, response: memories::MemoryCitationResult, serialization: None,
    },
    MemoryPolicyRead => "memory/policy/read" {
        params: MemoryPolicyReadParams, response: memories::MemoryPolicy, serialization: None,
    },
    MemoryPolicyUpdate => "memory/policy/update" {
        params: MemoryPolicyUpdateParams, response: memories::MemoryPolicyMutationResult, serialization: GlobalExclusive,
    },
    MemoryScopes => "memory/scopes" {
        params: MemoryScopesParams, response: MemoryScopesResult, serialization: None,
    },
    MemoryUpdate => "memory/update" {
        params: MemoryUpdateParams, response: memories::MemoryMutationResult, serialization: GlobalExclusive,
    },
    MemoryAdd => "memory/add" {
        params: MemoryAddParams, response: memories::MemoryMutationResult, serialization: GlobalExclusive,
    },
    MemoryList => "memory/list" {
        params: MemoryListParams, response: memories::MemoryListPage, serialization: None,
    },
    MemoryRead => "memory/read" {
        params: MemoryReadParams, response: memories::Memory, serialization: None,
    },
    MemorySearch => "memory/search" {
        params: MemorySearchParams, response: memories::MemorySearchPage, serialization: None,
    },
    MemoryDelete => "memory/delete" {
        params: MemoryDeleteParams, response: memories::MemoryDeleteResult, serialization: GlobalExclusive,
    },

    AutomationList => "automation/list" {
        params: EmptyParams, response: AutomationListResult, serialization: None,
    },
    AutomationWrite => "automation/write" {
        params: AutomationWriteParams, response: Automation, serialization: None,
    },
    AutomationDelete => "automation/delete" {
        params: AutomationDeleteParams, response: (), serialization: None,
    },
    AutomationRun => "automation/run" {
        params: AutomationRunParams, response: AutomationRun, serialization: None,
    },
    AutomationRuns => "automation/runs" {
        params: AutomationRunsParams, response: AutomationRunsResult, serialization: None,
    },
    AutomationStop => "automation/stop" {
        params: AutomationStopParams, response: AutomationRun, serialization: None,
    },
    Initialize => "initialize" {
        params: InitializeParams,
        response: InitializeResult,
        serialization: GlobalExclusive,
    },
    EnvCwdSet => "env/cwd/set" {
        params: EnvCwdSetParams,
        response: EnvCwdSetResult,
        serialization: GlobalExclusive,
    },
    EnvDirsSet => "env/dirs/set" {
        params: EnvDirsSetParams,
        response: EnvDirsSetResult,
        serialization: GlobalExclusive,
    },
    SessionDirList => "session/dirs/list" {
        params: SessionDirListParams,
        response: SessionDirListResult,
        serialization: SessionSharedRead,
    },
    SessionDirAdd => "session/dirs/add" {
        params: SessionDirAddParams,
        response: SessionDirAddResult,
        serialization: SessionExclusive,
    },
    SessionDirRemove => "session/dirs/remove" {
        params: SessionDirRemoveParams,
        response: SessionDirMutationResult,
        serialization: SessionExclusive,
    },
    SessionDirPermissionsSet => "session/dirs/permissions/set" {
        params: SessionDirPermissionsSetParams,
        response: SessionDirMutationResult,
        serialization: SessionExclusive,
    },
    DirPermissionsRead => "config/dirPermissions/read" {
        params: DirPermissionsReadParams,
        response: DirPermissionsReadResult,
        serialization: GlobalSharedRead,
    },
    DirPermissionsList => "config/dirPermissions/list" {
        params: EmptyParams,
        response: DirPermissionsListResult,
        serialization: GlobalSharedRead,
    },
    DirPermissionsSet => "config/dirPermissions/set" {
        params: DirPermissionsSetParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    DirPermissionsForget => "config/dirPermissions/forget" {
        params: DirPermissionsForgetParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    CallStart => "call/start" {
        params: CallStartParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    CallRead => "call/read" {
        params: CallResourceParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    CallScreenSources => "call/screenSources" {
        params: CallResourceParams,
        response: CallScreenSources,
        serialization: ConnectionExclusive("call"),
    },
    CallScreenFrames => "call/screenFrames" {
        params: CallResourceParams,
        response: CallScreenFrames,
        serialization: ConnectionExclusive("call"),
    },
    CallControl => "call/control" {
        params: CallControlParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    CallLeave => "call/leave" {
        params: CallResourceParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    CallEnd => "call/end" {
        params: CallEndParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    CallInvite => "call/invite" {
        params: CallInviteParams,
        response: CallInvitation,
        serialization: ConnectionExclusive("call"),
    },
    CallRemove => "call/remove" {
        params: CallMemberParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    CallRole => "call/role" {
        params: CallRoleParams,
        response: CallStatus,
        serialization: ConnectionExclusive("call"),
    },
    DocumentCollaborationOpen => "document/collaboration/open" {
        params: DocumentCollaborationOpenParams,
        response: DocumentCollaborationOpenResult,
        serialization: GlobalExclusive,
    },
    DocumentCollaborationSubmit => "document/collaboration/submit" {
        params: DocumentCollaborationSubmitParams,
        response: DocumentCollaborationSubmitResult,
        serialization: GlobalExclusive,
    },
    DocumentCollaborationPresencePublish => "document/collaboration/presence/publish" {
        params: DocumentCollaborationPresenceParams,
        response: DocumentCollaborationPresenceSnapshot,
        serialization: GlobalExclusive,
    },
    DocumentCollaborationPresenceRead => "document/collaboration/presence/read" {
        params: DocumentCollaborationPresenceReadParams,
        response: DocumentCollaborationPresenceSnapshot,
        serialization: GlobalSharedRead,
    },
    SessionCreate => "session/create" {
        params: SessionCreateParams,
        response: SessionResult,
        serialization: GlobalExclusive,
    },
    AgentRead => "agent/read" {
        params: AgentReadParams,
        response: AgentReadResult,
        serialization: GlobalSharedRead,
    },
    SessionRead => "session/read" {
        params: SessionReadParams,
        response: SessionResult,
        serialization: SessionSharedRead,
    },
    SessionCatalogRead => "session/catalog/read" {
        params: SessionReadParams,
        response: SessionCatalogReadResult,
        serialization: SessionSharedRead,
    },
    MessageCheckpoints => "session/thread/checkpoints" {
        params: MessageCheckpointsParams,
        response: MessageCheckpointsResult,
        serialization: SessionSharedRead,
    },
    SessionList => "session/list" {
        params: EmptyParams,
        response: SessionListResult,
        serialization: GlobalSharedRead,
    },
    SessionCatalogSubscribe => "session/catalog/subscribe" {
        params: EmptyParams,
        response: SessionListResult,
        serialization: GlobalSharedRead,
    },
    SessionCatalogUnsubscribe => "session/catalog/unsubscribe" {
        params: EmptyParams,
        response: (),
        serialization: None,
    },
    SessionSubscribe => "session/subscribe" {
        params: SessionSubscribeParams,
        response: SessionSubscribeResult,
        serialization: SessionSharedRead,
    },
    SessionRequest => "session/request" {
        params: SessionRequestParams,
        response: SessionRequestResult,
        serialization: SessionExclusive,
    },
    SessionUnsubscribe => "session/unsubscribe" {
        params: SessionUnsubscribeParams,
        response: (),
        serialization: None,
    },
    SessionThreadRead => "session/thread/read" {
        params: SessionThreadReadParams,
        response: SessionThreadReadResult,
        serialization: SessionSharedRead,
    },
    ThreadGoalGet => "thread/goal/get" {
        params: ThreadGoalGetParams,
        response: ThreadGoalGetResponse,
        serialization: GlobalSharedRead,
    },
    ThreadGoalSet => "thread/goal/set" {
        params: ThreadGoalSetParams,
        response: ThreadGoalSetResponse,
        serialization: GlobalExclusive,
    },
    ThreadGoalClear => "thread/goal/clear" {
        params: ThreadGoalClearParams,
        response: ThreadGoalClearResponse,
        serialization: GlobalExclusive,
    },
    TurnChangesList => "turnChanges/list" {
        params: TurnChangesListParams,
        response: TurnChangesListResult,
        serialization: SessionSharedRead,
    },
    TurnChangesRead => "turnChanges/read" {
        params: TurnChangesReadParams,
        response: TurnChangesReadResult,
        serialization: SessionSharedRead,
    },
    TurnChangesReadFile => "turnChanges/readFile" {
        params: TurnChangesReadFileParams,
        response: TurnChangesReadFileResult,
        serialization: SessionSharedRead,
    },
    TurnChangesGenerateMessage => "turnChanges/generateMessage" {
        params: TurnChangesMutationParams,
        response: TurnChangesMutationResult,
        serialization: SessionExclusive,
    },
    TurnChangesUpdateDraft => "turnChanges/updateDraft" {
        params: TurnChangesUpdateDraftParams,
        response: TurnChangesMutationResult,
        serialization: SessionExclusive,
    },
    TurnChangesCommit => "turnChanges/commit" {
        params: TurnChangesCommitParams,
        response: TurnChangesMutationResult,
        serialization: SessionExclusive,
    },
    TurnChangesDiscardThread => "turnChanges/discardThread" {
        params: TurnChangesDiscardThreadParams,
        response: TurnChangesMutationResult,
        serialization: SessionExclusive,
    },
    ProjectList => "project/list" {
        params: ProjectListParams,
        response: ProjectListResult,
        serialization: GlobalSharedRead,
    },
    ProjectRead => "project/read" {
        params: ProjectReadParams,
        response: ProjectReadResult,
        serialization: GlobalSharedRead,
    },
    ProjectCreate => "project/create" {
        params: ProjectCreateParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectDetailsUpdate => "project/details/update" {
        params: ProjectDetailsUpdateParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectRootAdd => "project/root/add" {
        params: ProjectRootAddParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectRootUpdate => "project/root/update" {
        params: ProjectRootUpdateParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectRootRemove => "project/root/remove" {
        params: ProjectRootRemoveParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectSessionLink => "project/session/link" {
        params: ProjectSessionMutationParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectSessionUnlink => "project/session/unlink" {
        params: ProjectSessionMutationParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectArchive => "project/archive" {
        params: ProjectLifecycleParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    ProjectRestore => "project/restore" {
        params: ProjectLifecycleParams,
        response: ProjectMutationResult,
        serialization: GlobalExclusive,
    },
    SessionThreadSubscribe => "session/thread/subscribe" {
        params: SessionThreadSubscribeParams,
        response: SessionThreadSubscribeResult,
        serialization: SessionSharedRead,
    },
    SessionThreadUnsubscribe => "session/thread/unsubscribe" {
        params: SessionThreadUnsubscribeParams,
        response: (),
        serialization: None,
    },
    ConfigRead => "config/read" {
        params: EmptyParams,
        response: ConfigReadResult,
        serialization: GlobalSharedRead,
    },
    McpServerStatus => "mcp/server/status" {
        params: EmptyParams,
        response: McpServerStatusResult,
        serialization: GlobalSharedRead,
    },
    McpServerConnect => "mcp/server/connect" {
        params: McpServerRuntimeIntentParams,
        response: McpServerRuntimeIntentResult,
        serialization: GlobalExclusive,
    },
    McpServerDisconnect => "mcp/server/disconnect" {
        params: McpServerRuntimeIntentParams,
        response: McpServerRuntimeIntentResult,
        serialization: GlobalExclusive,
    },
    McpOAuthStart => "mcp/oauth/start" {
        params: McpOAuthStartParams,
        response: McpOAuthStartResult,
        serialization: GlobalExclusive,
    },
    McpOAuthComplete => "mcp/oauth/complete" {
        params: McpOAuthCompleteParams,
        response: McpOAuthMutationResult,
        serialization: GlobalExclusive,
    },
    McpOAuthRefresh => "mcp/oauth/refresh" {
        params: McpOAuthMutationParams,
        response: McpOAuthMutationResult,
        serialization: GlobalExclusive,
    },
    McpOAuthRevoke => "mcp/oauth/revoke" {
        params: McpOAuthMutationParams,
        response: McpOAuthMutationResult,
        serialization: GlobalExclusive,
    },
    ConnectorList => "connector/list" {
        params: EmptyParams,
        response: ConnectorListResult,
        serialization: GlobalSharedRead,
    },
    ConnectorApiTokenConnect => "connector/connect/apiToken" {
        params: ConnectorApiTokenConnectParams,
        response: ConnectorCommandResultDto,
        serialization: GlobalExclusive,
    },
    ConnectorOAuthStart => "connector/connect/oauth/start" {
        params: ConnectorOAuthStartParams,
        response: ConnectorOAuthStartResult,
        serialization: GlobalExclusive,
    },
    ConnectorOAuthComplete => "connector/connect/oauth/complete" {
        params: ConnectorOAuthCompleteParams,
        response: ConnectorCommandResultDto,
        serialization: GlobalExclusive,
    },
    ConnectorOAuthCancel => "connector/connect/oauth/cancel" {
        params: ConnectorOAuthCancelParams,
        response: ConnectorCommandResultDto,
        serialization: GlobalExclusive,
    },
    ConnectorDeviceOAuthStart => "connector/connect/oauth/device/start" {
        params: ConnectorDeviceOAuthStartParams,
        response: ConnectorDeviceOAuthStartResult,
        serialization: GlobalExclusive,
    },
    ConnectorDeviceOAuthPoll => "connector/connect/oauth/device/poll" {
        params: ConnectorDeviceOAuthPollParams,
        response: ConnectorDeviceOAuthPollResult,
        serialization: GlobalExclusive,
    },
    ConnectorDeviceOAuthCancel => "connector/connect/oauth/device/cancel" {
        params: ConnectorOAuthCancelParams,
        response: ConnectorCommandResultDto,
        serialization: GlobalExclusive,
    },
    ConnectorOAuthRefresh => "connector/oauth/refresh" {
        params: ConnectorOAuthRefreshParams,
        response: (),
        serialization: GlobalExclusive,
    },
    ConnectorOAuthRevoke => "connector/oauth/revoke" {
        params: ConnectorDisconnectParams,
        response: ConnectorDisconnectResultDto,
        serialization: GlobalExclusive,
    },
    ConnectorDisconnect => "connector/disconnect" {
        params: ConnectorDisconnectParams,
        response: ConnectorDisconnectResultDto,
        serialization: GlobalExclusive,
    },
    ConnectorCredentialCleanupRetry => "connector/credential/cleanup" {
        params: ConnectorCredentialCleanupParams,
        response: ConnectorCredentialCleanupDto,
        serialization: GlobalExclusive,
    },
    PluginList => "plugin/list" {
        params: EmptyParams,
        response: PluginListResult,
        serialization: GlobalSharedRead,
    },
    MarketplaceSearch => "marketplace/search" {
        params: MarketplaceSearchParams,
        response: MarketplaceSearchResult,
        serialization: GlobalSharedRead,
    },
    MarketplaceGet => "marketplace/get" {
        params: MarketplaceGetParams,
        response: MarketplacePackageDetailsDto,
        serialization: GlobalSharedRead,
    },
    MarketplaceDownload => "marketplace/download" {
        params: MarketplaceDownloadParams,
        response: MarketplaceArtifactHandleDto,
        serialization: GlobalExclusive,
    },
    MarketplaceInstall => "marketplace/install" {
        params: MarketplaceInstallParams,
        response: MarketplaceInstalledPackageDto,
        serialization: GlobalExclusive,
    },
    MarketplaceUpdate => "marketplace/update" {
        params: MarketplaceUpdateParams,
        response: MarketplaceInstalledPackageDto,
        serialization: GlobalExclusive,
    },
    MarketplaceUninstall => "marketplace/uninstall" {
        params: MarketplaceUninstallParams,
        response: (),
        serialization: GlobalExclusive,
    },
    MarketplaceListInstalled => "marketplace/listInstalled" {
        params: EmptyParams,
        response: MarketplaceListInstalledResult,
        serialization: GlobalSharedRead,
    },
    MarketplaceAcquireCapability => "marketplace/acquireCapability" {
        params: MarketplaceAcquireCapabilityParams,
        response: MarketplaceAcquiredCapabilityDto,
        serialization: GlobalExclusive,
    },
    MarketplaceReleaseCapability => "marketplace/releaseCapability" {
        params: MarketplaceReleaseCapabilityParams,
        response: (),
        serialization: GlobalExclusive,
    },
    MarketplaceOpenResource => "marketplace/openResource" {
        params: MarketplaceOpenResourceParams,
        response: MarketplaceResourceContentDto,
        serialization: GlobalSharedRead,
    },
    PluginEnable => "plugin/enable" {
        params: PluginPackageCommandParams,
        response: PluginCommandResultDto,
        serialization: GlobalExclusive,
    },
    PluginDisable => "plugin/disable" {
        params: PluginPackageCommandParams,
        response: PluginCommandResultDto,
        serialization: GlobalExclusive,
    },
    PluginGrant => "plugin/grant" {
        params: PluginPackageCommandParams,
        response: PluginCommandResultDto,
        serialization: GlobalExclusive,
    },
    PluginRevokeGrant => "plugin/revokeGrant" {
        params: PluginPackageCommandParams,
        response: PluginCommandResultDto,
        serialization: GlobalExclusive,
    },
    PluginUninstall => "plugin/uninstall" {
        params: PluginPackageCommandParams,
        response: PluginCommandResultDto,
        serialization: GlobalExclusive,
    },
    ModelList => "model/list" {
        params: EmptyParams,
        response: ModelListResult,
        serialization: GlobalSharedRead,
    },
    ProviderList => "provider/list" {
        params: EmptyParams,
        response: ProviderListResult,
        serialization: GlobalSharedRead,
    },
    ProviderProbe => "provider/probe" {
        params: ProviderProbeParams,
        response: ProviderProbeResult,
        serialization: GlobalSharedRead,
    },
    ProviderModelsList => "provider/models/list" {
        params: ProviderModelsListParams,
        response: ProviderModelsListResult,
        serialization: GlobalSharedRead,
    },
    ProviderApiKeySet => "provider/apiKey/set" {
        params: ProviderApiKeySetParams,
        response: ProviderApiKeySetResult,
        serialization: GlobalExclusive,
    },
    AccountRead => "account/read" {
        params: EmptyParams,
        response: AccountReadResult,
        serialization: None,
    },
    AccountRateLimitsRead => "account/rateLimits/read" {
        params: AccountRateLimitsReadParams,
        response: AccountRateLimitsReadResult,
        serialization: None,
    },
    AccountLoginStart => "account/login/start" {
        params: AccountLoginStartParams,
        response: AccountLoginStartResult,
        serialization: GlobalExclusive,
    },
    AccountLoginCancel => "account/login/cancel" {
        params: AccountLoginCancelParams,
        response: AccountLoginCancelResult,
        serialization: GlobalExclusive,
    },
    AccountLogout => "account/logout" {
        params: AccountLogoutParams,
        response: AccountLogoutResult,
        serialization: GlobalExclusive,
    },
    ConfigUpdate => "config/update" {
        params: ConfigUpdateParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    ExecPolicyRuleUpsert => "execPolicy/rule/upsert" {
        params: ExecPolicyRuleUpsertParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    ExecPolicyRuleRemove => "execPolicy/rule/remove" {
        params: ExecPolicyRuleRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    ToolSearchConfigure => "toolSearch/configure" {
        params: ToolSearchConfigureParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    CodebaseConfigure => "codebase/configure" {
        params: CodebaseConfigureParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    CommitMessageAuthorize => "commitMessage/authorize" {
        params: CommitMessageAuthorizeParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    CommitMessageRevoke => "commitMessage/revoke" {
        params: CommitMessageRevokeParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    LanguageServerConfigure => "languageServer/configure" {
        params: LanguageServerConfigureParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    LanguageServerRemove => "languageServer/remove" {
        params: LanguageServerRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    ProviderConfigure => "provider/configure" {
        params: ProviderConfigureParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    ProviderRemove => "provider/remove" {
        params: ProviderRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    McpServerUpsert => "mcp/server/upsert" {
        params: McpServerUpsertParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    McpServerRemove => "mcp/server/remove" {
        params: McpServerRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    McpServerSetEnablement => "mcp/server/enablement/set" {
        params: McpServerSetEnablementParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    SkillSourceAdd => "skill/source/add" {
        params: SkillSourceAddParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    SkillSourceRemove => "skill/source/remove" {
        params: SkillSourceRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    SkillSourceSetEnablement => "skill/source/enablement/set" {
        params: SkillSourceSetEnablementParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    PluginRequestUpsert => "plugin/request/upsert" {
        params: PluginRequestUpsertParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    PluginRequestRemove => "plugin/request/remove" {
        params: PluginRequestRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    PluginRequestSetEnablement => "plugin/request/enablement/set" {
        params: PluginRequestSetEnablementParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    HookUpsert => "hook/upsert" {
        params: HookUpsertParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    HookRemove => "hook/remove" {
        params: HookRemoveParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    HookSetEnablement => "hook/enablement/set" {
        params: HookSetEnablementParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    InstructionImportPreview => "instructions/importPreview" {
        params: InstructionImportPreviewParams,
        response: InstructionImportPreviewResult,
        serialization: GlobalSharedRead,
    },
    InstructionImport => "instructions/import" {
        params: InstructionImportParams,
        response: InstructionImportResult,
        serialization: GlobalExclusive,
    },
    InstructionList => "instructions/list" {
        params: InstructionListParams,
        response: InstructionListResult,
        serialization: GlobalSharedRead,
    },
    SkillList => "skills/list" {
        params: SkillListParams,
        response: SkillListResult,
        serialization: GlobalSharedRead,
    },
    SkillSetEnablement => "skill/enablement/set" {
        params: SkillSetEnablementParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    SkillResourceOpen => "skill/resource/open" {
        params: SkillResourceOpenParams,
        response: SkillResourceOpenResult,
        serialization: ResourceExclusive("skillId"),
    },
    ExtensionList => "extensions/list" {
        params: ExtensionListParams,
        response: ExtensionListResult,
        serialization: GlobalSharedRead,
    },
    ExtensionResourceOpen => "extensions/resource/open" {
        params: ExtensionResourceOpenParams,
        response: ExtensionResourceOpenResult,
        serialization: ResourceExclusive("extensionId"),
    },
    ExtensionHostList => "extensionHost/list" {
        params: EmptyParams,
        response: ExtensionHostSnapshotDto,
        serialization: GlobalSharedRead,
    },
    ExtensionHostReconcile => "extensionHost/reconcile" {
        params: ExtensionHostReconcileParams,
        response: ExtensionHostSnapshotDto,
        serialization: GlobalExclusive,
    },
    ExtensionHostInvokeStart => "extensionHost/invoke/start" {
        params: ExtensionHostInvokeStartParams,
        response: ExtensionHostInvokeStartResult,
        serialization: None,
    },
    ExtensionHostInvokeRead => "extensionHost/invoke/read" {
        params: ExtensionHostInvokeReadParams,
        response: ExtensionHostInvokeReadResult,
        serialization: None,
    },
    ExtensionHostInvokeCancel => "extensionHost/invoke/cancel" {
        params: ExtensionHostInvokeCancelParams,
        response: ExtensionHostInvokeCancelResult,
        serialization: None,
    },
    TypstCompile => "document/typst/compile" {
        params: TypstCompileParams,
        response: TypstCompileResult,
        serialization: GlobalExclusive,
    },
    ResourceMetadata => "resource/metadata" {
        params: ResourceMetadataParams,
        response: ResourceMetadataResult,
        serialization: ResourceExclusive("resourceId"),
    },
    ResourceRead => "resource/read" {
        params: ResourceReadParams,
        response: ResourceReadResult,
        serialization: ResourceExclusive("resourceId"),
    },
    ResourceRelease => "resource/release" {
        params: ResourceReleaseParams,
        response: (),
        serialization: ResourceExclusive("resourceId"),
    },
    AttachmentUploadStart => "attachment/upload/start" {
        params: AttachmentUploadStartParams,
        response: AttachmentUploadStartResult,
        serialization: ConnectionExclusive("attachmentIngress"),
    },
    AttachmentUploadWrite => "attachment/upload/write" {
        params: AttachmentUploadWriteParams,
        response: AttachmentUploadWriteResult,
        serialization: ResourceExclusive("uploadId"),
    },
    AttachmentUploadFinish => "attachment/upload/finish" {
        params: AttachmentUploadFinishParams,
        response: AttachmentMaterializeResult,
        serialization: ResourceExclusive("uploadId"),
    },
    AttachmentUploadCancel => "attachment/upload/cancel" {
        params: AttachmentUploadCancelParams,
        response: (),
        serialization: ResourceExclusive("uploadId"),
    },
    AttachmentImportRemote => "attachment/importRemote" {
        params: AttachmentImportRemoteParams,
        response: AttachmentMaterializeResult,
        serialization: ConnectionExclusive("attachmentIngress"),
    },
    FsGetMetadata => "fs/getMetadata" {
        params: FsGetMetadataParams,
        response: FsGetMetadataResult,
        serialization: GlobalSharedRead,
    },
    FsReadDirectory => "fs/readDirectory" {
        params: FsReadDirectoryParams,
        response: FsReadDirectoryResult,
        serialization: GlobalSharedRead,
    },
    FsReadFile => "fs/readFile" {
        params: FsReadFileParams,
        response: FsReadFileResult,
        serialization: GlobalSharedRead,
    },
    FsReadBinaryFile => "fs/readBinaryFile" {
        params: FsReadBinaryFileParams,
        response: FsReadBinaryFileResult,
        serialization: GlobalSharedRead,
    },
    DiffCompute => "diff/compute" {
        params: DiffComputeParams,
        response: DiffComputeResult,
        serialization: GlobalSharedRead,
    },
    SyntaxOpen => "syntax/open" {
        params: SyntaxOpenParams,
        response: (),
        serialization: ResourceExclusive("documentId"),
    },
    SyntaxUpdate => "syntax/update" {
        params: SyntaxUpdateParams,
        response: (),
        serialization: ResourceExclusive("documentId"),
    },
    SyntaxAnalyze => "syntax/analyze" {
        params: SyntaxAnalyzeParams,
        response: SyntaxAnalyzeResult,
        serialization: ResourceExclusive("documentId"),
    },
    SyntaxSelectionRanges => "syntax/selectionRanges" {
        params: SyntaxSelectionRangesParams,
        response: SyntaxSelectionRangesResult,
        serialization: ResourceExclusive("documentId"),
    },
    SyntaxClose => "syntax/close" {
        params: SyntaxCloseParams,
        response: (),
        serialization: ResourceExclusive("documentId"),
    },
    LanguageServers => "language/servers" {
        params: LanguageServersParams,
        response: LanguageServersResult,
        serialization: GlobalSharedRead,
    },
    LanguageSynchronize => "language/synchronize" {
        params: LanguageSynchronizeParams,
        response: (),
        serialization: GlobalSharedRead,
    },
    LanguageClose => "language/close" {
        params: LanguageCloseParams,
        response: (),
        serialization: GlobalSharedRead,
    },
    LanguageCancel => "language/cancel" {
        params: LanguageCancelParams,
        response: LanguageCancelResult,
        serialization: GlobalSharedRead,
    },
    LanguageHover => "language/hover" {
        params: LanguageOperationParams<LanguageHoverParams>,
        response: LanguageHoverResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageCompletions => "language/completions" {
        params: LanguageOperationParams<LanguageCompletionsParams>,
        response: LanguageCompletionsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageResolveCompletion => "language/resolveCompletion" {
        params: LanguageOperationParams<LanguageResolveCompletionParams>,
        response: LanguageCompletionDetailsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageExecuteCommand => "language/executeCommand" {
        params: LanguageExecuteCommandParams,
        response: (),
        serialization: GlobalSharedRead,
    },
    LanguageDocumentDiagnostics => "language/documentDiagnostics" {
        params: LanguageOperationParams<LanguageDocumentDiagnosticsParams>,
        response: LanguageDocumentDiagnosticsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageDirectoryDiagnostics => "language/directoryDiagnostics" {
        params: LanguageOperationParams<LanguageDirectoryDiagnosticsParams>,
        response: LanguageDirectoryDiagnosticsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageLocations => "language/locations" {
        params: LanguageOperationParams<LanguageLocationsParams>,
        response: LanguageLocationsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageHierarchy => "language/hierarchy" {
        params: LanguageOperationParams<LanguageHierarchyParams>,
        response: LanguageHierarchyResultDto,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageDirectorySymbols => "language/directorySymbols" {
        params: LanguageOperationParams<LanguageDirectorySymbolsParams>,
        response: LanguageDirectorySymbolsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguagePrepareRename => "language/prepareRename" {
        params: LanguageOperationParams<LanguagePrepareRenameParams>,
        response: LanguagePrepareRenameResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageRename => "language/rename" {
        params: LanguageOperationParams<LanguageRenameParams>,
        response: LanguageDirectoryEditDto,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageCodeActions => "language/codeActions" {
        params: LanguageOperationParams<LanguageCodeActionsParams>,
        response: LanguageCodeActionsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageResolveCodeAction => "language/resolveCodeAction" {
        params: LanguageOperationParams<LanguageResolveCodeActionParams>,
        response: LanguageCodeActionDto,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageDocumentFormatting => "language/formatDocument" {
        params: LanguageOperationParams<LanguageDocumentFormattingParams>,
        response: LanguageFormattingResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageRangeFormatting => "language/formatRange" {
        params: LanguageOperationParams<LanguageRangeFormattingParams>,
        response: LanguageFormattingResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageSignatureHelp => "language/signatureHelp" {
        params: LanguageOperationParams<LanguageSignatureHelpParams>,
        response: LanguageSignatureHelpResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageInlayHints => "language/inlayHints" {
        params: LanguageOperationParams<LanguageInlayHintsParams>,
        response: LanguageInlayHintsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageLinkedEditingRanges => "language/linkedEditingRanges" {
        params: LanguageOperationParams<LanguageLinkedEditingRangesParams>,
        response: LanguageLinkedEditingRangesResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageSemanticTokens => "language/semanticTokens" {
        params: LanguageOperationParams<LanguageSemanticTokensParams>,
        response: LanguageSemanticTokensResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageDocumentSymbols => "language/documentSymbols" {
        params: LanguageOperationParams<LanguageDocumentFeaturesParams>,
        response: LanguageDocumentSymbolsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageCodeLenses => "language/codeLenses" {
        params: LanguageOperationParams<LanguageDocumentFeaturesParams>,
        response: LanguageCodeLensesResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageResolveCodeLens => "language/resolveCodeLens" {
        params: LanguageOperationParams<LanguageResolveCodeLensParams>,
        response: LanguageCodeLensesResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageDocumentLinks => "language/documentLinks" {
        params: LanguageOperationParams<LanguageDocumentFeaturesParams>,
        response: LanguageDocumentLinksResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageResolveDocumentLink => "language/resolveDocumentLink" {
        params: LanguageOperationParams<LanguageResolveDocumentLinkParams>,
        response: LanguageDocumentLinksResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageDocumentColors => "language/documentColors" {
        params: LanguageOperationParams<LanguageDocumentFeaturesParams>,
        response: LanguageDocumentColorsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageColorPresentations => "language/colorPresentations" {
        params: LanguageOperationParams<LanguageColorPresentationsParams>,
        response: LanguageColorPresentationsResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    LanguageFoldingRanges => "language/foldingRanges" {
        params: LanguageOperationParams<LanguageDocumentFeaturesParams>,
        response: LanguageFoldingRangesResult,
        serialization: GlobalSharedRead,
        cancellation: "operationId",
    },
    FsWriteFile => "fs/writeFile" {
        params: FsWriteFileParams,
        response: FsWriteFileResult,
        serialization: GlobalExclusive,
    },
    FsCreateFile => "fs/createFile" {
        params: FsCreateFileParams,
        response: FsGetMetadataResult,
        serialization: GlobalExclusive,
    },
    FsRename => "fs/rename" {
        params: FsRenameParams,
        response: (),
        serialization: GlobalExclusive,
    },
    FsDelete => "fs/delete" {
        params: FsDeleteParams,
        response: (),
        serialization: GlobalExclusive,
    },
    IssueConfigure => "issue/configure" {
        params: IssueConfigureParams,
        response: ConfigCommandResult,
        serialization: GlobalExclusive,
    },
    IssueList => "issue/list" {
        params: IssueListParams,
        response: IssueListResult,
        serialization: None,
    },
    IssueRead => "issue/read" {
        params: IssueReadParams,
        response: IssueReadResult,
        serialization: None,
    },
    GitRepositories => "git/repositories" {
        params: EmptyParams,
        response: GitRepositoriesResult,
        serialization: GlobalSharedRead,
    },
    GitStatus => "git/status" {
        params: GitRepositoryParams,
        response: GitStatusResult,
        serialization: GlobalSharedRead,
    },
    GitTextDiff => "git/textDiff" {
        params: GitRepositoryParams,
        response: GitTextDiffResult,
        serialization: GlobalSharedRead,
    },
    GitBranchList => "git/branch/list" {
        params: GitRepositoryParams,
        response: GitBranchListResult,
        serialization: GlobalSharedRead,
    },
    GitHistory => "git/history" {
        params: GitRepositoryParams,
        response: GitHistoryResult,
        serialization: GlobalSharedRead,
    },
    GitGraph => "git/graph" {
        params: GitGraphParams,
        response: GitGraphResult,
        serialization: GlobalSharedRead,
    },
    GitCommitChanges => "git/commitChanges" {
        params: GitCommitChangesParams,
        response: GitCommitChangesResult,
        serialization: GlobalSharedRead,
    },
    GitCommitFile => "git/commitFile" {
        params: GitCommitFileParams,
        response: GitCommitFileResult,
        serialization: GlobalSharedRead,
    },
    GitChangeFile => "git/changeFile" {
        params: GitChangeFileParams,
        response: GitChangeFileResult,
        serialization: GlobalSharedRead,
    },
    GitBranchSwitch => "git/branch/switch" {
        params: GitBranchSwitchParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    GitStage => "git/stage" {
        params: GitPathsParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    GitUnstage => "git/unstage" {
        params: GitPathsParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    GitDiscardWorktree => "git/discardWorktree" {
        params: GitPathsParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    GitCommit => "git/commit" {
        params: GitCommitParams,
        response: GitCommitResult,
        serialization: GlobalExclusive,
    },
    GitFetch => "git/fetch" {
        params: GitFetchParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    GitPull => "git/pull" {
        params: GitRepositoryParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    GitPush => "git/push" {
        params: GitRepositoryParams,
        response: GitOperationResult,
        serialization: GlobalExclusive,
    },
    ContentSearchStart => "grep/search/start" {
        params: ContentSearchStartParams,
        response: ContentSearchStartResult,
        serialization: None,
    },
    ContentSearchRead => "grep/search/read" {
        params: ContentSearchReadParams,
        response: ContentSearchReadResult,
        serialization: None,
    },
    ContentSearchCancel => "grep/search/cancel" {
        params: ContentSearchCancelParams,
        response: (),
        serialization: None,
    },
    CodebaseStatus => "codebase/status" {
        params: EmptyParams,
        response: CodebaseStatusResult,
        serialization: GlobalSharedRead,
    },
    CodebaseSearch => "codebase/search" {
        params: CodebaseSearchParams,
        response: CodebaseSearchResult,
        serialization: GlobalSharedRead,
    },
    CodebaseSymbolsStatus => "codebase/symbols/status" {
        params: EmptyParams,
        response: CodebaseSymbolsStatusResult,
        serialization: GlobalSharedRead,
    },
    CodebaseSymbolsSearch => "codebase/symbols/search" {
        params: CodebaseSymbolsSearchParams,
        response: CodebaseSymbolsSearchResult,
        serialization: GlobalSharedRead,
    },
    DocumentOverlaySynchronize => "codeIntelligence/document/synchronize" {
        params: DocumentOverlaySynchronizeParams,
        response: DocumentOverlayStatusResult,
        serialization: GlobalSharedRead,
    },
    DocumentOverlayClose => "codeIntelligence/document/close" {
        params: DocumentOverlayCloseParams,
        response: DocumentOverlayStatusResult,
        serialization: GlobalSharedRead,
    },
    CodebaseRetrieve => "codebase/retrieve" {
        params: CodebaseRetrievalParams,
        response: CodebaseRetrievalResult,
        serialization: GlobalSharedRead,
    },
    CodebaseRebuild => "codebase/rebuild" {
        params: EmptyParams,
        response: CodebaseStatusResult,
        serialization: GlobalExclusive,
    },
    GrepIndexStatus => "grep/index/status" {
        params: EmptyParams,
        response: GrepIndexStatusResult,
        serialization: GlobalSharedRead,
    },
    GrepIndexRebuild => "grep/index/rebuild" {
        params: EmptyParams,
        response: GrepIndexStatusResult,
        serialization: GlobalExclusive,
    },
    GrepIndexDisableAndDelete => "grep/index/disableAndDelete" {
        params: GrepIndexDisableAndDeleteParams,
        response: GrepIndexDisableAndDeleteResult,
        serialization: GlobalExclusive,
    },
    CloudCodebaseStatus => "codebase/cloud/status" {
        params: EmptyParams,
        response: CloudCodebaseStatusResult,
        serialization: GlobalSharedRead,
    },
    CloudCodebasePreview => "codebase/cloud/preview" {
        params: CloudCodebasePreviewParams,
        response: CloudCodebasePreviewResult,
        serialization: GlobalSharedRead,
    },
    CloudCodebaseAuthorize => "codebase/cloud/authorize" {
        params: CloudCodebaseAuthorizeParams,
        response: CloudCodebaseStatusResult,
        serialization: GlobalExclusive,
    },
    CloudCodebaseSync => "codebase/cloud/sync" {
        params: EmptyParams,
        response: CloudCodebaseStatusResult,
        serialization: GlobalExclusive,
    },
    CloudCodebaseRevoke => "codebase/cloud/revoke" {
        params: EmptyParams,
        response: CloudCodebaseStatusResult,
        serialization: GlobalExclusive,
    },
    TerminalProfileList => "terminal/profile/list" {
        params: EmptyParams,
        response: TerminalProfileListResult,
        serialization: GlobalSharedRead,
    },
    TerminalCreate => "terminal/create" {
        params: TerminalCreateParams,
        response: TerminalCreateResult,
        serialization: None,
    },
    TerminalCreateInSessionDirectory => "terminal/createInSessionDirectory" {
        params: TerminalCreateInSessionDirectoryParams,
        response: TerminalCreateResult,
        serialization: SessionExclusive,
    },
    TerminalAttach => "terminal/attach" {
        params: TerminalAttachParams,
        response: TerminalAttachResult,
        serialization: None,
    },
    TerminalWrite => "terminal/write" {
        params: TerminalWriteParams,
        response: (),
        serialization: None,
    },
    TerminalResize => "terminal/resize" {
        params: TerminalResizeParams,
        response: (),
        serialization: None,
    },
    TerminalRead => "terminal/read" {
        params: TerminalReadParams,
        response: TerminalReadResult,
        serialization: None,
    },
    TerminalClose => "terminal/close" {
        params: TerminalCloseParams,
        response: (),
        serialization: None,
    },
    DebugAdapterStart => "debug/adapter/start" {
        params: DebugAdapterStartParams,
        response: DebugAdapterStartResult,
        serialization: None,
    },
    DebugAdapterSend => "debug/adapter/send" {
        params: DebugAdapterSendParams,
        response: (),
        serialization: None,
    },
    DebugAdapterRead => "debug/adapter/read" {
        params: DebugAdapterReadParams,
        response: DebugAdapterReadResult,
        serialization: None,
    },
    DebugAdapterClose => "debug/adapter/close" {
        params: DebugAdapterCloseParams,
        response: (),
        serialization: None,
    },
}

/// Returns the canonical protocol metadata for an exact client method name.
pub fn client_method_definition(method: &str) -> Option<&'static ClientMethodDefinition> {
    CLIENT_METHODS
        .iter()
        .find(|definition| definition.method == method)
}

macro_rules! host_methods {
    (
        $(
            $variant:ident => $method:literal {
                params: $params:ty,
                response: $response:ty,
            }
        ),+ $(,)?
    ) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum HostMethod {
            $($variant,)+
        }

        impl HostMethod {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $method,)+
                }
            }
        }

        pub fn host_method(method: &str) -> Option<HostMethod> {
            match method {
                $($method => Some(HostMethod::$variant),)+
                _ => None,
            }
        }

        pub const HOST_METHODS: &[HostMethodDefinition] = &[
            $(
                HostMethodDefinition {
                    kind: HostMethod::$variant,
                    method: $method,
                    #[cfg(any(test, feature = "export"))]
                    params_type: <$params as TS>::name,
                    #[cfg(any(test, feature = "export"))]
                    result_type: <$response as TS>::name,
                },
            )+
        ];

        method_schema_type!(HostRequestSchema, "params", { $($method => $params,)+ });
        method_schema_type!(HostResultSchema, "result", { $($method => Box<$response>,)+ });
    };
}

host_methods! {
    BrowserCreate => "browser/create" {
        params: BrowserCreateParams,
        response: BrowserCreateResult,
    },
    BrowserObserve => "browser/observe" {
        params: BrowserObserveParams,
        response: BrowserObserveResult,
    },
    BrowserPerform => "browser/perform" {
        params: BrowserPerformParams,
        response: BrowserPerformResult,
    },
    BrowserClose => "browser/close" {
        params: BrowserCloseParams,
        response: (),
    },
}

macro_rules! server_notifications {
    (
        $(
            $variant:ident => $method:literal {
                params: $params:ty,
                $(storage: $storage:ident,)?
            }
        ),+ $(,)?
    ) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum ServerNotificationMethod {
            $($variant,)+
        }

        impl ServerNotificationMethod {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $method,)+
                }
            }
        }

        pub fn server_notification_method(method: &str) -> Option<ServerNotificationMethod> {
            match method {
                $($method => Some(ServerNotificationMethod::$variant),)+
                _ => None,
            }
        }

        /// A typed App Server notification decoded from the external wire contract.
        ///
        /// Consumers should project only the capabilities they own and retain a fallback arm.
        /// Adding a protocol notification is intentionally exhaustive only inside this crate.
        #[non_exhaustive]
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub enum ServerNotification {
            $(
                $variant(notification_storage_type!($params $(, $storage)?)),
            )+
            Unknown {
                method: String,
                params: serde_json::Value,
            },
        }

        /// Decodes one registered notification payload while preserving unknown methods.
        pub fn decode_server_notification(
            method: String,
            params: serde_json::Value,
        ) -> Result<ServerNotification, serde_json::Error> {
            match server_notification_method(&method) {
                $(
                    Some(ServerNotificationMethod::$variant) => {
                        serde_json::from_value::<$params>(params).map(|payload| {
                            ServerNotification::$variant(notification_storage!(
                                payload $(, $storage)?
                            ))
                        })
                    }
                )+
                None => Ok(ServerNotification::Unknown { method, params }),
            }
        }

        pub const SERVER_NOTIFICATIONS: &[ServerNotificationDefinition] = &[
            $(
                ServerNotificationDefinition {
                    kind: ServerNotificationMethod::$variant,
                    method: $method,
                    #[cfg(any(test, feature = "export"))]
                    params_type: <$params as TS>::name,
                },
            )+
        ];

        method_schema_type!(ServerNotificationSchema, "params", { $($method => $params,)+ });
    };
}

macro_rules! notification_storage_type {
    ($params:ty) => {
        $params
    };
    ($params:ty, boxed) => {
        Box<$params>
    };
}

macro_rules! notification_storage {
    ($payload:expr) => {
        $payload
    };
    ($payload:expr, boxed) => {
        Box::new($payload)
    };
}

server_notifications! {
    AccountLoginCompleted => "account/login/completed" {
        params: AccountLoginCompleted,
    },
    AccountUpdated => "account/updated" {
        params: AccountUpdated,
    },
    AgentRequest => "agent/request" {
        params: AgentRequestEnvelope,
    },
    SessionChanged => "session/changed" {
        params: SessionChanged,
    },
    SessionDeleted => "session/deleted" {
        params: SessionDeleted,
    },
    CallChanged => "call/changed" { params: CallStatus, },
    DocumentCollaborationUpdate => "document/collaboration/update" {
        params: DocumentCollaborationUpdate,
    },
    DocumentCollaborationPresence => "document/collaboration/presence" {
        params: DocumentCollaborationPresenceSnapshot,
    },
    SessionThreadUpdate => "session/thread/update" {
        params: ThreadUpdateEnvelope,
        storage: boxed,
    },
    SessionThreadTranscriptUpdate => "session/thread/transcript/update" {
        params: ThreadTranscriptUpdateEnvelope,
    },
    ThreadGoalUpdated => "thread/goal/updated" {
        params: ThreadGoalUpdatedNotification,
    },
    ThreadGoalCleared => "thread/goal/cleared" {
        params: ThreadGoalClearedNotification,
    },
    ConfigChanged => "config/changed" {
        params: ConfigChanged,
    },
    ConnectorsChanged => "connector/changed" {
        params: ConnectorsChanged,
    },
    PluginsChanged => "plugin/changed" {
        params: PluginsChanged,
    },
    MarketplaceChanged => "marketplace/changed" {
        params: MarketplaceChanged,
    },
    SkillsChanged => "skills/changed" {
        params: SkillsChanged,
    },
    ExtensionHostChanged => "extensionHost/changed" {
        params: ExtensionHostChanged,
    },
    GitStatusChanged => "git/statusChanged" {
        params: GitStatusChanged,
    },
    TurnChangesChanged => "turnChanges/changed" {
        params: TurnChangesChanged,
    },
    ProjectChanged => "project/changed" {
        params: ProjectChanged,
    },
    MemoryChanged => "memory/changed" {
        params: MemoryChanged,
    },
    QueueChanged => "queue/changed" { params: EmptyParams, },
    AutomationChanged => "automation/changed" {
        params: EmptyParams,
    },
    FsChanged => "fs/changed" {
        params: FsChanged,
    },
    LanguageDirectoryDiagnostics => "language/diagnostics" {
        params: LanguageDiagnosticsNotification,
    },
    LanguageServerMessage => "language/serverMessage" {
        params: LanguageServerMessageNotification,
    },
    LanguageServerProgress => "language/serverProgress" {
        params: LanguageServerProgressNotification,
    },
    LanguageServerState => "language/serverState" {
        params: LanguageServerStateNotification,
    },
}

macro_rules! typescript_bindings {
    ($($type:ty),+ $(,)?) => {
#[cfg(any(test, feature = "export"))]
        pub(crate) const TYPESCRIPT_BINDINGS: &[TypeScriptBinding] = &[
            $(
                TypeScriptBinding {
                    declaration: <$type as TS>::decl,
                    dependencies: <$type as TS>::dependencies,
                    identifier: <$type as TS>::ident,
                },
            )+
        ];
    };
}

typescript_bindings! {
    ash_protocol::AgentConfiguration,
    ash_protocol::AgentRoleSelection,
    ash_protocol::InstructionText,
    ash_protocol::ModelInstructionSelection,
    crate::protocol::issues::IssueConfigDto,
    crate::protocol::issues::IssueConfigureParams,
    crate::protocol::issues::IssueRepository,
    crate::protocol::issues::IssueSummary,
    crate::protocol::issues::IssueState,
    crate::protocol::issues::IssueListMode,
    crate::protocol::issues::IssueListParams,
    crate::protocol::issues::IssueListResult,
    crate::protocol::issues::IssueReadParams,
    crate::protocol::issues::IssueReadResult,
    crate::protocol::issues::IssueComment,
    AccountDto,
    AccountLoginCancelParams,
    AccountLoginCancelResult,
    AccountLoginCancelStatusDto,
    AccountLoginCompleted,
    AccountLoginCompletionStatusDto,
    AccountLoginFailureDto,
    AccountLoginMethodDto,
    AccountLoginStartParams,
    AccountLoginStartResult,
    AccountLogoutResult,
    AccountLogoutParams,
    AccountLogoutStatusDto,
    AccountReadResult,
    AccountRateLimitsReadParams,
    AccountRateLimitsReadResult,
    AccountXaiUsageDto,
    AccountRateLimitDto,
    AccountRateLimitWindowDto,
    AccountCreditBalanceDto,
    AccountStatusDto,
    AccountUpdated,
    ThreadId,
    SessionId,
    CommandId,
    RequestId,
    StreamInstanceId,
    ItemId,
    ToolCallId,
    ToolName,
    DirId,
    EnvId,
    ProjectId,
    ConnectorAccountDto,
    ConnectorAvailableActionDto,
    ConnectorOAuthMethodDto,
    ConnectorConnectionStateDto,
    ConnectorDto,
    ConnectorListResult,
    ConnectorSecretDto,
    ConnectorApiTokenConnectParams,
    ConnectorOAuthStartParams,
    ConnectorOAuthStartResult,
    ConnectorOAuthCompleteParams,
    ConnectorOAuthCancelParams,
    ConnectorDeviceOAuthStartParams,
    ConnectorDeviceOAuthStartResult,
    ConnectorDeviceOAuthPollParams,
    ConnectorDeviceOAuthPollResult,
    ConnectorOAuthRefreshParams,
    ConnectorDisconnectParams,
    ConnectorCommandDispositionDto,
    ConnectorCommandResultDto,
    ConnectorCredentialCleanupDto,
    ConnectorCredentialCleanupParams,
    ConnectorDisconnectResultDto,
    ConnectorsChanged,
    McpSecretDto,
    McpOAuthStartParams,
    McpOAuthStartResult,
    McpOAuthCompleteParams,
    McpOAuthMutationParams,
    McpOAuthMutationResult,
    McpServerRuntimeIntentDto,
    McpServerRuntimeIntentParams,
    McpServerRuntimeIntentResult,
    McpServerRuntimeStateDto,
    McpServerStatusDto,
    McpServerStatusResult,
    MarketplacePackageRefDto,
    MarketplaceArtifactHandleDto,
    MarketplaceCapabilityRefDto,
    MarketplaceResourceRefDto,
    MarketplaceCapabilityKindDto,
    MarketplaceCapabilityDescriptorDto,
    MarketplaceAvailableCapabilityDto,
    MarketplacePackageSummaryDto,
    MarketplaceSearchParams,
    MarketplaceSearchResult,
    MarketplaceGetParams,
    MarketplacePackageDetailsDto,
    MarketplacePackageSourceDto,
    MarketplaceUpstreamRegistryDto,
    MarketplaceUpstreamReferenceDto,
    MarketplaceDownloadParams,
    MarketplaceInstallParams,
    MarketplaceUpdateParams,
    MarketplaceInstallationStateDto,
    MarketplaceInstalledPackageDto,
    MarketplaceListInstalledResult,
    MarketplaceChanged,
    MarketplaceUninstallModeDto,
    MarketplaceUninstallParams,
    MarketplaceAcquireCapabilityParams,
    MarketplaceCapabilityLeaseDto,
    MarketplaceActivationSpecDto,
    MarketplaceSkillActivationSpecDto,
    MarketplaceThemeActivationSpecDto,
    MarketplaceMcpActivationSpecDto,
    MarketplaceMcpTransportDto,
    MarketplaceConnectorActivationSpecDto,
    MarketplaceLanguageActivationSpecDto,
    MarketplaceLocalizationActivationSpecDto,
    MarketplaceExecutableRuntimeDto,
    MarketplaceExecutableActivationSpecDto,
    MarketplaceAcquiredCapabilityDto,
    MarketplaceReleaseCapabilityParams,
    MarketplaceOpenResourceParams,
    MarketplaceResourceContentDto,
    PluginPackageDto,
    PluginListResult,
    PluginPackageCommandParams,
    PluginCommandDispositionDto,
    PluginCommandResultDto,
    PluginsChanged,
    TurnId,
    DelegationId,
    AgentJoinId,
    AgentMessageId,
    SchemaHash,
    ClientInfo,
    AgentInteractionCapability,
    BrowserCapability,
    DirPermissionsHostCapability,
    BrowserBinaryPayload,
    BrowserCloseParams,
    BrowserCreateParams,
    BrowserCreateResult,
    BrowserElementTargetDto,
    BrowserObserveParams,
    BrowserObserveResult,
    BrowserPerformActionDto,
    BrowserPerformParams,
    BrowserPerformResult,
    BrowserTextInputTargetDto,
    ClientCapabilities,
    ServerInfo,
    CallStartParams,
    CallResourceParams,
    CallControlParams,
    CallInviteParams,
    CallEndParams,
    CallInvitation,
    CallMemberParams,
    CallRoleParams,
    CallStatus,
    CallScreenSource,
    CallScreenSources,
    CallScreenFrame,
    CallScreenFrames,
    ScreenTarget,
    CallDeployment,
    CallConnection,
    CallControl,
    CallParticipant,
    CallRole,
    CallSnapshot,
    CallMember,
    MediaState,
    DocumentCollaborationOpenParams,
    DocumentCollaborationSnapshot,
    DocumentCollaborationOpenResult,
    DocumentCollaborationPresence,
    DocumentCollaborationPresenceParams,
    DocumentCollaborationPresenceReadParams,
    DocumentCollaborationPresenceSnapshot,
    DocumentCollaborationUpdate,
    DocumentCollaborationSubmitParams,
    DocumentCollaborationSubmitResult,
    ModelRefDto,
    CodebaseModelsDto,
    CodebaseAutomaticContextDto,
    CodebaseConfigDto,
    ApprovalReviewModelSelectionDto,
    GrepBackendDto,
    GitAutoFetchModeDto,
    GitConfigDto,
    ModelContextConfigDto,
    CustomProviderConfigDto,
    CustomProviderProtocolDto,
    ProviderConfigDto,
    McpCredentialBindingDto,
    McpServerEnablementDto,
    McpTransportDto,
    McpServerConfigDto,
    SkillSourceEnablementDto,
    SkillSourceConfigDto,
    PluginRequestEnablementDto,
    PluginRequestDto,
    HookEventDto,
    HookEnablementDto,
    HookMatcherDto,
    HookActionDto,
    HookConfigDto,
    LanguageServerModeDto,
    LanguageServerConfigDto,
    FrontendConfigDto,
    ConfigReadResult,
    TimeContextConfigDto,
    TimeContext,
    TimeContextMode,
    TimeZoneOrigin,
    ConfigChanged,
    ConfigCommandDispositionDto,
    ConfigCommandResult,
    ConfigUpdateParams,
    ExecPolicyActionKindDto,
    ExecPolicyTokenDto,
    ExecPolicyHostMatcherDto,
    ExecPolicyScopeMatcherDto,
    ExecPolicySelectorDto,
    ExecPolicyEffectDto,
    ExecPolicyRuleDto,
    ExecPolicyRuleUpsertParams,
    ExecPolicyRuleRemoveParams,
    ToolSearchModeDto,
    ToolSearchEmbeddingStatusDto,
    ToolSearchConfigDto,
    ToolSearchConfigureParams,
    CodebaseConfigureParams,
    CommitMessageAuthorizeParams,
    CommitMessageRevokeParams,
    LanguageServerConfigureParams,
    LanguageServerRemoveParams,
    ProviderConfigureParams,
    ProviderRemoveParams,
    McpServerUpsertParams,
    McpServerRemoveParams,
    McpServerSetEnablementParams,
    SkillSourceAddParams,
    SkillSourceRemoveParams,
    SkillSourceSetEnablementParams,
    PluginRequestUpsertParams,
    PluginRequestRemoveParams,
    PluginRequestSetEnablementParams,
    HookUpsertParams,
    HookRemoveParams,
    HookSetEnablementParams,
    SkillName,
    SkillSourceId,
    SkillId,
    ContentDigest,
    DelegatedTask,
    AgentDefinitionSelectionReason,
    FrozenAgentDefinitionRef,
    AgentRoleSource,
    AgentRoleSnapshot,
    AgentTreeExecutionStatus,
    AgentTreeWaitingReason,
    AgentTreeNodeProjection,
    AgentTreeProjection,
    AgentContextSource,
    AgentContextContent,
    AgentMaterializedContext,
    ForkedAgentContext,
    AgentContextMode,
    DelegatedPolicyCeiling,
    AgentCapabilityScope,
    ContextSeedDigest,
    AgentContextSeed,
    ThreadSequenceRange,
    DelegationResultStatus,
    DelegationArtifactRef,
    DelegationResultDigest,
    DelegationResult,
    AgentMessageProvenance,
    AgentMessageContent,
    AgentMessage,
    AgentJoinPolicy,
    AgentJoinStatus,
    AgentJoin,
    SkillVersionSelector,
    SkillRef,
    SkillActivationReason,
    FrozenSkillActivation,
    SkillCatalogReloadDto,
    SkillEnablementDto,
    SkillSourceKindDto,
    SkillCompatibilityDto,
    SkillDto,
    SkillDiagnosticCodeDto,
    SkillDiagnosticDto,
    InstructionImportPreviewParams,
    InstructionImportPreviewResult,
    InstructionImportParams,
    InstructionImportResult,
    InstructionImportItem,
    InstructionImportStatus,
    InstructionImportSource,
    InstructionListParams,
    InstructionListResult,
    InstructionDto,
    InstructionDiagnosticDto,
    InstructionScopeDto,
    InstructionLoadDto,
    SkillListParams,
    SkillListResult,
    SkillResourceKindDto,
    SkillResourceOpenParams,
    SkillResourceOpenResult,
    SkillSetEnablementParams,
    SkillsChanged,
    ExtensionCatalogReloadDto,
    ExtensionSourceKindDto,
    ExtensionDiagnosticCodeDto,
    ExtensionDto,
    ExtensionDiagnosticDto,
    ExtensionListParams,
    ExtensionListResult,
    ExtensionResourceOpenParams,
    ExtensionResourceOpenResult,
    ExtensionHostReconcileModeDto,
    ExtensionHostReconcileParams,
    ExtensionHostSnapshotDto,
    ExtensionHostExtensionDto,
    ExtensionHostLifecycleDto,
    ExtensionHostOutputEventDto,
    ExtensionHostOutputOperationDto,
    ExtensionHostOutputChannelKindDto,
    ExtensionHostOutputSeverityDto,
    ExtensionHostFailureCodeDto,
    ExtensionHostFailureDto,
    ExtensionHostRegistrationDescriptorDto,
    ExtensionHostRegistrationKindDto,
    ExtensionHostLanguageProviderOperationDto,
    ExtensionHostInvokeStartParams,
    ExtensionHostInvokeStartResult,
    ExtensionHostInvokeReadParams,
    ExtensionHostInvokeReadResult,
    ExtensionHostInvokeCancelParams,
    ExtensionHostInvokeCancelResult,
    ExtensionHostInvokeCancelDispositionDto,
    ExtensionHostCancellationReasonDto,
    ExtensionHostChanged,
    SlashCommandArgumentModeDto,
    SlashCommandDefinition,
    ProtocolVersion,
    CapabilityContract,
    ServerCapabilities,
    InitializeParams,
    InitializeResult,
    EnvCwdSetParams,
    EnvCwdSetResult,
    DirGrantDto,
    EnvDirDto,
    EnvDirSetEntry,
    EnvDirsSetParams,
    EnvDirsSetResult,
    SessionDirSelector,
    SessionDirDto,
    DirContributionsDto,
    SessionDirListParams,
    SessionDirListResult,
    SessionDirAddParams,
    SessionDirRemoveParams,
    SessionDirMutationDto,
    SessionDirAddResult,
    SessionDirMutationResult,
    PermissionDto,
    SessionDirPermissionsSetParams,
    DirPermissionsReadParams,
    DirPermissionsReadResult,
    DirPermissionsEntryDto,
    DirPermissionsListResult,
    DirPermissionsSetParams,
    DirPermissionsForgetParams,
    SessionStatus,
    SessionManagerStatus,
    SessionManagerActivity,
    SessionManagerInfo,
    ThreadOrigin,
    SessionThread,
    Session,
    ApprovalMode,
    SessionCreateParams,
    SessionReadParams,
    MessageCheckpointsParams,
    MessageCheckpointsResult,
    MessageCheckpoint,
    MessageBoundary,
    WorkspaceCheckpoint,
    RepositoryCheckpoint,
    HistoryPrefixRef,
    AgentId,
    AgentReadParams,
    AgentReadResult,
    AgentThread,
    SessionSubscribeParams,
    SessionUnsubscribeParams,
    SessionChanged,
    SessionCatalogReadResult,
    SessionDeleted,
    SessionRequest,
    SessionRequestParams,
    SessionRequestResult,
    AdvisorConfig,
    AdvisorSelection,
    AdvisorConfigureResult,
    SessionThreadReadParams,
    SessionThreadReadResult,
    SessionThreadSubscribeParams,
    SessionThreadSubscribeResult,
    SessionThreadUnsubscribeParams,
    SessionResult,
    SessionListResult,
    SessionSubscribeResult,
    SessionThreadProjection,
    SessionThreadResult,
    SessionRewriteResult,
    ThreadGoalStatus,
    ThreadGoal,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalUpdatedNotification,
    ThreadGoalClearedNotification,
    ThreadSnapshotHistory,
    ThreadHistoryBoundary,
    CapabilitySupport,
    ModelAccess,
    ModelOutputTransport,
    ModelCapabilities,
    ReasoningEffort,
    ReasoningState,
    Personality,
    ModelCatalogEntry,
    ModelListResult,
    ProviderApiKeyDto,
    ProviderApiKeyPolicyDto,
    ProviderApiKeySetParams,
    ProviderApiKeySetResult,
    ProviderProbeParams,
    ProviderProbeResult,
    ProviderModelsListParams,
    ProviderModelsListFailureCodeDto,
    ProviderModelsListFailureDto,
    ProviderModelsListResult,
    ProviderCatalogEntryDto,
    ProviderListResult,
    StableTurnErrorCode,
    StableTurnError,
    ThreadStatus,
    ThreadArchiveReason,
    TurnStatus,
    ActionApprovalCapabilityKind,
    ActionApprovalCapability,
    ActionApprovalRequest,
    ActionApprovalDecision,
    ActionApprovalResponse,
    AgentInteractionKind,
    AgentRequest,
    AgentRequestEnvelope,
    AgentResponse,
    TurnInteraction,
    PendingInteraction,
    InteractionDeadline,
    InteractionCancelReason,
    RequestUserInput,
    RequestUserInputResponse,
    UserInputQuestion,
    UserInputOption,
    UserInputAnswer,
    DynamicToolCall,
    DynamicToolResponse,
    DynamicToolOutput,
    ThreadItem,
    ToolCallBinding,
    ToolSourceProvenance,
    ToolCallCaller,
    ContentPart,
    ImageAttachmentRef,
    AttachmentRef,
    AudioAttachmentRef,
    AudioMediaType,
    ImageMediaType,
    ImageDetail,
    ModelContextUsageSource,
    ModelContextUsage,
    ModelInputEstimate,
    ModelUsage,
    ModelUsageTotal,
    ModelUsageSummary,
    ModelBillingEvidence,
    ModelBillingRecord,
    ModelBillingScope,
    ModelCostLineItem,
    ModelId,
    ModelInvocationId,
    ModelInvocationOutcome,
    ModelInvocationRecord,
    ModelMoneyAmount,
    ModelReferenceCostReason,
    ModelReferenceCostRecord,
    ModelReferenceCostSummary,
    RatedModelCost,
    ToolMode,
    ToolProfileSnapshot,
    ReviewTarget,
    TurnKind,
    TurnInstructions,
    Turn,
    Thread,
    ToolExecutionAuthority,
    ToolOutputStream,
    ProcessExitStatus,
    ProcessExecutionOutput,
    ToolReplaySafety,
    SandboxDenialOutput,
    ContextCheckpointId,
    ContextSourceRange,
    ContextSourceDigest,
    ContextCheckpointVerification,
    ContextCheckpoint,
    TurnExecutionBinding,
    ThreadEvent,
    PlanStepStatus,
    PlanStep,
    PlanUpdate,
    StreamCursor,
    ItemDelta,
    ThreadUpdate,
    ThreadUpdateEnvelope,
    ThreadTranscriptEntry,
    ThreadTranscriptSnapshot,
    ThreadTranscriptChange,
    ThreadTranscriptUpdateEnvelope,
    InputItem,
    TurnStartResult,
    TurnSteerResult,
    TurnInterruptResult,
    TurnInteractionResolveResult,
    ChangeSetId,
    TurnChangeCaptureStateDto,
    TurnChangeMessageStateDto,
    TurnChangeCommitStateDto,
    TurnChangeTerminalStateDto,
    TurnChangeFileKindDto,
    TurnChangeFileDto,
    TurnChangeFileStatisticsDto,
    ThreadDirBinding,
    ThreadWorktreeRepositoryBindingDto,
    TurnChangeSetSummary,
    TurnChangesListParams,
    TurnChangesListResult,
    TurnChangesReadParams,
    TurnChangesReadResult,
    TurnChangesReadFileParams,
    TurnChangesReadFileResult,
    TurnChangesMutationParams,
    TurnChangesUpdateDraftParams,
    TurnChangesCommitParams,
    TurnChangesDiscardThreadParams,
    TurnChangesMutationResult,
    TurnChangesChanged,
    ProjectStatusDto,
    UnixMillis,
    Automation,
    AutomationDefinition,
    AutomationSchedule,
    AutomationSession,
    AutomationStatus,
    AutomationRun,
    AutomationRunStatus,
    ExtensionItemsParams,
    ExtensionItemsResult,
    ExtensionItem,
    ExtensionItemStatus,
    ExtensionItemContent,
    SearchSource,
    QueueEditParams,
    QueueEditAction,
    QueueMove,
    QueueEnqueueParams,
    QueueListParams,
    QueueCancelParams,
    QueueListResult,
    QueueInput,
    UserInput,
    QueuedMessage,
    QueueStatus,
    FeedbackPrepareParams,
    FeedbackUploadParams,
    DiagnosticSnapshot,
    AuthHeader,
    AuthRecovery,
    DiagnosticOutcome,
    RequestAttempt,
    RequestOutcome,
    ResponseDebugContext,
    ResponseDiagnostic,
    ResponseOperation,
    Activity,
    ActivitySummary,
    Observation,
    Outcome,
    UsageSnapshot,
    UsageEvent,
    PreparedFeedback,
    BuildInfo,
    Feature,
    FeatureState,
    FeatureStage,
    FeatureSource,
    MemoryDiagnosticsSessionParams,
    MemoryAddParams,
    MemoryUpdateParams,
    MemoryScopesParams,
    MemoryScopesResult,
    MemoryScopeDescriptor,
    MemoryCitationReadParams,
    MemoryPolicyReadParams,
    MemoryPolicyUpdateParams,
    memories::MemoryCitation,
    memories::MemoryCitationResult,
    memories::MemoryReadMode,
    memories::MemoryWriteMode,
    memories::MemoryPolicy,
    memories::MemoryPolicyMutationResult,
    MemoryListParams,
    MemoryReadParams,
    MemorySearchParams,
    MemoryDeleteParams,
    MemoryChanged,
    memories::MemoryId,
    memories::MemoryScope,
    memories::MemorySource,
    memories::Memory,
    memories::MemorySummary,
    memories::MemoryListPage,
    memories::MemorySearchMatch,
    memories::MemorySearchPage,
    memories::MemoryMutationDisposition,
    memories::MemoryMutationResult,
    memories::MemoryDeleteResult,
    MemoryProduct,
    MemoryStart,
    MemoryRole,
    MemoryOrigin,
    MemoryPhase,
    MemoryMetricKind,
    MemoryUnavailable,
    MemoryMetric,
    MemoryObservation,
    MemoryEvidence,
    MemoryStatus,
    MemoryFinding,
    MemorySample,
    MemoryTrend,
    MemoryTargetReport,
    MemoryReport,
    AutomationListResult,
    AutomationWriteParams,
    AutomationDeleteParams,
    AutomationRunParams,
    AutomationRunsParams,
    AutomationRunsResult,
    AutomationStopParams,
    ProjectRootDto,
    ProjectDto,
    ProjectSummaryDto,
    ProjectListParams,
    ProjectListResult,
    ProjectReadParams,
    ProjectReadResult,
    ProjectCreateParams,
    ProjectDetailsUpdateParams,
    ProjectRootAddParams,
    ProjectRootUpdateParams,
    ProjectRootRemoveParams,
    ProjectSessionMutationParams,
    ProjectLifecycleParams,
    ProjectCommandDispositionDto,
    ProjectMutationResult,
    ProjectChanged,
    TypstCompileParams,
    TypstCompileResult,
    TypstDiagnosticDto,
    TypstDiagnosticSeverityDto,
    TypstSourceRangeDto,
    ResourceMetadataParams,
    ResourceMetadataResult,
    ResourceReadParams,
    ResourceReadResult,
    ResourceReleaseParams,
    AttachmentUploadStartParams,
    AttachmentUploadStartResult,
    AttachmentUploadWriteParams,
    AttachmentUploadWriteResult,
    AttachmentUploadFinishParams,
    AttachmentUploadCancelParams,
    AttachmentImportRemoteParams,
    AttachmentMaterializeResult,
    FsFileType,
    FsGetMetadataParams,
    FsGetMetadataResult,
    FsReadDirectoryParams,
    FsReadDirectoryEntry,
    FsReadDirectoryResult,
    FsReadBinaryFileParams,
    FsReadBinaryFileResult,
    FsReadFileParams,
    FsReadFileResult,
    DiffComputeParams,
    DiffRowKindDto,
    DiffRangeDto,
    DiffComputeRowDto,
    DiffHunkDto,
    DiffComputeResult,
    SyntaxLanguageDto,
    SyntaxOpenParams,
    SyntaxEditDto,
    SyntaxUpdateParams,
    SyntaxPositionDto,
    SyntaxRangeDto,
    SyntaxTokenKindDto,
    SyntaxTokenDto,
    SyntaxFoldingRangeDto,
    SyntaxSelectionRangeDto,
    SyntaxSelectionRangesParams,
    SyntaxSelectionRangesResult,
    SyntaxSymbolKindDto,
    SyntaxSymbolDto,
    SyntaxDiagnosticKindDto,
    SyntaxDiagnosticDto,
    SyntaxAnalyzeParams,
    SyntaxCloseParams,
    SyntaxAnalyzeResult,
    LanguageLocationKindDto,
    LanguagePositionDto,
    LanguageRangeDto,
    LanguageDocumentDto,
    LanguageServersParams,
    LanguageServersResult,
    LanguageServerDescriptorDto,
    LanguageSynchronizeParams,
    LanguageCloseParams,
    LanguageOperationParams<()>,
    LanguageCancelParams,
    LanguageCancelStatusDto,
    LanguageCancelResult,
    LanguageHoverParams,
    LanguageHoverResult,
    LanguageCompletionTriggerKindDto,
    LanguageCompletionsParams,
    LanguageCompletionItemKindDto,
    LanguageCompletionInsertTextFormatDto,
    LanguageCompletionItemDto,
    LanguageResolveCompletionParams,
    LanguageCompletionDetailsResult,
    LanguageExecuteCommandParams,
    LanguageCompletionsResult,
    LanguageDocumentDiagnosticsParams,
    LanguageDiagnosticReportKindDto,
    LanguageDocumentDiagnosticsResult,
    LanguageDirectoryDiagnosticsParams,
    LanguageDirectoryDiagnosticSnapshotDto,
    LanguageDirectoryDiagnosticsResult,
    LanguageFormattingOptionsDto,
    LanguageDocumentFormattingParams,
    LanguageRangeFormattingParams,
    LanguageFormattingResult,
    LanguageSignatureHelpTriggerKindDto,
    LanguageSignatureHelpParams,
    LanguageParameterInformationDto,
    LanguageSignatureInformationDto,
    LanguageSignatureHelpResult,
    LanguageInlayHintsParams,
    LanguageInlayHintKindDto,
    LanguageInlayHintDto,
    LanguageInlayHintsResult,
    LanguageLinkedEditingRangesParams,
    LanguageLinkedEditingRangesResult,
    LanguageSemanticTokensParams,
    LanguageSemanticTokenDto,
    LanguageSemanticTokensResult,
    LanguageDocumentFeaturesParams,
    LanguageDocumentSymbolDto,
    LanguageDocumentSymbolsResult,
    LanguageCommandDto,
    LanguageCodeLensDto,
    LanguageCodeLensesResult,
    LanguageResolveCodeLensParams,
    LanguageDocumentLinkDto,
    LanguageDocumentLinksResult,
    LanguageResolveDocumentLinkParams,
    LanguageColorDto,
    LanguageDocumentColorDto,
    LanguageDocumentColorsResult,
    LanguageColorPresentationsParams,
    LanguageColorPresentationDto,
    LanguageColorPresentationsResult,
    LanguageFoldingRangeKindDto,
    LanguageFoldingRangeDto,
    LanguageFoldingRangesResult,
    LanguageLocationsParams,
    LanguageLocationDto,
    LanguageLocationsResult,
    LanguageHierarchyKindDto,
    LanguageHierarchyItemDto,
    LanguageHierarchyParams,
    LanguageHierarchyEntryDto,
    LanguageHierarchyResultDto,
    LanguageDirectorySymbolsParams,
    LanguageDirectorySymbolDto,
    LanguageDirectorySymbolsResult,
    LanguagePrepareRenameParams,
    LanguageRenamePreparationDto,
    LanguagePrepareRenameResult,
    LanguageRenameParams,
    LanguageTextEditDto,
    LanguageTextDocumentEditDto,
    LanguageDirectoryEditDto,
    LanguageDirectoryEditEntryDto,
    LanguageDiagnosticSeverityDto,
    LanguageCodeActionDiagnosticDto,
    LanguageDiagnosticsNotification,
    LanguageServerMessageSeverityDto,
    LanguageServerMessageSourceDto,
    LanguageServerMessageNotification,
    LanguageServerProgressNotification,
    LanguageServerStateDto,
    LanguageServerStateNotification,
    LanguageCodeActionsParams,
    LanguageCodeActionDto,
    LanguageCodeActionsResult,
    LanguageResolveCodeActionParams,
    FsWriteFileParams,
    FsWriteFileResult,
    FsExistingTargetBehavior,
    FsMissingTargetBehavior,
    FsDeleteMode,
    FsCreateFileParams,
    FsRenameParams,
    FsDeleteParams,
    FsChanged,
    GitChangeStatusDto,
    GitUpstreamDto,
    GitHeadDto,
    GitSubmoduleStateDto,
    GitRepositoryParams,
    GitFetchModeDto,
    GitFetchParams,
    GitRepositoryDto,
    GitRepositoriesResult,
    GitRepositoryChangeDto,
    GitStatusResult,
    GitStatusChanged,
    GitBranchDto,
    GitBranchListResult,
    GitCommitSummaryDto,
    GitHistoryResult,
    GitRemoteProviderDto,
    GitRepositoryIdentityDto,
    GitRemoteDto,
    GitReferenceKindDto,
    GitReferenceDto,
    GitGraphParams,
    GitGraphResult,
    GitCommitChangesParams,
    GitCommitChangeDto,
    GitCommitChangesResult,
    GitCommitFileParams,
    GitCommitFileContentDto,
    GitCommitFileResult,
    GitChangeFileComparisonDto,
    GitChangeFileParams,
    GitChangeFileResult,
    GitBranchSwitchParams,
    GitTextDiffDto,
    GitDiffStatisticsDto,
    GitTextDiffResult,
    GitPathsParams,
    GitCommitParams,
    GitOperationResult,
    GitCommitResult,
    ContentSearchPatternKind,
    ContentSearchCaseSensitivity,
    ContentSearchFreshness,
    ContentSearchStartParams,
    ContentSearchStartResult,
    ContentSearchReadParams,
    ContentSearchMatchRange,
    ContentSearchMatch,
    ContentSearchReadResult,
    ContentSearchCancelParams,
    CodebaseStateDto,
    CodebaseStatusResult,
    GrepIndexStatusResult,
    GrepIndexDisableAndDeleteParams,
    GrepIndexDisableAndDeleteResult,
    LocalIndexClearOutcomeDto,
    CodebaseSearchParams,
    CodebaseChunkSpanDto,
    CodebaseSearchHitDto,
    CodebaseSearchResult,
    CodebaseSymbolsStateDto,
    CodebaseSymbolsStatusResult,
    CodebaseSymbolsSearchParams,
    SymbolKindDto,
    CodebaseSymbolsSearchHitDto,
    CodebaseSymbolsSearchResult,
    DocumentOverlaySynchronizeParams,
    DocumentOverlayCloseParams,
    DocumentOverlayStatusResult,
    CodebaseRetrievalParams,
    CodebaseRetrievalDegradationDto,
    CodebaseRetrievalHitDto,
    CodebaseRetrievalResult,
    CodebaseDeploymentModeDto,
    CloudCodebaseStateDto,
    CloudCodebaseSelectionDto,
    CloudCodebaseDestinationDto,
    CloudCodebaseGrantDto,
    CloudCodebasePreviewParams,
    CloudCodebasePreviewResult,
    CloudCodebaseAuthorizeParams,
    CloudCodebaseStatusResult,
    TerminalProfile,
    TerminalProfileListResult,
    TerminalProfileSelection,
    TerminalLifecycle,
    TerminalCreateParams,
    TerminalCreateInSessionDirectoryParams,
    TerminalCreateResult,
    TerminalReconnectLease,
    TerminalAttachParams,
    TerminalAttachResult,
    TerminalWriteParams,
    TerminalResizeParams,
    TerminalReadParams,
    TerminalOutputChunk,
    TerminalCommandStatus,
    TerminalCommandStatusEvent,
    TerminalReadResult,
    TerminalCloseParams,
    DebugAdapterStartParams,
    DebugAdapterStartResult,
    DebugAdapterSendParams,
    DebugAdapterReadParams,
    DebugAdapterMessageDto,
    DebugAdapterReadResult,
    DebugAdapterCloseParams,
    AppServerErrorName,
    AppServerErrorData,
    AppServerError,
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
