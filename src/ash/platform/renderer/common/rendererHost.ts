import type { ISymphonyBackend } from '../../symphony/common/symphonyService.js';
import type { IInstructionService } from '../../instructions/common/instructionService.js';
import type { IFileSearchService } from '../../search/common/fileSearch.js';
import type { IAssetService } from '../../assets/common/assetService.js';
import type { IIssueReporterService } from '../../issue/common/issue.js';
import type { IGitHubService } from '../../github/common/githubService.js';
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
import type { IDiffApi } from "../../diff/common/diffApi.js";
import type { ISyntaxApi } from "../../syntax/common/syntaxApi.js";
import type { IGitApi } from "../../git/common/gitApi.js";
import type { IContentSearchConfigurationService } from '../../search/common/search.js';
import type { IContentSearchApi } from "../../search/common/searchApi.js";
import type { IModelApi, ISessionApi, IThreadApi, ITurnApi } from "../../sessions/common/sessionApi.js";
import type { IAppServerSkillApi } from "../../agentHost/common/appServerApi.js";
import type { ILanguageServerService } from "../../language/common/languageServerService.js";
import type { ITerminalProcessService } from "../../terminal/common/terminal.js";
import type { ITypstApi } from "../../typst/common/typstApi.js";
import type { IDocumentCollaborationApi } from "../../collaboration/common/documentCollaborationApi.js";
import type { ICodebaseApi } from "../../codebase/common/codebaseApi.js";
import type { IConnectorApi } from "../../connectors/common/connectorApi.js";
import type { IToolSearchApi } from "../../toolSearch/common/toolSearchApi.js";
import type { ILanguageApi } from "../../language/common/languageApi.js";
import type { IPluginApi } from "../../plugins/common/pluginApi.js";
import type { IDebugAdapterProcessService } from "../../debug/common/debugAdapterProcessService.js";
import type { IExtensionHostApi } from "../../extensionHost/common/extensionHostApi.js";
import type { ICodebaseSymbolsApi } from "../../codebaseSymbols/common/codebaseSymbolsApi.js";
import type { IRemoteAgentApi } from "../../remote/common/remoteAgentApi.js";
import type { IRemoteConnectionService } from "../../remote/common/remoteConnectionService.js";
import type { IRemoteTunnelService } from "../../remote/common/remoteTunnelService.js";
import type { IMarketplaceApi } from "../../marketplace/common/marketplaceApi.js";
import type { IDirPermissionsApi } from "../../dirPermissions/common/dirPermissionsApi.js";
import type { IHooksService } from '../../hooks/common/hooksService.js';
import type { IAgentCapabilitiesService } from '../../agentCapabilities/common/agentCapabilitiesService.js';
import type { IExecutionSettingsService } from '../../execution/common/executionSettingsService.js';
import type { ITraceSettingsService } from '../../trace/common/traceSettingsService.js';
import type { IAccountApi } from "../../accounts/common/accountApi.js";
import type { ITurnChangesApi } from "../../turnChanges/common/turnChangesApi.js";
import type { IAutomationService } from '../../automation/common/automationService.js';
import type { ITeamApi } from '../../teams/common/teamApi.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
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
	/** Available when the host supplies profile-backed recovery storage. */
	readonly backup?: IBackupService;
	readonly assets: IAssetService;
	readonly testing: ITestExecutionService;
	readonly calls?: ICallService;
	readonly dictation?: IDictationService;
	readonly automation?: IAutomationService;
	readonly symphony?: ISymphonyBackend;
	readonly memoryDiagnostics?: IMemoryDiagnosticsService;
	readonly memories?: IMemoriesService;
	readonly approvalEnvironment?: IApprovalEnvironmentService;
	readonly appServer: IAppServerApi;
	readonly accounts: IAccountApi;
	readonly remote?: IRemoteAgentApi;
	/** Optional because web hosts cannot restart into a host-owned SSH connection. */
	readonly remoteConnections?: IRemoteConnectionService;
	/** Optional because web and disconnected hosts cannot own an SSH process. */
	readonly remoteTunnels?: IRemoteTunnelService;
	readonly session: ISessionApi;
	readonly teams: ITeamApi;
	readonly model: IModelApi;
	readonly thread: IThreadApi;
	readonly turn: ITurnApi;
	readonly turnChanges: ITurnChangesApi;
	readonly skills: IAppServerSkillApi;
	readonly instructions: IInstructionService;
	readonly languageServers: ILanguageServerService;
	readonly typst: ITypstApi;
	readonly documentCollaboration: IDocumentCollaborationApi;
	readonly resource: IResourceApi;
	readonly extensions: IExtensionApi;
	readonly extensionHost: IExtensionHostApi;
	readonly fs: IFileApi;
	readonly diff: IDiffApi;
	readonly syntax: ISyntaxApi;
	readonly language: ILanguageApi;
	readonly git: IGitApi;
	readonly fileSearch: IFileSearchService;
	readonly contentSearch: IContentSearchApi;
	readonly contentSearchConfiguration: IContentSearchConfigurationService;
	readonly terminal: ITerminalProcessService;
	readonly events: IServerEventApi;
	readonly codebase: ICodebaseApi;
	readonly codebaseSymbols: ICodebaseSymbolsApi;
	readonly connectors: IConnectorApi;
	readonly plugins: IPluginApi;
	readonly marketplace: IMarketplaceApi;
	readonly toolSearch: IToolSearchApi;
	readonly dirPermissions: IDirPermissionsApi;
	readonly agentCapabilities: IAgentCapabilitiesService;
	readonly traceSettings: ITraceSettingsService;
	readonly executionSettings: IExecutionSettingsService;
	readonly networkDiagnostics: INetworkDiagnosticsService;
	readonly issueReporter: IIssueReporterService;
	readonly github: IGitHubService;
	readonly hooks: IHooksService;
}

export const IRendererHostService = createServiceIdentifier<IRendererHost>('rendererHostService');
