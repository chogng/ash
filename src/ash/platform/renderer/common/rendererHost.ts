import type { ISecretStorageStatusService } from '../../secrets/common/secrets.js';
import type { IMessageHistoryService } from '../../messageHistory/common/messageHistory.js';
import type { IExtensionBackendApi } from '../../agentHost/common/extensionBackendApi.js';
import type { ISymphonyBackend } from '../../symphony/common/symphonyService.js';
import type { IInstructionService } from '../../instructions/common/instructionService.js';
import type { IFileSearchService } from '../../search/common/fileSearch.js';
import type { IAssetService } from '../../assets/common/assetService.js';
import type { IIssueReporterService } from '../../issue/common/issue.js';
import type { IGitHubService } from '../../github/common/githubService.js';
import type { ILocalGitService } from '../../git/common/localGitService.js';
import type { IBackupService } from '../../backup/common/backup.js';
import type { INetworkDiagnosticsService } from '../../networkDiagnostics/common/networkDiagnosticsService.js';
import type { ICallService } from '../../call/common/callService.js';
import type { IDictationService } from '../../dictation/common/dictationService.js';
import type { ILocalTranscriptionService } from '../../localTranscription/common/localTranscription.js';
import type { IApprovalEnvironmentService } from '../../approvalEnvironment/common/approvalEnvironmentService.js';
import type { IMemoriesService } from '../../memories/common/memoriesService.js';
import type { IMemoryDiagnosticsService } from '../../memory/common/memoryDiagnosticsService.js';
import type { IAppServerApi, IResourceApi, IServerEventApi } from "../../agentHost/common/appServerApi.js";
import type { IExtensionApi } from "../../extensions/common/extensionApi.js";
import type { IFileApi } from "../../files/common/fileApi.js";
import type { ISyntaxApi } from "../../syntax/common/syntaxApi.js";
import type { IContentSearchConfigurationService } from '../../search/common/search.js';
import type { IContentSearchApi } from "../../search/common/searchApi.js";
import type { IAgentSessionService, IAgentThreadService, IAgentTurnService } from "../../agentHost/common/agentService.js";
import type { IAgentModelsService } from "../../agentHost/common/agentModels.js";
import type { IAppServerSkillApi, IAppServerHookApi } from "../../agentHost/common/appServerApi.js";
import type { ILanguageServerService } from "../../language/common/languageServerService.js";
import type { ITerminalProcessService } from "../../terminal/common/terminal.js";
import type { IDocumentCollaborationApi } from "../../collaboration/common/documentCollaborationApi.js";
import type { ICodebaseApi } from "../../codebase/common/codebaseApi.js";
import type { IConnectorApi } from "../../connectors/common/connectorApi.js";
import type { IToolSearchApi } from "../../toolSearch/common/toolSearchApi.js";
import type { ILanguageApi } from "../../language/common/languageApi.js";
import type { IPluginManagementApi } from "../../extensionManagement/common/pluginManagementApi.js";
import type { IDebugAdapterProcessService } from "../../debug/common/debugAdapterProcessService.js";
import type { IExtensionHostApi } from '../../agentHost/common/extensionHostApi.js';
import type { ICodebaseSymbolsApi } from "../../codebaseSymbols/common/codebaseSymbolsApi.js";
import type { IRemoteAgentApi } from "../../remote/common/remoteAgentApi.js";
import type { IRemoteConnectionApi } from "../../remote/common/remoteConnectionService.js";
import type { IExtensionManagementApi } from "../../extensionManagement/common/extensionManagementApi.js";
import type { IWorkspaceTrustApi } from '../../workspace/common/workspaceTrust.js';
import type { IAgentCapabilitiesService } from '../../agentCapabilities/common/agentCapabilitiesService.js';
import type { IAgentToolsApi } from '../../agentHost/common/agentToolsApi.js';
import type { IMcpServerStatusService } from '../../mcp/common/mcpServerStatusService.js';
import type { IMcpServerManagementService } from '../../mcp/common/mcpServerManagementService.js';
import type { IAgentExecutionSettingsService } from '../../agentHost/common/agentExecutionSettingsService.js';
import type { ITraceSettingsService } from '../../trace/common/traceSettingsService.js';
import type { IAccountApi } from "../../accounts/common/accountApi.js";
import type { ITurnChangesApi } from "../../turnChanges/common/turnChangesApi.js";
import type { IAutomationBackendService } from '../../automation/common/automationService.js';
import type { IAgentVoiceService } from '../../agentHost/common/agentService.js';
import type { ITeamApi } from '../../teams/common/teamApi.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { URI } from '../../../base/common/uri.js';
import type { ITestExecutionService } from '../../testing/common/testExecutionService.js';

