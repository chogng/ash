import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { SkillReference } from './appServerApi.js';
import type { ModelRef, ModelReasoningEffort, AdvisorConfig, AdvisorSelection } from './agentModels.js';
import type { ApprovalMode } from './approvalModes.js';
import type { WorkspaceTrustPermission } from '../../workspace/common/workspaceTrust.js';

export type SessionMode = 'agent' | 'plan' | 'debug' | 'multitask' | 'ask';
export type SessionId = string;
export type ThreadId = string;
type ChatMode = SessionMode;

export interface SessionMutationParams {
	readonly sessionId: string;
	readonly commandId: string;
}

export type AgentInput =
	| { readonly type: 'text'; readonly text: string; }
	| { readonly type: 'context'; readonly name: string; readonly content: string; }
	| { readonly type: 'toolSelection'; readonly disabled: string[]; }
	| { readonly type: 'image'; readonly url: string; }
	| { readonly type: 'instruction'; readonly path: string; }
	| { readonly type: 'skill'; readonly skill: SkillReference; };

interface SessionOperations {
	readonly createThread: { readonly title: string; };
	readonly archive: {};
	readonly restore: {};
	readonly stop: {};
	readonly configureAdvisor: {
		readonly threadId: string;
		readonly expectedSequence: number;
		readonly selection: AdvisorSelection;
	};
	readonly consultAdvisor: {
		readonly threadId: string;
		readonly expectedSequence: number;
		readonly question: string;
	};
	readonly startTurn: {
		readonly threadId: string;
		readonly expectedSequence: number;
		readonly mode: SessionMode;
		readonly approvalMode?: ApprovalMode | null;
		readonly model?: ModelRef | null;
		readonly reasoningEffort?: ModelReasoningEffort | null;
		readonly toolMode?: 'direct' | 'codeMode' | 'codeModeOnly' | null;
		readonly input: AgentInput[];
	};
	readonly compactContext: {
		readonly threadId: string;
		readonly expectedSequence: number;
		readonly retentionPrompt?: string | null;
	};
	readonly steerTurn: {
		readonly threadId: string;
		readonly expectedSequence: number;
		readonly turnId: string;
		readonly input: AgentInput[];
	};
	readonly interruptTurn: { readonly threadId: string; readonly expectedSequence: number; readonly turnId: string; };
	readonly resolveInteraction: {
		readonly threadId: string;
		readonly expectedSequence: number;
		readonly turnId: string;
		readonly requestId: string;
		readonly response: AgentResponse;
	};
}

export type SessionOperationInput<T extends keyof SessionOperations> = SessionMutationParams & SessionOperations[T];

export interface SessionReadParams {
	readonly sessionId: string;
}

export interface SessionCreateParams {
	readonly commandId: string;
	readonly title: string;
	readonly executionTarget:
	| { readonly type: 'local'; readonly root: string; }
	| { readonly type: 'ssh'; readonly host: string; readonly root: string; }
	| { readonly type: 'provider'; readonly providerId: string; readonly workspace: string; readonly root: string; }
	| null;
	readonly agent:
	| { readonly type: 'default'; }
	| {
		readonly type: 'exact';
		readonly source: { readonly type: 'builtIn'; } | { readonly type: 'directory'; readonly id: string; };
		readonly name: string;
	};
}

export interface AgentSessionActivity {
	readonly status: 'idle' | 'needsInput' | 'working' | 'readyForReview' | 'completed' | 'failed' | 'stopped';
	readonly statusChangedAtUnixMs: number;
	readonly activity?: { readonly type: 'operation' | 'question' | 'failure'; readonly text: string; } | null;
	readonly summary?: string | null;
}

export interface AgentSession {
	readonly sessionId: string;
	readonly title: string;
	readonly status: 'active' | 'archived';
	readonly executionTarget?: SessionCreateParams['executionTarget'];
	readonly model?: ModelRef | null;
	readonly manager: AgentSessionActivity;
	readonly threads: readonly {
		readonly threadId: string;
		readonly title: string;
		readonly parentThreadId?: string | null;
		readonly forkedFromId?: string | null;
		readonly status: 'active' | 'archived';
		readonly manager?: AgentSessionActivity | null;
	}[];
}

