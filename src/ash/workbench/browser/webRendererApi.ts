import { AppServerProjectService } from '../../platform/projects/browser/appServerProjectService.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import type { AppServerFrameDecoder } from '../../platform/agentHost/browser/appServerFrameDecoder.js';
import { AgentHostResourceService } from '../services/agentHost/common/agentHostResourceService.js';
import { registerAgentHostResourceHost } from '../../platform/agentHost/browser/agentHostResourceHost.js';
import type { IAppServerConnectionRecovery } from '../../platform/agentHost/common/appServerApi.js';
import { AppServerChannelService } from '../../platform/collab/browser/appServerChannelService.js';
import { createAppServerSecretStorageStatusService } from '../../platform/secrets/browser/appServerSecretStorageStatusService.js';
import { AppServerMessageHistoryService } from '../../platform/messageHistory/browser/appServerMessageHistoryService.js';
import { createExtensionBackendApi } from '../../platform/agentHost/browser/extensionBackendApi.js';
import { createAppServerExecutionSettingsService } from '../../platform/agentHost/browser/appServerExecutionSettingsService.js';
import { AppServerSymphonyService } from '../../platform/symphony/browser/appServerSymphonyService.js';
import { createAppServerInstructionService } from '../../platform/instructions/browser/appServerInstructionService.js';
import { createAppServerFileSearchApi } from '../../platform/search/browser/fileSearchApi.js';
import { AppServerAssetService } from '../../platform/assets/browser/appServerAssetService.js';
import { AppServerIssueReporterService } from '../../platform/issue/browser/appServerIssueReporterService.js';
import { AppServerGitHubService } from '../../platform/github/browser/appServerGitHubService.js';
import { AppServerLocalGitService } from '../../platform/git/browser/appServerLocalGitService.js';
import { createAppServerNetworkDiagnosticsApi } from '../../platform/networkDiagnostics/browser/networkDiagnosticsApi.js';
import { AppServerTestExecutionService } from '../../platform/testing/browser/appServerTestExecutionService.js';
import { createAppServerLanguageServerService } from '../../platform/language/browser/languageServerService.js';
import { AppServerCallService } from '../../platform/call/browser/appServerCallService.js';
import { AppServerApprovalEnvironmentService } from '../../platform/approvalEnvironment/browser/appServerApprovalEnvironmentService.js';
import { AppServerMemoriesService } from '../../platform/memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../platform/memory/browser/appServerMemoryDiagnosticsService.js';
import { generateUuid } from '../../base/common/uuid.js';
import {
	createAppServerAppServerApi,
	createAppServerResourceApi,
	createAppServerServerEventApi,
	createAppServerSkillOperations,
	createAppServerHookOperations,
} from '../../platform/agentHost/browser/appServerApi.js';
import { type AppServerTransport } from '../../platform/agentHost/common/appServerTransport.js';
import {
	AppServerConnectionRecovery,
	AppServerProtocolClient,
	type AppServerProtocolClientOptions,
	type AppServerConnectionMetadata,
} from '../../platform/agentHost/browser/appServerProtocolClient.js';
import { createAppServerFileApi } from '../../platform/files/browser/fileApi.js';
import { createAppServerExtensionApi } from '../../platform/extensions/browser/extensionApi.js';
import { createAppServerSyntaxApi } from '../../platform/syntax/browser/syntaxApi.js';
import { mergeRendererHostCapabilities, type IRendererHost, type RendererHostCapabilities } from '../../platform/renderer/common/rendererHost.js';
import { createAppServerContentSearchApi, createAppServerContentSearchConfigurationApi } from '../../platform/search/browser/searchApi.js';
import { createAppServerAgentSessionService, createAppServerAgentThreadService, createAppServerAgentTurnService } from '../../platform/agentHost/browser/appServerAgentService.js';
import { createAppServerAgentModelsService } from '../../platform/agentHost/browser/appServerAgentModels.js';
import { AppServerTerminalProcessService } from '../../platform/terminal/browser/appServerTerminalProcessService.js';
import { createAppServerDocumentCollaborationApi } from '../../platform/collab/browser/documentCollaborationApi.js';
import { createAppServerCodebaseApi } from '../../platform/codebase/browser/codebaseApi.js';
import { createAppServerCodebaseSymbolsApi } from '../../platform/codebaseSymbols/browser/codebaseSymbolsApi.js';
import { createAppServerConnectorApi, type BrowserConnectorHostServices } from '../../platform/connectors/browser/connectorApi.js';
import { createAppServerToolSearchApi } from '../../platform/toolSearch/browser/toolSearchApi.js';
import { createAppServerLanguageApi } from '../../platform/language/browser/languageApi.js';
import { createAppServerPluginManagementApi } from '../../platform/extensionManagement/browser/pluginManagementApi.js';
import { createAppServerExtensionHostApi } from '../../platform/agentHost/browser/extensionHostApi.js';
import { createAppServerExtensionManagementApi } from '../../platform/extensionManagement/browser/extensionManagementApi.js';
import { createAppServerWorkspaceTrustApi } from '../../platform/workspace/browser/workspaceTrustApi.js';
import { createAppServerAgentCapabilitiesApi } from '../../platform/agentCapabilities/browser/agentCapabilitiesApi.js';
import { createAppServerAgentToolsApi } from '../../platform/agentHost/browser/agentToolsApi.js';
import { createAppServerMcpServerStatusApi } from '../../platform/mcp/browser/mcpServerStatusApi.js';
import { AppServerMcpServerManagementService } from '../../platform/mcp/browser/appServerMcpServerManagementService.js';
import { createAppServerTraceSettingsApi } from '../../platform/trace/browser/traceSettingsApi.js';
import { createAppServerAccountApi } from '../../platform/accounts/browser/accountApi.js';
import { createAppServerTurnChangesApi } from '../../platform/turnChanges/browser/turnChangesApi.js';
import { AppServerAutomationService } from '../../platform/agentHost/browser/appServerAutomationService.js';
import { createAppServerTeamApi } from '../../platform/teams/browser/teamApi.js';

