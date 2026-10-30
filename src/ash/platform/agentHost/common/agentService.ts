import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type * as Agent from './agent.js';

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

export class AgentThreadHistoryConflictError extends Error {
	constructor() { super('Thread files changed after their checkpoint'); }
}

export interface IAgentTurnService {
	enqueue(params: Agent.QueueEnqueueParams, signal?: AbortSignal): Promise<Agent.QueuedMessage>;
	listQueued(params: Agent.QueueListParams): Promise<Agent.QueueListResult>;
	consultAdvisor(params: Agent.SessionOperationInput<'consultAdvisor'>): Promise<Agent.TurnStartResult>;
	start(params: Agent.SessionOperationInput<'startTurn'>, signal?: AbortSignal): Promise<Agent.TurnStartResult>;
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