export interface AgentExecutionNode {
	readonly threadId: string;
	readonly threadSequence: number;
	readonly title: string;
	readonly parentThreadId?: string | null;
	readonly forkedFromId?: string | null;
	readonly executionStatus: 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
	readonly currentTurnId?: string | null;
	readonly waitingReason?: 'approval' | 'userInput' | 'capability' | null;
	readonly usage: ModelUsageSummary;
	readonly goal?: ThreadGoal | null;
	readonly role?: { readonly name: string; readonly selectionReason: 'explicit' | 'automatic'; } | null;
	readonly result?: { readonly status: string; readonly summary: string; } | null;
	readonly joins?: readonly { readonly status: 'waiting' | 'satisfied'; }[];
	readonly children?: readonly AgentExecutionNode[];
}

interface AgentTree {
	readonly roots: readonly AgentExecutionNode[];
}
export interface SessionResult {
	readonly session: AgentSession;
	readonly agentTree: AgentTree;
}
export interface SessionThreadResult {
	readonly session: AgentSession;
	readonly threadId: string;
}
export interface SessionListResult {
	readonly sessions: readonly AgentSession[];
}
export interface SessionCatalogReadResult {
	readonly session?: AgentSession | null;
}
export interface SessionSubscribeResult extends SessionResult {
	readonly threadSnapshots: readonly ThreadSubscription[];
}
export interface AgentRoleListResult {
	readonly agents: readonly {
		readonly name: string;
		readonly description: string;
		readonly source: { readonly type: 'builtIn'; } | { readonly type: 'directory'; readonly id: string; };
	}[];
}
interface TurnStartResult {
	readonly turnId: string;
	readonly sequence: number;
}
interface TurnInterruptResult {
	readonly sequence: number;
}
type TurnSteerResult = TurnStartResult;
type TurnInteractionResolveResult = TurnInterruptResult;
type AdvisorConfigureResult = TurnInterruptResult;

export interface QueueEnqueueParams extends SessionMutationParams {
	readonly threadId: string;
	readonly mode: SessionMode;
	readonly model?: ModelRef | null;
	readonly reasoningEffort?: ModelReasoningEffort | null;
	readonly approvalMode: ApprovalMode;
	readonly input: AgentInput[];
}
interface QueuedMessage {
	readonly status: 'pending' | 'paused' | 'delivering' | 'started' | 'rejected' | 'cancelled';
}
interface QueueListParams extends SessionReadParams {
	readonly threadId: string;
}
interface QueueListResult {
	readonly messages: readonly QueuedMessage[];
}
interface SessionTraceReadParams extends SessionReadParams {
	readonly after: Record<string, number>;
	readonly limit: number;
}
interface SessionTraceReadResult {
	readonly trace: unknown;
	readonly cursors: Record<string, number>;
	readonly hasMore: boolean;
}
interface SessionTraceDiagnosticsReadParams extends SessionReadParams {
	readonly after: number;
	readonly limit: number;
}
interface SessionTraceDiagnosticsReadResult {
	readonly diagnostics: unknown;
	readonly cursor: number;
	readonly hasMore: boolean;
}
interface SessionTracePayloadReadParams extends SessionReadParams {
	readonly captureId: string;
	readonly payloadId: string;
}
interface SessionTracePayloadReadResult {
	readonly payload: unknown;
}
interface SessionTraceGraphReadResult {
	readonly graph: unknown;
}

export interface ChatImageAttachment {
	readonly contentDigest: string;
	readonly mediaType: 'png' | 'jpeg' | 'gif' | 'webP';
	readonly encodedBytes: number;
	readonly width: number;
	readonly height: number;
}

export interface ChatAudioAttachment {
	readonly contentDigest: string;
	readonly mediaType: 'wav' | 'mp3' | 'm4a' | 'webM' | 'ogg';
	readonly encodedBytes: number;
	readonly durationMs: number;
}

export interface ChatReasoningState {
	readonly scope: string;
	readonly item: unknown;
}

export type ChatToolSource =
	| { readonly type: 'product'; readonly component: string; }
	| {
		readonly type: 'plugin';
		readonly pluginId: string;
		readonly version: string;
		readonly packageDigest: string;
		readonly contributionId: string;
	}
	| {
		readonly type: 'mcp';
		readonly serverId: string;
		readonly remoteName: string;
		readonly catalogGeneration: number;
		readonly connectionGeneration: number;
	}
	| { readonly type: 'dynamic'; readonly name: string; }
	| { readonly type: 'extension' | 'system'; readonly id: string; };

