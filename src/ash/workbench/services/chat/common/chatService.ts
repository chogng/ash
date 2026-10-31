import type { AgentInteractionOffer, AgentReviewTarget, ChatHookRun, SessionMode, Turn, Thread, ThreadGoalUpdate, AgentResponse, ThreadUpdateEnvelope, ThreadTranscriptUpdateEnvelope, ThreadRead, ThreadSubscription, ThreadSnapshotHistory } from '../../../../platform/agentHost/common/agent.js';
export type {
	ChatImageAttachment,
	ChatAudioAttachment,
	ChatReasoningState,
	ChatToolSource,
	ChatToolCallBinding,
	ChatContentPart,
	ThreadItem,
	TurnStatus,
	TurnError,
	PlanStepStatus,
	PlanStep,
	PlanUpdate,
	Turn,
	ModelUsageTotal,
	ModelUsageSummary,
	ThreadGoalStatus,
	ThreadGoal,
	ThreadOrigin,
	Thread,
	ThreadGoalUpdate,
	UserInputOption,
	UserInputQuestion,
	RequestUserInput,
	ActionApprovalCapability,
	ActionApprovalRequest,
	DynamicToolCall,
	AgentRequest,
	AgentResponse,
	TurnInteraction,
	ThreadCommittedEvent,
	ThreadUpdate,
	ThreadUpdateEnvelope,
	ThreadTranscriptEntry,
	ChatHookRun,
	ThreadTranscriptSnapshot,
	ThreadTranscriptChange,
	ThreadTranscriptUpdateEnvelope,
	ThreadRead,
	ThreadSubscription,
	ThreadSnapshotHistory,
	ThreadHistoryBoundary,
} from '../../../../platform/agentHost/common/agent.js';
import type { ModelRef, AdvisorConfig, AdvisorSelection, ModelProviderCredentialStatus } from '../../../../platform/agentHost/common/agentModels.js';
export type { ModelRef, AdvisorConfig, AdvisorSelection, ModelProviderCredentialStatus } from '../../../../platform/agentHost/common/agentModels.js';
import type { Event } from '../../../../base/common/event.js';
import { PRODUCT_SLASH_COMMANDS } from '../../../../../../.build/protocol/typescript/index.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { SkillReference } from '../../../../platform/agentHost/common/appServerApi.js';
import type { ModelReasoningEffort } from './modelCatalog.js';
import type { ResolvedChatContext } from './chatContextService.js';

import type { ApprovalMode } from '../../../../platform/agentHost/common/approvalModes.js';

export type { ModelCatalogEntry } from './modelCatalog.js';

import type { SessionId, ThreadId, IMessageCheckpoint as ChatCheckpoint, AgentThreadHistoryState } from '../../../../platform/agentHost/common/agent.js';
export type { SessionId, ThreadId, IMessageCheckpoint as ChatCheckpoint } from '../../../../platform/agentHost/common/agent.js';
export { AgentThreadHistoryConflictError as ChatHistoryConflictError } from '../../../../platform/agentHost/common/agentService.js';

/** Identifies the reply that produced a document edit, independently of the visible Chat. */
export interface ChatEditSource {
	readonly threadId: ThreadId;
	readonly turnId: string;
}

export type ChatEditOutcome = 'completed' | 'failed' | 'interrupted';

export interface RestoreChatCheckpointOptions {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly itemId: string;
	readonly boundary: 'before' | 'after';
	readonly title: string;
}

/** An authorized directory Agent that can start a new Chat Session. */
export interface ChatAgent {
	readonly name: string;
	readonly description: string;
	readonly sourceId: string;
}

export type { ApprovalMode } from '../../../../platform/agentHost/common/approvalModes.js';

export interface SlashCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly argumentMode: 'none' | 'optional';
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

/** Current context estimate and execution capacity, independently of accumulated billing usage. */
export interface ChatContextUsage {
	readonly estimatedTokens: number;
	readonly contextWindow?: number;
	readonly autoCompactAt?: number;
	readonly model?: ModelRef;
	readonly latestRequestTokens?: number;
	readonly categories: readonly {
		readonly category: 'systemPrompt' | 'systemTools' | 'memoryFiles' | 'skills' | 'conversation';
		readonly tokens: number;
	}[];
}

/** The same admissible input boundary Core uses to decide automatic compaction. */
export function getContextInputBudget(usage: ChatContextUsage): number | undefined {
	const budget = usage.autoCompactAt ?? usage.contextWindow;
	return budget !== undefined && budget > 0 ? budget : undefined;
}

/** User-facing Hook feedback; process evidence remains in Execution trace. */
export interface IChatHookPart {
	readonly kind: 'hook';
	/** The owning transcript's typed run, including status and Turn/tool identity. */
	readonly run: ChatHookRun;
}

/** Captured origin, cancellation and idempotency of one composer submission. */
export interface ChatSubmissionOptions {
	readonly signal?: AbortSignal;
	readonly source?: { readonly sessionId: SessionId; readonly threadId: ThreadId; };
	readonly commandId?: string;
}

