import { createAppServerSecretStorageStatusService } from '../../secrets/browser/appServerSecretStorageStatusService.js';
import { AppServerMessageHistoryService } from '../../messageHistory/browser/appServerMessageHistoryService.js';
import { createExtensionBackendApi } from './extensionBackendApi.js';
import { createAppServerExecutionSettingsService } from './appServerExecutionSettingsService.js';
import { AppServerSymphonyService } from '../../symphony/browser/appServerSymphonyService.js';
import { createAppServerInstructionService } from '../../instructions/browser/appServerInstructionService.js';
import { createAppServerFileSearchApi } from '../../search/browser/fileSearchApi.js';
import { AppServerAssetService } from '../../assets/browser/appServerAssetService.js';
import { AppServerIssueReporterService } from '../../issue/browser/appServerIssueReporterService.js';
import { AppServerGitHubService } from '../../github/browser/appServerGitHubService.js';
import { AppServerLocalGitService } from '../../git/browser/appServerLocalGitService.js';
import { createAppServerNetworkDiagnosticsApi } from '../../networkDiagnostics/browser/networkDiagnosticsApi.js';
import { AppServerTestExecutionService } from '../../testing/browser/appServerTestExecutionService.js';
import { createAppServerLanguageServerService } from "../../language/browser/languageServerService.js";
import { AppServerCallService } from '../../call/browser/appServerCallService.js';
import { AppServerApprovalEnvironmentService } from '../../approvalEnvironment/browser/appServerApprovalEnvironmentService.js';
import { AppServerMemoriesService } from '../../memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../memory/browser/appServerMemoryDiagnosticsService.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createAppServerAppServerApi, createAppServerResourceApi, createAppServerServerEventApi, createAppServerSkillOperations, createAppServerHookOperations } from "./appServerApi.js";
import { type AppServerTransport } from "../common/appServerTransport.js";
import { AppServerProtocolClient, type AppServerProtocolClientOptions, type AppServerConnectionMetadata } from "./appServerProtocolClient.js";
import { createAppServerFileApi } from "../../files/browser/fileApi.js";
import { createAppServerExtensionApi } from "../../extensions/browser/extensionApi.js";
import { createAppServerSyntaxApi } from "../../syntax/browser/syntaxApi.js";
import { mergeRendererHostCapabilities, type IRendererHost, type RendererHostCapabilities } from "../../renderer/common/rendererHost.js";
import { createAppServerContentSearchApi, createAppServerContentSearchConfigurationApi } from "../../search/browser/searchApi.js";
import { createAppServerAgentSessionService, createAppServerAgentThreadService, createAppServerAgentTurnService } from "./appServerAgentService.js";
import { createAppServerAgentModelsService } from "./appServerAgentModels.js";
import { AppServerTerminalProcessService } from "../../terminal/browser/appServerTerminalProcessService.js";
import { createAppServerDocumentCollaborationApi } from "../../collaboration/browser/documentCollaborationApi.js";
import { createAppServerCodebaseApi } from "../../codebase/browser/codebaseApi.js";
import { createAppServerCodebaseSymbolsApi } from "../../codebaseSymbols/browser/codebaseSymbolsApi.js";
import { createAppServerConnectorApi, type BrowserConnectorHostServices } from "../../connectors/browser/connectorApi.js";
import { createAppServerToolSearchApi } from "../../toolSearch/browser/toolSearchApi.js";
import { createAppServerLanguageApi } from "../../language/browser/languageApi.js";
import { createAppServerPluginManagementApi } from "../../extensionManagement/browser/pluginManagementApi.js";
import { createAppServerExtensionHostApi } from './extensionHostApi.js';
import { createAppServerExtensionManagementApi } from "../../extensionManagement/browser/extensionManagementApi.js";
import { createAppServerWorkspaceTrustApi } from '../../workspace/browser/workspaceTrustApi.js';
import { createAppServerAgentCapabilitiesApi } from '../../agentCapabilities/browser/agentCapabilitiesApi.js';
import { createAppServerAgentToolsApi } from './agentToolsApi.js';
import { createAppServerMcpServerStatusApi } from '../../mcp/browser/mcpServerStatusApi.js';
import { AppServerMcpServerManagementService } from '../../mcp/browser/appServerMcpServerManagementService.js';
import { createAppServerTraceSettingsApi } from '../../trace/browser/traceSettingsApi.js';
import { createAppServerAccountApi } from "../../accounts/browser/accountApi.js";
import { createAppServerTurnChangesApi } from "../../turnChanges/browser/turnChangesApi.js";
import { AppServerAutomationService } from '../../automation/browser/appServerAutomationService.js';
import { createAppServerTeamApi } from '../../teams/browser/teamApi.js';

export type RendererCapabilityContribution = (connection: AppServerProtocolClient, appServer: IRendererHost["appServer"]) => RendererHostCapabilities;

export interface ConnectedWebRendererApi {
	readonly api: IRendererHost;
	readonly metadata: AppServerConnectionMetadata;
	dispose(): void;
}