export interface ChatToolCallBinding {
	readonly registryIncarnation?: string | null;
	readonly registryGeneration: number;
	readonly definitionDigest: string;
	readonly sourceChain: readonly ChatToolSource[];
	readonly activity?:
	| { readonly type: 'read' | 'search' | 'list' | 'edit'; readonly target: string; }
	| { readonly type: 'run'; }
	| { readonly type: 'fileRead'; readonly path: string; readonly offset: number; readonly limit: number; }
	| { readonly type: 'fileSearch' | 'fileList'; readonly pattern: string; readonly path: string; }
	| { readonly type: 'fileEdit'; readonly path: string; }
	| {
		readonly type: 'command';
		readonly program: string;
		readonly arguments: readonly string[];
		readonly workingDirectory: string;
	}
	| null;
	readonly caller:
	| { readonly type: 'direct'; }
	| {
		readonly type: 'codeMode';
		readonly parentToolCallId: string;
		readonly cellId: string;
		readonly runtimeCallId: string;
	};
}

export type ChatContentPart =
	| {
		readonly type: 'artifact'; readonly artifact: {
			readonly source: { readonly type: 'embeddedResource'; readonly uri: string; } | { readonly type: 'resourceLink'; readonly uri: string; } | { readonly type: 'mcpApp'; readonly uri: string; } | { readonly type: 'structuredResult'; } | { readonly type: 'viewMetadata'; };
			readonly mimeType: string;
			readonly data: { readonly type: 'text'; readonly text: string; } | { readonly type: 'bytes'; readonly bytes: Uint8Array; } | { readonly type: 'json'; readonly json: string; };
			readonly contentDigest: string;
			readonly truncated: boolean;
			readonly resourceMetadata?: string | null;
		};
	}
	| { readonly type: 'text'; readonly text: string; }
	| {
		readonly type: 'imageAttachment';
		readonly attachment: ChatImageAttachment;
		readonly detail: 'auto' | 'low' | 'high' | 'original';
	}
	| { readonly type: 'imageUrl'; readonly url: string; readonly detail: 'auto' | 'low' | 'high' | 'original'; }
	| { readonly type: 'audioAttachment'; readonly attachment: ChatAudioAttachment; }
	| { readonly type: 'audioUrl'; readonly url: string; };

type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer' | { readonly other: string; };

export type ThreadItem =
	| { readonly type: 'userMessage'; readonly itemId: string; readonly turnId: string; readonly text: string; }
	| {
		readonly type: 'userContext';
		readonly itemId: string;
		readonly turnId: string;
		readonly name: string;
		readonly content: string;
	}
	| { readonly type: 'userImage'; readonly itemId: string; readonly turnId: string; readonly url: string; }
	| {
		readonly type: 'userImageAttachment';
		readonly itemId: string;
		readonly turnId: string;
		readonly attachment: ChatImageAttachment;
	}
	| {
		readonly type: 'userAudioAttachment';
		readonly itemId: string;
		readonly turnId: string;
		readonly attachment: ChatAudioAttachment;
	}
	| {
		readonly type: 'agentMessage';
		readonly itemId: string;
		readonly turnId: string;
		readonly text: string;
		readonly phase?: MessagePhase | null;
	}
	| {
		readonly type: 'reasoning';
		readonly itemId: string;
		readonly turnId: string;
		readonly text: string;
		readonly state: readonly ChatReasoningState[];
	}
	| { readonly type: 'plan'; readonly itemId: string; readonly turnId: string; readonly text: string; }
	| {
		readonly type: 'toolCall';
		readonly itemId: string;
		readonly turnId: string;
		readonly toolCallId: string;
		readonly name: string;
		readonly argumentsJson: string;
		readonly binding?: ChatToolCallBinding | null;
	}
	| {
		readonly type: 'toolResult';
		readonly itemId: string;
		readonly turnId: string;
		readonly toolCallId: string;
		readonly text: string;
		readonly content?: readonly ChatContentPart[] | null;
		readonly isError: boolean;
	};

export type TurnStatus =
	| 'created'
	| 'running'
	| 'waitingForApproval'
	| 'waitingForUserInput'
	| 'waitingForCapability'
	| 'cancelling'
	| 'completed'
	| 'failed'
	| 'interrupted';

export interface TurnError {
	readonly code:
	| 'policyCircuitBreaker'
	| 'modelConfiguration'
	| 'providerCredentials'
	| 'rateLimited'
	| 'connectionFailed'
	| 'providerUnavailable'
	| 'providerHttp'
	| 'modelInvocationFailed'
	| 'contextOverflow'
	| 'providerAuth'
	| 'invalidRequest'
	| 'invalidResponse'
	| 'completionPersistenceFailed'
	| 'interactionDeadlineElapsed'
	| 'toolRepetition'
	| 'usageLimited'
	| 'worktreeCaptureFailed';
	readonly message: string;
	readonly retryable: boolean;
}

