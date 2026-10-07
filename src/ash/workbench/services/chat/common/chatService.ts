import type { Event } from "../../../../base/common/event.js";
import { PRODUCT_SLASH_COMMANDS } from "../../../../../../.build/protocol/typescript/index.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { SkillReference } from "../../../../platform/skills/common/skillApi.js";
import type { ModelReasoningEffort } from "./modelCatalog.js";
import type { ResolvedChatContext } from "./chatContextService.js";
import type { SessionMode } from '../../../../platform/sessions/common/sessionApi.js';
import type { ApprovalMode } from '../../../../platform/sessions/common/approvalModes.js';
import type { AgentTracePage, AgentTraceDiagnosticPage, AgentTraceGraph } from './agentTrace.js';

export type { ModelCatalogEntry } from "./modelCatalog.js";

export type SessionId = string;
export type ThreadId = string;

/** Identifies the reply that produced a document edit, independently of the visible Chat. */
export interface ChatEditSource {
	readonly threadId: ThreadId;
	readonly turnId: string;
}

export type ChatEditOutcome = 'completed' | 'failed' | 'interrupted';

export interface ModelRef {
	readonly provider: string;
	readonly model: string;
}

/** An authorized directory Agent that can start a new Chat Session. */
export interface ChatAgent {
	readonly name: string;
	readonly description: string;
	readonly sourceId: string;
}

export type { ApprovalMode } from '../../../../platform/sessions/common/approvalModes.js';

export interface ModelProviderCredentialStatus {
	readonly connection: string;
	readonly access: 'apiKey' | 'subscription' | 'local' | 'enterprise' | 'unknown';
	readonly active: boolean;
	readonly configured: boolean;
	readonly ready: boolean;
	readonly provider: string;
	readonly displayName: string;
	readonly apiKeyPolicy: 'unsupported' | 'optional' | 'required';
	readonly apiKeyConfigured: boolean;
}

export interface ChatImageAttachment {
	readonly contentDigest: string;
	readonly mediaType: "png" | "jpeg" | "gif" | "webP";
	readonly encodedBytes: number;
	readonly width: number;
	readonly height: number;
}

export interface ChatAudioAttachment {
	readonly contentDigest: string;
	readonly mediaType: "wav" | "mp3" | "m4a" | "webM" | "ogg";
	readonly encodedBytes: number;
	readonly durationMs: number;
}

export interface ChatReasoningState {
	readonly scope: string;
	readonly item: unknown;
}

export type ChatToolSource =
	| { readonly type: "product"; readonly component: string; }
	| { readonly type: "plugin"; readonly pluginId: string; readonly version: string; readonly packageDigest: string; readonly contributionId: string; }
	| { readonly type: "mcp"; readonly serverId: string; readonly remoteName: string; readonly catalogGeneration: number; readonly connectionGeneration: number; }
	| { readonly type: "dynamic"; readonly name: string; }
	| { readonly type: "extension" | "system"; readonly id: string; };

export interface ChatToolCallBinding {
	readonly registryIncarnation?: string | null;
	readonly registryGeneration: number;
	readonly definitionDigest: string;
	readonly sourceChain: readonly ChatToolSource[];
	readonly activity?:
	| { readonly type: "read" | "search" | "list" | "edit"; readonly target: string; }
	| { readonly type: "run"; }
	| { readonly type: "fileRead"; readonly path: string; readonly offset: number; readonly limit: number; }
	| { readonly type: "fileSearch" | "fileList"; readonly pattern: string; readonly path: string; }
	| { readonly type: "fileEdit"; readonly path: string; }
	| { readonly type: "command"; readonly program: string; readonly arguments: readonly string[]; readonly workingDirectory: string; }
	| null;
	readonly caller: { readonly type: "direct"; } | { readonly type: "codeMode"; readonly parentToolCallId: string; readonly cellId: string; readonly runtimeCallId: string; };
}

export type ChatContentPart =
	| { readonly type: "text"; readonly text: string; }
	| { readonly type: "imageAttachment"; readonly attachment: ChatImageAttachment; readonly detail: "auto" | "low" | "high" | "original"; }
	| { readonly type: "imageUrl"; readonly url: string; readonly detail: "auto" | "low" | "high" | "original"; }
	| { readonly type: "audioAttachment"; readonly attachment: ChatAudioAttachment; }
	| { readonly type: "audioUrl"; readonly url: string; };

