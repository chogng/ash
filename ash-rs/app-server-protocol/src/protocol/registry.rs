use crate::protocol::account::AccountDto;
use crate::protocol::account::AccountLoginCancelParams;
use crate::protocol::account::AccountLoginCancelResult;
use crate::protocol::account::AccountLoginCancelStatusDto;
use crate::protocol::account::AccountLoginCompleted;
use crate::protocol::account::AccountLoginCompletionStatusDto;
use crate::protocol::account::AccountLoginFailureDto;
use crate::protocol::account::AccountLoginMethodDto;
use crate::protocol::account::AccountLoginStartParams;
use crate::protocol::account::AccountLoginStartResult;
use crate::protocol::account::AccountLogoutParams;
use crate::protocol::account::AccountLogoutResult;
use crate::protocol::account::AccountLogoutStatusDto;
use crate::protocol::account::AccountReadResult;
use crate::protocol::account::AccountStatusDto;
use crate::protocol::account::AccountUpdated;
use crate::protocol::agent::AgentReadParams;
use crate::protocol::agent::AgentReadResult;
use crate::protocol::agent::AgentThread;
use crate::protocol::attachments::AttachmentImportRemoteParams;
use crate::protocol::attachments::AttachmentMaterializeResult;
use crate::protocol::attachments::AttachmentUploadCancelParams;
use crate::protocol::attachments::AttachmentUploadFinishParams;
use crate::protocol::attachments::AttachmentUploadStartParams;
use crate::protocol::attachments::AttachmentUploadStartResult;
use crate::protocol::attachments::AttachmentUploadWriteParams;
use crate::protocol::attachments::AttachmentUploadWriteResult;
use crate::protocol::automation::AutomationDeleteParams;
use crate::protocol::automation::AutomationListResult;
use crate::protocol::automation::AutomationRunParams;
use crate::protocol::automation::AutomationRunsParams;
use crate::protocol::automation::AutomationRunsResult;
use crate::protocol::automation::AutomationStopParams;
use crate::protocol::automation::AutomationWriteParams;
use crate::protocol::browser::BrowserBinaryPayload;
use crate::protocol::browser::BrowserCloseParams;
use crate::protocol::browser::BrowserCreateParams;
use crate::protocol::browser::BrowserCreateResult;
use crate::protocol::browser::BrowserElementTargetDto;
use crate::protocol::browser::BrowserObserveParams;
use crate::protocol::browser::BrowserObserveResult;
use crate::protocol::browser::BrowserPerformActionDto;
use crate::protocol::browser::BrowserPerformParams;
use crate::protocol::browser::BrowserPerformResult;
use crate::protocol::browser::BrowserTextInputTargetDto;
use crate::protocol::codebase::CloudCodebaseAuthorizeParams;
use crate::protocol::codebase::CloudCodebaseDestinationDto;
use crate::protocol::codebase::CloudCodebaseGrantDto;
use crate::protocol::codebase::CloudCodebasePreviewParams;
use crate::protocol::codebase::CloudCodebasePreviewResult;
use crate::protocol::codebase::CloudCodebaseSelectionDto;
use crate::protocol::codebase::CloudCodebaseStateDto;
use crate::protocol::codebase::CloudCodebaseStatusResult;
use crate::protocol::codebase::CodebaseChunkSpanDto;
use crate::protocol::codebase::CodebaseDeploymentModeDto;
use crate::protocol::codebase::CodebaseRetrievalDegradationDto;
use crate::protocol::codebase::CodebaseRetrievalHitDto;
use crate::protocol::codebase::CodebaseRetrievalParams;
use crate::protocol::codebase::CodebaseRetrievalResult;
use crate::protocol::codebase::CodebaseSearchHitDto;
use crate::protocol::codebase::CodebaseSearchParams;
use crate::protocol::codebase::CodebaseSearchResult;
use crate::protocol::codebase::CodebaseStateDto;
use crate::protocol::codebase::CodebaseStatusResult;
use crate::protocol::codebase::LocalIndexClearOutcomeDto;
use crate::protocol::codebase::TgrepDisableAndDeleteParams;
use crate::protocol::codebase::TgrepDisableAndDeleteResult;
use crate::protocol::codebase::TgrepIndexStatusResult;
use crate::protocol::codebase_symbols::CodebaseSymbolsSearchHitDto;
use crate::protocol::codebase_symbols::CodebaseSymbolsSearchParams;
use crate::protocol::codebase_symbols::CodebaseSymbolsSearchResult;
use crate::protocol::codebase_symbols::CodebaseSymbolsStateDto;
use crate::protocol::codebase_symbols::CodebaseSymbolsStatusResult;
use crate::protocol::codebase_symbols::DocumentOverlayCloseParams;
use crate::protocol::codebase_symbols::DocumentOverlayStatusResult;
use crate::protocol::codebase_symbols::DocumentOverlaySynchronizeParams;
use crate::protocol::codebase_symbols::SymbolKindDto;
use crate::protocol::collaboration::DocumentCollaborationOpenParams;
use crate::protocol::collaboration::DocumentCollaborationOpenResult;
use crate::protocol::collaboration::DocumentCollaborationPresence;
use crate::protocol::collaboration::DocumentCollaborationPresenceParams;
use crate::protocol::collaboration::DocumentCollaborationPresenceReadParams;
use crate::protocol::collaboration::DocumentCollaborationPresenceSnapshot;
use crate::protocol::collaboration::DocumentCollaborationSnapshot;
use crate::protocol::collaboration::DocumentCollaborationSubmitParams;
use crate::protocol::collaboration::DocumentCollaborationSubmitResult;
use crate::protocol::collaboration::DocumentCollaborationUpdate;
use crate::protocol::common::AgentInteractionCapability;
use crate::protocol::common::BrowserCapability;
use crate::protocol::common::ClientCapabilities;
use crate::protocol::common::ClientInfo;
use crate::protocol::common::CommandId;
use crate::protocol::common::DirPermissionsHostCapability;
use crate::protocol::common::EmptyParams;
use crate::protocol::common::ItemId;
use crate::protocol::common::RequestId;
use crate::protocol::common::SchemaHash;
use crate::protocol::common::ServerInfo;
use crate::protocol::common::SessionId;
use crate::protocol::common::StreamInstanceId;
use crate::protocol::common::ThreadId;
use crate::protocol::common::ToolCallId;
use crate::protocol::common::ToolName;
use crate::protocol::common::TurnId;
use crate::protocol::config::AgentGrepBackendDto;
use crate::protocol::config::ApprovalReviewModelSelectionDto;
use crate::protocol::config::CodebaseAutomaticContextDto;
use crate::protocol::config::CodebaseConfigDto;
use crate::protocol::config::CodebaseConfigureParams;
use crate::protocol::config::CodebaseModelsDto;
use crate::protocol::config::CommitMessageAuthorizeParams;
use crate::protocol::config::CommitMessageRevokeParams;
use crate::protocol::config::ConfigChanged;
use crate::protocol::config::ConfigCommandDispositionDto;
use crate::protocol::config::ConfigCommandResult;
use crate::protocol::config::ConfigReadResult;
use crate::protocol::config::ConfigUpdateParams;
use crate::protocol::config::CustomProviderConfigDto;
use crate::protocol::config::CustomProviderProtocolDto;
use crate::protocol::config::ExecPolicyActionKindDto;
use crate::protocol::config::ExecPolicyEffectDto;
use crate::protocol::config::ExecPolicyHostMatcherDto;
use crate::protocol::config::ExecPolicyRuleDto;
use crate::protocol::config::ExecPolicyRuleRemoveParams;
use crate::protocol::config::ExecPolicyRuleUpsertParams;
use crate::protocol::config::ExecPolicyScopeMatcherDto;
use crate::protocol::config::ExecPolicySelectorDto;
use crate::protocol::config::ExecPolicyTokenDto;
use crate::protocol::config::FrontendConfigDto;
use crate::protocol::config::HookActionDto;
use crate::protocol::config::HookConfigDto;
use crate::protocol::config::HookEnablementDto;
use crate::protocol::config::HookEventDto;
use crate::protocol::config::HookMatcherDto;
use crate::protocol::config::HookRemoveParams;
use crate::protocol::config::HookSetEnablementParams;
use crate::protocol::config::HookUpsertParams;
use crate::protocol::config::LanguageServerConfigDto;
use crate::protocol::config::LanguageServerConfigureParams;
use crate::protocol::config::LanguageServerModeDto;
use crate::protocol::config::LanguageServerRemoveParams;
use crate::protocol::config::McpCredentialBindingDto;
use crate::protocol::config::McpServerConfigDto;
use crate::protocol::config::McpServerEnablementDto;
use crate::protocol::config::McpServerRemoveParams;
use crate::protocol::config::McpServerSetEnablementParams;
use crate::protocol::config::McpServerUpsertParams;
use crate::protocol::config::McpTransportDto;
use crate::protocol::config::ModelContextConfigDto;
use crate::protocol::config::ModelRefDto;
use crate::protocol::config::PluginRequestDto;
use crate::protocol::config::PluginRequestEnablementDto;
use crate::protocol::config::PluginRequestRemoveParams;
use crate::protocol::config::PluginRequestSetEnablementParams;
use crate::protocol::config::PluginRequestUpsertParams;
use crate::protocol::config::ProviderConfigDto;
use crate::protocol::config::ProviderConfigureParams;
use crate::protocol::config::ProviderRemoveParams;
use crate::protocol::config::SkillSourceAddParams;
use crate::protocol::config::SkillSourceConfigDto;
use crate::protocol::config::SkillSourceEnablementDto;
use crate::protocol::config::SkillSourceRemoveParams;
use crate::protocol::config::SkillSourceSetEnablementParams;
use crate::protocol::config::TimeContextConfigDto;
use crate::protocol::config::ToolSearchConfigDto;
use crate::protocol::config::ToolSearchConfigureParams;
use crate::protocol::config::ToolSearchEmbeddingStatusDto;
use crate::protocol::config::ToolSearchModeDto;
use crate::protocol::connectors::ConnectorAccountDto;
use crate::protocol::connectors::ConnectorApiTokenConnectParams;
use crate::protocol::connectors::ConnectorAvailableActionDto;
use crate::protocol::connectors::ConnectorCommandDispositionDto;
use crate::protocol::connectors::ConnectorCommandResultDto;
use crate::protocol::connectors::ConnectorConnectionStateDto;
use crate::protocol::connectors::ConnectorCredentialCleanupDto;
use crate::protocol::connectors::ConnectorCredentialCleanupParams;
use crate::protocol::connectors::ConnectorDeviceOAuthPollParams;
use crate::protocol::connectors::ConnectorDeviceOAuthPollResult;
use crate::protocol::connectors::ConnectorDeviceOAuthStartParams;
use crate::protocol::connectors::ConnectorDeviceOAuthStartResult;
use crate::protocol::connectors::ConnectorDisconnectParams;
use crate::protocol::connectors::ConnectorDisconnectResultDto;
use crate::protocol::connectors::ConnectorDto;
use crate::protocol::connectors::ConnectorListResult;
use crate::protocol::connectors::ConnectorOAuthCancelParams;
use crate::protocol::connectors::ConnectorOAuthCompleteParams;
use crate::protocol::connectors::ConnectorOAuthMethodDto;
use crate::protocol::connectors::ConnectorOAuthRefreshParams;
use crate::protocol::connectors::ConnectorOAuthStartParams;
use crate::protocol::connectors::ConnectorOAuthStartResult;
use crate::protocol::connectors::ConnectorSecretDto;
use crate::protocol::connectors::ConnectorsChanged;
use crate::protocol::debug::DebugAdapterCloseParams;
use crate::protocol::debug::DebugAdapterMessageDto;
use crate::protocol::debug::DebugAdapterReadParams;
use crate::protocol::debug::DebugAdapterReadResult;
use crate::protocol::debug::DebugAdapterSendParams;
use crate::protocol::debug::DebugAdapterStartParams;
use crate::protocol::debug::DebugAdapterStartResult;
use crate::protocol::diagnostics::FeedbackPrepareParams;
use crate::protocol::diagnostics::FeedbackUploadParams;
use crate::protocol::diff::DiffComputeParams;
use crate::protocol::diff::DiffComputeResult;
use crate::protocol::diff::DiffComputeRowDto;
use crate::protocol::diff::DiffHunkDto;
use crate::protocol::diff::DiffRangeDto;
use crate::protocol::diff::DiffRowKindDto;
use crate::protocol::document::TypstCompileParams;
use crate::protocol::document::TypstCompileResult;
use crate::protocol::document::TypstDiagnosticDto;
use crate::protocol::document::TypstDiagnosticSeverityDto;
use crate::protocol::document::TypstSourceRangeDto;
use crate::protocol::environment::DirContributionsDto;
use crate::protocol::environment::DirGrantDto;
use crate::protocol::environment::DirPermissionsEntryDto;
use crate::protocol::environment::DirPermissionsForgetParams;
use crate::protocol::environment::DirPermissionsListResult;
use crate::protocol::environment::DirPermissionsReadParams;
use crate::protocol::environment::DirPermissionsReadResult;
use crate::protocol::environment::DirPermissionsSetParams;
use crate::protocol::environment::EnvCwdSetParams;
use crate::protocol::environment::EnvCwdSetResult;
use crate::protocol::environment::EnvDirDto;
use crate::protocol::environment::EnvDirSetEntry;
use crate::protocol::environment::EnvDirsSetParams;
use crate::protocol::environment::EnvDirsSetResult;
use crate::protocol::environment::PermissionDto;
use crate::protocol::environment::SessionDirAddParams;
use crate::protocol::environment::SessionDirAddResult;
use crate::protocol::environment::SessionDirDto;
use crate::protocol::environment::SessionDirListParams;
use crate::protocol::environment::SessionDirListResult;
use crate::protocol::environment::SessionDirMutationDto;
use crate::protocol::environment::SessionDirMutationResult;
use crate::protocol::environment::SessionDirPermissionsSetParams;
use crate::protocol::environment::SessionDirRemoveParams;
use crate::protocol::environment::SessionDirSelector;
use crate::protocol::error::AppServerError;
use crate::protocol::error::AppServerErrorData;
use crate::protocol::error::AppServerErrorName;
use crate::protocol::extension_host::ExtensionHostCancellationReasonDto;
use crate::protocol::extension_host::ExtensionHostChanged;
use crate::protocol::extension_host::ExtensionHostExtensionDto;
use crate::protocol::extension_host::ExtensionHostFailureCodeDto;
use crate::protocol::extension_host::ExtensionHostFailureDto;
use crate::protocol::extension_host::ExtensionHostInvokeCancelDispositionDto;
use crate::protocol::extension_host::ExtensionHostInvokeCancelParams;
use crate::protocol::extension_host::ExtensionHostInvokeCancelResult;
use crate::protocol::extension_host::ExtensionHostInvokeReadParams;
use crate::protocol::extension_host::ExtensionHostInvokeReadResult;
use crate::protocol::extension_host::ExtensionHostInvokeStartParams;
use crate::protocol::extension_host::ExtensionHostInvokeStartResult;
use crate::protocol::extension_host::ExtensionHostLanguageProviderOperationDto;
use crate::protocol::extension_host::ExtensionHostLifecycleDto;
use crate::protocol::extension_host::ExtensionHostOutputChannelKindDto;
use crate::protocol::extension_host::ExtensionHostOutputEventDto;
use crate::protocol::extension_host::ExtensionHostOutputOperationDto;
use crate::protocol::extension_host::ExtensionHostOutputSeverityDto;
use crate::protocol::extension_host::ExtensionHostReconcileModeDto;
use crate::protocol::extension_host::ExtensionHostReconcileParams;
use crate::protocol::extension_host::ExtensionHostRegistrationDescriptorDto;
use crate::protocol::extension_host::ExtensionHostRegistrationKindDto;
use crate::protocol::extension_host::ExtensionHostSnapshotDto;
use crate::protocol::extension_items::ExtensionItemsParams;
use crate::protocol::extension_items::ExtensionItemsResult;
use crate::protocol::extensions::ExtensionCatalogReloadDto;
use crate::protocol::extensions::ExtensionDiagnosticCodeDto;
use crate::protocol::extensions::ExtensionDiagnosticDto;
use crate::protocol::extensions::ExtensionDto;
use crate::protocol::extensions::ExtensionListParams;
use crate::protocol::extensions::ExtensionListResult;
use crate::protocol::extensions::ExtensionResourceOpenParams;
use crate::protocol::extensions::ExtensionResourceOpenResult;
use crate::protocol::extensions::ExtensionSourceKindDto;
use crate::protocol::fs::FsChanged;
use crate::protocol::fs::FsCreateFileParams;
use crate::protocol::fs::FsDeleteMode;
use crate::protocol::fs::FsDeleteParams;
use crate::protocol::fs::FsExistingTargetBehavior;
use crate::protocol::fs::FsFileType;
use crate::protocol::fs::FsGetMetadataParams;
use crate::protocol::fs::FsGetMetadataResult;
use crate::protocol::fs::FsMissingTargetBehavior;
use crate::protocol::fs::FsReadBinaryFileParams;
use crate::protocol::fs::FsReadBinaryFileResult;
use crate::protocol::fs::FsReadDirectoryEntry;
use crate::protocol::fs::FsReadDirectoryParams;
use crate::protocol::fs::FsReadDirectoryResult;
use crate::protocol::fs::FsReadFileParams;
use crate::protocol::fs::FsReadFileResult;
use crate::protocol::fs::FsRenameParams;
use crate::protocol::fs::FsWriteFileParams;
use crate::protocol::fs::FsWriteFileResult;
use crate::protocol::git::GitBranchDto;
use crate::protocol::git::GitBranchListResult;
use crate::protocol::git::GitBranchSwitchParams;
use crate::protocol::git::GitChangeFileComparisonDto;
use crate::protocol::git::GitChangeFileParams;
use crate::protocol::git::GitChangeFileResult;
use crate::protocol::git::GitChangeStatusDto;
use crate::protocol::git::GitCommitChangeDto;
use crate::protocol::git::GitCommitChangesParams;
use crate::protocol::git::GitCommitChangesResult;
use crate::protocol::git::GitCommitFileContentDto;
use crate::protocol::git::GitCommitFileParams;
use crate::protocol::git::GitCommitFileResult;
use crate::protocol::git::GitCommitParams;
use crate::protocol::git::GitCommitResult;
use crate::protocol::git::GitCommitSummaryDto;
use crate::protocol::git::GitDiffStatisticsDto;
use crate::protocol::git::GitGraphParams;
use crate::protocol::git::GitGraphResult;
use crate::protocol::git::GitHeadDto;
use crate::protocol::git::GitHistoryResult;
use crate::protocol::git::GitOperationResult;
use crate::protocol::git::GitPathsParams;
use crate::protocol::git::GitReferenceDto;
use crate::protocol::git::GitReferenceKindDto;
use crate::protocol::git::GitRemoteDto;
use crate::protocol::git::GitRemoteProviderDto;
use crate::protocol::git::GitRepositoriesResult;
use crate::protocol::git::GitRepositoryChangeDto;
use crate::protocol::git::GitRepositoryDto;
use crate::protocol::git::GitRepositoryIdentityDto;
use crate::protocol::git::GitRepositoryParams;
use crate::protocol::git::GitStatusChanged;
use crate::protocol::git::GitStatusResult;
use crate::protocol::git::GitSubmoduleStateDto;
use crate::protocol::git::GitTextDiffDto;
use crate::protocol::git::GitTextDiffResult;
use crate::protocol::git::GitUpstreamDto;
use crate::protocol::goal::ThreadGoalClearParams;
use crate::protocol::goal::ThreadGoalClearResponse;
use crate::protocol::goal::ThreadGoalClearedNotification;
use crate::protocol::goal::ThreadGoalGetParams;
use crate::protocol::goal::ThreadGoalGetResponse;
use crate::protocol::goal::ThreadGoalSetParams;
use crate::protocol::goal::ThreadGoalSetResponse;
use crate::protocol::goal::ThreadGoalUpdatedNotification;
use crate::protocol::initialize::CapabilityContract;
use crate::protocol::initialize::InitializeParams;
use crate::protocol::initialize::InitializeResult;
use crate::protocol::initialize::ProtocolVersion;
use crate::protocol::initialize::ServerCapabilities;
use crate::protocol::instructions::InstructionDiagnosticDto;
use crate::protocol::instructions::InstructionDto;
use crate::protocol::instructions::InstructionImportItem;
use crate::protocol::instructions::InstructionImportParams;
use crate::protocol::instructions::InstructionImportPreviewParams;
use crate::protocol::instructions::InstructionImportPreviewResult;
use crate::protocol::instructions::InstructionImportResult;
use crate::protocol::instructions::InstructionImportSource;
use crate::protocol::instructions::InstructionImportStatus;
use crate::protocol::instructions::InstructionListParams;
use crate::protocol::instructions::InstructionListResult;
use crate::protocol::instructions::InstructionLoadDto;
use crate::protocol::instructions::InstructionScopeDto;
use crate::protocol::issues::IssueConfigureParams;
use crate::protocol::issues::IssueListParams;
use crate::protocol::issues::IssueListResult;
use crate::protocol::issues::IssueReadParams;
use crate::protocol::issues::IssueReadResult;
use crate::protocol::language::LanguageCancelParams;
use crate::protocol::language::LanguageCancelResult;
use crate::protocol::language::LanguageCancelStatusDto;
use crate::protocol::language::LanguageCloseParams;
use crate::protocol::language::LanguageCodeActionDiagnosticDto;
use crate::protocol::language::LanguageCodeActionDto;
use crate::protocol::language::LanguageCodeActionsParams;
use crate::protocol::language::LanguageCodeActionsResult;
use crate::protocol::language::LanguageCodeLensDto;
use crate::protocol::language::LanguageCodeLensesResult;
use crate::protocol::language::LanguageColorDto;
use crate::protocol::language::LanguageColorPresentationDto;
use crate::protocol::language::LanguageColorPresentationsParams;
use crate::protocol::language::LanguageColorPresentationsResult;
use crate::protocol::language::LanguageCommandDto;
use crate::protocol::language::LanguageCompletionDetailsResult;
use crate::protocol::language::LanguageCompletionInsertTextFormatDto;
use crate::protocol::language::LanguageCompletionItemDto;
use crate::protocol::language::LanguageCompletionItemKindDto;
use crate::protocol::language::LanguageCompletionTriggerKindDto;
use crate::protocol::language::LanguageCompletionsParams;
use crate::protocol::language::LanguageCompletionsResult;
use crate::protocol::language::LanguageDiagnosticReportKindDto;
use crate::protocol::language::LanguageDiagnosticSeverityDto;
use crate::protocol::language::LanguageDiagnosticsNotification;
use crate::protocol::language::LanguageDirectoryDiagnosticSnapshotDto;
use crate::protocol::language::LanguageDirectoryDiagnosticsParams;
use crate::protocol::language::LanguageDirectoryDiagnosticsResult;
use crate::protocol::language::LanguageDirectoryEditDto;
use crate::protocol::language::LanguageDirectoryEditEntryDto;
use crate::protocol::language::LanguageDirectorySymbolDto;
use crate::protocol::language::LanguageDirectorySymbolsParams;
use crate::protocol::language::LanguageDirectorySymbolsResult;
use crate::protocol::language::LanguageDocumentColorDto;
use crate::protocol::language::LanguageDocumentColorsResult;
use crate::protocol::language::LanguageDocumentDiagnosticsParams;
use crate::protocol::language::LanguageDocumentDiagnosticsResult;
use crate::protocol::language::LanguageDocumentDto;
use crate::protocol::language::LanguageDocumentFeaturesParams;
use crate::protocol::language::LanguageDocumentFormattingParams;
use crate::protocol::language::LanguageDocumentLinkDto;
use crate::protocol::language::LanguageDocumentLinksResult;
use crate::protocol::language::LanguageDocumentSymbolDto;
use crate::protocol::language::LanguageDocumentSymbolsResult;
use crate::protocol::language::LanguageExecuteCommandParams;
use crate::protocol::language::LanguageFoldingRangeDto;
use crate::protocol::language::LanguageFoldingRangeKindDto;
use crate::protocol::language::LanguageFoldingRangesResult;
use crate::protocol::language::LanguageFormattingOptionsDto;
use crate::protocol::language::LanguageFormattingResult;
use crate::protocol::language::LanguageHierarchyEntryDto;
use crate::protocol::language::LanguageHierarchyItemDto;
use crate::protocol::language::LanguageHierarchyKindDto;
use crate::protocol::language::LanguageHierarchyParams;
use crate::protocol::language::LanguageHierarchyResultDto;
use crate::protocol::language::LanguageHoverParams;
use crate::protocol::language::LanguageHoverResult;
use crate::protocol::language::LanguageInlayHintDto;
use crate::protocol::language::LanguageInlayHintKindDto;
use crate::protocol::language::LanguageInlayHintsParams;
use crate::protocol::language::LanguageInlayHintsResult;
use crate::protocol::language::LanguageLinkedEditingRangesParams;
use crate::protocol::language::LanguageLinkedEditingRangesResult;
use crate::protocol::language::LanguageLocationDto;
use crate::protocol::language::LanguageLocationKindDto;
use crate::protocol::language::LanguageLocationsParams;
use crate::protocol::language::LanguageLocationsResult;
use crate::protocol::language::LanguageOperationParams;
use crate::protocol::language::LanguageParameterInformationDto;
use crate::protocol::language::LanguagePositionDto;
use crate::protocol::language::LanguagePrepareRenameParams;
use crate::protocol::language::LanguagePrepareRenameResult;
use crate::protocol::language::LanguageRangeDto;
use crate::protocol::language::LanguageRangeFormattingParams;
use crate::protocol::language::LanguageRenameParams;
use crate::protocol::language::LanguageRenamePreparationDto;
use crate::protocol::language::LanguageResolveCodeActionParams;
use crate::protocol::language::LanguageResolveCodeLensParams;
use crate::protocol::language::LanguageResolveCompletionParams;
use crate::protocol::language::LanguageResolveDocumentLinkParams;
use crate::protocol::language::LanguageSemanticTokenDto;
use crate::protocol::language::LanguageSemanticTokensParams;
use crate::protocol::language::LanguageSemanticTokensResult;
use crate::protocol::language::LanguageServerMessageNotification;
use crate::protocol::language::LanguageServerMessageSeverityDto;
use crate::protocol::language::LanguageServerMessageSourceDto;
use crate::protocol::language::LanguageServerProgressNotification;
use crate::protocol::language::LanguageServerStateDto;
use crate::protocol::language::LanguageServerStateNotification;
use crate::protocol::language::LanguageSignatureHelpParams;
use crate::protocol::language::LanguageSignatureHelpResult;
use crate::protocol::language::LanguageSignatureHelpTriggerKindDto;
use crate::protocol::language::LanguageSignatureInformationDto;
use crate::protocol::language::LanguageSynchronizeParams;
use crate::protocol::language::LanguageTextDocumentEditDto;
use crate::protocol::language::LanguageTextEditDto;
use crate::protocol::marketplace::MarketplaceAcquireCapabilityParams;
use crate::protocol::marketplace::MarketplaceAcquiredCapabilityDto;
use crate::protocol::marketplace::MarketplaceActivationSpecDto;
use crate::protocol::marketplace::MarketplaceArtifactHandleDto;
use crate::protocol::marketplace::MarketplaceAvailableCapabilityDto;
use crate::protocol::marketplace::MarketplaceCapabilityDescriptorDto;
use crate::protocol::marketplace::MarketplaceCapabilityKindDto;
use crate::protocol::marketplace::MarketplaceCapabilityLeaseDto;
use crate::protocol::marketplace::MarketplaceCapabilityRefDto;
use crate::protocol::marketplace::MarketplaceChanged;
use crate::protocol::marketplace::MarketplaceConnectorActivationSpecDto;
use crate::protocol::marketplace::MarketplaceDownloadParams;
use crate::protocol::marketplace::MarketplaceExecutableActivationSpecDto;
use crate::protocol::marketplace::MarketplaceExecutableRuntimeDto;
use crate::protocol::marketplace::MarketplaceGetParams;
use crate::protocol::marketplace::MarketplaceInstallParams;
use crate::protocol::marketplace::MarketplaceInstallationStateDto;
use crate::protocol::marketplace::MarketplaceInstalledPackageDto;
use crate::protocol::marketplace::MarketplaceLanguageActivationSpecDto;
use crate::protocol::marketplace::MarketplaceListInstalledResult;
use crate::protocol::marketplace::MarketplaceLocalizationActivationSpecDto;
use crate::protocol::marketplace::MarketplaceMcpActivationSpecDto;
use crate::protocol::marketplace::MarketplaceMcpTransportDto;
use crate::protocol::marketplace::MarketplaceOpenResourceParams;
use crate::protocol::marketplace::MarketplacePackageDetailsDto;
use crate::protocol::marketplace::MarketplacePackageRefDto;
use crate::protocol::marketplace::MarketplacePackageSourceDto;
use crate::protocol::marketplace::MarketplacePackageSummaryDto;
use crate::protocol::marketplace::MarketplaceReleaseCapabilityParams;
use crate::protocol::marketplace::MarketplaceResourceContentDto;
use crate::protocol::marketplace::MarketplaceResourceRefDto;
use crate::protocol::marketplace::MarketplaceSearchParams;
use crate::protocol::marketplace::MarketplaceSearchResult;
use crate::protocol::marketplace::MarketplaceSkillActivationSpecDto;
use crate::protocol::marketplace::MarketplaceThemeActivationSpecDto;
use crate::protocol::marketplace::MarketplaceUninstallModeDto;
use crate::protocol::marketplace::MarketplaceUninstallParams;
use crate::protocol::marketplace::MarketplaceUpdateParams;
use crate::protocol::marketplace::MarketplaceUpstreamReferenceDto;
use crate::protocol::marketplace::MarketplaceUpstreamRegistryDto;
use crate::protocol::mcp::McpOAuthCompleteParams;
use crate::protocol::mcp::McpOAuthMutationParams;
use crate::protocol::mcp::McpOAuthMutationResult;
use crate::protocol::mcp::McpOAuthStartParams;
use crate::protocol::mcp::McpOAuthStartResult;
use crate::protocol::mcp::McpSecretDto;
use crate::protocol::mcp::McpServerRuntimeIntentDto;
use crate::protocol::mcp::McpServerRuntimeIntentParams;
use crate::protocol::mcp::McpServerRuntimeIntentResult;
use crate::protocol::mcp::McpServerRuntimeStateDto;
use crate::protocol::mcp::McpServerStatusDto;
use crate::protocol::mcp::McpServerStatusResult;
use crate::protocol::memory::MemoryAddParams;
use crate::protocol::memory::MemoryChanged;
use crate::protocol::memory::MemoryCitationReadParams;
use crate::protocol::memory::MemoryDeleteParams;
use crate::protocol::memory::MemoryListParams;
use crate::protocol::memory::MemoryPolicyReadParams;
use crate::protocol::memory::MemoryPolicyUpdateParams;
use crate::protocol::memory::MemoryReadParams;
use crate::protocol::memory::MemoryScopeDescriptor;
use crate::protocol::memory::MemoryScopesParams;
use crate::protocol::memory::MemoryScopesResult;
use crate::protocol::memory::MemorySearchParams;
use crate::protocol::memory::MemoryUpdateParams;
use crate::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
use crate::protocol::model::ModelCatalogEntry;
use crate::protocol::model::ModelListResult;
use crate::protocol::notification::ThreadTranscriptUpdateEnvelope;
use crate::protocol::notification::ThreadUpdateEnvelope;
use crate::protocol::plugins::PluginCommandDispositionDto;
use crate::protocol::plugins::PluginCommandResultDto;
use crate::protocol::plugins::PluginListResult;
use crate::protocol::plugins::PluginPackageCommandParams;
use crate::protocol::plugins::PluginPackageDto;
use crate::protocol::plugins::PluginsChanged;
use crate::protocol::projects::ProjectChanged;
use crate::protocol::projects::ProjectCommandDispositionDto;
use crate::protocol::projects::ProjectCreateParams;
use crate::protocol::projects::ProjectDetailsUpdateParams;
use crate::protocol::projects::ProjectDto;
use crate::protocol::projects::ProjectLifecycleParams;
use crate::protocol::projects::ProjectListParams;
use crate::protocol::projects::ProjectListResult;
use crate::protocol::projects::ProjectMutationResult;
use crate::protocol::projects::ProjectReadParams;
use crate::protocol::projects::ProjectReadResult;
use crate::protocol::projects::ProjectRootAddParams;
use crate::protocol::projects::ProjectRootDto;
use crate::protocol::projects::ProjectRootRemoveParams;
use crate::protocol::projects::ProjectRootUpdateParams;
use crate::protocol::projects::ProjectSessionMutationParams;
use crate::protocol::projects::ProjectStatusDto;
use crate::protocol::projects::ProjectSummaryDto;
use crate::protocol::provider::ProviderApiKeyDto;
use crate::protocol::provider::ProviderApiKeyPolicyDto;
use crate::protocol::provider::ProviderApiKeySetParams;
use crate::protocol::provider::ProviderApiKeySetResult;
use crate::protocol::provider::ProviderCatalogEntryDto;
use crate::protocol::provider::ProviderListResult;
use crate::protocol::provider::ProviderModelsListFailureCodeDto;
use crate::protocol::provider::ProviderModelsListFailureDto;
use crate::protocol::provider::ProviderModelsListParams;
use crate::protocol::provider::ProviderModelsListResult;
use crate::protocol::provider::ProviderProbeParams;
use crate::protocol::provider::ProviderProbeResult;
use crate::protocol::queue::QueueCancelParams;
use crate::protocol::queue::QueueEditAction;
use crate::protocol::queue::QueueEditParams;
use crate::protocol::queue::QueueEnqueueParams;
use crate::protocol::queue::QueueListParams;
use crate::protocol::queue::QueueListResult;
use crate::protocol::resources::ResourceMetadataParams;
use crate::protocol::resources::ResourceMetadataResult;
use crate::protocol::resources::ResourceReadParams;
use crate::protocol::resources::ResourceReadResult;
use crate::protocol::resources::ResourceReleaseParams;
use crate::protocol::search::ContentSearchCancelParams;
use crate::protocol::search::ContentSearchCaseSensitivity;
use crate::protocol::search::ContentSearchMatch;
use crate::protocol::search::ContentSearchMatchRange;
use crate::protocol::search::ContentSearchPatternKind;
use crate::protocol::search::ContentSearchReadParams;
use crate::protocol::search::ContentSearchReadResult;
use crate::protocol::search::ContentSearchStartParams;
use crate::protocol::search::ContentSearchStartResult;
use crate::protocol::session::MessageCheckpointsParams;
use crate::protocol::session::MessageCheckpointsResult;
use crate::protocol::session::SessionChanged;
use crate::protocol::session::SessionCreateParams;
use crate::protocol::session::SessionDeleted;
use crate::protocol::session::SessionListResult;
use crate::protocol::session::SessionReadParams;
use crate::protocol::session::SessionRequest;
use crate::protocol::session::SessionRequestParams;
use crate::protocol::session::SessionRequestResult;
use crate::protocol::session::SessionResult;
use crate::protocol::session::SessionRewriteResult;
use crate::protocol::session::SessionSubscribeParams;
use crate::protocol::session::SessionSubscribeResult;
use crate::protocol::session::SessionThreadProjection;
use crate::protocol::session::SessionThreadReadParams;
use crate::protocol::session::SessionThreadReadResult;
use crate::protocol::session::SessionThreadResult;
use crate::protocol::session::SessionThreadSubscribeParams;
use crate::protocol::session::SessionThreadSubscribeResult;
use crate::protocol::session::SessionThreadUnsubscribeParams;
use crate::protocol::session::SessionUnsubscribeParams;
use crate::protocol::session::ThreadHistoryBoundary;
use crate::protocol::session::ThreadSnapshotHistory;
use crate::protocol::skills::SkillCatalogReloadDto;
use crate::protocol::skills::SkillCompatibilityDto;
use crate::protocol::skills::SkillDiagnosticCodeDto;
use crate::protocol::skills::SkillDiagnosticDto;
use crate::protocol::skills::SkillDto;
use crate::protocol::skills::SkillEnablementDto;
use crate::protocol::skills::SkillListParams;
use crate::protocol::skills::SkillListResult;
use crate::protocol::skills::SkillResourceKindDto;
use crate::protocol::skills::SkillResourceOpenParams;
use crate::protocol::skills::SkillResourceOpenResult;
use crate::protocol::skills::SkillSetEnablementParams;
use crate::protocol::skills::SkillSourceKindDto;
use crate::protocol::skills::SkillsChanged;
use crate::protocol::slash_commands::SlashCommandArgumentModeDto;
use crate::protocol::slash_commands::SlashCommandDefinition;
use crate::protocol::syntax::SyntaxAnalyzeParams;
use crate::protocol::syntax::SyntaxAnalyzeResult;
use crate::protocol::syntax::SyntaxDiagnosticDto;
use crate::protocol::syntax::SyntaxDiagnosticKindDto;
use crate::protocol::syntax::SyntaxFoldingRangeDto;
use crate::protocol::syntax::SyntaxLanguageDto;
use crate::protocol::syntax::SyntaxPositionDto;
use crate::protocol::syntax::SyntaxRangeDto;
use crate::protocol::syntax::SyntaxSelectionRangeDto;
use crate::protocol::syntax::SyntaxSelectionRangesParams;
use crate::protocol::syntax::SyntaxSelectionRangesResult;
use crate::protocol::syntax::SyntaxSymbolDto;
use crate::protocol::syntax::SyntaxSymbolKindDto;
use crate::protocol::syntax::SyntaxTokenDto;
use crate::protocol::syntax::SyntaxTokenKindDto;
use crate::protocol::terminal::TerminalAttachParams;
use crate::protocol::terminal::TerminalAttachResult;
use crate::protocol::terminal::TerminalCloseParams;
use crate::protocol::terminal::TerminalCommandStatus;
use crate::protocol::terminal::TerminalCommandStatusEvent;
use crate::protocol::terminal::TerminalCreateInSessionDirectoryParams;
use crate::protocol::terminal::TerminalCreateParams;
use crate::protocol::terminal::TerminalCreateResult;
use crate::protocol::terminal::TerminalLifecycle;
use crate::protocol::terminal::TerminalOutputChunk;
use crate::protocol::terminal::TerminalProfile;
use crate::protocol::terminal::TerminalProfileListResult;
use crate::protocol::terminal::TerminalProfileSelection;
use crate::protocol::terminal::TerminalReadParams;
use crate::protocol::terminal::TerminalReadResult;
use crate::protocol::terminal::TerminalReconnectLease;
use crate::protocol::terminal::TerminalResizeParams;
use crate::protocol::terminal::TerminalWriteParams;
use crate::protocol::transcript::ThreadTranscriptChange;
use crate::protocol::transcript::ThreadTranscriptEntry;
use crate::protocol::transcript::ThreadTranscriptSnapshot;
use crate::protocol::turn::InputItem;
use crate::protocol::turn::TurnInteractionResolveResult;
use crate::protocol::turn::TurnInterruptResult;
use crate::protocol::turn::TurnStartResult;
use crate::protocol::turn::TurnSteerResult;
use crate::protocol::turn_changes::ChangeSetId;
use crate::protocol::turn_changes::ThreadDirBinding;
use crate::protocol::turn_changes::ThreadWorktreeRepositoryBindingDto;
use crate::protocol::turn_changes::TurnChangeCaptureStateDto;
use crate::protocol::turn_changes::TurnChangeCommitStateDto;
use crate::protocol::turn_changes::TurnChangeFileDto;
use crate::protocol::turn_changes::TurnChangeFileKindDto;
use crate::protocol::turn_changes::TurnChangeFileStatisticsDto;
use crate::protocol::turn_changes::TurnChangeMessageStateDto;
use crate::protocol::turn_changes::TurnChangeSetSummary;
use crate::protocol::turn_changes::TurnChangeTerminalStateDto;
use crate::protocol::turn_changes::TurnChangesChanged;
use crate::protocol::turn_changes::TurnChangesCommitParams;
use crate::protocol::turn_changes::TurnChangesDiscardThreadParams;
use crate::protocol::turn_changes::TurnChangesListParams;
use crate::protocol::turn_changes::TurnChangesListResult;
use crate::protocol::turn_changes::TurnChangesMutationParams;
use crate::protocol::turn_changes::TurnChangesMutationResult;
use crate::protocol::turn_changes::TurnChangesReadFileParams;
use crate::protocol::turn_changes::TurnChangesReadFileResult;
use crate::protocol::turn_changes::TurnChangesReadParams;
use crate::protocol::turn_changes::TurnChangesReadResult;
use crate::protocol::turn_changes::TurnChangesUpdateDraftParams;
use analytics::UsageEvent;
use analytics::UsageSnapshot;
use ash_environment::EnvId;
use ash_file_access::DirId;
use ash_memory_diagnostics::MemoryEvidence;
use ash_memory_diagnostics::MemoryFinding;
use ash_memory_diagnostics::MemoryMetric;
use ash_memory_diagnostics::MemoryMetricKind;
use ash_memory_diagnostics::MemoryObservation;
use ash_memory_diagnostics::MemoryOrigin;
use ash_memory_diagnostics::MemoryPhase;
use ash_memory_diagnostics::MemoryProduct;
use ash_memory_diagnostics::MemoryReport;
use ash_memory_diagnostics::MemoryRole;
use ash_memory_diagnostics::MemorySample;
use ash_memory_diagnostics::MemoryStart;
use ash_memory_diagnostics::MemoryStatus;
use ash_memory_diagnostics::MemoryTargetReport;
use ash_memory_diagnostics::MemoryTrend;
use ash_memory_diagnostics::MemoryUnavailable;
use ash_protocol::ActionApprovalCapability;
use ash_protocol::ActionApprovalCapabilityKind;
use ash_protocol::ActionApprovalDecision;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::ActionApprovalResponse;
use ash_protocol::AgentCapabilityScope;
use ash_protocol::AgentContextContent;
use ash_protocol::AgentContextMode;
use ash_protocol::AgentContextSeed;
use ash_protocol::AgentContextSource;
use ash_protocol::AgentDefinitionSelectionReason;
use ash_protocol::AgentId;
use ash_protocol::AgentInteractionKind;
use ash_protocol::AgentJoin;
use ash_protocol::AgentJoinId;
use ash_protocol::AgentJoinPolicy;
use ash_protocol::AgentJoinStatus;
use ash_protocol::AgentMaterializedContext;
use ash_protocol::AgentMessage;
use ash_protocol::AgentMessageContent;
use ash_protocol::AgentMessageId;
use ash_protocol::AgentMessageProvenance;
use ash_protocol::AgentRequest;
use ash_protocol::AgentRequestEnvelope;
use ash_protocol::AgentResponse;
use ash_protocol::AgentRoleSnapshot;
use ash_protocol::AgentRoleSource;
use ash_protocol::AgentTreeExecutionStatus;
use ash_protocol::AgentTreeNodeProjection;
use ash_protocol::AgentTreeProjection;
use ash_protocol::AgentTreeWaitingReason;
use ash_protocol::ApprovalMode;
use ash_protocol::AttachmentRef;
use ash_protocol::AudioAttachmentRef;
use ash_protocol::AudioMediaType;
use ash_protocol::Automation;
use ash_protocol::AutomationDefinition;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use ash_protocol::AutomationSchedule;
use ash_protocol::AutomationSession;
use ash_protocol::AutomationStatus;
use ash_protocol::CapabilitySupport;
use ash_protocol::ContentDigest;
use ash_protocol::ContentPart;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ContextCheckpointId;
use ash_protocol::ContextCheckpointVerification;
use ash_protocol::ContextSeedDigest;
use ash_protocol::ContextSourceDigest;
use ash_protocol::ContextSourceRange;
use ash_protocol::DelegatedPolicyCeiling;
use ash_protocol::DelegatedTask;
use ash_protocol::DelegationArtifactRef;
use ash_protocol::DelegationId;
use ash_protocol::DelegationResult;
use ash_protocol::DelegationResultDigest;
use ash_protocol::DelegationResultStatus;
use ash_protocol::DynamicToolCall;
use ash_protocol::DynamicToolOutput;
use ash_protocol::DynamicToolResponse;
use ash_protocol::ForkedAgentContext;
use ash_protocol::FrozenAgentDefinitionRef;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::HistoryPrefixRef;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;
use ash_protocol::InteractionCancelReason;
use ash_protocol::InteractionDeadline;
use ash_protocol::ItemDelta;
use ash_protocol::MessageBoundary;
use ash_protocol::MessageCheckpoint;
use ash_protocol::ModelAccess;
use ash_protocol::ModelBillingEvidence;
use ash_protocol::ModelBillingRecord;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelContextUsage;
use ash_protocol::ModelContextUsageSource;
use ash_protocol::ModelCostLineItem;
use ash_protocol::ModelId;
use ash_protocol::ModelInputEstimate;
use ash_protocol::ModelInvocationId;
use ash_protocol::ModelInvocationOutcome;
use ash_protocol::ModelInvocationRecord;
use ash_protocol::ModelMoneyAmount;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelReferenceCostReason;
use ash_protocol::ModelReferenceCostRecord;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsage;
use ash_protocol::ModelUsageSummary;
use ash_protocol::ModelUsageTotal;
use ash_protocol::PendingInteraction;
use ash_protocol::Personality;
use ash_protocol::PlanStep;
use ash_protocol::PlanStepStatus;
use ash_protocol::PlanUpdate;
use ash_protocol::ProcessExecutionOutput;
use ash_protocol::ProcessExitStatus;
use ash_protocol::ProjectId;
use ash_protocol::RatedModelCost;
use ash_protocol::ReasoningEffort;
use ash_protocol::RepositoryCheckpoint;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::ReviewTarget;
use ash_protocol::SandboxDenialOutput;
use ash_protocol::Session;
use ash_protocol::SessionManagerActivity;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_protocol::SkillVersionSelector;
use ash_protocol::StableTurnError;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::StreamCursor;
use ash_protocol::Thread;
use ash_protocol::ThreadArchiveReason;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadGoal;
use ash_protocol::ThreadGoalStatus;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadOrigin;
use ash_protocol::ThreadSequenceRange;
use ash_protocol::ThreadStatus;
use ash_protocol::ThreadUpdate;
use ash_protocol::TimeContext;
use ash_protocol::TimeContextMode;
use ash_protocol::TimeZoneOrigin;
use ash_protocol::ToolCallBinding;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolExecutionAuthority;
use ash_protocol::ToolMode;
use ash_protocol::ToolOutputStream;
use ash_protocol::ToolProfileSnapshot;
use ash_protocol::ToolReplaySafety;
use ash_protocol::ToolSourceProvenance;
use ash_protocol::Turn;
use ash_protocol::TurnExecutionBinding;
use ash_protocol::TurnInstructions;
use ash_protocol::TurnInteraction;
use ash_protocol::TurnKind;
use ash_protocol::TurnStatus;
use ash_protocol::UnixMillis;
use ash_protocol::UserInput;
use ash_protocol::UserInputAnswer;
use ash_protocol::UserInputOption;
use ash_protocol::UserInputQuestion;
use ash_protocol::WorkspaceCheckpoint;
use build_info::BuildInfo;
use diagnostics::Activity;
use diagnostics::ActivitySummary;
use diagnostics::DiagnosticSnapshot;
use diagnostics::Observation;
use diagnostics::Outcome;
use extension_items::ExtensionItem;
use extension_items::ExtensionItemContent;
use extension_items::ExtensionItemStatus;
use extension_items::SearchSource;
use features::Feature;
use features::FeatureSource;
use features::FeatureStage;
use features::FeatureState;
use feedback::PreparedFeedback;
use queue::QueueInput;
use queue::QueueMove;
use queue::QueueStatus;
use queue::QueuedMessage;
use response_debug_context::AuthHeader;
use response_debug_context::AuthRecovery;
use response_debug_context::DiagnosticOutcome;
use response_debug_context::RequestAttempt;
use response_debug_context::RequestOutcome;
use response_debug_context::ResponseDebugContext;
use response_debug_context::ResponseDiagnostic;
use response_debug_context::ResponseOperation;
use schemars::JsonSchema;
use ts_rs::Config;
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
    params_type: fn(&Config) -> String,
    result_type: fn(&Config) -> String,
}

