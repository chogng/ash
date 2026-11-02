import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import type { IPlaywrightService } from '../../browserView/common/playwrightService.js';
import type { IBrowserViewOwner, IBrowserViewNetwork } from '../../browserView/common/browserView.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type * as Agent from './agent.js';
import type { IProjectService } from '../../projects/common/projectService.js';
import type { ISecretStorageStatusService } from '../../secrets/common/secrets.js';
import type { IMessageHistoryService } from '../../messageHistory/common/messageHistory.js';
import type { IExtensionBackendApi } from '../../extensions/common/extensionBackendApi.js';
import type { ISymphonyBackend } from '../../symphony/common/symphonyService.js';
import type { IInstructionService } from '../../instructions/common/instructionService.js';
import type { IFileSearchService } from '../../search/common/fileSearch.js';
import type { IAssetService } from '../../assets/common/assetService.js';
import type { IIssueReporterService } from '../../issue/common/issue.js';
import type { IGitHubService } from '../../github/common/githubService.js';
import type { ILocalGitService } from '../../git/common/localGitService.js';
import type { IBackupService } from '../../backup/common/backup.js';
import type { INetworkDiagnosticsService } from '../../networkDiagnostics/common/networkDiagnosticsService.js';
import type { IChannelService } from '../../collab/common/channelService.js';
import type { ICallService } from '../../call/common/callService.js';
import type { IApprovalEnvironmentService } from '../../approvalEnvironment/common/approvalEnvironmentService.js';
import type { IMemoriesService } from '../../memories/common/memoriesService.js';
import type { IMemoryDiagnosticsService } from '../../memory/common/memoryDiagnosticsService.js';
import type { IAppServerApi, IResourceApi, IServerEventApi, IAppServerSkillApi, IAppServerHookApi } from './appServerApi.js';
import type { IExtensionApi } from '../../extensions/common/extensionApi.js';
import type { IFileApi } from '../../files/common/fileApi.js';
import type { ISyntaxApi } from '../../syntax/common/syntaxApi.js';
import type { IContentSearchConfigurationService } from '../../search/common/search.js';
import type { IContentSearchApi } from '../../search/common/searchApi.js';
import type { IAgentModelsService } from '../../models/common/agentModels.js';
import type { ILanguageServerService } from '../../language/common/languageServerService.js';
import type { ITerminalProcessService } from '../../terminal/common/terminal.js';
import type { IDocumentCollaborationApi } from '../../collab/common/documentCollaborationApi.js';
import type { ICodebaseApi } from '../../codebase/common/codebaseApi.js';
import type { IConnectorApi } from '../../connectors/common/connectorApi.js';
import type { IToolSearchApi } from '../../toolSearch/common/toolSearchApi.js';
import type { ILanguageApi } from '../../language/common/languageApi.js';
import type { IPluginManagementApi } from '../../extensionManagement/common/pluginManagementApi.js';
import type { IExtensionHostApi } from '../../extensions/common/extensionHostApi.js';
import type { ICodebaseSymbolsApi } from '../../codebaseSymbols/common/codebaseSymbolsApi.js';
import type { IExtensionManagementApi } from '../../extensionManagement/common/extensionManagementApi.js';
import type { IWorkspaceTrustApi } from '../../workspace/common/workspaceTrust.js';
import type { IAgentCapabilitiesService } from '../../agentCapabilities/common/agentCapabilitiesService.js';
import type { IAgentToolsApi } from './agentToolsApi.js';
import type { IMcpServerStatusService } from '../../mcp/common/mcpServerStatusService.js';
import type { IMcpServerManagementService } from '../../mcp/common/mcpServerManagementService.js';
import type { IAgentExecutionSettingsService } from './agentExecutionSettingsService.js';
import type { ITraceSettingsService } from '../../trace/common/traceSettingsService.js';
import type { IAccountApi } from '../../accounts/common/accountApi.js';
import type { ITurnChangesApi } from '../../turnChanges/common/turnChangesApi.js';
import type { IAutomationBackendService } from '../../automations/common/automation.js';
import type { ITeamApi } from '../../teams/common/teamApi.js';
import type { IWorkspaceConfigurationFileApi } from '../../workspace/common/workspaceIpc.js';
import type { ITestExecutionService } from '../../testing/common/testExecutionService.js';

