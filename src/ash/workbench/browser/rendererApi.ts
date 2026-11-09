import type { IVoiceCodeTranscriptionBackendService } from '../../platform/dictation/common/dictation.js';
import type { IAgentConnection } from '../../platform/agentHost/common/agentService.js';
import type { IRemoteAgentHostService } from '../../platform/agentHost/common/remoteAgentHostService.js';
import type { ILocalTranscriptionService, ILocalTranscriptionModelService } from '../../platform/localTranscription/common/localTranscription.js';
import type { IDebugAdapterProcessService } from '../../platform/debug/common/debugAdapterProcessService.js';
import type { IRemoteAgentApi } from '../../platform/remote/common/remoteAgentApi.js';
import type { IRemoteConnectionApi } from '../../platform/remote/common/remoteConnectionService.js';
import type { URI } from '../../base/common/uri.js';
import { createDisconnectedSecretStorageStatusService } from '../../platform/secrets/browser/appServerSecretStorageStatusService.js';
import { createDisconnectedLocalGitService } from '../../platform/git/browser/appServerLocalGitService.js';
import { createDisconnectedExecutionSettingsService } from '../../platform/agentHost/browser/appServerExecutionSettingsService.js';
import { createDisconnectedInstructionService } from '../../platform/instructions/browser/appServerInstructionService.js';
import { createDisconnectedFileSearchApi } from '../../platform/search/browser/fileSearchApi.js';
import { createDisconnectedNetworkDiagnosticsApi } from '../../platform/networkDiagnostics/browser/networkDiagnosticsApi.js';
import { createDisconnectedIssueReporterService } from '../../platform/issue/browser/appServerIssueReporterService.js';
import { createDisconnectedGitHubService } from '../../platform/github/browser/appServerGitHubService.js';
import { Event } from '../../base/common/event.js';
import { createDisconnectedLanguageServerService } from '../../platform/language/browser/languageServerService.js';
import { createDisconnectedAppServerApi, createDisconnectedResourceApi, createDisconnectedServerEventApi, createDisconnectedSkillOperations, createDisconnectedHookOperations } from '../../platform/agentHost/browser/appServerApi.js';
import { createDisconnectedFileApi } from '../../platform/files/browser/fileApi.js';
import { createDisconnectedExtensionApi } from '../../platform/extensions/browser/extensionApi.js';
import { createDisconnectedSyntaxApi } from '../../platform/syntax/browser/syntaxApi.js';
import { unavailableOperation, WebAppServerUnavailableError } from '../../platform/agentHost/browser/disconnectedAppServer.js';
import { createDisconnectedContentSearchApi, createDisconnectedContentSearchConfigurationApi } from '../../platform/search/browser/searchApi.js';
import { createDisconnectedAgentHostInputCompletionService, createDisconnectedAgentSessionService, createDisconnectedAgentThreadService, createDisconnectedAgentTurnService } from '../../platform/agentHost/browser/appServerAgentService.js';
import { createDisconnectedAgentModelsService } from '../../platform/models/browser/appServerAgentModels.js';
import { DisconnectedTerminalProcessService } from '../../platform/terminal/browser/disconnectedTerminalProcessService.js';
import { createDisconnectedDocumentCollaborationApi } from '../../platform/collab/browser/documentCollaborationApi.js';
import { createDisconnectedCodebaseApi } from '../../platform/codebase/browser/codebaseApi.js';
import { createDisconnectedCodebaseSymbolsApi } from '../../platform/codebaseSymbols/browser/codebaseSymbolsApi.js';
import { createDisconnectedConnectorApi } from '../../platform/connectors/browser/connectorApi.js';
import { createDisconnectedToolSearchApi } from '../../platform/toolSearch/browser/toolSearchApi.js';
import { createDisconnectedLanguageApi } from '../../platform/language/browser/languageApi.js';
import { createDisconnectedPluginManagementApi } from '../../platform/extensionManagement/browser/pluginManagementApi.js';
import { createDisconnectedExtensionHostApi } from '../../platform/extensions/browser/extensionHostApi.js';
import { createDisconnectedExtensionsApi } from '../../platform/extensionManagement/browser/extensionManagementApi.js';
import { createDisconnectedWorkspaceTrustApi } from '../../platform/workspace/browser/workspaceTrustApi.js';
import { createDisconnectedAgentCapabilitiesApi } from '../../platform/agentCapabilities/browser/agentCapabilitiesApi.js';
import { createDisconnectedAgentToolsApi } from '../../platform/agentHost/browser/agentToolsApi.js';
import { createDisconnectedMcpServerStatusApi } from '../../platform/mcp/browser/mcpServerStatusApi.js';
import { createDisconnectedMcpServerManagementService } from '../../platform/mcp/browser/appServerMcpServerManagementService.js';
import { createDisconnectedTraceSettingsApi } from '../../platform/trace/browser/traceSettingsApi.js';
import { createDisconnectedAccountApi } from '../../platform/accounts/browser/accountApi.js';
import { createDisconnectedTurnChangesApi } from '../../platform/turnChanges/browser/turnChangesApi.js';
import { createDisconnectedTeamApi } from '../../platform/teams/browser/teamApi.js';