export interface AdvisorConfig {
	readonly model: ModelRef;
	readonly enabled: boolean;
	readonly reasoningEffort?: ModelReasoningEffort | null;
	readonly maxCalls: number;
	readonly maxOutputTokens: number;
}

export type AdvisorSelection = { readonly type: "default"; } | { readonly type: "off"; } | { readonly type: "model"; readonly config: AdvisorConfig; };

export interface SlashCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly argumentMode: "none" | "optional";
	readonly argumentHint?: string;
}

/** Shared product metadata; execution bindings remain with each client. */
export const ProductSlashCommands: Readonly<Record<keyof typeof PRODUCT_SLASH_COMMANDS, SlashCommandDefinition>> = PRODUCT_SLASH_COMMANDS;

export interface SkillSelectorDefinition {
	readonly name: string;
	readonly description: string;
	readonly source: string;
	readonly skill: SkillReference;
}

export type ThreadItem =
	| { readonly type: "userMessage"; readonly itemId: string; readonly turnId: string; readonly text: string; }
	| { readonly type: "userContext"; readonly itemId: string; readonly turnId: string; readonly name: string; readonly content: string; }
	| { readonly type: "userImage"; readonly itemId: string; readonly turnId: string; readonly url: string; }
	| { readonly type: "userImageAttachment"; readonly itemId: string; readonly turnId: string; readonly attachment: ChatImageAttachment; }
	| { readonly type: "userAudioAttachment"; readonly itemId: string; readonly turnId: string; readonly attachment: ChatAudioAttachment; }
	| { readonly type: "agentMessage"; readonly itemId: string; readonly turnId: string; readonly text: string; }
	| { readonly type: "reasoning"; readonly itemId: string; readonly turnId: string; readonly text: string; readonly state: readonly ChatReasoningState[]; }
	| { readonly type: "plan"; readonly itemId: string; readonly turnId: string; readonly text: string; }
	| { readonly type: "toolCall"; readonly itemId: string; readonly turnId: string; readonly toolCallId: string; readonly name: string; readonly argumentsJson: string; readonly binding?: ChatToolCallBinding | null; }
	| { readonly type: "toolResult"; readonly itemId: string; readonly turnId: string; readonly toolCallId: string; readonly text: string; readonly content?: readonly ChatContentPart[] | null; readonly isError: boolean; };

export type TurnStatus = "created" | "running" | "waitingForApproval" | "waitingForUserInput" | "waitingForCapability" | "cancelling" | "completed" | "failed" | "interrupted";

export interface TurnError {
	readonly code: "policyCircuitBreaker" | "modelConfiguration" | "providerCredentials" | "rateLimited" | "connectionFailed" | "providerUnavailable" | "providerHttp" | "modelInvocationFailed" | "contextOverflow" | "providerAuth" | "invalidRequest" | "invalidResponse" | "completionPersistenceFailed" | "interactionDeadlineElapsed" | "toolRepetition" | "usageLimited" | "worktreeCaptureFailed";
	readonly message: string;
	readonly retryable: boolean;
}

export type PlanStepStatus = "pending" | "inProgress" | "completed";

export interface PlanStep {
	readonly step: string;
	readonly status: PlanStepStatus;
}

export interface PlanUpdate {
	readonly explanation?: string | null;
	readonly steps: readonly PlanStep[];
}