/** Domain capabilities borrowed from one backend connection. The runtime owns their lifetime and recovery. */
export interface IAgentConnection {
	readonly browserHost?: IAgentBrowserHostConnection;
	readonly tcp?: import('../../network/common/tcp.js').ITcpService;
	readonly workspaceConfigurationFiles?: IWorkspaceConfigurationFileApi;
	/** Connection-owned callback registrations and immutable context transfer leases. */
	readonly contextResourceHost?: IDisposable;
	/** Available when the host supplies profile-backed recovery storage. */
	readonly backup?: IBackupService;
	readonly assets: IAssetService;
	readonly projects: IProjectService;
	readonly testing: ITestExecutionService;
	readonly calls?: ICallService;
	readonly channels?: IChannelService;
	readonly agentVoice?: IAgentVoiceService;
	readonly automation?: IAutomationBackendService;
	readonly messageHistory?: IMessageHistoryService;
	readonly symphony?: ISymphonyBackend;
	readonly memoryDiagnostics?: IMemoryDiagnosticsService;
	readonly memories?: IMemoriesService;
	readonly approvalEnvironment?: IApprovalEnvironmentService;
	readonly appServer: IAppServerApi;
	readonly accounts: IAccountApi;
	readonly completions: IAgentHostInputCompletionService;
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

export const IAgentConnection = createServiceIdentifier<IAgentConnection>('agentConnection');

export const CanvasesEnabledSettingId = 'chat.canvases.enabled';

/** Window-owned Canvas callbacks. App Server supplies task identity; extensions supply sources. */
export interface IAgentCanvasHost {
	listCanvases(sessionId: string, threadId: string, signal: AbortSignal): Promise<readonly IAgentCanvasDefinition[] | undefined>;
	openCanvasSource(request: IAgentCanvasOpenRequest, signal: AbortSignal): Promise<{ readonly url: string; readonly title?: string; readonly status?: string; }>;
	closeCanvasSource(threadId: string, targetId: string, signal: AbortSignal): Promise<void>;
	acceptCanvasOpen(request: { readonly sessionId: string; readonly threadId: string; readonly instanceId: string; }, state: { readonly id: string; readonly succeeded: boolean; }, source?: { readonly url: string; readonly title?: string; readonly status?: string; }): void;
}

export interface IAgentCanvasDefinition {
	readonly id: { readonly extensionId: string; readonly canvasId: string; };
	readonly displayName: string;
	readonly description: string;
	readonly requiresInput: boolean;
}

export interface IAgentCanvasOpenRequest {
	readonly sessionId: string;
	readonly threadId: string;
	readonly instanceId: string;
	readonly definition: { readonly extensionId: string; readonly canvasId: string; };
}

export interface IAgentSessionService {
	readonly onDidChangeSession: Event<Agent.AgentSessionChange>;
	readonly onDidDeleteSession: Event<Agent.SessionId>;
	/** Collects process logs from the runtime owning this Session, using connection-owned resources. */
	collectDebugLogs(params: Agent.SessionReadParams, signal?: AbortSignal): Promise<{
		readonly files: readonly {
			readonly name: string;
			readonly bytes: Uint8Array;
			readonly truncated: boolean;
		}[];
		readonly omittedFiles: number;
	}>;
	/** Optional runtime capability; cancellation belongs to the originating connection. */
	invokeRuntime?(providerId: string, request: Agent.SessionRuntimeRequest, signal: AbortSignal): Promise<Agent.SessionRuntimeResult>;
	create(params: Agent.SessionCreateParams): Promise<Agent.SessionResult>;
	listAgents(): Promise<Agent.AgentRoleListResult>;
	/** Includes packaged workflow roles for Settings, without changing selectable root definitions. */
	readRoleCatalog(): Promise<Agent.AgentRoleCatalog>;
	read(params: Agent.SessionReadParams): Promise<Agent.SessionResult>;
	readCatalog(params: Agent.SessionReadParams): Promise<Agent.SessionCatalogReadResult>;
	list(): Promise<Agent.SessionListResult>;
	subscribeCatalog(): Promise<Agent.SessionListResult>;
	unsubscribeCatalog(): Promise<void>;
	subscribe(params: Agent.SessionReadParams): Promise<Agent.SessionSubscribeResult>;
	unsubscribe(params: Agent.SessionReadParams): Promise<void>;
	createThread(params: Agent.SessionOperationInput<'createThread'>): Promise<Agent.SessionThreadResult>;
	archive(params: Agent.SessionOperationInput<'archive'>): Promise<Agent.SessionResult>;
	rename(params: Agent.SessionOperationInput<'rename'>): Promise<Agent.SessionResult>;
	delete(params: Agent.SessionOperationInput<'delete'>): Promise<void>;
	restore(params: Agent.SessionOperationInput<'restore'>): Promise<Agent.SessionResult>;
	stop(params: Agent.SessionOperationInput<'stop'>): Promise<Agent.SessionResult>;
}

export interface IAgentThreadService {
	canCreateSideChat(sessionId: string): boolean;
	createSideChat(params: Agent.SessionMutationParams & {
		readonly threadId: string; readonly sourceTurnId: string; readonly title: string; readonly selection?: string;
	}): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	fork(params: Agent.SessionMutationParams & {
		readonly threadId: string;
		readonly title: string;
		readonly target: 'session' | 'thread';
	}): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	rewrite(params: Agent.SessionMutationParams & {
		readonly threadId: string;
		readonly beforeTurnId: string;
		readonly title: string;
		readonly input: readonly Agent.AgentInput[];
	}, signal?: AbortSignal): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	rename(params: Agent.SessionMutationParams & { readonly threadId: string; readonly title: string; readonly source: 'manual' | 'automatic'; }): Promise<void>;
	/** Delivery grants are independent of historical committed events. */
	readonly onDidOfferInteraction: Event<Agent.AgentInteractionOffer>;
	readonly onDidChangeConnection: Event<void>;
	/** Domain notifications from this renderer's connection; disposing the listener releases it. */
	readonly onDidUpdateThread: Event<Agent.ThreadUpdateEnvelope>;
	readonly onDidUpdateThreadTranscript: Event<Agent.ThreadTranscriptUpdateEnvelope>;
	readAttachment(source: Agent.AgentAttachmentSource, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; }>;
	listAppTools(source: Agent.AgentAttachmentSource & { readonly contentIndex: number; }, signal?: AbortSignal): Promise<readonly Agent.AgentMcpAppTool[]>;
	invokeAppTool(source: Agent.AgentAttachmentSource & { readonly contentIndex: number; }, name: string, argumentsJson: string, signal?: AbortSignal): Promise<Extract<Agent.ThreadItem, { readonly type: 'toolResult'; }>>;
	readToolResource(source: Agent.AgentAttachmentSource & { readonly contentIndex: number; }, signal?: AbortSignal): Promise<Agent.AgentToolResource>;
	/** Reads through the original App provider; the URI grants no local filesystem access. */
	readAppResource(source: Agent.AgentAttachmentSource & { readonly contentIndex: number; }, uri: string, signal?: AbortSignal): Promise<Agent.AgentToolResource>;
	readHistoryState(params: { readonly sessionId: string; readonly threadId: string; }): Promise<Agent.AgentThreadHistoryState>;
	moveHistory(params: { readonly sessionId: string; readonly threadId: string; readonly expectedSequence: number; readonly direction: 'undo' | 'redo'; readonly commandId: string; }): Promise<void>;
	readContext(params: { readonly sessionId: string; readonly threadId: string; }): Promise<{ readonly context: Agent.AgentContextUsage; }>;
	checkpoints(params: {
		readonly sessionId: string;
		readonly threadId: string;
	}): Promise<readonly Agent.IMessageCheckpoint[]>;
	restoreMessage(params: Agent.IRestoreMessageOptions): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	readTrace(params: Agent.SessionTraceReadParams): Promise<Agent.SessionTraceReadResult>;
	readTraceDiagnostics(params: Agent.SessionTraceDiagnosticsReadParams): Promise<Agent.SessionTraceDiagnosticsReadResult>;
	readTracePayload(params: Agent.SessionTracePayloadReadParams): Promise<Agent.SessionTracePayloadReadResult>;
	readTraceGraph(params: Agent.SessionReadParams): Promise<Agent.SessionTraceGraphReadResult>;
	startWireLog(params: Agent.SessionWireLogParams): Promise<void>;
	stopWireLog(params: Agent.SessionWireLogParams): Promise<void>;
	readWireLog(params: Agent.SessionWireLogReadParams): Promise<Agent.AgentWireLogPage>;