export type PlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface PlanStep {
	readonly step: string;
	readonly status: PlanStepStatus;
}

export interface PlanUpdate {
	readonly explanation?: string | null;
	readonly steps: readonly PlanStep[];
}

export interface Turn {
	/** Missing only in older local consumers; the protocol adapter always preserves the Core purpose. */
	readonly kind?: 'coding' | 'review' | 'advisor' | 'shell' | 'tool' | 'contextCompaction';
	readonly turnId: string;
	readonly status: TurnStatus;
	readonly mode: ChatMode;
	readonly approvalMode: ApprovalMode;
	readonly model?: ModelRef | null;
	readonly reasoningEffort?: ModelReasoningEffort | null;
	readonly plan?: PlanUpdate | null;
	readonly usage: ModelUsageSummary;
	readonly items: readonly ThreadItem[];
	readonly error?: TurnError | null;
}

export interface ModelUsageTotal {
	readonly reported: number;
	readonly complete: boolean;
}

export interface ModelUsageSummary {
	readonly modelInvocations: number;
	readonly inputTokens: ModelUsageTotal;
	readonly outputTokens: ModelUsageTotal;
	readonly cachedInputTokens: ModelUsageTotal;
	readonly cacheWriteInputTokens: ModelUsageTotal;
	readonly reasoningTokens: ModelUsageTotal;
}

export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface ThreadGoal {
	readonly threadId: ThreadId;
	readonly goalId: string;
	readonly objective: string;
	readonly status: ThreadGoalStatus;
	readonly tokenBudget?: number | null;
	readonly tokensUsed: number;
}

export type ThreadOrigin =
	| { readonly type: 'root'; }
	| { readonly type: 'fork'; readonly parentThreadId: ThreadId; readonly parentSequence: number; }
	| {
		readonly type: 'message';
		readonly parentThreadId: ThreadId;
		readonly parentSequence: number;
		readonly itemId: string;
		readonly boundary: 'before' | 'after';
	}
	| { readonly type: 'rewind'; readonly parentThreadId: ThreadId; readonly beforeTurnId: string; }
	| {
		readonly type: 'agentSpawn';
		readonly parentThreadId: ThreadId;
		readonly parentSequence: number;
		readonly delegationId: string;
	}
	| { readonly type: 'replacement'; readonly sourceThreadId: ThreadId; readonly sourceSequence: number; };

export interface Thread {
	readonly advisor: AdvisorSelection;
	readonly agentId: string;
	readonly origin: ThreadOrigin;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly title: string;
	readonly status: 'active' | 'archived';
	readonly sequence: number;
	readonly usage: ModelUsageSummary;
	readonly goal?: ThreadGoal | null;
	readonly turns: readonly Turn[];
}

export interface ThreadGoalUpdate {
	readonly threadId: ThreadId;
	readonly goal?: ThreadGoal;
}

export interface UserInputOption {
	readonly label: string;
	readonly description: string;
}
export interface UserInputQuestion {
	readonly id: string;
	readonly header: string;
	readonly question: string;
	readonly options?: readonly UserInputOption[];
	readonly allowFreeForm: boolean;
}
export interface RequestUserInput {
	readonly questions: readonly UserInputQuestion[];
}
export interface ActionApprovalCapability {
	readonly kind:
	| 'fileRead'
	| 'fileWrite'
	| 'processSpawn'
	| 'network'
	| 'credentialUse'
	| 'externalMutation'
	| 'systemConfiguration'
	| 'userInterface';
	readonly scope: string;
}
export type ActionApprovalDecision = 'approveOnce' | 'approveForSession' | 'approveAndSaveRule' | 'decline';

export interface ActionApprovalRequest {
	readonly allowedDecisions?: readonly ActionApprovalDecision[];
	readonly command?: { readonly program: string; readonly arguments: readonly string[]; } | null;
	readonly reason: string;
	readonly capabilities: readonly ActionApprovalCapability[];
}
export interface DynamicToolCall {
	readonly callId: string;
	readonly name: string;
	readonly definitionDigest: string;
	readonly arguments: unknown;
}

export interface RequestedDirectoryGrant {
	readonly path: string;
	readonly permissions: readonly WorkspaceTrustPermission[];
}

export interface PermissionResponse {
	readonly duration: 'turn' | 'session';
	readonly directories: readonly RequestedDirectoryGrant[];
	readonly networkHosts: readonly string[];
}

export interface PermissionRequest extends PermissionResponse {
	readonly environmentId: string;
	readonly reason: string;
}