export interface Turn {
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

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface ThreadGoal {
	readonly threadId: ThreadId;
	readonly goalId: string;
	readonly objective: string;
	readonly status: ThreadGoalStatus;
	readonly tokenBudget?: number | null;
	readonly tokensUsed: number;
}

export type ThreadOrigin =
	| { readonly type: "root"; }
	| { readonly type: "fork"; readonly parentThreadId: ThreadId; readonly parentSequence: number; }
	| { readonly type: "message"; readonly parentThreadId: ThreadId; readonly parentSequence: number; readonly itemId: string; readonly boundary: "before" | "after"; }
	| { readonly type: "rewind"; readonly parentThreadId: ThreadId; readonly beforeTurnId: string; }
	| { readonly type: "agentSpawn"; readonly parentThreadId: ThreadId; readonly parentSequence: number; readonly delegationId: string; }
	| { readonly type: "replacement"; readonly sourceThreadId: ThreadId; readonly sourceSequence: number; };

export interface Thread {
	readonly advisor: AdvisorSelection;
	readonly agentId: string;
	readonly origin: ThreadOrigin;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly title: string;
	readonly status: "active" | "archived";
	readonly sequence: number;
	readonly usage: ModelUsageSummary;
	readonly goal?: ThreadGoal | null;
	readonly turns: readonly Turn[];
}

export interface ThreadGoalUpdate {
	readonly threadId: ThreadId;
	readonly goal?: ThreadGoal;
}

export interface UserInputOption { readonly label: string; readonly description: string; }
export interface UserInputQuestion { readonly id: string; readonly header: string; readonly question: string; readonly options?: readonly UserInputOption[]; readonly allowFreeForm: boolean; }
export interface RequestUserInput { readonly questions: readonly UserInputQuestion[]; }
export interface ActionApprovalCapability {
	readonly kind: 'fileRead' | 'fileWrite' | 'processSpawn' | 'network' | 'credentialUse' | 'externalMutation' | 'systemConfiguration' | 'userInterface';
	readonly scope: string;
}
export interface ActionApprovalRequest {
	readonly reason: string;
	readonly capabilities: readonly ActionApprovalCapability[];
}
export interface DynamicToolCall { readonly callId: string; readonly name: string; readonly definitionDigest: string; readonly arguments: unknown; }

export type AgentRequest =
	| { readonly type: "approval"; readonly request: ActionApprovalRequest; }
	| { readonly type: "userInput"; readonly request: RequestUserInput; }
	| { readonly type: "dynamicTool"; readonly call: DynamicToolCall; };

export type AgentResponse =
	| { readonly type: "approval"; readonly response: { readonly decision: "approveOnce" | "decline"; }; }
	| { readonly type: "userInput"; readonly response: { readonly answers: Readonly<Record<string, { readonly value: string; }>>; }; }
	| { readonly type: "dynamicTool"; readonly response: { readonly callId: string; readonly content: readonly ({ readonly type: "text"; readonly text: string; } | { readonly type: "image"; readonly dataUrl: string; })[]; readonly success: boolean; }; };

export interface TurnInteraction {
	readonly requestId: string;
	readonly itemId?: string | null;
	readonly request: AgentRequest;
	readonly deadline?: { readonly expiresAtUnixMs: number; } | null;
}

export type ThreadCommittedEvent =
	| { readonly type: "interactionRequested"; readonly interaction: TurnInteraction; }
	| { readonly type: 'turnModeChanged'; readonly turnId: string; readonly fromMode: ChatMode; readonly mode: ChatMode; }
	| {
		readonly type:
		"threadCreated"
		| "advisorConfigured"
		| "modelProvidersMigrated"
		| "threadArchived"
		| "threadRestored"
		| "goalCreated"
		| "goalUpdated"
		| "goalCleared"
		| "userGoalChanged"
		| "turnExecutionBound"
		| "agentContextSeedCommitted"
		| "historyPrefixBound"
		| "historyImported"
		| "forkHistoryImported"
		| "forkTurnImported"
		| "forkHistoryImportCompleted"
		| "contextCheckpointCommitted"
		| "contextOverflowRecoveryCommitted"
		| "turnAccepted"
		| "turnStarted"
		| "turnSteered"
		| "turnSteerDelivered"
		| "turnExecutionAttempted"
		| "modelUsageRecorded"
		| "modelInvocationRecorded"
		| "itemCompleted"
		| "planUpdated"
		| "interactionResolved"
		| "toolExecutionStarted"
		| "toolExecutionEscalated"
		| "interactionCancelled"
		| "turnCompleted"
		| "turnFailed"
		| "turnCancelling"
		| "turnInterrupted"
		| "delegationRequested"
		| "delegationStarted"
		| "delegationCancellationRequested"
		| "agentCancellationReceived"
		| "delegationResultProduced"
		| "delegationResultReceived"
		| "agentMessageSent"
		| "agentMessageReceived"
		| "agentJoinRequested"
		| "agentJoinSatisfied";
	};

export type ThreadUpdate =
	| { readonly type: "committed"; readonly event: ThreadCommittedEvent; }
	| { readonly type: "itemStarted"; readonly item: ThreadItem; }
	| { readonly type: "itemDelta"; readonly itemId: string; readonly delta: { readonly type: "agentMessage" | "reasoning" | "plan"; readonly text: string; }; }
	| { readonly type: "toolOutputDelta"; readonly turnId: string; readonly toolCallId: string; readonly stream: "stdout" | "stderr"; readonly text: string; };

export interface ThreadUpdateEnvelope {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly durableSequence: number;
	readonly streamCursor?: { readonly streamInstanceId: string; readonly sequence: number; } | null;
	readonly update: ThreadUpdate;
}

export type ThreadTranscriptEntry =
	| { readonly type: "item"; readonly entryId: string; readonly turnId: string; readonly item: ThreadItem; readonly transient: boolean; }
	| { readonly type: "turnPlan"; readonly entryId: string; readonly turnId: string; readonly plan: PlanUpdate; }
	| { readonly type: "turnError"; readonly entryId: string; readonly turnId: string; readonly error: TurnError; }
	| { readonly type: "toolOutput"; readonly entryId: string; readonly turnId: string; readonly toolCallId: string; readonly stream: "stdout" | "stderr"; readonly text: string; };

export interface ThreadTranscriptSnapshot {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly durableSequence: number;
	readonly revision: number;
	readonly entries: readonly ThreadTranscriptEntry[];
}

export type ThreadTranscriptChange =
	| { readonly type: "upsert"; readonly entry: ThreadTranscriptEntry; }
	| { readonly type: "remove"; readonly entryIds: readonly string[]; }
	| { readonly type: "clearTransient"; };

export interface ThreadTranscriptUpdateEnvelope {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly durableSequence: number;
	readonly revision: number;
	readonly changes: readonly ThreadTranscriptChange[];
}

export interface ThreadRead {
	readonly thread: Thread;
	readonly transcript: ThreadTranscriptSnapshot;
}

export interface ThreadSubscription {
	readonly thread: Thread;
	readonly transcript: ThreadTranscriptSnapshot;
	readonly updates: readonly ThreadUpdateEnvelope[];
}

export interface StartTurnOptions {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly expectedSequence: number;
	readonly text: string;
	readonly mode: ChatMode;
	readonly approvalMode?: ApprovalMode;
	readonly model?: ModelRef;
	/** Overrides this Turn's model effort without changing the user's model settings. */
	readonly reasoningEffort?: ModelReasoningEffort;
	readonly contexts?: readonly ResolvedChatContext[];
	readonly skills?: readonly SkillReference[];
}

export type ChatMode = SessionMode;
export interface ConfigureAdvisorOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly selection: AdvisorSelection; }
export interface ConsultAdvisorOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly question: string; }
export interface CompactContextOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly retentionPrompt?: string; }
export interface SteerTurnOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly turnId: string; readonly expectedSequence: number; readonly text: string; readonly contexts?: readonly ResolvedChatContext[]; }
export interface InterruptTurnOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly turnId: string; readonly expectedSequence: number; }
export interface ResolveInteractionOptions extends InterruptTurnOptions { readonly requestId: string; readonly response: AgentResponse; }