/** Optional product capabilities contributed by a statically selected host bundle. */
export interface WorkbenchHostCapabilities {
	readonly debugAdapter?: IDebugAdapterProcessService;
	readonly localTranscription?: ILocalTranscriptionService;
	readonly localTranscriptionModels?: ILocalTranscriptionModelService;
}

/** Merges product capabilities while rejecting two contributions that claim the same slot. */
export function mergeWorkbenchHostCapabilities(capabilities: readonly WorkbenchHostCapabilities[]): WorkbenchHostCapabilities {
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

/** Startup composition only. Runtime consumers inject the individual domain services. */
export interface IWorkbenchHost extends IAgentConnection, WorkbenchHostCapabilities {
	readonly dictation?: IVoiceCodeTranscriptionBackendService;
	/** Native local connection remains distinct when the window's primary host is remote. */
	readonly localTcp?: import('../../platform/network/common/tcp.js').ITcpService;
	/** Actual local OS user directory when supplied by the desktop host. */
	readonly localUserHome?: URI;
	/** Granted local profile directory; absent in browser-only hosts. */
	readonly userDataHome?: URI;
	/** Opens this host's profile TOML; absent when the host cannot edit a local profile. */
	readonly editUserConfiguration?: () => Promise<void>;
	readonly remote?: IRemoteAgentApi;
	/** Optional because web hosts cannot restart into a host-owned SSH connection. */
	readonly remoteConnections?: IRemoteConnectionApi;
	/** Additional backend scopes are available only in hosts with a multi-host window owner. */
	readonly agentHosts?: IRemoteAgentHostService;
}

export { WebAppServerUnavailableError };

/** Builds disconnected domain ports; Desktop keeps host support while its carrier is offline. */
export function createDisconnectedRendererApi(isAvailable = false): IWorkbenchHost {
	const appServer = createDisconnectedAppServerApi(unavailableOperation, isAvailable);
	return {
		appServer,
		accounts: createDisconnectedAccountApi(unavailableOperation),
		completions: createDisconnectedAgentHostInputCompletionService(),
		session: createDisconnectedAgentSessionService(unavailableOperation),
		teams: createDisconnectedTeamApi(unavailableOperation),
		model: createDisconnectedAgentModelsService(unavailableOperation),
		secretStorage: createDisconnectedSecretStorageStatusService(unavailableOperation),
		thread: createDisconnectedAgentThreadService(unavailableOperation),
		turn: createDisconnectedAgentTurnService(unavailableOperation),
		turnChanges: createDisconnectedTurnChangesApi(unavailableOperation),
		skills: createDisconnectedSkillOperations(unavailableOperation),
		instructions: createDisconnectedInstructionService(unavailableOperation),
		documentCollaboration: createDisconnectedDocumentCollaborationApi(unavailableOperation),
		resource: createDisconnectedResourceApi(unavailableOperation),
		extensions: createDisconnectedExtensionApi(unavailableOperation),
		extensionHost: createDisconnectedExtensionHostApi(unavailableOperation),
		fs: createDisconnectedFileApi(unavailableOperation),
		syntax: createDisconnectedSyntaxApi(unavailableOperation),
		language: createDisconnectedLanguageApi(unavailableOperation),
		languageServers: createDisconnectedLanguageServerService(unavailableOperation),
		extensionBackend: { request: () => unavailableOperation('extensionBackend.request') },
		fileSearch: createDisconnectedFileSearchApi(unavailableOperation),
		contentSearch: createDisconnectedContentSearchApi(unavailableOperation),
		contentSearchConfiguration: createDisconnectedContentSearchConfigurationApi(unavailableOperation),
		terminal: new DisconnectedTerminalProcessService(unavailableOperation, appServer),
		projects: { addSession: () => unavailableOperation('project/session/link'), moveSession: (_id, _from, to) => unavailableOperation(to ? 'project/session/link' : 'project/session/unlink'), moveExternalConversation: () => unavailableOperation('project/conversation/membership'), onDidChange: Event.None, list: () => unavailableOperation('project/list'), read: () => unavailableOperation('project/read'), create: () => unavailableOperation('project/create'), update: () => unavailableOperation('project/details/update'), setAppearance: () => unavailableOperation('project/appearance/update'), archive: () => unavailableOperation('project/archive'), restore: () => unavailableOperation('project/restore'), remove: () => unavailableOperation('project/delete') },
		assets: {
			getCatalog: () => unavailableOperation('asset/catalog'),
			updateEntry: () => unavailableOperation('asset/catalog/update'),
			createCollection: () => unavailableOperation('asset/collection/create'),
			deleteCollection: () => unavailableOperation('asset/collection/delete'),
			importImage: () => unavailableOperation('asset/import'),
			getVersion: () => unavailableOperation('asset/version'),
			readVersion: () => unavailableOperation('asset/read'),
		},
		testing: { onDidUpdate: Event.None, onDidDisconnect: Event.None, discover: unavailableOperation, run: unavailableOperation, prepareDebug: unavailableOperation, read: unavailableOperation, cancel: unavailableOperation, release: unavailableOperation },
		events: createDisconnectedServerEventApi(),
		codebase: createDisconnectedCodebaseApi(unavailableOperation),
		codebaseSymbols: createDisconnectedCodebaseSymbolsApi(unavailableOperation),
		connectors: createDisconnectedConnectorApi(unavailableOperation),
		plugins: createDisconnectedPluginManagementApi(unavailableOperation),
		localGit: createDisconnectedLocalGitService(unavailableOperation),
		extensionManagement: createDisconnectedExtensionsApi(unavailableOperation),
		toolSearch: createDisconnectedToolSearchApi(unavailableOperation),
		workspaceTrust: createDisconnectedWorkspaceTrustApi(unavailableOperation),
		networkDiagnostics: createDisconnectedNetworkDiagnosticsApi(unavailableOperation),
		issueReporter: createDisconnectedIssueReporterService(unavailableOperation),
		github: createDisconnectedGitHubService(),
		agentCapabilities: createDisconnectedAgentCapabilitiesApi(unavailableOperation),
		agentTools: createDisconnectedAgentToolsApi(unavailableOperation),
		mcpServerStatus: createDisconnectedMcpServerStatusApi(unavailableOperation),
		mcpServerManagement: createDisconnectedMcpServerManagementService(unavailableOperation),
		traceSettings: createDisconnectedTraceSettingsApi(unavailableOperation),
		executionSettings: createDisconnectedExecutionSettingsService(unavailableOperation),
		hooks: createDisconnectedHookOperations(unavailableOperation),
	};
}
