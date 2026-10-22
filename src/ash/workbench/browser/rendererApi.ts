import { createDisconnectedSecretStorageStatusService } from '../../platform/secrets/browser/appServerSecretStorageStatusService.js';
import { createDisconnectedLocalGitService } from '../../platform/git/browser/appServerLocalGitService.js';
import { createDisconnectedExecutionSettingsService } from '../../platform/agentHost/browser/appServerExecutionSettingsService.js';
import { createDisconnectedInstructionService } from '../../platform/instructions/browser/appServerInstructionService.js';
import { createDisconnectedFileSearchApi } from '../../platform/search/browser/fileSearchApi.js';
import { createDisconnectedNetworkDiagnosticsApi } from '../../platform/networkDiagnostics/browser/networkDiagnosticsApi.js';
import { createDisconnectedIssueReporterService } from '../../platform/issue/browser/appServerIssueReporterService.js';
import { createDisconnectedGitHubService } from '../../platform/github/browser/appServerGitHubService.js';
import { Event } from '../../base/common/event.js';
import { createDisconnectedLanguageServerService } from "../../platform/language/browser/languageServerService.js";
import { createDisconnectedAppServerApi, createDisconnectedResourceApi, createDisconnectedServerEventApi, createDisconnectedSkillOperations, createDisconnectedHookOperations } from "../../platform/agentHost/browser/appServerApi.js";
import { createDisconnectedFileApi } from "../../platform/files/browser/fileApi.js";
import { createDisconnectedExtensionApi } from "../../platform/extensions/browser/extensionApi.js";
import { createDisconnectedSyntaxApi } from "../../platform/syntax/browser/syntaxApi.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import { unavailableOperation, WebAppServerUnavailableError } from "../../platform/renderer/browser/disconnectedHost.js";
import { createDisconnectedContentSearchApi, createDisconnectedContentSearchConfigurationApi } from "../../platform/search/browser/searchApi.js";
import { createDisconnectedAgentSessionService, createDisconnectedAgentThreadService, createDisconnectedAgentTurnService } from "../../platform/agentHost/browser/appServerAgentService.js";
import { createDisconnectedAgentModelsService } from "../../platform/agentHost/browser/appServerAgentModels.js";
import { DisconnectedTerminalProcessService } from "../../platform/terminal/browser/disconnectedTerminalProcessService.js";
import { createDisconnectedDocumentCollaborationApi } from "../../platform/collaboration/browser/documentCollaborationApi.js";
import { createDisconnectedCodebaseApi } from "../../platform/codebase/browser/codebaseApi.js";
import { createDisconnectedCodebaseSymbolsApi } from "../../platform/codebaseSymbols/browser/codebaseSymbolsApi.js";
import { createDisconnectedConnectorApi } from "../../platform/connectors/browser/connectorApi.js";
import { createDisconnectedToolSearchApi } from "../../platform/toolSearch/browser/toolSearchApi.js";
import { createDisconnectedLanguageApi } from "../../platform/language/browser/languageApi.js";
import { createDisconnectedPluginManagementApi } from "../../platform/extensionManagement/browser/pluginManagementApi.js";
import { createDisconnectedExtensionHostApi } from '../../platform/agentHost/browser/extensionHostApi.js';
import { createDisconnectedExtensionsApi } from "../../platform/extensionManagement/browser/extensionManagementApi.js";
import { createDisconnectedWorkspaceTrustApi } from '../../platform/workspace/browser/workspaceTrustApi.js';
import { createDisconnectedAgentCapabilitiesApi } from '../../platform/agentCapabilities/browser/agentCapabilitiesApi.js';
import { createDisconnectedAgentToolsApi } from '../../platform/agentHost/browser/agentToolsApi.js';
import { createDisconnectedMcpServerStatusApi } from '../../platform/mcp/browser/mcpServerStatusApi.js';
import { createDisconnectedMcpServerManagementService } from '../../platform/mcp/browser/appServerMcpServerManagementService.js';
import { createDisconnectedTraceSettingsApi } from '../../platform/trace/browser/traceSettingsApi.js';
import { createDisconnectedAccountApi } from "../../platform/accounts/browser/accountApi.js";
import { createDisconnectedTurnChangesApi } from "../../platform/turnChanges/browser/turnChangesApi.js";
import { createDisconnectedTeamApi } from '../../platform/teams/browser/teamApi.js';

export { WebAppServerUnavailableError };

/** Composes the explicit disconnected capability set for standalone Web pages. */
export function createDisconnectedRendererApi(): IRendererHost {
	const appServer = createDisconnectedAppServerApi(unavailableOperation);
	return {
		hasAppServer: false,
		appServer,
		accounts: createDisconnectedAccountApi(unavailableOperation),
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
		projects: { onDidChange: Event.None, list: () => unavailableOperation("project/list"), read: () => unavailableOperation("project/read"), create: () => unavailableOperation("project/create"), update: () => unavailableOperation("project/details/update") },
		assets: {
			getCatalog: () => unavailableOperation("asset/catalog"),
			updateEntry: () => unavailableOperation("asset/catalog/update"),
			createCollection: () => unavailableOperation("asset/collection/create"),
			deleteCollection: () => unavailableOperation("asset/collection/delete"),
			importImage: () => unavailableOperation("asset/import"),
			getVersion: () => unavailableOperation("asset/version"),
			readVersion: () => unavailableOperation("asset/read"),
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