export type AgentRequest =
	| { readonly type: 'approval'; readonly request: ActionApprovalRequest; }
	| { readonly type: 'permissions'; readonly request: PermissionRequest; }
	| { readonly type: 'userInput'; readonly request: RequestUserInput; }
	| { readonly type: 'dynamicTool'; readonly call: DynamicToolCall; };

export type AgentResponse =
	| { readonly type: 'approval'; readonly response: { readonly decision: ActionApprovalDecision; }; }
	| { readonly type: 'permissions'; readonly response: PermissionResponse; }
	| {
		readonly type: 'userInput';
		readonly response: { readonly answers: Readonly<Record<string, { readonly value: string; }>>; };
	}
	| {
		readonly type: 'dynamicTool';
		readonly response: {
			readonly callId: string;
			readonly content: readonly (
				| { readonly type: 'text'; readonly text: string; }
				| { readonly type: 'image'; readonly dataUrl: string; }
			)[];
			readonly success: boolean;
		};
	};

export interface TurnInteraction {
	readonly requestId: string;
	readonly itemId?: string | null;
	readonly request: AgentRequest;
	readonly deadline?: { readonly expiresAtUnixMs: number; } | null;
}

/** An actionable interaction offered exclusively to this renderer connection. */
export interface AgentInteractionOffer {
	readonly connectionGeneration: number;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly turnId: string;
	readonly interaction: TurnInteraction;
}

export type ThreadCommittedEvent =
	| { readonly type: 'interactionResolved' | 'interactionCancelled'; readonly turnId: string; readonly requestId: string; }
	| { readonly type: 'turnCompleted' | 'turnFailed' | 'turnInterrupted'; readonly turnId: string; }
	| { readonly type: 'interactionRequested'; readonly interaction: TurnInteraction; }
	| {
		readonly type: 'turnModeChanged';
		readonly turnId: string;
		readonly fromMode: ChatMode;
		readonly mode: ChatMode;
	}
	| {
		readonly type:
		| 'threadCreated'
		| 'advisorConfigured'
		| 'modelProvidersMigrated'
		| 'threadArchived'
		| 'threadRestored'
		| 'goalCreated'
		| 'goalUpdated'
		| 'goalCleared'
		| 'voiceTranscriptRecorded'
		| 'userGoalChanged'
		| 'turnExecutionBound'
		| 'agentContextSeedCommitted'
		| 'historyPrefixBound'
		| 'threadHistoryMoved'
		| 'historyImported'
		| 'forkHistoryImported'
		| 'forkTurnImported'
		| 'forkHistoryImportCompleted'
		| 'contextCheckpointCommitted'
		| 'contextOverflowRecoveryCommitted'
		| 'turnAccepted'
		| 'turnStarted'
		| 'turnPermissionPolicyChanged'
		| 'turnSteered'
		| 'turnSteerDelivered'
		| 'turnExecutionAttempted'
		| 'modelUsageRecorded'
		| 'modelInvocationRecorded'
		| 'modelResponseEvaluated'
		| 'itemCompleted'
		| 'planUpdated'
		| 'hookRunUpdated'
		| 'toolExecutionStarted'
		| 'toolExecutionEscalated'
		| 'turnCancelling'
		| 'delegationRequested'
		| 'delegationStarted'
		| 'delegationCancellationRequested'
		| 'agentCancellationReceived'
		| 'delegationResultProduced'
		| 'delegationResultReceived'
		| 'agentMessageSent'
		| 'agentMessageReceived'
		| 'agentJoinRequested'
		| 'agentJoinSatisfied'
		| 'voiceTranscriptRecorded';
	};

export type ThreadUpdate =
	| { readonly type: 'committed'; readonly event: ThreadCommittedEvent; }
	| { readonly type: 'itemStarted'; readonly item: ThreadItem; }
	| {
		readonly type: 'itemDelta';
		readonly itemId: string;
		readonly delta:
		| { readonly type: 'agentMessage' | 'reasoning' | 'plan'; readonly text: string; }
		| { readonly type: 'agentMessagePhase'; readonly phase: MessagePhase | null; };
	}
	| {
		readonly type: 'toolOutputDelta';
		readonly turnId: string;
		readonly toolCallId: string;
		readonly stream: 'stdout' | 'stderr';
		readonly text: string;
	};

export interface ThreadUpdateEnvelope {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly durableSequence: number;
	readonly streamCursor?: { readonly streamInstanceId: string; readonly sequence: number; } | null;
	readonly update: ThreadUpdate;
}