export interface StartTurnOptions extends ChatSubmissionOptions {
	/** Supplied by the owning composer from its loaded Thread. */
	readonly isNewSession?: boolean;
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
export interface StartReviewOptions {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly expectedSequence: number;
	readonly target: AgentReviewTarget;
}
export interface ConfigureAdvisorOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly selection: AdvisorSelection; }
export interface ConsultAdvisorOptions { readonly isNewSession?: boolean; readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly question: string; }
export interface CompactContextOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly retentionPrompt?: string; }
export interface SteerTurnOptions extends ChatSubmissionOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly turnId: string; readonly expectedSequence: number; readonly text: string; readonly contexts?: readonly ResolvedChatContext[]; }
export interface InterruptTurnOptions { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly turnId: string; readonly expectedSequence: number; }
export interface ResolveInteractionOptions extends InterruptTurnOptions { readonly requestId: string; readonly response: AgentResponse; }

export type TurnChangeCaptureState = 'open' | 'sealed' | 'incomplete' | 'discarded';
export type TurnChangeMessageState = 'unconfigured' | 'queued' | 'generating' | 'ready' | 'failed';
export type TurnChangeCommitState = 'idle' | 'queued' | 'committing' | 'committed' | 'partiallyCommitted' | 'conflict' | 'failed';

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
	readonly terminalState?: 'completed' | 'failed' | 'interrupted';
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
	readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'typeChanged';
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

/** Net file changes from this conversation's baseline to its current history checkpoint. */
export interface ThreadChangesSummary {
	readonly sequence: number;
	readonly revision: string;
	readonly statistics: TurnChangeSetSummary['statistics'];
	readonly repositories: readonly { readonly repositoryId: string; readonly files: readonly TurnChangeFile[]; }[];
	readonly warnings: readonly string[];
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

export interface IChatRequestSubmittedEvent {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly isNewSession: boolean;
	/** The submitting composer's journal revision fences replies arriving after a newer cross-window request. */
	readonly requestSequence: number;
}

/** Frontend Chat operations, catalogs, and Thread update lifecycle. */
export interface ChatInteractionOfferChange {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly offer?: AgentInteractionOffer;
}

export interface RewriteChatRequestOptions {
	readonly signal?: AbortSignal;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly turnId: string;
	readonly itemId: string;
	readonly text: string;
	readonly commandId: string;
}

export interface IChatService {
	/** Rewrites an initial user message while retaining its accepted context and attachments. */
	rewriteRequest(options: RewriteChatRequestOptions): Promise<{ readonly sessionId: SessionId; readonly threadId: ThreadId; }>;
	renameThread(sessionId: SessionId, threadId: ThreadId, title: string): Promise<void>;
	/** Only accepted local submissions establish window activity; broadcasts never establish ownership. */
	readonly onDidSubmitRequest: Event<IChatRequestSubmittedEvent>;
	/** Current connection delivery authority; committed history does not grant this lease. */
	getInteractionOffer(sessionId: SessionId, threadId: ThreadId): AgentInteractionOffer | undefined;
	readonly onDidChangeInteractionOffer: Event<ChatInteractionOfferChange>;
	readHistoryState(sessionId: SessionId, threadId: ThreadId): Promise<AgentThreadHistoryState>;
	moveHistory(options: { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly expectedSequence: number; readonly direction: 'undo' | 'redo'; }): Promise<void>;
	readCheckpoints(sessionId: SessionId, threadId: ThreadId): Promise<readonly ChatCheckpoint[]>;
	/** Creates an independent Thread and directory from the backend's immutable checkpoint. */
	restoreCheckpoint(options: RestoreChatCheckpointOptions): Promise<{ readonly sessionId: SessionId; readonly threadId: ThreadId; }>;
	/** Session invalidation also discovers Threads that have not yet been subscribed. */
	readonly onDidChangeSession: Event<{ readonly sessionId: SessionId; readonly agentTreeChanged: boolean; }>;
	readonly onDidUpdateThread: Event<ThreadUpdateEnvelope>;
	readonly onDidUpdateThreadTranscript: Event<ThreadTranscriptUpdateEnvelope>;
	readonly onDidUpdateGoal: Event<ThreadGoalUpdate>;
	readonly onDidBecomeReady: Event<void>;
	readonly onDidUpdateTurnChanges: Event<TurnChangesUpdate>;
	readonly onDidChangeQueue: Event<void>;
	listSlashCommands(): Promise<readonly SlashCommandDefinition[]>;
	readThread(sessionId: SessionId, threadId: ThreadId, history?: ThreadSnapshotHistory): Promise<ThreadRead>;
	readContextUsage(sessionId: SessionId, threadId: ThreadId): Promise<ChatContextUsage>;
	/** The owner retains the subscription across refreshes/reconnects until explicitly released. */
	subscribeThread(sessionId: SessionId, threadId: ThreadId, afterSequence: number, owner: object, history?: ThreadSnapshotHistory): Promise<ThreadSubscription>;
	unsubscribeThread(sessionId: SessionId, threadId: ThreadId, owner: object): Promise<void>;
	startTurn(options: StartTurnOptions): Promise<void>;
	startReview(options: StartReviewOptions): Promise<void>;
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
	readThreadChanges(sessionId: SessionId, threadId: ThreadId): Promise<ThreadChangesSummary>;
	readThreadChangeFile(sessionId: SessionId, threadId: ThreadId, revision: string, repositoryId: string, path: string): Promise<TurnChangeFileContents>;
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

export const IChatService = createServiceIdentifier<IChatService>('chatService');