/** Connects a browser Renderer host through its transport. */
export async function connectWebRendererApi(transport: AppServerTransport, connectorHostServices: BrowserConnectorHostServices, options: AppServerProtocolClientOptions = {}, contributions: readonly RendererCapabilityContribution[] = []): Promise<ConnectedWebRendererApi> {
	const connection = new AppServerProtocolClient(transport, { ...options, capabilities: { agentInteractions: { version: 1, kinds: ['approval', 'userInput'] }, ...options.capabilities } });
	try {
		const metadata = await connection.connect();
		let disposed = false;
		let reconnecting = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let releaseWait: (() => void) | undefined;
		const reconnect = connection.onStateChange(state => {
			if (state !== 'crashed' || disposed || reconnecting) { return; }
			reconnecting = true;
			void (async () => {
				const deadline = Date.now() + 5 * 60_000;
				let delay = 500;
				try {
					while (!disposed && connection.state === 'crashed' && Date.now() < deadline) {
						await new Promise<void>(resolve => { releaseWait = resolve; retryTimer = setTimeout(resolve, delay); });
						releaseWait = undefined;
						if (disposed || connection.state !== 'crashed') { return; }
						try { await connection.connect(); return; }
						catch { delay = Math.min(delay * 2, 10_000); }
					}
				} finally { reconnecting = false; }
			})();
		});
		const instanceId = generateUuid();
		const memoryDiagnostics = connection.capabilities?.contracts.memoryDiagnostics?.version === 1 ? new AppServerMemoryDiagnosticsService(connection, 'browser', async () => [{ instanceId, processId: null, role: 'renderer', phase: 'unknown', metrics: [{ kind: 'domNodes', value: document.getElementsByTagName('*').length, unavailable: null }, { kind: 'javaScriptHeapBytes', value: null, unavailable: 'unsupported' }, { kind: 'residentBytes', value: null, unavailable: 'unsupported' }] }]) : undefined;
		const memories = connection.capabilities?.memories ? new AppServerMemoriesService(connection) : undefined;
		const calls = connection.capabilities?.contracts.calls?.version === 1 ? new AppServerCallService(connection) : undefined;
		const symphony = connection.capabilities?.contracts.symphony?.version === 1 ? new AppServerSymphonyService(connection) : undefined;
		const automation = connection.capabilities?.contracts.automation?.version === 1 ? new AppServerAutomationService(connection) : undefined;
		const api = { ...createRendererHost(connection, connectorHostServices, contributions), calls, automation, symphony, memoryDiagnostics, memories };
		return {
			api,
			metadata,
			dispose: () => { disposed = true; reconnect.dispose(); clearTimeout(retryTimer); releaseWait?.(); memories?.dispose(); memoryDiagnostics?.dispose(); automation?.dispose(); symphony?.dispose(); calls?.dispose(); api.mcpServerManagement.dispose(); connection.dispose(); },
		};
	} catch (error) {
		connection.dispose();
		throw error;
	}
}

export function createRendererHost(connection: AppServerProtocolClient, connectorHostServices: BrowserConnectorHostServices, contributions: readonly RendererCapabilityContribution[]): IRendererHost {
	const appServer = createAppServerAppServerApi(connection);
	const resource = createAppServerResourceApi(connection);
	const capabilities = mergeRendererHostCapabilities(contributions.map(contribution => contribution(connection, appServer)));
	return {
		appServer,
		hasAppServer: true,
		messageHistory: connection.capabilities?.contracts.messageHistory?.version === 1 ? new AppServerMessageHistoryService(connection) : undefined,
		approvalEnvironment: connection.capabilities?.approvalEnvironment ? new AppServerApprovalEnvironmentService(connection) : undefined,
		accounts: createAppServerAccountApi(connection, connectorHostServices),
		session: createAppServerAgentSessionService(connection),
		teams: createAppServerTeamApi(connection),
		model: createAppServerAgentModelsService(connection),
		secretStorage: createAppServerSecretStorageStatusService(connection),
		thread: createAppServerAgentThreadService(connection),
		turn: createAppServerAgentTurnService(connection),
		turnChanges: createAppServerTurnChangesApi(connection),
		skills: createAppServerSkillOperations(connection),
		instructions: createAppServerInstructionService(connection),
		documentCollaboration: createAppServerDocumentCollaborationApi(connection),
		resource,
		extensions: createAppServerExtensionApi(connection, resource),
		extensionHost: createAppServerExtensionHostApi(connection),
		extensionBackend: createExtensionBackendApi(connection),
		fs: createAppServerFileApi(connection),
		syntax: createAppServerSyntaxApi(connection),
		language: createAppServerLanguageApi(connection),
		languageServers: createAppServerLanguageServerService(connection),
		fileSearch: createAppServerFileSearchApi(connection),
		contentSearch: createAppServerContentSearchApi(connection),
		contentSearchConfiguration: createAppServerContentSearchConfigurationApi(connection),
		terminal: new AppServerTerminalProcessService(connection, appServer),
		assets: new AppServerAssetService(connection),
		testing: new AppServerTestExecutionService(connection),
		...capabilities,
		events: createAppServerServerEventApi(connection),
		codebase: createAppServerCodebaseApi(connection),
		codebaseSymbols: createAppServerCodebaseSymbolsApi(connection),
		connectors: createAppServerConnectorApi(connection, connectorHostServices),
		plugins: createAppServerPluginManagementApi(connection),
		localGit: new AppServerLocalGitService(connection),
		extensionManagement: createAppServerExtensionManagementApi(connection),
		toolSearch: createAppServerToolSearchApi(connection),
		workspaceTrust: createAppServerWorkspaceTrustApi(connection),
		networkDiagnostics: createAppServerNetworkDiagnosticsApi(connection),
		issueReporter: new AppServerIssueReporterService(connection),
		github: new AppServerGitHubService(connection),
		agentCapabilities: createAppServerAgentCapabilitiesApi(connection),
		agentTools: createAppServerAgentToolsApi(connection),
		mcpServerStatus: createAppServerMcpServerStatusApi(connection),
		mcpServerManagement: new AppServerMcpServerManagementService(connection, connectorHostServices),
		traceSettings: createAppServerTraceSettingsApi(connection),
		executionSettings: createAppServerExecutionSettingsService(connection),
		hooks: createAppServerHookOperations(connection),
	};
}