export type TurnChangeCaptureState = "open" | "sealed" | "incomplete" | "discarded";
export type TurnChangeMessageState = "unconfigured" | "queued" | "generating" | "ready" | "failed";
export type TurnChangeCommitState = "idle" | "queued" | "committing" | "committed" | "partiallyCommitted" | "conflict" | "failed";

export interface TurnChangeSetSummary {
	readonly changeSetId: string;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly turnId: string;
	readonly repositoryId: string;
	readonly targetBranch?: string;
	readonly statistics: { readonly files: number; readonly additions: number; readonly deletions: number; };
	readonly captureState: TurnChangeCaptureState;
	readonly messageState: TurnChangeMessageState;
	readonly commitState: TurnChangeCommitState;
	readonly committedPaths: readonly string[];
	readonly terminalState?: "completed" | "failed" | "interrupted";
	readonly dependencies: readonly string[];
	readonly externalDependencyPaths: readonly string[];
	readonly warnings: readonly string[];
	readonly conflictPaths: readonly string[];
	readonly failureMessage?: string;
	readonly commitId?: string;
	readonly revision: number;
}

export interface TurnChangeFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly kind: "added" | "modified" | "deleted" | "renamed" | "typeChanged";
	readonly beforeMode?: string;
	readonly afterMode?: string;
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
}

export interface TurnChangeDetails {
	readonly summary: TurnChangeSetSummary;
	readonly files: readonly TurnChangeFile[];
	readonly generatedMessage?: string;
	readonly draftMessage?: string;
}