/** Optional product capabilities contributed by a statically selected host bundle. */
export interface RendererHostCapabilities {
	readonly debugAdapter?: IDebugAdapterProcessService;
	readonly localTranscription?: ILocalTranscriptionService;
}

/** Merges product capabilities while rejecting two contributions that claim the same slot. */
export function mergeRendererHostCapabilities(capabilities: readonly RendererHostCapabilities[]): RendererHostCapabilities {
	const merged: Record<string, unknown> = {};
	for (const capability of capabilities) {
		for (const [name, value] of Object.entries(capability)) {
			if (value === undefined) continue;
			if (Object.hasOwn(merged, name)) throw new Error(`Renderer host capability '${name}' was contributed more than once`);
			merged[name] = value;
		}
	}
	return merged;
}

/** Transport-neutral capability set supplied by a renderer host at startup. */
export interface IRendererHost extends RendererHostCapabilities {
	/** Host support is stable for the window; connection state describes temporary availability. */
	readonly hasAppServer: boolean;
	/** Actual local OS user directory when supplied by the desktop host. */
	readonly localUserHome?: URI;
	/** Opens this host's profile TOML; absent when the host cannot edit a local profile. */
	readonly editUserConfiguration?: () => Promise<void>;
	/** Available when the host supplies profile-backed recovery storage. */
	readonly backup?: IBackupService;
	readonly assets: IAssetService;
	readonly testing: ITestExecutionService;
	readonly calls?: ICallService;
	readonly dictation?: IDictationService;
	readonly agentVoice?: IAgentVoiceService;
	readonly automation?: IAutomationBackendService;
	readonly messageHistory?: IMessageHistoryService;
	readonly symphony?: ISymphonyBackend;
	readonly memoryDiagnostics?: IMemoryDiagnosticsService;
	readonly memories?: IMemoriesService;
	readonly approvalEnvironment?: IApprovalEnvironmentService;
	readonly appServer: IAppServerApi;
	readonly accounts: IAccountApi;
	readonly remote?: IRemoteAgentApi;
	/** Optional because web hosts cannot restart into a host-owned SSH connection. */
	readonly remoteConnections?: IRemoteConnectionApi;
	readonly session: IAgentSessionService;
	readonly teams: ITeamApi;
	readonly model: IAgentModelsService;
	readonly secretStorage: ISecretStorageStatusService;
	readonly thread: IAgentThreadService;
	readonly turn: IAgentTurnService;
	readonly turnChanges: ITurnChangesApi;
	readonly skills: IAppServerSkillApi;
	readonly instructions: IInstructionService;
	readonly languageServers: ILanguageServerService;
	readonly documentCollaboration: IDocumentCollaborationApi;
	readonly resource: IResourceApi;
	readonly extensions: IExtensionApi;
	readonly extensionHost: IExtensionHostApi;
	readonly extensionBackend: IExtensionBackendApi;
	readonly fs: IFileApi;
	readonly syntax: ISyntaxApi;
	readonly language: ILanguageApi;
	readonly fileSearch: IFileSearchService;
	readonly contentSearch: IContentSearchApi;
	readonly contentSearchConfiguration: IContentSearchConfigurationService;
	readonly terminal: ITerminalProcessService;
	readonly events: IServerEventApi;
	readonly codebase: ICodebaseApi;
	readonly codebaseSymbols: ICodebaseSymbolsApi;
	readonly connectors: IConnectorApi;
	readonly plugins: IPluginManagementApi;
	readonly localGit: ILocalGitService;
	readonly extensionManagement: IExtensionManagementApi;
	readonly toolSearch: IToolSearchApi;
	readonly workspaceTrust: IWorkspaceTrustApi;
	readonly agentCapabilities: IAgentCapabilitiesService;
	readonly agentTools: IAgentToolsApi;
	readonly mcpServerStatus: IMcpServerStatusService;
	readonly mcpServerManagement: IMcpServerManagementService;
	readonly traceSettings: ITraceSettingsService;
	readonly executionSettings: IAgentExecutionSettingsService;
	readonly networkDiagnostics: INetworkDiagnosticsService;
	readonly issueReporter: IIssueReporterService;
	readonly github: IGitHubService;
	readonly hooks: IAppServerHookApi;
}

export const IRendererHostService = createServiceIdentifier<IRendererHost>('rendererHostService');