impl ClientMethodDefinition {
    pub fn params_type(&self) -> String {
        (self.params_type)(&Config::default())
    }

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
    params_type: fn(&Config) -> String,
    result_type: fn(&Config) -> String,
}

impl HostMethodDefinition {
    pub fn params_type(&self) -> String {
        (self.params_type)(&Config::default())
    }

    pub fn result_type(&self) -> String {
        (self.result_type)(&Config::default())
    }
}

#[derive(Clone, Copy)]
pub struct ServerNotificationDefinition {
    pub kind: ServerNotificationMethod,
    pub method: &'static str,
    params_type: fn(&Config) -> String,
}

impl ServerNotificationDefinition {
    pub fn params_type(&self) -> String {
        (self.params_type)(&Config::default())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct TypeScriptBinding {
    declaration: fn(&Config) -> String,
    dependencies: fn(&Config) -> Vec<ts_rs::Dependency>,
    identifier: fn(&Config) -> String,
}

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

type VariantSchema = (
    &'static str,
    fn(&mut schemars::SchemaGenerator) -> schemars::Schema,
);

// Keep object construction out of the hundreds of registered method instantiations.
// The payload schema functions retain their concrete types; this loop is compiled once.
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
        pub(crate) struct $name;

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
                    params_type: <$params as TS>::name,
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
        serialization: GlobalSharedRead,
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
    SyntaxAnalyze => "syntax/analyze" {
        params: SyntaxAnalyzeParams,
        response: SyntaxAnalyzeResult,
        serialization: GlobalSharedRead,
    },
    SyntaxSelectionRanges => "syntax/selectionRanges" {
        params: SyntaxSelectionRangesParams,
        response: SyntaxSelectionRangesResult,
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
        params: GitRepositoryParams,
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
    ContentSearchStart => "content/search/start" {
        params: ContentSearchStartParams,
        response: ContentSearchStartResult,
        serialization: None,
    },
    ContentSearchRead => "content/search/read" {
        params: ContentSearchReadParams,
        response: ContentSearchReadResult,
        serialization: None,
    },
    ContentSearchCancel => "content/search/cancel" {
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
    TgrepIndexStatus => "agentGrep/tgrep/status" {
        params: EmptyParams,
        response: TgrepIndexStatusResult,
        serialization: GlobalSharedRead,
    },
    TgrepIndexRebuild => "agentGrep/tgrep/rebuild" {
        params: EmptyParams,
        response: TgrepIndexStatusResult,
        serialization: GlobalExclusive,
    },
    TgrepDisableAndDelete => "agentGrep/tgrep/disableAndDelete" {
        params: TgrepDisableAndDeleteParams,
        response: TgrepDisableAndDeleteResult,
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
                    params_type: <$params as TS>::name,
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
    AgentGrepBackendDto,
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
    SessionDeleted,
    SessionRequest,
    SessionRequestParams,
    SessionRequestResult,
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
    SyntaxAnalyzeResult,
    LanguageLocationKindDto,
    LanguagePositionDto,
    LanguageRangeDto,
    LanguageDocumentDto,
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
    ContentSearchStartParams,
    ContentSearchStartResult,
    ContentSearchReadParams,
    ContentSearchMatchRange,
    ContentSearchMatch,
    ContentSearchReadResult,
    ContentSearchCancelParams,
    CodebaseStateDto,
    CodebaseStatusResult,
    TgrepIndexStatusResult,
    TgrepDisableAndDeleteParams,
    TgrepDisableAndDeleteResult,
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