export interface TurnChangeFileContents {
	readonly path: string;
	readonly binary: boolean;
	readonly truncated: boolean;
	readonly before?: string;
	readonly after?: string;
}

export interface TurnCommitSelection {
	readonly changeSetId: string;
	readonly expectedRevision: number;
	readonly paths: readonly string[];
}

export interface TurnCommitPreview {
	readonly commitId: string;
	readonly targetBranch: string;
	readonly message: string;
	readonly files: readonly TurnChangeFile[];
	readonly warnings: readonly string[];
}

export interface TurnChangesUpdate {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly changeSets: readonly TurnChangeSetSummary[];
}

/** Frontend Chat operations, catalogs, and Thread update lifecycle. */
export interface IChatService {
	readTrace(sessionId: SessionId, after: Readonly<Record<string, number>>): Promise<AgentTracePage>;
	readTraceDiagnostics(sessionId: SessionId, after: number): Promise<AgentTraceDiagnosticPage>;
	readTracePayload(sessionId: SessionId, captureId: string, payloadId: string): Promise<unknown>;
	readTraceGraph(sessionId: SessionId): Promise<AgentTraceGraph>;
	/** Session invalidation also discovers Threads that have not yet been subscribed. */
	readonly onDidChangeSession: Event<{ readonly sessionId: SessionId; readonly agentTreeChanged: boolean; }>;
	readonly onDidUpdateThread: Event<ThreadUpdateEnvelope>;
	readonly onDidUpdateThreadTranscript: Event<ThreadTranscriptUpdateEnvelope>;
	readonly onDidUpdateGoal: Event<ThreadGoalUpdate>;
	readonly onDidBecomeReady: Event<void>;
	readonly onDidChangeSkills: Event<void>;
	readonly onDidUpdateTurnChanges: Event<TurnChangesUpdate>;
	readonly onDidChangeQueue: Event<void>;
	listSlashCommands(): Promise<readonly SlashCommandDefinition[]>;
	listSkillSelectors(): Promise<readonly SkillSelectorDefinition[]>;
	readThread(sessionId: SessionId, threadId: ThreadId): Promise<ThreadRead>;
	/** The owner retains the subscription across refreshes/reconnects until explicitly released. */
	subscribeThread(sessionId: SessionId, threadId: ThreadId, afterSequence: number, owner: object): Promise<ThreadSubscription>;
	unsubscribeThread(sessionId: SessionId, threadId: ThreadId, owner: object): Promise<void>;
	startTurn(options: StartTurnOptions): Promise<void>;
	queueTurn(options: StartTurnOptions): Promise<void>;
	queuedMessageCount(sessionId: SessionId, threadId: ThreadId): Promise<number>;
	compactContext(options: CompactContextOptions): Promise<void>;
	configureAdvisor(options: ConfigureAdvisorOptions): Promise<void>;
	consultAdvisor(options: ConsultAdvisorOptions): Promise<void>;
	readAdvisorDefault(): Promise<AdvisorConfig | null>;
	saveAdvisorDefault(advisor: AdvisorConfig | null): Promise<void>;
	steerTurn(options: SteerTurnOptions): Promise<void>;
	interruptTurn(options: InterruptTurnOptions): Promise<void>;
	resolveInteraction(options: ResolveInteractionOptions): Promise<void>;
	listTurnChanges(sessionId: SessionId, threadId: ThreadId): Promise<readonly TurnChangeSetSummary[]>;
	readTurnChange(sessionId: SessionId, threadId: ThreadId, changeSetId: string): Promise<TurnChangeDetails>;
	readTurnChangeFile(sessionId: SessionId, threadId: ThreadId, changeSetId: string, path: string): Promise<TurnChangeFileContents>;
	generateTurnChangeMessage(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]>;
	updateTurnChangeDraft(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number, message: string): Promise<readonly TurnChangeSetSummary[]>;
	prepareTurnCommit(sessionId: SessionId, threadId: ThreadId, selections: readonly TurnCommitSelection[], message: string): Promise<TurnCommitPreview>;
	readTurnCommit(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<TurnCommitPreview>;
	readTurnCommitFile(sessionId: SessionId, threadId: ThreadId, commitId: string, path: string): Promise<TurnChangeFileContents>;
	commitTurnChange(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<readonly TurnChangeSetSummary[]>;
	discardThreadChanges(sessionId: SessionId, threadId: ThreadId, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]>;
}

export const IChatService = createServiceIdentifier<IChatService>("chatService");
