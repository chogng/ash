import { createDisconnectedSecretStorageStatusService } from '../../secrets/browser/appServerSecretStorageStatusService.js';
import { createDisconnectedLocalGitService } from '../../git/browser/appServerLocalGitService.js';
import { createDisconnectedExecutionSettingsService } from './appServerExecutionSettingsService.js';
import { createDisconnectedInstructionService } from '../../instructions/browser/appServerInstructionService.js';
import { createDisconnectedFileSearchApi } from '../../search/browser/fileSearchApi.js';
import { createDisconnectedNetworkDiagnosticsApi } from '../../networkDiagnostics/browser/networkDiagnosticsApi.js';
import { createDisconnectedIssueReporterService } from '../../issue/browser/appServerIssueReporterService.js';
import { createDisconnectedGitHubService } from '../../github/browser/appServerGitHubService.js';
import { Event } from '../../../base/common/event.js';
import { createDisconnectedLanguageServerService } from "../../language/browser/languageServerService.js";
import { createDisconnectedAppServerApi, createDisconnectedResourceApi, createDisconnectedServerEventApi, createDisconnectedSkillOperations, createDisconnectedHookOperations } from "./appServerApi.js";
import { createDisconnectedFileApi } from "../../files/browser/fileApi.js";
import { createDisconnectedExtensionApi } from "../../extensions/browser/extensionApi.js";
import { createDisconnectedSyntaxApi } from "../../syntax/browser/syntaxApi.js";
import type { IRendererHost } from "../../renderer/common/rendererHost.js";
import { unavailableOperation, WebAppServerUnavailableError } from "../../renderer/browser/disconnectedHost.js";
import { createDisconnectedContentSearchApi, createDisconnectedContentSearchConfigurationApi } from "../../search/browser/searchApi.js";
import { createDisconnectedAgentSessionService, createDisconnectedAgentThreadService, createDisconnectedAgentTurnService } from "./appServerAgentService.js";
import { createDisconnectedAgentModelsService } from "./appServerAgentModels.js";
import { DisconnectedTerminalProcessService } from "../../terminal/browser/disconnectedTerminalProcessService.js";
import { createDisconnectedDocumentCollaborationApi } from "../../collaboration/browser/documentCollaborationApi.js";
import { createDisconnectedCodebaseApi } from "../../codebase/browser/codebaseApi.js";
import { createDisconnectedCodebaseSymbolsApi } from "../../codebaseSymbols/browser/codebaseSymbolsApi.js";
import { createDisconnectedConnectorApi } from "../../connectors/browser/connectorApi.js";
import { createDisconnectedToolSearchApi } from "../../toolSearch/browser/toolSearchApi.js";
import { createDisconnectedLanguageApi } from "../../language/browser/languageApi.js";
import { createDisconnectedPluginManagementApi } from "../../extensionManagement/browser/pluginManagementApi.js";
import { createDisconnectedExtensionHostApi } from './extensionHostApi.js';
import { createDisconnectedExtensionsApi } from "../../extensionManagement/browser/extensionManagementApi.js";
import { createDisconnectedWorkspaceTrustApi } from '../../workspace/browser/workspaceTrustApi.js';
import { createDisconnectedAgentCapabilitiesApi } from '../../agentCapabilities/browser/agentCapabilitiesApi.js';
import { createDisconnectedMcpServerStatusApi } from '../../mcp/browser/mcpServerStatusApi.js';
import { createDisconnectedMcpServerManagementService } from '../../mcp/browser/appServerMcpServerManagementService.js';
import { createDisconnectedTraceSettingsApi } from '../../trace/browser/traceSettingsApi.js';
import { createDisconnectedAccountApi } from "../../accounts/browser/accountApi.js";
import { createDisconnectedTurnChangesApi } from "../../turnChanges/browser/turnChangesApi.js";
import { createDisconnectedTeamApi } from '../../teams/browser/teamApi.js';

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
		mcpServerStatus: createDisconnectedMcpServerStatusApi(unavailableOperation),
		mcpServerManagement: createDisconnectedMcpServerManagementService(unavailableOperation),
		traceSettings: createDisconnectedTraceSettingsApi(unavailableOperation),
		executionSettings: createDisconnectedExecutionSettingsService(unavailableOperation),
		hooks: createDisconnectedHookOperations(unavailableOperation),
	};
}