/** Speech retained by Core independently of execution Turns and their instruction roles. */
export interface AgentVoiceTranscript {
	readonly itemId: string;
	readonly voiceSessionId: string;
	readonly mediaEpoch: number;
	readonly speaker: 'user' | 'assistant';
	readonly text: string;
	readonly startMs: number;
	readonly endMs: number;
	readonly afterItemId: string | null;
}

export type ThreadTranscriptEntry =
	| { readonly type: 'voiceTranscript'; readonly entryId: string; readonly turnId?: undefined; readonly transcript: AgentVoiceTranscript; }
	| { readonly type: 'hookRun'; readonly entryId: string; readonly turnId: string; readonly run: ChatHookRun; }
	| {
		readonly type: 'item';
		readonly entryId: string;
		readonly turnId: string;
		readonly item: ThreadItem;
		readonly transient: boolean;
	}
	| { readonly type: 'turnPlan'; readonly entryId: string; readonly turnId: string; readonly plan: PlanUpdate; }
	| { readonly type: 'turnError'; readonly entryId: string; readonly turnId: string; readonly error: TurnError; }
	| {
		readonly type: 'toolOutput';
		readonly entryId: string;
		readonly turnId: string;
		readonly toolCallId: string;
		readonly stream: 'stdout' | 'stderr';
		readonly text: string;
	};

export interface ChatHookRun {
	readonly runId: string;
	readonly hookId: string;
	readonly event: string;
	readonly status:
	| { readonly type: 'running' | 'continued'; }
	| { readonly type: 'denied' | 'cancelled'; readonly reason: string; }
	| { readonly type: 'failed'; readonly message: string; };
	readonly startedAtUnixMs: number;
	readonly durationMs: number;
	readonly turnId: string | null;
	readonly toolCallId: string | null;
	readonly toolName: string | null;
}

export interface ThreadTranscriptSnapshot {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly durableSequence: number;
	readonly revision: number;
	readonly entries: readonly ThreadTranscriptEntry[];
}

export type ThreadTranscriptChange =
	| { readonly type: 'upsert'; readonly entry: ThreadTranscriptEntry; }
	| { readonly type: 'remove'; readonly entryIds: readonly string[]; }
	| { readonly type: 'clearTransient'; };

export interface ThreadTranscriptUpdateEnvelope {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly durableSequence: number;
	readonly revision: number;
	readonly changes: readonly ThreadTranscriptChange[];
}

/** A bounded, chronological Turn window. Omission preserves full-history callers. */
export type ThreadSnapshotHistory =
	| { readonly type: 'latest'; readonly turnLimit: number; }
	| { readonly type: 'before'; readonly turnId: string; readonly turnLimit: number; };

export interface ThreadHistoryBoundary {
	readonly hasOlderTurns: boolean;
	readonly oldestTurnId?: string | null;
}

export interface ThreadRead {
	readonly thread: Thread;
	readonly directory?: SessionCreateParams['executionTarget'];
	readonly transcript: ThreadTranscriptSnapshot;
	readonly history?: ThreadHistoryBoundary;
}

export interface ThreadSubscription extends ThreadRead {
	readonly updates: readonly ThreadUpdateEnvelope[];
}

export interface IAgentSessionService {
	/** Optional runtime capability; cancellation belongs to the originating connection. */
	invokeRuntime?(providerId: string, request: SessionRuntimeRequest, signal: AbortSignal): Promise<SessionRuntimeResult>;
	create(params: SessionCreateParams): Promise<SessionResult>;
	listAgents(): Promise<AgentRoleListResult>;
	read(params: SessionReadParams): Promise<SessionResult>;
	readCatalog(params: SessionReadParams): Promise<SessionCatalogReadResult>;
	list(): Promise<SessionListResult>;
	subscribeCatalog(): Promise<SessionListResult>;
	unsubscribeCatalog(): Promise<void>;
	subscribe(params: SessionReadParams): Promise<SessionSubscribeResult>;
	unsubscribe(params: SessionReadParams): Promise<void>;
	createThread(params: SessionOperationInput<'createThread'>): Promise<SessionThreadResult>;
	archive(params: SessionOperationInput<'archive'>): Promise<SessionResult>;
	restore(params: SessionOperationInput<'restore'>): Promise<SessionResult>;
	stop(params: SessionOperationInput<'stop'>): Promise<SessionResult>;
}