	configureAdvisor(params: Agent.SessionOperationInput<'configureAdvisor'>): Promise<Agent.AdvisorConfigureResult>;
	read(params: { readonly sessionId: string; readonly threadId: string; readonly history?: Agent.ThreadSnapshotHistory; }): Promise<Agent.ThreadRead>;
	subscribe(params: {
		readonly sessionId: string;
		readonly threadId: string;
		readonly afterSequence: number;
		readonly history?: Agent.ThreadSnapshotHistory;
	}): Promise<Agent.ThreadSubscription>;
	unsubscribe(params: Agent.SessionReadParams & { readonly threadId: string; }): Promise<void>;
}

/** The connection-owned capture was released, for example by a backend reconnect. */
export class AgentWireLogCaptureUnavailableError extends Error {
	constructor() { super('Wire capture is unavailable'); this.name = 'AgentWireLogCaptureUnavailableError'; }
}

export class AgentThreadHistoryConflictError extends Error {
	constructor() { super('Thread files changed after their checkpoint'); }
}

/** The displayed queue revision is stale or has already entered delivery. */
export class AgentQueueConflictError extends Error { }

export interface IAgentTurnService {
	enqueue(params: Agent.QueueEnqueueParams, signal?: AbortSignal): Promise<Agent.QueuedMessage>;
	listQueued(params: Agent.QueueListParams): Promise<Agent.QueueListResult>;
	editQueued(params: Agent.QueueMessageTarget, action: Agent.QueueMessageEdit): Promise<Agent.QueuedMessage>;
	cancelQueued(params: Agent.QueueMessageTarget): Promise<Agent.QueuedMessage>;
	consultAdvisor(params: Agent.SessionOperationInput<'consultAdvisor'>): Promise<Agent.TurnStartResult>;
	start(params: Agent.SessionOperationInput<'startTurn'>, signal?: AbortSignal): Promise<Agent.TurnStartResult>;
	startReview(params: Agent.SessionOperationInput<'startReview'>): Promise<Agent.TurnStartResult>;
	compact(params: Agent.SessionOperationInput<'compactContext'>): Promise<Agent.TurnStartResult>;
	steer(params: Agent.SessionOperationInput<'steerTurn'>, signal?: AbortSignal): Promise<Agent.TurnSteerResult>;
	interrupt(params: Agent.SessionOperationInput<'interruptTurn'>): Promise<Agent.TurnInterruptResult>;
	resolveInteraction(params: Agent.SessionOperationInput<'resolveInteraction'>): Promise<Agent.TurnInteractionResolveResult>;
}

export const IAgentSessionService = createServiceIdentifier<IAgentSessionService>('agentSessionService');

export const IAgentThreadService = createServiceIdentifier<IAgentThreadService>('agentThreadService');

export const IAgentTurnService = createServiceIdentifier<IAgentTurnService>('agentTurnService');

/** Optional connection-owned agent media capability. Chat owns its UI; Core owns transcript/task facts. */
export const IAgentVoiceService = createServiceIdentifier<IAgentVoiceService | undefined>('agentVoiceService');

export interface IAgentVoiceService {
	readonly isAvailable: boolean;
	readonly state: Agent.AgentVoiceSessionState | undefined;
	readonly onDidChange: Event<void>;
	readonly onDidRequestTask: Event<Agent.AgentVoiceTaskRequest>;
	getOptions(): Promise<readonly Agent.AgentVoiceConnectionChoice[]>;
	start(source: Agent.AgentVoiceSource, selection: Agent.AgentVoiceSelection, signal?: AbortSignal): Promise<Agent.AgentVoiceSessionState>;
	stop(): Promise<void>;
	interrupt(): Promise<void>;
	/** Closes microphone capture and model input while retaining playback and the conversation. */
	setMuted(muted: boolean): Promise<void>;
	setInputMode(mode: Agent.AgentVoiceInputMode): Promise<void>;
	/** Each gesture has a unique ID. The transport renews its lease until the matching release. */
	pttDown(id: string): Promise<void>;
	/** A delayed release for an older gesture cannot end the current hold. */
	pttUp(id: string): Promise<void>;
	rejectTask(request: Agent.AgentVoiceTaskRequest): Promise<void>;
}

/** The renderer protocol owner binds a secondary connection without exposing its transport client. */
export interface IAgentBrowserHostConnection {
	register(playwright: IPlaywrightService, configuration: IConfigurationService, canvases: IAgentCanvasHost, scope: IAgentBrowserHostScope, resolveNetwork: (owner: IBrowserViewOwner) => IBrowserViewNetwork | undefined): IDisposable;
}

export interface IAgentBrowserHostScope {
	readonly providerId: string;
	toFrontendIdentity(backendId: string): string;
	toBackendIdentity(frontendId: string): string | undefined;
}

/** Host-owned discovery; the input editor owns presentation, edits and context admission. */
export interface IAgentHostInputCompletionService {
	readonly onDidChangeConnection: Event<void>;
	getTriggerCharacters(sessionId?: string): readonly string[];
	complete(request: Agent.AgentHostInputCompletionRequest, signal: AbortSignal): Promise<readonly Agent.AgentHostInputCompletionItem[]>;
}
export const IAgentHostInputCompletionService = createServiceIdentifier<IAgentHostInputCompletionService>('agentHostInputCompletionService');