export type RendererCapabilityContribution = (connection: AppServerProtocolClient, appServer: IRendererHost['appServer']) => RendererHostCapabilities;

export interface ConnectedWebRendererApi {
	readonly api: IRendererHost;
	readonly metadata: AppServerConnectionMetadata;
	dispose(): void;
}

/** Connects a browser Renderer host through its transport. */
export async function connectWebRendererApi(
	transport: AppServerTransport,
	connectorHostServices: BrowserConnectorHostServices,
	options: AppServerProtocolClientOptions = {},
	contributions: readonly RendererCapabilityContribution[] = [],
	decoder?: AppServerFrameDecoder,
): Promise<ConnectedWebRendererApi> {
	const connection = new AppServerProtocolClient(
		transport,
		{
			...options,
			capabilities: {
				agentInteractions: { version: 1, kinds: ['approval', 'permissions', 'userInput'] },
				...options.capabilities,
			},
		},
		decoder,
	);
	let metadata: AppServerConnectionMetadata;
	const recovery = new AppServerConnectionRecovery(
		connection,
		async () => {
			connection.disconnect();
			metadata = await connection.connect();
		},
		() => {},
		{
			autoRestore: true,
			initialDelayMs: 500,
			maxDelayMs: 10_000,
			maxAttempts: Number.POSITIVE_INFINITY,
			maxElapsedTimeMs: 5 * 60_000,
		},
	);
	try {
		await recovery.connect();
		const instanceId = generateUuid();
		const memoryDiagnostics =
			connection.capabilities?.contracts.memoryDiagnostics?.version === 1
				? new AppServerMemoryDiagnosticsService(connection, 'browser', async () => [
						{
							instanceId,
							processId: null,
							role: 'renderer',
							phase: 'unknown',
							metrics: [
								{
									kind: 'domNodes',
									value: document.getElementsByTagName('*').length,
									unavailable: null,
								},
								{ kind: 'javaScriptHeapBytes', value: null, unavailable: 'unsupported' },
								{ kind: 'residentBytes', value: null, unavailable: 'unsupported' },
							],
						},
					])
				: undefined;
		const memories = connection.capabilities?.memories ? new AppServerMemoriesService(connection) : undefined;
		const channels = connection.capabilities?.contracts.channels?.version === 1 ? new AppServerChannelService(connection) : undefined;
		const calls = connection.capabilities?.contracts.calls?.version === 1 ? new AppServerCallService(connection, false) : undefined;
		const symphony = connection.capabilities?.contracts.symphony?.version === 1 ? new AppServerSymphonyService(connection) : undefined;
		const automation = connection.capabilities?.contracts.automation?.version === 1 ? new AppServerAutomationService(connection) : undefined;
		const api = {
			...createRendererHost(connection, connectorHostServices, contributions, undefined, recovery),
			channels,
			calls,
			automation,
			symphony,
			memoryDiagnostics,
			memories,
		};
		return {
			api,
			metadata: metadata!,
			dispose: () => {
				recovery.dispose();
				memories?.dispose();
				memoryDiagnostics?.dispose();
				automation?.dispose();
				symphony?.dispose();
				calls?.dispose();
				channels?.dispose();
				api.mcpServerManagement.dispose();
				api.contextResourceHost?.dispose();
				connection.dispose();
			},
		};
	} catch (error) {
		recovery.dispose();
		connection.dispose();
		throw error;
	}
}

/**
 * Workbench composes domain adapters; the supplied client remains the connection owner.
 * For a host-bound SSH client, domain paths retain that host while the wire uses server-local paths.
 */
export function createRendererHost(
	connection: AppServerProtocolClient,
	connectorHostServices: BrowserConnectorHostServices,
	contributions: readonly RendererCapabilityContribution[],
	sshHost?: string,
	recovery?: IAppServerConnectionRecovery,
): IRendererHost {
	const contextResourceHost = connection.capabilities?.contracts.hostResources?.version === 1 ? new DisposableStore() : undefined;
	const snapshots = contextResourceHost?.add(new AgentHostResourceService());
	try {
		if (contextResourceHost && snapshots) {
			contextResourceHost.add(registerAgentHostResourceHost(connection, snapshots));
		}
		const appServer = createAppServerAppServerApi(connection, recovery);
		const resource = createAppServerResourceApi(connection);
		const capabilities = mergeRendererHostCapabilities(contributions.map(contribution => contribution(connection, appServer)));
		return {
			appServer,
			contextResourceHost,
			hasAppServer: true,
			messageHistory: connection.capabilities?.contracts.messageHistory?.version === 1 ? new AppServerMessageHistoryService(connection) : undefined,
			approvalEnvironment: connection.capabilities?.approvalEnvironment ? new AppServerApprovalEnvironmentService(connection) : undefined,
			accounts: createAppServerAccountApi(connection, connectorHostServices),
			session: createAppServerAgentSessionService(connection, sshHost),
			teams: createAppServerTeamApi(connection),
			model: createAppServerAgentModelsService(connection),
			secretStorage: createAppServerSecretStorageStatusService(connection),
			thread: createAppServerAgentThreadService(connection, sshHost, snapshots),
			turn: createAppServerAgentTurnService(connection, snapshots),
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
			projects: new AppServerProjectService(connection),
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
	} catch (error) {
		contextResourceHost?.dispose();
		throw error;
	}
}