export type SessionRuntimeRequest = { readonly operation: 'list'; } | { readonly operation: 'probe' | 'prepare' | 'stop' | 'remove'; readonly workspace: string; };
export type SessionRuntimeResult =
	| { readonly type: 'targets'; readonly targets: readonly NonNullable<SessionCreateParams['executionTarget']>[]; }
	| { readonly type: 'availability'; readonly available: boolean; }
	| { readonly type: 'target'; readonly target: NonNullable<SessionCreateParams['executionTarget']>; }
	| { readonly type: 'released'; };

/** A backend-owned message boundary and its file restoration availability. */
export interface IMessageCheckpoint {
	readonly itemId: string;
	readonly turnId: string;
	readonly sourceThreadId: string;
	readonly files: 'git' | 'directory' | 'noFiles' | 'unavailable';
	readonly unavailableReason?: string;
}

export interface IRestoreMessageOptions {
	readonly sessionId: string;
	readonly threadId: string;
	readonly itemId: string;
	readonly boundary: 'before' | 'after';
	readonly title: string;
	readonly commandId: string;
}

/** Locates a stored media part without exposing a backend path or accepting a storage digest. */
export interface AgentAttachmentSource {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly itemId: string;
	readonly contentIndex?: number;
}

/** Validated external origins for one source-owned App document. */
export interface AgentMcpAppCsp {
	readonly connectDomains: readonly string[];
	readonly resourceDomains: readonly string[];
	readonly frameDomains: readonly string[];
	readonly baseUriDomains: readonly string[];
}

export interface AgentToolResource {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly appCsp?: AgentMcpAppCsp;
	readonly encoding?: 'text' | 'binary';
	readonly resourceMetadata?: string | null;
}

/** Original public MCP Tool contract for a source-bound App catalog. */
export interface AgentMcpAppTool extends Readonly<Record<string, unknown>> {
	readonly name: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface IAgentThreadService {
	/** Delivery grants are independent of historical committed events. */
	readonly onDidOfferInteraction: Event<AgentInteractionOffer>;
	readonly onDidChangeConnection: Event<void>;
	/** Domain notifications from this renderer's connection; disposing the listener releases it. */
	readonly onDidUpdateThread: Event<ThreadUpdateEnvelope>;
	readonly onDidUpdateThreadTranscript: Event<ThreadTranscriptUpdateEnvelope>;
	readAttachment(source: AgentAttachmentSource, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; }>;
	listAppTools(source: AgentAttachmentSource & { readonly contentIndex: number; }, signal?: AbortSignal): Promise<readonly AgentMcpAppTool[]>;
	invokeAppTool(source: AgentAttachmentSource & { readonly contentIndex: number; }, name: string, argumentsJson: string, signal?: AbortSignal): Promise<Extract<ThreadItem, { readonly type: 'toolResult'; }>>;
	readToolResource(source: AgentAttachmentSource & { readonly contentIndex: number; }, signal?: AbortSignal): Promise<AgentToolResource>;
	/** Reads through the original App provider; the URI grants no local filesystem access. */
	readAppResource(source: AgentAttachmentSource & { readonly contentIndex: number; }, uri: string, signal?: AbortSignal): Promise<AgentToolResource>;
	readHistoryState(params: { readonly sessionId: string; readonly threadId: string; }): Promise<AgentThreadHistoryState>;
	moveHistory(params: { readonly sessionId: string; readonly threadId: string; readonly expectedSequence: number; readonly direction: 'undo' | 'redo'; readonly commandId: string; }): Promise<void>;
	readContext(params: { readonly sessionId: string; readonly threadId: string; }): Promise<{ readonly context: AgentContextUsage; }>;
	checkpoints(params: {
		readonly sessionId: string;
		readonly threadId: string;
	}): Promise<readonly IMessageCheckpoint[]>;
	restoreMessage(params: IRestoreMessageOptions): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	readTrace(params: SessionTraceReadParams): Promise<SessionTraceReadResult>;
	readTraceDiagnostics(params: SessionTraceDiagnosticsReadParams): Promise<SessionTraceDiagnosticsReadResult>;
	readTracePayload(params: SessionTracePayloadReadParams): Promise<SessionTracePayloadReadResult>;
	readTraceGraph(params: SessionReadParams): Promise<SessionTraceGraphReadResult>;
	configureAdvisor(params: SessionOperationInput<'configureAdvisor'>): Promise<AdvisorConfigureResult>;
	read(params: { readonly sessionId: string; readonly threadId: string; readonly history?: ThreadSnapshotHistory; }): Promise<ThreadRead>;
	subscribe(params: {
		readonly sessionId: string;
		readonly threadId: string;
		readonly afterSequence: number;
		readonly history?: ThreadSnapshotHistory;
	}): Promise<ThreadSubscription>;
	unsubscribe(params: SessionReadParams & { readonly threadId: string; }): Promise<void>;
}

export interface AgentThreadHistoryState {
	readonly sequence: number;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

export class AgentThreadHistoryConflictError extends Error {
	constructor() { super('Thread files changed after their checkpoint'); }
}

export interface AgentContextUsage {
	readonly estimatedTokens: number;
	readonly allocation?: { readonly contextWindow: number; readonly autoCompactAt: number; } | null;
	readonly model?: ModelRef | null;
	readonly latestRequest?: { readonly usedTokens: number; } | null;
	readonly categories: readonly { readonly category: 'systemPrompt' | 'systemTools' | 'memoryFiles' | 'skills' | 'conversation'; readonly tokens: number; }[];
}

export interface IAgentTurnService {
	enqueue(params: QueueEnqueueParams): Promise<QueuedMessage>;
	listQueued(params: QueueListParams): Promise<QueueListResult>;
	consultAdvisor(params: SessionOperationInput<'consultAdvisor'>): Promise<TurnStartResult>;
	start(params: SessionOperationInput<'startTurn'>): Promise<TurnStartResult>;
	compact(params: SessionOperationInput<'compactContext'>): Promise<TurnStartResult>;
	steer(params: SessionOperationInput<'steerTurn'>): Promise<TurnSteerResult>;
	interrupt(params: SessionOperationInput<'interruptTurn'>): Promise<TurnInterruptResult>;
	resolveInteraction(params: SessionOperationInput<'resolveInteraction'>): Promise<TurnInteractionResolveResult>;
}

export const IAgentSessionService = createServiceIdentifier<IAgentSessionService>('agentSessionService');
export const IAgentThreadService = createServiceIdentifier<IAgentThreadService>('agentThreadService');
export const IAgentTurnService = createServiceIdentifier<IAgentTurnService>('agentTurnService');

export interface AgentVoiceSource { readonly sessionId: string; readonly threadId: string; }
export interface AgentVoiceSelection { readonly connectionId: string; readonly modelId?: string; readonly voice?: string; }
export type AgentVoiceInputMode = 'openMic' | 'pushToTalk';
export interface AgentVoiceModelChoice { readonly modelId: string; readonly defaultVoice: string; readonly voices: readonly string[]; }
export interface AgentVoiceConnectionChoice { readonly connectionId: string; readonly name: string; readonly defaultModel: string; readonly models: readonly AgentVoiceModelChoice[]; }
export interface AgentVoiceSessionState extends AgentVoiceSource {
	readonly resourceId: string;
	readonly mediaEpoch: number;
	readonly sequence: number;
	readonly state: 'connecting' | 'connected' | 'stopping' | 'ended' | 'failed';
	readonly inputMode: AgentVoiceInputMode;
	readonly muted: boolean;
	/** True only after the capture source and model input have acknowledged the policy. */
	readonly listening: boolean;
	readonly inputSequence: number;
	readonly usageMilliseconds: number;
	readonly error?: string;
}
export interface AgentVoiceTaskRequest extends AgentVoiceSource {
	readonly resourceId: string;
	readonly mediaEpoch: number;
	readonly delegationId: string;
	readonly commandId: string;
	readonly transcript: string;
}

/** Optional connection-owned agent media capability. Chat owns its UI; Core owns transcript/task facts. */
export const IAgentVoiceService = createServiceIdentifier<IAgentVoiceService | undefined>('agentVoiceService');
export interface IAgentVoiceService {
	readonly isAvailable: boolean;
	readonly state: AgentVoiceSessionState | undefined;
	readonly onDidChange: Event<void>;
	readonly onDidRequestTask: Event<AgentVoiceTaskRequest>;
	getOptions(): Promise<readonly AgentVoiceConnectionChoice[]>;
	start(source: AgentVoiceSource, selection: AgentVoiceSelection, signal?: AbortSignal): Promise<AgentVoiceSessionState>;
	stop(): Promise<void>;
	interrupt(): Promise<void>;
	/** Closes microphone capture and model input while retaining playback and the conversation. */
	setMuted(muted: boolean): Promise<void>;
	setInputMode(mode: AgentVoiceInputMode): Promise<void>;
	/** Each gesture has a unique ID. The transport renews its lease until the matching release. */
	pttDown(id: string): Promise<void>;
	/** A delayed release for an older gesture cannot end the current hold. */
	pttUp(id: string): Promise<void>;
	rejectTask(request: AgentVoiceTaskRequest): Promise<void>;
}
