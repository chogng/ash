import { SessionModelSelection } from './sessionModelSelection.js';
import { findLastIdx } from '../../base/common/arraysFind.js';
import { ChatHistoryAnchorError, ChatRequestQueueKind } from '../../workbench/services/chat/common/chatService.js';
import { updateAdvisorConfig } from '../../workbench/services/chat/common/advisor.js';
import { raceCancellationError, RunOnceScheduler } from '../../base/common/async.js';
import { commitChatSession } from '../../workbench/contrib/chat/browser/chatSessions/chatSessionCommit.js';
import type { ChatContextUsage } from '../../workbench/services/chat/common/chatService.js';
import { IAgentExecutionSettingsService } from '../../platform/agentHost/common/agentExecutionSettingsService.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { IPromptsService } from '../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { toSkillSelectors } from '../../workbench/contrib/chat/common/skillSelectors.js';
import { ILanguageModelsService } from '../../workbench/contrib/chat/common/languageModels.js';
import { Emitter, Event } from '../../base/common/event.js';
import { canceled, isCancellationError } from '../../base/common/errors.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { AgentInteractionDecision, ChatAgent, ChatMode, ChatSubmissionOptions, IChatService, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, Thread, ThreadGoal, ThreadTranscriptEntry, ThreadTranscriptUpdateEnvelope, ThreadUpdateEnvelope, Turn, TurnChangeDetails, ThreadChangesSummary, TurnChangeSetSummary, TurnInteraction } from '../../workbench/services/chat/common/chatService.js';
import { localize } from '../../nls.js';
import type { SkillReference } from '../../platform/agentHost/common/appServerApi.js';
import type { ResolvedChatContext } from '../../workbench/services/chat/common/chatContextService.js';
import type { SessionHistoryBindingDiagnostic } from '../services/sessions/browser/sessionOpenTelemetryService.js';
import { chatExecutionWorkspace, findAgentNode, type IActiveSessionThread, type ISession, type IUntitledChatSession, type ModelRef, type SessionId, type ThreadId } from '../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { chatQueuedMessageListItems, chatStreamingResponseUpdate, chatTranscriptListItems, type ChatStreamingResponseUpdate, type IChatListItem } from '../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ChatHistoryRedoModel } from '../../workbench/contrib/chat/common/model/chatHistoryRedoModel.js';
import type { ChatInputState } from '../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { modelRefIdentity, type ModelReasoningEffort } from '../../workbench/services/chat/common/modelCatalog.js';
import type { ApprovalMode } from '../../workbench/services/chat/common/chatService.js';
import type { AgentModelDefaults, ModelExecutionAvailability, ModelSelectionAvailability } from '../../platform/models/common/agentModels.js';
import { observableValue } from '../../base/common/observable.js';
import type { IChatSessionHistoryStatus } from '../../platform/chat/common/chatSessionHistory.js';
import { ChatAIDisabledSettingId } from '../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { ThreadHistoryBoundary, ThreadRead } from '../../workbench/services/chat/common/chatService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { codeConversationDefaultsSetting, codeConversationWorkspaceKey, parseCodeConversationModel, type CodeConversationDefaults, type CodeConversationModel } from '../common/codeConversationDefaults.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../common/agentHostSessionsProvider.js';
import { agentHostTurnDirectory } from '../common/agentHostSessionWorkspace.js';
import { hasSelectedCodeWorkspace } from '../common/sessionWorkspace.js';
import { IContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { SessionsWorkspaceModeContext } from '../common/contextkeys.js';
import { readChatRequestVersions } from './chatRequestVersions.js';
import { isNative } from '../../base/common/platform.js';

const historyPageTurns = 20;

export type ChatWidgetState =
	| 'loading'
	| 'ready'
	| 'submitting'
	| 'error';

/** The local or durable identity currently displayed by a Chat pane. */
export type ChatWidgetSelection =
	| {
		readonly kind: 'session';
		readonly active: IActiveSessionThread;
		/** The host can present the conversation from its first request after inherited context. */
		readonly firstRequestClientId?: string;
	}
	| { readonly kind: 'untitled'; readonly session: IUntitledChatSession; };

/**
 * State for one Chat tab, before or after it acquires a durable Thread.
 *
 * Canonical committed state is refreshed from `session/thread/read`. Transcript
 * entries arrive already assembled by App Server and are applied by stable ID.
 */
export class ChatWidgetModel extends Disposable {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<ChatStreamingResponseUpdate | void>());
	private readonly historyBindingFinished = this._register(new Emitter<SessionHistoryBindingDiagnostic>());
	readonly onDidFinishHistoryBinding = this.historyBindingFinished.event;
	private readonly _onDidChangeComposer = this._register(new Emitter<void>());
	private _composerGeneration = 0;
	private materializingComposer: { readonly untitledSessionId: string; readonly generation: number; readonly threadId: ThreadId; } | undefined;
	private voiceDraft: { readonly id: string; readonly generation: number; } | undefined;
	private transcriptEntries: ThreadTranscriptEntry[] = [];
	private transcriptRevision = 0;
	private historyBoundary: ThreadHistoryBoundary | undefined;
	private olderHistoryRequest: Promise<void> | undefined;
	private olderHistoryError: string | undefined;
	private selection: ChatWidgetSelection;
	private _thread: Thread | undefined;
	private comparableVersionTurns = new Set<string>();
	private requestVersionRevision = 0;
	private readonly refreshRequestVersions = this._register(new RunOnceScheduler(() => void this.loadRequestVersions(), 100));
	private contextUsage: ChatContextUsage | undefined;
	private contextUsageRequest = 0;
	private _state: ChatWidgetState = 'loading';
	// A late local completion cannot release a newer operation's busy state.
	private stateRequest = 0;
	private _error: string | undefined;
	private readonly _historyStatus = observableValue<IChatSessionHistoryStatus | undefined>(this, undefined);
	private generation = 0;
	private readPending: number | undefined;
	private readRequest = 0;
	private threadRead: { readonly generation: number; promise: Promise<void>; invalidated: boolean; replaceHistory: boolean; } | undefined;
	private durableSequence = 0;
	private snapshotRequest = 0;
	private initializePromise: Promise<void> | undefined;
	private subscriptionThreadId: ThreadId | undefined;
	private subscriptionPromise: Promise<void> | undefined;
	private modelCatalog: readonly ModelCatalogEntry[] = [];
	private _models: readonly ModelCatalogEntry[] = [];
	private modelsError: string | undefined;
	private modelsGeneration = 0;
	private modelAvailability: { readonly model: ModelRef; readonly status: ModelExecutionAvailability; } | undefined;
	private modelAvailabilityRequest: { readonly model: ModelRef; readonly promise: Promise<void>; } | undefined;
	private modelAvailabilityGeneration = 0;
	private defaults: AgentModelDefaults | undefined;
	private readonly selectedModes = new Map<string, ChatMode>();
	private queue: Awaited<ReturnType<IChatService['readQueue']>> = [];
	private readonly historyRedo: ChatHistoryRedoModel;
	private queueGeneration = 0;
	private readonly threadModelSelection = new SessionModelSelection();
	private readonly defaultApprovalMode = observableValue<ApprovalMode>(this, 'manual');
	private approvalGeneration = 0;
	private readonly selectedApprovalModes = observableValue<ReadonlyMap<string, ApprovalMode>>(this, new Map());
	// A New Chat's key is replaced with its Thread ID when the first message materializes it.
	private readonly selectedReasoningEfforts = new Map<string, { effort: ModelReasoningEffort | undefined; }>();
	private readonly recapViews = new Map<string, { sessionId: SessionId; threadId: ThreadId; focused: boolean; }>();
	private _slashCommands: readonly SlashCommandDefinition[] = [];
	private _skillSelectors: readonly SkillSelectorDefinition[] = [];
	private skillCatalogGeneration = 0;
	private readonly skillSelectorsLoading = observableValue(this, false);
	private _changeSets: readonly TurnChangeSetSummary[] = [];
	private readonly changeDetails = new Map<string, TurnChangeDetails>();
	private changesGeneration = 0;
	private threadChanges: ThreadChangesSummary | undefined;
	private threadChangesError: string | undefined;
	private summaryRequest = 0;
	private summaryRead: { readonly generation: number; sequence: number; promise: Promise<void>; invalidated: boolean; } | undefined;

	readonly onDidChangePresentation = this._onDidChange.event;
	readonly onDidChange = Event.map(this.onDidChangePresentation, () => undefined);
	/** Navigation retires input synchronously, including A-B-A. First materialization keeps its composer. */
	readonly onDidChangeComposer: Event<void> = this._onDidChangeComposer.event;

	get composerGeneration(): number { return this._composerGeneration; }

	protected get useCodeModelDefaults(): boolean { return true; }
	protected get commandInterpretation(): 'literal' | undefined { return undefined; }

	/** Only the selected initiating draft can replace an incidental early catalog pane. */
	get materializingUntitledSessionId(): string | undefined {
		const composer = this.materializingComposer;
		return composer?.generation === this.composerGeneration && composer.threadId === this.threadId ? composer.untitledSessionId : undefined;
	}

	constructor(chatService: IChatService, selection: ChatWidgetSelection, sessionService: ISessionsManagementService, @IPromptsService private readonly skills: IPromptsService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService, @IAgentExecutionSettingsService private readonly execution: IAgentExecutionSettingsService, @IConfigurationService private readonly configuration: IConfigurationService, @IStorageService private readonly storage: IStorageService, @IContextKeyService private readonly contextKeys?: IContextKeyService) {
		super();
		this.chatService = chatService;
		this.historyRedo = this._register(new ChatHistoryRedoModel(chatService, () => this._onDidChange.fire()));
		this.sessionService = sessionService;
		this.selection = selection;
		if (contextKeys) {
			const keys = new Set([SessionsWorkspaceModeContext.key]);
			this._register(contextKeys.onDidChangeContext(event => {
				if (event.affectsSome(keys)) {
					this.refreshRequestVersions.schedule();
					this._onDidChange.fire();
				}
			}));
		}
		this._register(sessionService.onDidChange(() => {
			if (this.isCodeConversation) this.refreshRequestVersions.schedule();
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId)) this._onDidChange.fire();
		}));
		this._register(chatService.onDidUpdateThread((update) => this.acceptUpdate(update)));
		this._register(chatService.onDidUpdateThreadTranscript((update) => this.acceptTranscriptUpdate(update)));
		this._register(chatService.onDidUpdateGoal((update) => {
			if (update.threadId !== this.threadId || !this._thread) return;
			this._thread = { ...this._thread, goal: update.goal ?? null };
			this._onDidChange.fire();
		}));
		this._register(chatService.onDidChangeInteractionOffer(change => {
			if (change.sessionId === this.sessionId && change.threadId === this.threadId) this._onDidChange.fire();
		}));
		this._register(chatService.onDidBecomeReady(() => {
			for (const [surface, view] of this.recapViews) {
				void this.reportRecapPresence(view.sessionId, view.threadId, surface, view.focused).catch(() => { });
			}
			void this.reconnect();
		}));
		this._register(execution.onDidChange(() => void this.loadDefaultApprovalMode()));
		this._register(this.languageModels.onDidChangeModels(() => {
			void this.refreshModelAvailability(true);
			void this.loadModels();
		}));
		this._register(chatService.onDidChangeQueue(() => void this.loadQueue()));
		this._register(this.skills.onDidChangeSkills(() => void this.loadSkillSelectors()));
		this._register(chatService.onDidUpdateTurnChanges((update) => {
			if (update.sessionId === this.sessionId && this.isCodeConversation) this.refreshRequestVersions.schedule();
			if (update.sessionId !== this.sessionId || update.threadId !== this.threadId) return;
			this.acceptChangeSets(update.changeSets);
			void this.refreshChanges();
		}));
		this._register(toDisposable(() => {
			this.generation++;
			this._composerGeneration++;
			const active = this.activeSession;
			if (active) void this.chatService.unsubscribeThread(active.session.sessionId, active.threadId, this);
			this._thread = undefined;
			this.transcriptEntries = [];
			this.transcriptRevision = 0;
			this.historyBoundary = undefined;
		}));
		void this.initialize();
	}

	get state(): ChatWidgetState {
		return this._state;
	}

	get inputState(): ChatInputState {
		const pendingInteraction = activeTurn(this._thread)?.pendingInteraction;
		const active = this.activeSession;
		const forkSource = this.selection.kind === 'untitled' ? this.selection.session.forkSource : undefined;
		const agentSession = forkSource ? this.sessionService.sessions.find(session => session.sessionId === forkSource.sessionId) : active?.session;
		const agentThreadId = forkSource?.threadId ?? active?.threadId;
		const agentTree = agentSession?.agentTree;
		const modelUnavailableMessage = this.modelUnavailableMessage;
		return {
			draftIdentity: { id: this.composerIdentity, generation: this.composerGeneration },
			mode: this.mode,
			activeMode: activeTurn(this._thread)?.mode,
			queuedMessages: this.queue.filter(message => message.status !== 'rejected').length,
			phase: this._state,
			inputBlocked: modelUnavailableMessage !== undefined || this.requiresWorkspaceSelection || this.historyStatus !== undefined || this.configuration.getValue<boolean>(ChatAIDisabledSettingId),
			status: modelUnavailableMessage,
			aiDisabled: this.configuration.getValue<boolean>(ChatAIDisabledSettingId),
			error: this.historyStatus ? undefined : this._error,
			canInterrupt: this.canInterrupt,
			changes: this.threadChanges?.statistics,
			changesRevision: this.threadChanges?.revision,
			changesScope: this.selection.kind === 'session' ? 'conversation' : 'workspace',
			changesError: this.threadChangesError,
			contextUsage: this.contextUsage,
			approvalMode: this.selectedApprovalModes.get().get(this.composerIdentity) ?? this._thread?.turns.at(-1)?.approvalMode ?? this.defaultApprovalMode.get(),
			models: this._models,
			modelsError: this.modelsError,
			slashCommands: this._slashCommands,
			skillSelectors: this._skillSelectors,
			skillSelectorsLoading: this.skillSelectorsLoading.get(),
			selectedModel: this.selectedModel,
			selectedModelEntry: this.selectedModelEntry,
			selectedReasoningEffort: this.selectedReasoningEffort,
			isAutomaticModel: this.isAutomaticModel,
			selectedAgent: this.selection.kind === 'untitled' && !forkSource ? this.selection.session.agent : undefined,
			agentName: agentTree && agentThreadId ? findAgentNode(agentTree, agentThreadId)?.role?.name : undefined,
			canSelectAgent: this.selection.kind === 'untitled' && !forkSource,
			interaction: this.interaction,
			pendingUserInputRequestId: pendingInteraction?.kind === 'userInput' ? pendingInteraction.requestId : undefined,
		};
	}

	private get requiresWorkspaceSelection(): boolean {
		if (this.selection.kind === 'session' || !this.isCodeConversation) return false;
		const { forkSource } = this.selection.session;
		if (forkSource) {
			const session = this.sessionService.sessions.find(candidate => candidate.sessionId === forkSource.sessionId);
			return !session || !chatExecutionWorkspace(session, session.chats.find(chat => chat.threadId === forkSource.threadId));
		}
		return !hasSelectedCodeWorkspace(this.selection.session);
	}

	get error(): string | undefined {
		return this.historyStatus?.message ?? this._error;
	}

	get historyStatus(): IChatSessionHistoryStatus | undefined {
		return this._historyStatus.get();
	}

	get olderHistory(): { readonly loading: boolean; readonly error?: string; } | undefined {
		return this.historyBoundary?.hasOlderTurns && this.historyBoundary.oldestTurnId && !this.hasFirstPresentedRequest
			? { loading: !!this.olderHistoryRequest, error: this.olderHistoryError }
			: undefined;
	}

	private get hasFirstPresentedRequest(): boolean {
		const firstRequest = this.selection.kind === 'session' && this.selection.firstRequestClientId;
		return !!firstRequest && this.transcriptEntries.some(entry => entry.type === 'item'
			&& entry.item.type === 'userMessage' && entry.item.clientId === firstRequest);
	}

	/** Older pages never replace the live cursor, execution state or interaction offer. */
	loadOlderHistory(): Promise<void> {
		if (this.isDisposed) return Promise.resolve();
		if (this.olderHistoryRequest) return this.olderHistoryRequest;
		const active = this.activeSession;
		const boundary = this.historyBoundary;
		if (!active || !boundary?.hasOlderTurns || !boundary.oldestTurnId || this.hasFirstPresentedRequest) return Promise.resolve();
		const cursor = boundary.oldestTurnId;
		const generation = this.generation;
		const readPage = (turnId: string) => this.chatService.readThread(active.session.sessionId, active.threadId, { type: 'before', turnId, turnLimit: historyPageTurns });
		this.olderHistoryError = undefined;
		const pending = Promise.resolve().then(async () => {
			let pageBoundary = boundary;
			try {
				let page: ThreadRead;
				try {
					page = await readPage(cursor);
				} catch (error) {
					if (!(error instanceof ChatHistoryAnchorError) || this.isDisposed || generation !== this.generation) throw error;
					await this.refreshThread({ replaceHistory: true });
					if (this.isDisposed || generation !== this.generation) return;
					const refreshed = this.historyBoundary;
					if (!refreshed?.hasOlderTurns || !refreshed.oldestTurnId) return;
					pageBoundary = refreshed;
					if (refreshed.oldestTurnId === cursor) throw error;
					page = await readPage(refreshed.oldestTurnId);
				}
				if (this.isDisposed || generation !== this.generation || this.historyBoundary !== pageBoundary) return;
				if (!this._thread || page.thread.threadId !== active.threadId || page.thread.sequence < this.durableSequence) {
					this.scheduleRefresh();
					throw new Error(localize('chat.history.changed', 'Chat history changed. Try loading again.'));
				}
				const existing = new Set(this._thread.turns.map(turn => turn.turnId));
				this._thread = { ...this._thread, turns: [...page.thread.turns.filter(turn => !existing.has(turn.turnId)), ...this._thread.turns] };
				this.transcriptEntries = mergeTranscriptEntries(page.transcript.entries.map(cloneTranscriptEntry), this.transcriptEntries);
				this.historyBoundary = page.history;
				if (page.thread.sequence > this._thread.sequence) this.scheduleRefresh();
			} catch (error) {
				if (!this.isDisposed && generation === this.generation && this.historyBoundary === pageBoundary) {
					this.olderHistoryError = localize('chat.history.olderFailed', 'Could not load earlier messages: {0}', String(error));
				}
			} finally {
				if (!this.isDisposed && this.olderHistoryRequest === pending) {
					this.olderHistoryRequest = undefined;
					this._onDidChange.fire();
				}
			}
		});
		this.olderHistoryRequest = pending;
		this._onDidChange.fire();
		return pending;
	}

	get thread(): Thread | undefined {
		return this._thread;
	}

	get goal(): ThreadGoal | undefined {
		return this._thread?.goal ?? undefined;
	}

	get selectedSession(): ChatWidgetSelection {
		return this.selection;
	}

	get sessionId(): SessionId | undefined {
		return this.activeSession?.session.sessionId;
	}

	get session(): ISession | undefined {
		return this.selection.kind === 'session' ? this.selection.active.session : undefined;
	}

	get isNestedDraft(): boolean {
		return this.selection.kind === 'untitled' && this.selection.session.forkSource !== undefined;
	}

	get untitledSessionId(): string | undefined {
		return this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : undefined;
	}

	get welcomeDraftId(): string | undefined {
		return this.untitledSessionId ?? (this.voiceDraft?.generation === this.composerGeneration && !this.items.length ? this.voiceDraft.id : undefined);
	}

	get threadId(): ThreadId | undefined {
		return this.activeSession?.threadId;
	}

	get models(): readonly ModelCatalogEntry[] {
		return this._models;
	}

	get slashCommands(): readonly SlashCommandDefinition[] {
		return this._slashCommands;
	}

	get skillSelectors(): readonly SkillSelectorDefinition[] {
		return this._skillSelectors;
	}

	get mode(): ChatMode {
		const key = this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
		return this.selectedModes.get(key) ?? 'agent';
	}

	selectMode(mode: ChatMode): void {
		const key = this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
		this.selectedModes.set(key, mode);
		this._onDidChange.fire();
	}

	get selectedModel(): ModelRef | undefined {
		return this.selection.kind === 'untitled'
			? this.selection.session.model
			: this.threadModelSelection.resolveModel(this.selection.active, this._thread);
	}

	get isAutomaticModel(): boolean {
		return this.selection.kind === 'untitled'
			? this.selection.session.model === undefined
			: this.threadModelSelection.isAutomatic(this.selection.active.threadId);
	}

	private get selectedModelEntry(): ModelCatalogEntry | undefined {
		const selected = this.selectedModel;
		// Picker visibility applies to new choices. An active model still needs its metadata.
		return selected && this.modelCatalog.find(entry => sameModel(entry.model, selected));
	}

	private get modelUnavailableMessage(): string | undefined {
		const availability = this.modelAvailability;
		if (!availability || this.isAutomaticModel || !sameModel(availability.model, this.selectedModel)) return undefined;
		const name = this.selectedModelEntry?.displayName ?? availability.model.model;
		switch (availability.status) {
			case 'retired':
				return localize({ bundle: 'ash.sessions', key: 'sessions.code.modelRetired' }, '{0} has been retired. Choose another model to send.', name);
			case 'modelUnavailable':
				return localize({ bundle: 'ash.sessions', key: 'sessions.code.modelUnavailable' }, '{0} is unavailable. Choose another model to send.', name);
			case 'connectionUnavailable':
				return localize({ bundle: 'ash.sessions', key: 'sessions.code.modelConnectionUnavailable' }, 'The connection for {0} is unavailable. Reconnect or choose another model to send.', name);
			case 'ready':
			case 'unknown':
				return undefined;
		}
	}

	get selectedReasoningEffort(): ModelReasoningEffort | undefined {
		if (this.isAutomaticModel) return undefined;
		const effort = this.preferredReasoningEffort();
		return effort && this.selectedModelEntry?.supportedReasoningEfforts?.some(option => option.effort === effort) ? effort : undefined;
	}

	private preferredReasoningEffort(): ModelReasoningEffort | undefined {
		if (this.selection.kind === 'untitled') return draftReasoningEffort(this.selection.session);
		const selection = this.selectedReasoningEfforts.get(this.composerIdentity);
		if (selection) return selection.effort;
		return this._thread?.turns.at(-1)?.reasoningEffort ?? undefined;
	}

	get items(): readonly IChatListItem[] {
		const thread = this._thread;
		const latestTurnId = thread?.turns.at(-1)?.turnId;
		const provider = this.selection.kind === 'session' ? this.selection.active.session.providerId : this.selection.session.providerId;
		const source = thread && {
			sessionId: thread.sessionId, threadId: thread.threadId, commandTerminals: isNative && (!provider || provider === LOCAL_AGENT_HOST_PROVIDER_ID),
			directoryForTurn: (turn: Turn) => agentHostTurnDirectory(thread.sessionId, turn.directory),
		};
		let transcript = chatTranscriptListItems(this.transcriptEntries, latestTurnId, thread?.turns, source, {
			archived: thread?.status === 'archived', hasOlderTurns: this.historyBoundary?.hasOlderTurns,
		}, this._changeSets);
		const firstRequest = this.selection.kind === 'session' && this.selection.firstRequestClientId;
		if (firstRequest) {
			const start = transcript.findIndex(item => item.type === 'userMessage' && item.requestClientId === firstRequest);
			if (start > 0) transcript = transcript.slice(start);
		}
		if (thread && this.isCodeConversation && (this._changeSets.length || this.comparableVersionTurns.size)) {
			const captured = new Map<string, boolean>();
			for (const change of this._changeSets) {
				if (change.threadId !== thread.threadId) continue;
				captured.set(change.turnId, captured.get(change.turnId) !== false && change.captureState === 'sealed' && change.terminalState === 'completed');
			}
			const finalReplies = new Map<string, string>();
			const replayableTurns = new Set(thread.turns.filter(turn => (!turn.kind || turn.kind === 'coding')
				&& turn.items.find(item => item.type === 'userMessage')?.clientId).map(turn => turn.turnId));
			for (const item of transcript) {
				const source = item.feedbackSource;
				if (source && this.comparableVersionTurns.has(source.turnId)) finalReplies.set(source.turnId, item.id);
			}
			transcript = transcript.map(item => {
				const request = item.requestSource;
				if (request && thread.status === 'active' && replayableTurns.has(request.turnId) && captured.get(request.turnId)) return { ...item, canRunAnotherVersion: true };
				if (item.feedbackSource && finalReplies.get(item.feedbackSource.turnId) === item.id) return { ...item, canCompareResults: true };
				return item;
			});
		}
		const redo = this.historyRedo.item(thread);
		const queued = this.queue.length && thread?.status === 'active' ? chatQueuedMessageListItems(this.queue) : [];
		return redo || queued.length ? [...transcript, ...(redo ? [redo] : []), ...queued] : transcript;
	}

	protected get isCodeConversation(): boolean {
		return this.contextKeys?.getValue(SessionsWorkspaceModeContext.key) === 'code';
	}

	private async loadRequestVersions(): Promise<void> {
		const threadId = this.threadId;
		const session = this.sessionService.sessions.find(candidate => candidate.sessionId === this.sessionId);
		const revision = ++this.requestVersionRevision;
		const pairs = this.isCodeConversation && session && threadId ? await readChatRequestVersions(this.chatService, session, threadId) : [];
		if (this.isDisposed || this.requestVersionRevision !== revision || threadId !== this.threadId || (session && session.sessionId !== this.sessionId)) return;
		const turns = new Set(pairs.flatMap(({ original, alternate }) => original.threadId === threadId ? [original.turnId] : [alternate.turnId]));
		if (turns.size === this.comparableVersionTurns.size && [...turns].every(turnId => this.comparableVersionTurns.has(turnId))) return;
		this.comparableVersionTurns = turns;
		this._onDidChange.fire();
	}

	get interaction(): TurnInteraction | undefined {
		const active = this.activeSession;
		if (!active) return undefined;
		const offer = this.chatService.getInteractionOffer(active.session.sessionId, active.threadId);
		return offer?.interaction;
	}

	get agentTree() {
		return this.activeSession?.session.agentTree ?? [];
	}

	get changeSets(): readonly TurnChangeSetSummary[] {
		return this._changeSets;
	}

	turnChangeDetails(changeSetId: string): TurnChangeDetails | undefined {
		return this.changeDetails.get(changeSetId);
	}

	async generateChangeMessage(changeSet: TurnChangeSetSummary): Promise<void> {
		const owner = this.requireChangeOwner();
		const operation = this.captureOperation();
		const changes = await this.chatService.generateTurnChangeMessage(owner.sessionId, owner.threadId, changeSet.changeSetId, changeSet.revision);
		this.requireCurrentOperation(operation);
		this.acceptChangeSets(changes);
	}

	async updateChangeDraft(changeSet: TurnChangeSetSummary, message: string): Promise<void> {
		const owner = this.requireChangeOwner();
		const operation = this.captureOperation();
		const changes = await this.chatService.updateTurnChangeDraft(owner.sessionId, owner.threadId, changeSet.changeSetId, changeSet.revision, message);
		this.requireCurrentOperation(operation);
		this.acceptChangeSets(changes);
		await this.loadChangeDetails(changeSet.changeSetId, this.changesGeneration);
	}

	async discardChanges(): Promise<void> {
		const owner = this.requireChangeOwner();
		const operation = this.captureOperation();
		const expectedRevision = Math.max(0, ...this._changeSets.map((changeSet) => changeSet.revision));
		const changes = await this.chatService.discardThreadChanges(owner.sessionId, owner.threadId, expectedRevision);
		this.requireCurrentOperation(operation);
		this.acceptChangeSets(changes);
	}

	get canInterrupt(): boolean {
		if (activeTurn(this._thread)) return true;
		return this.selection.kind === 'untitled' && this._state === 'submitting'
			&& this.sessionService.untitledSessions.some(draft => draft.untitledSessionId === this.untitledSessionId && draft.devContainer);
	}

	/** History recovery can settle independently of model and skill discovery. */
	get pendingHistoryBinding(): Promise<void> | undefined { return this.subscriptionPromise; }

	async initialize(): Promise<void> {
		if (!this.initializePromise) {
			this.initializePromise = this._initialize();
		}
		return this.initializePromise;
	}

	async selectThread(active: IActiveSessionThread): Promise<void> {
		if (this.selection.kind === 'untitled') {
			const draft = this.selection.session;
			const promoted = this.sessionService.materializedSessions.get().get(draft.untitledSessionId);
			if (promoted?.sessionId === active.session.sessionId && promoted.threadId === active.threadId) {
				this.adoptUntitledSession(draft, active);
				await this.subscribe(active);
				return;
			}
		}
		const current = this.activeSession;
		if (!current || active.session.sessionId !== current.session.sessionId) {
			throw new Error(`ChatWidgetModel cannot select a Thread from another Session: ${active.session.sessionId}`);
		}
		const previousThreadId = current.threadId;
		const previousModel = current.session.model;
		if (previousThreadId !== active.threadId) {
			this._historyStatus.set(undefined);
			this.durableSequence = 0;
			this.snapshotRequest = 0;
			this._composerGeneration++;
			this._onDidChangeComposer.fire();
		}
		this.selection = { kind: 'session', active };
		// Catalog hydration changes metadata; reselecting the same conversation must not
		// erase a failed history read or start another read beside initialization/Retry.
		if (previousThreadId === active.threadId) {
			if (!sameModel(previousModel, active.session.model)) void this.loadModels();
			this._onDidChange.fire();
			return;
		}
		if (previousThreadId !== active.threadId) {
			void this.chatService.unsubscribeThread(current.session.sessionId, previousThreadId, this);
		}
		await this.subscribe(active);
	}

	selectUntitledSession(session: IUntitledChatSession): void {
		if (this.selection.kind !== 'untitled' || this.selection.session.untitledSessionId !== session.untitledSessionId) {
			throw new Error(`ChatWidgetModel cannot select another Untitled Chat Session: ${session.untitledSessionId}`);
		}
		const sameProvider = this.selection.session.providerId === session.providerId;
		this.selection = { kind: 'untitled', session };
		if (sameProvider) this.applyDefaultNewChatModel();
		this._onDidChange.fire();
		void this.loadModels();
	}

	/** A retained editor can rebind its single slot while a grid pane keeps one Session. */
	protected bindSelection(selection: ChatWidgetSelection): void {
		if (selection.kind === 'untitled' && selection.session.untitledSessionId === this.untitledSessionId) {
			if (selection.session !== (this.selection.kind === 'untitled' && this.selection.session)) {
				this.selection = selection;
				this._onDidChange.fire();
			}
			return;
		}
		if (selection.kind === 'session' && selection.active.session.sessionId === this.sessionId && selection.active.threadId === this.threadId) {
			if (selection.active.session !== this.session) void this.selectThread(selection.active);
			return;
		}
		const previous = this.activeSession;
		this._composerGeneration++;
		this._onDidChangeComposer.fire();
		this.generation++;
		if (previous) void this.chatService.unsubscribeThread(previous.session.sessionId, previous.threadId, this);
		this.selection = selection;
		this.subscriptionThreadId = undefined;
		this.subscriptionPromise = undefined;
		this.initializePromise = undefined;
		this.durableSequence = 0;
		this.snapshotRequest = 0;
		this._historyStatus.set(undefined);
		this.resetThreadPresentation(false);
		void this.initialize();
	}

	protected restoreThreadModel(model: ModelRef | undefined, effort: ModelReasoningEffort | undefined): void {
		const id = this.threadId;
		if (!id) return;
		if (model) {
			this.threadModelSelection.select(id, model);
			this.selectedReasoningEfforts.set(id, { effort });
		} else {
			this.threadModelSelection.clear(id);
			this.selectedReasoningEfforts.delete(id);
		}
		void this.refreshModelAvailability();
		this._onDidChange.fire();
	}

	protected notifyModelChoicesChanged(): void { this._onDidChange.fire(); }

	async selectModel(model: ModelRef): Promise<void> {
		if (!this._models.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
			throw new Error(localize('chat.modelPicker.unavailable', 'The selected model is not available'));
		}
		this.setConversationModel(model);
	}

	async selectAutomaticModel(): Promise<void> {
		this.setConversationModel(undefined);
	}

	private setConversationModel(model: ModelRef | undefined): void {
		if (this.isDisposed) return;
		this.rememberConversationModel({ model: model ?? null, effort: model ? this.preferredReasoningEffort() : undefined });
		if (this.selection.kind === 'untitled') {
			this.sessionService.setUntitledSessionModel(this.selection.session.untitledSessionId, model);
			this.refreshUntitledSelection();
		} else {
			this.threadModelSelection.select(this.selection.active.threadId, model);
		}
		void this.refreshModelAvailability();
		this._onDidChange.fire();
	}

	async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const model = this.selectedModel;
		if (!model || this.isAutomaticModel) throw new Error('Select a model before setting its thinking effort');
		const entry = this.selectedModelEntry;
		if (!entry || (effort !== undefined && !entry.supportedReasoningEfforts?.some(option => option.effort === effort))) {
			throw new Error('The selected model does not support this thinking effort');
		}
		if (this.isDisposed) return;
		this.rememberConversationModel({ model, effort });
		if (this.selection.kind === 'untitled') {
			this.sessionService.setUntitledSessionReasoningEffort(this.selection.session.untitledSessionId, effort ?? null);
			this.refreshUntitledSelection();
		} else {
			this.selectedReasoningEfforts.set(this.composerIdentity, { effort });
			this._onDidChange.fire();
		}
	}

	async listAgents(): Promise<readonly ChatAgent[]> {
		return this.sessionService.listAgents();
	}

	selectAgent(agent: ChatAgent | undefined): void {
		if (this.selection.kind !== 'untitled') throw new Error('Start a new Chat to select an Agent');
		if (this.selection.session.agent?.name === agent?.name && this.selection.session.agent?.sourceId === agent?.sourceId) return;
		const untitledSessionId = this.selection.session.untitledSessionId;
		this.sessionService.setUntitledSessionAgent(untitledSessionId, agent);
		const session = this.sessionService.untitledSessions.find(candidate => candidate.untitledSessionId === untitledSessionId)!;
		this.selection = { kind: 'untitled', session };
		this._onDidChange.fire();
	}

	async send(text: string, mode: ChatMode = this.mode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions): Promise<void> {
		await this.submitMessage(text, mode, skills, contexts, options);
	}

	sendInBackground(text: string, mode: ChatMode, skills: readonly SkillReference[] | undefined, contexts: readonly ResolvedChatContext[], signal?: AbortSignal): Promise<IActiveSessionThread | undefined> {
		if (this.selection.kind !== 'untitled' || this.selection.session.forkSource) throw canceled();
		return this.submitMessage(text, mode, skills, contexts, { signal }, this.selection.session.untitledSessionId);
	}

	private async submitMessage(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions, backgroundDraftId?: string): Promise<IActiveSessionThread | undefined> {
		if (!text.trim() && !contexts?.length) return;
		this.assertAIEnabled();
		this.assertWorkspaceSelected();
		const operation = this.captureOperation(options);
		const stateRequest = ++this.stateRequest;
		let modelBlock: Error | undefined;
		try {
			this.requireCurrentOperation(operation);
			await this.initialize();
			this.requireCurrentOperation(operation);
			if (this.historyStatus) throw new Error(this.historyStatus.message);
			this.assertAIEnabled();
			const model = this.isAutomaticModel ? undefined : this.selectedModel;
			await this.awaitOperationPreparation(this.refreshModelAvailability(true), operation);
			if (!sameModel(model, this.isAutomaticModel ? undefined : this.selectedModel)) throw canceled();
			const unavailable = this.modelUnavailableMessage;
			if (unavailable) {
				modelBlock = new Error(unavailable);
				throw modelBlock;
			}
			// Once accepted, this request keeps its model even if the picker changes during preparation.
			const reasoningEffort = this.selectedReasoningEffort;
			this.setState('submitting');
			this.requireCurrentOperation(operation);
			let active: IActiveSessionThread;
			let thread: Thread | undefined;
			if (backgroundDraftId) {
				active = await this.sessionService.materializeUntitledSession(backgroundDraftId, operation.signal);
				this.requireCurrentOperation(operation);
				thread = (await this.chatService.readThread(active.session.sessionId, active.threadId, { type: 'latest', turnLimit: 1 })).thread;
				if (thread.turns.length > 0) {
					throw new Error(localize('sessions.chat.backgroundSend.alreadyStarted', 'This session already has a request. Open it from the session list to continue.'));
				}
			} else {
				active = await this.ensureActiveSession(operation.signal);
				if (this.isDisposed || operation.signal?.aborted || operation.generation !== this.composerGeneration || active.session.sessionId !== this.sessionId || active.threadId !== this.threadId) throw canceled();
				// Materializing a foreground composer changes its identity to the durable Thread.
				operation.identity = active.threadId;
				if (this._thread?.threadId !== active.threadId) await this.subscribe(active);
				thread = this._thread;
			}
			this.requireCurrentOperation(operation);
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error('Chat Thread is not available');
			}
			if (options?.signal?.aborted || options?.source && (active.session.sessionId !== options.source.sessionId || active.threadId !== options.source.threadId)) throw canceled();
			const turn = activeTurn(thread);
			const submission = {
				isNewSession: thread.turns.length === 0,
				sessionId: active.session.sessionId,
				threadId: active.threadId,
				expectedSequence: thread.sequence,
				// Reference offsets belong to the exact composer text, including leading whitespace.
				text,
				mode,
				// An unknown/default choice stays with the backend authority; only conversation choices override it.
				approvalMode: this.selectedApprovalModes.get().get(this.composerIdentity) ?? this._thread?.turns.at(-1)?.approvalMode,
				model,
				reasoningEffort,
				contexts,
				signal: operation.signal,
				commandId: options?.commandId,
				source: options?.source,
				...(this.commandInterpretation && { commandInterpretation: this.commandInterpretation }),
				skills,
			};
			if (backgroundDraftId) {
				await this.chatService.startTurn(submission);
				this.sessionService.completeBackgroundSend(backgroundDraftId, active);
				if (this.isCurrentTarget(operation)) this.setState('ready');
				return active;
			}
			const needsNewTurn = !!turn && (turn.kind !== undefined && turn.kind !== 'coding' && turn.kind !== 'review' || turn.mode !== mode || !!skills?.length);
			if (turn && options?.queue === ChatRequestQueueKind.Steering && needsNewTurn) {
				throw new Error(localize('chat.steer.incompatible', 'The current request has a different mode, Skill or task type. Add this message to the queue instead.'));
			}
			if (turn && (options?.queue === ChatRequestQueueKind.Queued || needsNewTurn)) {
				// A frozen Turn keeps its approach. A new approach gets its own durable submission.
				await this.chatService.queueTurn(submission);
				if (!this.isCurrentOperation(operation)) { this.recoverCancelledSubmission(operation, stateRequest); return; }
				await this.loadQueue();
			} else if (turn) {
				if (!isSteerableTurn(turn)) throw new Error(localize('chat.steer.unavailable', 'The current request cannot accept steering. Add this message to the queue instead.'));
				await this.chatService.steerTurn({ ...submission, turnId: turn.turnId });
			} else {
				await this.chatService.startTurn(submission);
			}
			if (!this.isCurrentOperation(operation)) { this.recoverCancelledSubmission(operation, stateRequest); return; }
			await this.refreshThread();

		} catch (error) {
			if (modelBlock && error === modelBlock) throw error;
			if (!this.isCurrentTarget(operation) || stateRequest !== this.stateRequest) throw error;
			if (operation.signal?.aborted || isCancellationError(error)) {
				if (this._state === 'submitting') this.setState('ready');
				throw error;
			}
			if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
				this.setState(this.historyStatus ? 'error' : 'ready');
				throw error;
			}
			this.setError(error);
			throw error;
		}
	}


	/** Voice obtains a durable owner through the same draft materialization as typed input. */
	async prepareConversation(signal?: AbortSignal): Promise<{ readonly sessionId: SessionId; readonly threadId: ThreadId; }> {
		this.assertAIEnabled();
		const operation = this.captureOperation({ signal });
		await this.awaitOperationPreparation(this.initialize(), operation);
		this.requireCurrentOperation(operation);
		const active = await this.ensureActiveSession(signal, true);
		if (this.isDisposed || signal?.aborted || operation.generation !== this.composerGeneration || active.threadId !== this.threadId || active.session.sessionId !== this.sessionId) throw canceled();
		return { sessionId: active.session.sessionId, threadId: active.threadId };
	}

	selectApprovalMode(mode: ApprovalMode): void {
		this.selectedApprovalModes.set(new Map(this.selectedApprovalModes.get()).set(this.composerIdentity, mode));
		this._onDidChange.fire();
	}

	private get composerIdentity(): string {
		return this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
	}

	reportRecapPresence(sessionId: SessionId, threadId: ThreadId, surface: string, focused: boolean | null): Promise<void> {
		if (focused === null) this.recapViews.delete(surface);
		else this.recapViews.set(surface, { sessionId, threadId, focused });
		return this.chatService.setRecapPresence?.(sessionId, threadId, surface, focused) ?? Promise.resolve();
	}

	async executeServerCommand(name: string, argumentsText: string, submissionSignal?: AbortSignal): Promise<void | string> {
		this.assertAIEnabled();
		if (name === 'recap') {
			const operation = this.captureOperation({ signal: submissionSignal });
			const active = this.activeSession;
			if (!active || !this.chatService.generateRecap) throw new Error(localize('chat.recap.needsConversation', 'Finish a conversation turn before using /recap.'));
			const recap = await this.chatService.generateRecap(active.session.sessionId, active.threadId);
			this.requireCurrentOperation(operation);
			return recap;
		}
		if (name !== 'compact' && name !== 'advisor') {
			await this.send(`/${name}${argumentsText ? ` ${argumentsText}` : ''}`, this.mode, undefined, undefined, { signal: submissionSignal });
			return;
		}
		const operation = this.captureOperation({ signal: submissionSignal });
		const stateRequest = ++this.stateRequest;
		try {
			this.setState('submitting');
			this.requireCurrentOperation(operation);
			const argument = argumentsText.trim();
			const isModelSelection = /^[^/\s]+\/\S+$/.test(argument);
			const isAdvisorConfigArgument = argument === 'off' || argument === 'clear' || isModelSelection;
			if (name === 'advisor' && isAdvisorConfigArgument) {
				const current = await this.awaitOperationPreparation(this.chatService.readAdvisorDefault(), operation);
				this.requireCurrentOperation(operation);
				if (argument === 'clear') {
					await this.chatService.saveAdvisorDefault(updateAdvisorConfig(current, { type: 'clear' }));
					this.requireCurrentOperation(operation);
				} else if (argument === 'off') {
					if (current) await this.chatService.saveAdvisorDefault(updateAdvisorConfig(current, { type: 'setEnabled', enabled: false }));
					this.requireCurrentOperation(operation);
				} else {
					const models = await this.awaitOperationPreparation(this.languageModels.listAdvisorModels(), operation);
					this.requireCurrentOperation(operation);
					const chosen = models.find(entry => `${entry.model.provider}/${entry.model.model}` === argument);
					if (!chosen) throw new Error(localize('chat.advisor.modelUnavailable', 'Advisor model is unavailable: {0}', argument));
					const config = updateAdvisorConfig(current, { type: 'selectModel', model: chosen });
					await this.chatService.saveAdvisorDefault(config);
					this.requireCurrentOperation(operation);
				}
				if (stateRequest === this.stateRequest) this.setState('ready');
				return;
			}
			const advisorDefault = name === 'advisor' ? await this.awaitOperationPreparation(this.chatService.readAdvisorDefault(), operation) : null;
			this.requireCurrentOperation(operation);
			if (name === 'advisor' && !argument) throw new Error(localize('chat.advisor.questionRequired', 'Enter a question after /advisor'));
			if (name === 'advisor' && this.selection.kind === 'untitled' && (!advisorDefault || !advisorDefault.enabled)) {
				throw new Error(localize('chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'));
			}
			const active = await this.ensureActiveSession(operation.signal);
			if (this.isDisposed || operation.generation !== this.composerGeneration || active.session.sessionId !== this.sessionId || active.threadId !== this.threadId) throw canceled();
			operation.identity = active.threadId;
			if (this._thread?.threadId !== active.threadId) {
				await this.awaitOperationPreparation(this.subscribe(active), operation);
				this.requireCurrentOperation(operation);
			}
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error('Chat Thread is not available');
			}
			if (name === 'advisor') {
				const options = { sessionId: active.session.sessionId, threadId: active.threadId, expectedSequence: thread.sequence, isNewSession: thread.turns.length === 0 };
				if (activeTurn(thread)) throw new Error(localize('chat.advisor.turnActive', 'Wait for the active Turn to finish before starting a consultation'));
				if (!advisorDefault || !advisorDefault.enabled) throw new Error(localize('chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'));
				await this.chatService.consultAdvisor({ ...options, question: argument });
				this.requireCurrentOperation(operation);
				await this.refreshThread();
				this.requireCurrentOperation(operation);
				return;
			}
			if (activeTurn(thread)) {
				throw new Error('Context can be compacted only when the active Turn has finished');
			}
			await this.chatService.compactContext({
				sessionId: active.session.sessionId,
				threadId: active.threadId,
				expectedSequence: thread.sequence,
				...(argumentsText.trim() ? { retentionPrompt: argumentsText.trim() } : {}),
			});
			this.requireCurrentOperation(operation);
			await this.refreshThread();
			this.requireCurrentOperation(operation);
		} catch (error) {
			if (!this.isCurrentTarget(operation) || stateRequest !== this.stateRequest) throw error;
			if (operation.signal?.aborted || isCancellationError(error)) { this.recoverCancelledSubmission(operation, stateRequest); throw error; }
			this.setError(error);
			throw error;
		}
	}

	private assertAIEnabled(): void {
		if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			throw new Error(localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.'));
		}
	}

	async retryFailedTurn(turnId: string): Promise<void> {
		const turns = this._thread?.turns ?? [];
		const turn = turns.at(-1);
		if (turn?.turnId !== turnId || turn.status !== 'failed' || turn.error?.retryable !== true || turn.kind !== undefined && turn.kind !== 'coding' && turn.kind !== 'review') {
			throw new Error('Only the latest retryable failed Turn can be retried');
		}
		await this.send('Try again.', turn.mode);
	}

	async interrupt(): Promise<void> {
		if (this.selection.kind === 'untitled' && this._state === 'submitting') {
			this.sessionService.cancelUntitledSessionPreparation(this.selection.session.untitledSessionId);
			return;
		}
		const thread = this._thread;
		const turn = activeTurn(thread);
		if (!thread || !turn) return;
		const operation = this.captureOperation();
		const stateRequest = ++this.stateRequest;
		const isCurrent = () => stateRequest === this.stateRequest && this.isCurrentOperation(operation) && activeTurn(this._thread)?.turnId === turn.turnId;
		try {
			this.setState('submitting');
			// Stopping existing work remains permitted when the preference blocks new AI requests.
			if (!this.isCurrentOperation(operation)) { throw canceled(); }
			await this.chatService.interruptTurn({
				sessionId: thread.sessionId,
				threadId: thread.threadId,
				turnId: turn.turnId,
				expectedSequence: thread.sequence,
			});
			if (!isCurrent()) return;
			await this.refreshThread();

		} catch (error) {
			if (isCurrent()) this.setError(error);
			throw error;
		}
	}

	async resolveInteraction(response: AgentInteractionDecision, expectedRequestId?: string): Promise<void> {
		const thread = this._thread;
		const offer = thread ? this.chatService.getInteractionOffer(thread.sessionId, thread.threadId) : undefined;
		const interaction = offer?.interaction;
		if (!thread || !offer || !interaction) return;
		if (expectedRequestId !== undefined && interaction.requestId !== expectedRequestId) { throw canceled(); }
		if ((response.type === 'cancelUserInput' ? 'userInput' : response.type) !== interaction.request.type) {
			throw new Error('Interaction response kind does not match request');
		}
		const operation = this.captureOperation();
		const stateRequest = ++this.stateRequest;
		const isCurrent = () => stateRequest === this.stateRequest && this.isCurrentOperation(operation) && this.chatService.getInteractionOffer(thread.sessionId, thread.threadId) === offer;
		try {
			this.setState('submitting');
			this.requireCurrentOperation(operation);
			if (this.chatService.getInteractionOffer(thread.sessionId, thread.threadId) !== offer) throw canceled();
			await this.chatService.resolveInteraction({
				sessionId: thread.sessionId,
				threadId: thread.threadId,
				turnId: offer.turnId,
				requestId: interaction.requestId,
				expectedSequence: thread.sequence,
				response,
			});
			const currentOffer = this.chatService.getInteractionOffer(thread.sessionId, thread.threadId);
			if (!this.isCurrentOperation(operation) || stateRequest !== this.stateRequest || currentOffer && currentOffer !== offer) return;
			await this.refreshThread();

		} catch (error) {
			if (isCurrent()) this.setError(error);
			throw error;
		}
	}

	private async _initialize(): Promise<void> {
		this.setState('loading');
		if (this.selection.kind === 'untitled') {
			await this.loadCatalogs();
			if (!this.isDisposed && this.selection.kind === 'untitled') {
				this.setState('ready');
			}
			return;
		}
		await Promise.all([this.subscribe(this.selection.active), this.loadCatalogs()]);
	}

	private async loadDefaultApprovalMode(): Promise<void> {
		const generation = ++this.approvalGeneration;
		try {
			const snapshot = await this.execution.read();
			if (this.isDisposed || generation !== this.approvalGeneration) return;
			this.defaultApprovalMode.set(snapshot.settings.approvalMode);
			this._onDidChange.fire();
		} catch { /* A disconnected composer retains its last known default until reconnect. */ }
	}

	private async loadCatalogs(): Promise<void> {
		const generation = ++this.modelsGeneration;
		const slashCatalog = this.commandInterpretation === 'literal' ? [] : this.chatService.listSlashCommands();
		const [models, slashCommands] = await Promise.allSettled([this.languageModels.listModelCatalog(), slashCatalog, this.loadSkillSelectors(), this.loadDefaultApprovalMode(), this.loadModelDefaults()]);
		if (this.isDisposed) return;
		if (generation === this.modelsGeneration && models.status === 'fulfilled') {
			this.acceptModelCatalog(models.value);
		} else if (generation === this.modelsGeneration && models.status === 'rejected') {
			this.modelsError = String(models.reason);
		}
		if (slashCommands.status === 'fulfilled') this._slashCommands = slashCommands.value;
		this._onDidChange.fire();
		await this.refreshModelAvailability();
	}

	private async loadModels(): Promise<void> {
		const generation = ++this.modelsGeneration;
		try {
			const [models] = await Promise.all([this.languageModels.listModelCatalog(), this.loadModelDefaults()]);
			if (this.isDisposed || generation !== this.modelsGeneration) return;
			this.acceptModelCatalog(models);
			this._onDidChange.fire();
		} catch (error) {
			if (this.isDisposed || generation !== this.modelsGeneration) return;
			this.modelsError = String(error);
			this._onDidChange.fire();
		}
		await this.refreshModelAvailability();
	}

	private async loadModelDefaults(): Promise<void> {
		if (!this.useCodeModelDefaults) return;
		try {
			const defaults = await this.languageModels.readModelDefaults();
			if (!this.isDisposed) this.defaults = defaults;
		} catch { /* Keep the last backend snapshot until the connection recovers. */ }
	}

	private acceptModelCatalog(catalog: readonly ModelCatalogEntry[]): void {
		this.modelCatalog = catalog;
		this._models = catalog.filter(entry => this.languageModels.isModelVisible(entry.model));
		this.modelsError = undefined;
		this.applyDefaultNewChatModel();
	}

	private refreshModelAvailability(force = false): Promise<void> {
		const model = this.isAutomaticModel ? undefined : this.selectedModel;
		if (!model || this.isDisposed) {
			this.modelAvailabilityGeneration++;
			this.modelAvailabilityRequest = undefined;
			this.modelAvailability = undefined;
			return Promise.resolve();
		}
		const pending = this.modelAvailabilityRequest;
		if (!force && pending && sameModel(pending.model, model)) return pending.promise;
		if (!force && this.modelAvailability && sameModel(this.modelAvailability.model, model)) return Promise.resolve();
		if (!sameModel(this.modelAvailability?.model, model)) this.modelAvailability = undefined;
		const generation = ++this.modelAvailabilityGeneration;
		const promise = this.checkModelAvailability(model, generation).finally(() => {
			if (generation === this.modelAvailabilityGeneration) this.modelAvailabilityRequest = undefined;
		});
		this.modelAvailabilityRequest = { model, promise };
		return promise;
	}

	private async checkModelAvailability(model: ModelRef, generation: number): Promise<void> {
		let availability: ModelSelectionAvailability;
		try {
			availability = await this.languageModels.readModelAvailability(model);
		} catch {
			// A failed check does not prove that a model is unavailable.
			return;
		}
		if (this.isDisposed || generation !== this.modelAvailabilityGeneration
			|| this.isAutomaticModel || !sameModel(model, this.selectedModel)) return;
		const previous = this.modelAvailability?.status;
		const status = availability.selected;
		if (status === 'unknown' && previous) return;
		this.modelAvailability = { model, status };
		if (status !== 'unknown' && status !== 'ready' && availability.defaultAvailability === 'ready'
			&& availability.configuredDefault && !sameModel(model, availability.configuredDefault) && this.selection.kind === 'untitled') {
			const draft = this.selection.session;
			if (draft.modelDefaults && draft.modelSelectionKind !== 'manual' && !draft.forkSource) {
				this.sessionService.setUntitledSessionDefaultModel(draft.untitledSessionId, availability.configuredDefault, { workspace: draft.modelDefaults.workspace }, model);
				this.refreshUntitledSelection();
			}
		}
		if (previous !== status) this._onDidChange.fire();
	}

	private applyDefaultNewChatModel(): void {
		if (!this.useCodeModelDefaults || this.selection.kind !== 'untitled' || !this.modelCatalog.length) return;
		const draft = this.selection.session;
		const workspace = codeConversationWorkspaceKey(draft.workspace) ?? null;
		if (draft.modelDefaults?.workspace === workspace) return;
		const settings = this.configuration.getValue<CodeConversationDefaults>(codeConversationDefaultsSetting);
		const last = this.lastConversationModel();
		const defaults = (workspace ? settings?.workspaces[workspace] : undefined) ?? settings?.profile ?? last;
		const model = defaults.model ?? undefined;
		this.sessionService.setUntitledSessionDefaultModel(draft.untitledSessionId, model, { workspace, effort: defaults.effort });
		this.refreshUntitledSelection();
	}

	private get lastConversationModelKey(): string {
		const provider = this.selection.kind === 'untitled' ? this.selection.session.providerId : this.selection.active.session.providerId;
		return `sessions.code.lastConversationModel.${provider ?? LOCAL_AGENT_HOST_PROVIDER_ID}`;
	}

	private lastConversationModel(): CodeConversationModel {
		const raw = this.storage.get(this.lastConversationModelKey, StorageScope.PROFILE);
		if (raw !== undefined) {
			try { return parseCodeConversationModel(JSON.parse(raw)); } catch { /* Recover an invalid saved selection from backend defaults. */ }
		}
		const model = this.languageModels.getDefaultNewChatModel(this._models) ?? null;
		const selection = { model };
		if (this.defaults) this.rememberConversationModel(selection);
		return selection;
	}

	private rememberConversationModel(selection: CodeConversationModel): void {
		if (this.useCodeModelDefaults) this.storage.store(this.lastConversationModelKey, JSON.stringify(selection), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private refreshUntitledSelection(): void {
		if (this.selection.kind !== 'untitled') return;
		const previous = this.selection.session;
		const session = this.sessionService.untitledSessions.find(candidate => candidate.untitledSessionId === previous.untitledSessionId);
		if (!session || session === previous) return;
		this.selection = { kind: 'untitled', session };
		this._onDidChange.fire();
	}

	private async loadSkillSelectors(): Promise<void> {
		if (this.commandInterpretation === 'literal') return;
		const generation = ++this.skillCatalogGeneration;
		const sessionId = this.sessionId;
		this.skillSelectorsLoading.set(true);
		this._onDidChange.fire();
		try {
			const catalog = await this.skills.findAgentSkills(CancellationToken.None, sessionId);
			if (this.isDisposed || generation !== this.skillCatalogGeneration || sessionId !== this.sessionId) return;
			this._skillSelectors = toSkillSelectors(catalog);
		} catch {
			// Keep the last valid catalog when a transient refresh fails.
		} finally {
			if (!this.isDisposed && generation === this.skillCatalogGeneration && sessionId === this.sessionId) {
				this.skillSelectorsLoading.set(false);
				this._onDidChange.fire();
			}
		}
	}

	private async subscribe(active: IActiveSessionThread): Promise<void> {
		if (
			this.subscriptionThreadId === active.threadId &&
			this.subscriptionPromise
		) {
			return this.subscriptionPromise;
		}
		this.subscriptionThreadId = active.threadId;
		const promise = this.performSubscribe(active);
		this.subscriptionPromise = promise;
		try {
			await promise;
		} finally {
			if (this.subscriptionPromise === promise) {
				this.subscriptionThreadId = undefined;
				this.subscriptionPromise = undefined;
			}
		}
	}

	private resetThreadPresentation(sameThread: boolean): void {
		if (!sameThread) {
			this._thread = undefined;
			this.transcriptEntries = [];
			this.historyBoundary = undefined;
		}
		this.olderHistoryRequest = undefined;
		this.olderHistoryError = undefined;
		this.contextUsage = undefined;
		this.contextUsageRequest++;
		this.transcriptRevision = 0;
		this._changeSets = [];
		this.threadChanges = undefined;
		this.threadChangesError = undefined;
		this.summaryRequest++;
		this.queue = [];
		this.queueGeneration++;
		this.historyRedo.reset();
		this.changeDetails.clear();
		this.changesGeneration++;
	}

	private async performSubscribe(active: IActiveSessionThread): Promise<void> {
		const started = performance.now();
		let subscribedAt: number | undefined;
		let reconciliationMs: number | undefined;
		let outcome: SessionHistoryBindingDiagnostic['outcome'] = 'superseded';
		const generation = ++this.generation;
		const oldThreadId = this._thread?.threadId;
		const request = ++this.readRequest;
		this.resetThreadPresentation(oldThreadId === active.threadId);
		this.setState('loading');
		if (oldThreadId && oldThreadId !== active.threadId) {
			void this.chatService.unsubscribeThread(active.session.sessionId, oldThreadId, this);
		}
		try {
			const subscribed = await this.chatService.subscribeThread(active.session.sessionId, active.threadId, this.durableSequence, this, { type: 'latest', turnLimit: historyPageTurns });
			subscribedAt = performance.now();
			if (this.isDisposed || generation !== this.generation) return;
			const result = { ...await this.bridgeHistoryGap(subscribed, generation), updates: subscribed.updates };
			if (this.isDisposed || generation !== this.generation) return;
			const snapshot = this.acceptThreadSnapshot(result, request);
			const currentThread = this.thread;
			void this.loadContextUsage(generation);
			if (currentThread && !this.selectedModes.has(active.threadId)) {
				this.selectedModes.set(active.threadId, currentThread.turns.at(-1)?.mode ?? 'agent');
			}
			for (const update of result.updates) {
				if (update.durableSequence > (currentThread?.sequence ?? this.durableSequence)) {
					this.acceptUpdate(update);
				}
			}
			if (snapshot.thread) { this._historyStatus.set(undefined); this.setState('ready'); }
			else if (snapshot.transcript) this._onDidChange.fire();
			reconciliationMs = Math.round(performance.now() - subscribedAt);
			if (snapshot.thread || snapshot.transcript) outcome = 'bound';
			void this.loadTurnChanges(generation);
			void this.loadQueue();
			if (currentThread?.status === 'active') void this.historyRedo.refresh(currentThread.sessionId, currentThread.threadId);
		} catch (error) {
			if (this.isDisposed || generation !== this.generation || request !== this.readRequest) return;
			outcome = isCancellationError(error) ? 'cancelled' : 'failed';
			this.setHistoryError(error, 'history');
		} finally {
			this.historyBindingFinished.fire({
				outcome, durationMs: Math.round(performance.now() - started),
				subscriptionMs: subscribedAt === undefined ? undefined : Math.round(subscribedAt - started),
				reconciliationMs,
			});
		}
	}

	private acceptUpdate(update: ThreadUpdateEnvelope): void {
		const selectedThreadId = this._thread?.threadId ?? this.threadId;
		if (!selectedThreadId) return;
		if (update.threadId !== selectedThreadId || update.sessionId !== this.sessionId) return;
		if (update.update.type !== 'committed') return;
		this.durableSequence = Math.max(this.durableSequence, update.durableSequence);
		if (update.update.event.type === 'voiceTranscriptRecorded' && this._thread && update.durableSequence === this._thread.sequence + 1) {
			// Speech changes the journal boundary, never execution state or model inputs.
			this._thread = { ...this._thread, sequence: update.durableSequence };
			return;
		}
		if (update.update.event.type === 'threadHistoryMoved') {
			void this.historyRedo.refresh(update.sessionId, update.threadId);
			// Retire the old checkpoint synchronously, before the replacement snapshot arrives.
			this.summaryRequest++;
			this.threadChanges = undefined;
			this.threadChangesError = undefined;
			this.changesGeneration++;
			this._changeSets = [];
			void this.loadTurnChanges(this.generation);
			this._onDidChange.fire();
		}
		if (update.update.event.type === 'turnAccepted') this.historyRedo.reset();
		this.acceptCommittedEvent(update);
		this.scheduleRefresh();
	}

	private async reconnect(): Promise<void> {
		const active = this.activeSession;
		await Promise.all([
			active ? this.subscribe(active) : Promise.resolve(),
			this.loadCatalogs(),
		]);
	}

	private async loadContextUsage(threadGeneration: number): Promise<void> {
		const active = this.activeSession;
		if (!active) return;
		const request = ++this.contextUsageRequest;
		try {
			const usage = await this.chatService.readContextUsage(active.session.sessionId, active.threadId);
			if (this.isDisposed || threadGeneration !== this.generation || request !== this.contextUsageRequest) return;
			this.contextUsage = usage;
			this._onDidChange.fire();
		} catch {
			if (this.isDisposed || threadGeneration !== this.generation || request !== this.contextUsageRequest) return;
			// An unavailable estimate must not leave a previous thread's capacity visible.
			this.contextUsage = undefined;
			this._onDidChange.fire();
		}
	}

	private async loadQueue(): Promise<void> {
		const active = this.activeSession;
		if (!active) return;
		const generation = ++this.queueGeneration;
		try {
			const queue = await this.chatService.readQueue(active.session.sessionId, active.threadId);
			if (this.isDisposed || generation !== this.queueGeneration || active.threadId !== this.threadId) return;
			this.queue = queue;
			this._onDidChange.fire();
		} catch (error) {
			if (!this.isDisposed && generation === this.queueGeneration) this.setError(error);
		}
	}

	refreshChanges(): Promise<void> {
		const owner = this.activeSession;
		if (!owner || this.isDisposed) return Promise.resolve();
		const generation = this.generation;
		if (this.summaryRead?.generation === generation) {
			if (this.durableSequence > this.summaryRead.sequence) this.summaryRead.invalidated = true;
			return this.summaryRead.promise;
		}
		const read = { generation, sequence: this.durableSequence, promise: Promise.resolve(), invalidated: false };
		this.summaryRead = read;
		read.promise = (async () => {
			do {
				read.invalidated = false;
				read.sequence = this.durableSequence;
				await this.readChangesSummary(owner, generation);
				// Durable history may advance while its summary is being read. Request
				// one fresh summary instead of concurrent reads whose results will be discarded.
			} while (!this.isDisposed && generation === this.generation && (read.invalidated || this.durableSequence > read.sequence));
		})().finally(() => { if (this.summaryRead === read) this.summaryRead = undefined; });
		return read.promise;
	}

	private async readChangesSummary(owner: IActiveSessionThread, generation: number): Promise<void> {
		const request = ++this.summaryRequest;
		try {
			const summary = await this.chatService.readThreadChanges(owner.session.sessionId, owner.threadId);
			if (this.isDisposed || generation !== this.generation || request !== this.summaryRequest || summary.sequence < this.durableSequence) return;
			this.threadChanges = summary;
			this.threadChangesError = undefined;
		} catch {
			if (this.isDisposed || generation !== this.generation || request !== this.summaryRequest) return;
			this.threadChanges = undefined;
			this.threadChangesError = localize('chat.changes.loadFailed', 'Changes are unavailable. Open Changes to retry.');
		}
		this._onDidChange.fire();
	}

	private async loadTurnChanges(threadGeneration: number): Promise<void> {
		const owner = this.activeSession;
		if (!owner) return;
		const changesGeneration = ++this.changesGeneration;
		try {
			const changeSets = await this.chatService.listTurnChanges(owner.session.sessionId, owner.threadId);
			if (this.isDisposed || threadGeneration !== this.generation || changesGeneration !== this.changesGeneration) return;
			this._changeSets = changeSets;
			if (this.isCodeConversation) this.refreshRequestVersions.schedule();
			this._onDidChange.fire();
			for (const changeSet of changeSets) void this.loadChangeDetails(changeSet.changeSetId, changesGeneration);
		} catch {
			// Changes are auxiliary to the transcript; the next notification or reconnect retries them.
		}
	}

	private acceptChangeSets(updates: readonly TurnChangeSetSummary[]): void {
		const byId = new Map(this._changeSets.map((changeSet) => [changeSet.changeSetId, changeSet]));
		for (const update of updates) byId.set(update.changeSetId, update);
		this._changeSets = [...byId.values()];
		this._onDidChange.fire();
		const generation = this.changesGeneration;
		for (const update of updates) void this.loadChangeDetails(update.changeSetId, generation);
	}

	private async loadChangeDetails(changeSetId: string, generation: number): Promise<void> {
		const owner = this.activeSession;
		if (!owner) return;
		try {
			const details = await this.chatService.readTurnChange(owner.session.sessionId, owner.threadId, changeSetId);
			if (this.isDisposed || generation !== this.changesGeneration || details.summary.threadId !== this.threadId) return;
			this.changeDetails.set(changeSetId, details);
			this._onDidChange.fire();
		} catch {
			// Summary state remains useful while a detail read is retried by the next update.
		}
	}

	private acceptCommittedEvent(update: ThreadUpdateEnvelope): void {
		if (update.update.type !== 'committed') return;
		const event = update.update.event;
		switch (event.type) {
			case 'turnModeChanged':
				// Follow an Agent's switch unless the user has chosen a different next-turn mode.
				if (this._thread && update.durableSequence > this._thread.sequence
					&& this._thread.turns.at(-1)?.turnId === event.turnId && this.mode === event.fromMode) {
					this.selectedModes.set(update.threadId, event.mode);
					this._onDidChange.fire();
				}
				break;
			default:
				break;
		}
	}

	private acceptTranscriptUpdate(update: ThreadTranscriptUpdateEnvelope): void {
		const selectedThreadId = this._thread?.threadId ?? this.threadId;
		if (!selectedThreadId || update.threadId !== selectedThreadId || update.sessionId !== this.sessionId) return;
		if (update.revision <= this.transcriptRevision) return;
		const isNext = update.revision === this.transcriptRevision + 1;
		const resetsTransientState = update.changes.some((change) => change.type === 'clearTransient');
		if (!isNext && !resetsTransientState) {
			this.scheduleRefresh();
			return;
		}
		let streamingResponse: ChatStreamingResponseUpdate | undefined;
		for (const change of update.changes) {
			switch (change.type) {
				case 'upsert': {
					const index = findLastIdx(this.transcriptEntries, entry => entry.entryId === change.entry.entryId);
					const entry = cloneTranscriptEntry(change.entry);
					if (index < 0) this.transcriptEntries.push(entry);
					else {
						if (update.changes.length === 1) {
							const turn = this._thread?.turns.at(-1);
							const workspace = turn && turn.turnId === entry.turnId ? agentHostTurnDirectory(update.sessionId, turn.directory) : undefined;
							streamingResponse = chatStreamingResponseUpdate(this.transcriptEntries[index], entry, workspace);
						}
						this.transcriptEntries[index] = entry;
					}
					break;
				}
				case 'remove': {
					const removed = new Set(change.entryIds);
					this.transcriptEntries = this.transcriptEntries.filter((entry) => !removed.has(entry.entryId));
					break;
				}
				case 'clearTransient':
					this.transcriptEntries = this.transcriptEntries.filter((entry) => !isTransientTranscriptEntry(entry));
					break;
			}
		}
		this.transcriptRevision = update.revision;
		this._onDidChange.fire(streamingResponse);
	}

	private scheduleRefresh(): void {
		const generation = this.generation;
		if (this.readPending === generation) return;
		this.readPending = generation;
		queueMicrotask(() => {
			if (this.readPending === generation) this.readPending = undefined;
			if (this.isDisposed || generation !== this.generation) return;
			void this.refreshThread();
		});
	}

	private refreshThread({ replaceHistory = false } = {}): Promise<void> {
		if (this.isDisposed || !this.activeSession) return Promise.resolve();
		const generation = this.generation;
		if (this.threadRead?.generation === generation) {
			this.threadRead.invalidated = true;
			this.threadRead.replaceHistory ||= replaceHistory;
			// The pending result may still advance state, but its failure no longer
			// describes the refresh requested after this notification or mutation.
			this.readRequest++;
			return this.threadRead.promise;
		}
		const read = { generation, promise: Promise.resolve(), invalidated: false, replaceHistory };
		this.threadRead = read;
		read.promise = (async () => {
			try {
				do {
					read.invalidated = false;
					const replaceHistory = read.replaceHistory;
					read.replaceHistory = false;
					await this.readThreadSnapshot(replaceHistory);
					// Retire the original read before issuing one replacement for the
					// accumulated updates. Writes keep their own execution and result.
				} while (!this.isDisposed && generation === this.generation && read.invalidated);
			} finally {
				if (this.threadRead === read) this.threadRead = undefined;
			}
		})();
		return read.promise;
	}

	private async readThreadSnapshot(replaceHistory: boolean): Promise<void> {
		const active = this.activeSession;
		if (!active) return;
		const threadId = active.threadId;
		const generation = this.generation;
		const request = ++this.readRequest;
		try {
			let result = await this.chatService.readThread(active.session.sessionId, threadId, { type: 'latest', turnLimit: historyPageTurns });
			if (this.isDisposed || generation !== this.generation) return;
			if (!replaceHistory) result = await this.bridgeHistoryGap(result, generation);
			if (
				this.isDisposed ||
				generation !== this.generation ||
				(request !== this.readRequest && result.thread.sequence <= (this._thread?.sequence ?? 0) && result.transcript.revision <= this.transcriptRevision) ||
				result.thread.threadId !== this.threadId
			) return;
			const snapshot = this.acceptThreadSnapshot(result, request, { refresh: true, replaceHistory });
			if (!snapshot.thread) { if (snapshot.transcript) this._onDidChange.fire(); return; }
			void this.loadContextUsage(generation);
			this._error = undefined;
			this._historyStatus.set(undefined);
			this._state = 'ready';
			this._onDidChange.fire();
		} catch (error) {
			if (!this.isDisposed && generation === this.generation && request === this.readRequest) {
				this.setHistoryError(error, 'live');
			}
		}
	}

	private setHistoryError(error: unknown, kind: IChatSessionHistoryStatus['kind']): void {
		const active = this.activeSession;
		if (!active || isCancellationError(error)) return;
		const generation = this.generation;
		let recovery: Promise<void> | undefined;
		const status: IChatSessionHistoryStatus = {
			kind,
			message: kind === 'history'
				? localize('chat.history.loadFailed', 'Could not load chat history: {0}', String(error))
				: localize('chat.history.updateFailed', 'Could not refresh this chat: {0}', String(error)),
			action: {
				label: localize('chat.history.retry', 'Retry loading chat'),
				run: () => {
					if (recovery) return recovery;
					// A retained action must never recover a different selection or a newer connection.
					if (this.isDisposed || generation !== this.generation || this.historyStatus !== status) return Promise.resolve();
					this.setState('loading');
					recovery = kind === 'history' ? this.subscribe(active) : this.refreshThread();
					return recovery;
				},
			},
		};
		this._historyStatus.set(status);
		this.setState('error');
	}

	/** Hydration and refresh obey the same sequence floor; streaming revisions advance independently. */
	private acceptThreadSnapshot(result: ThreadRead, request: number, { refresh = false, replaceHistory = false } = {}): { readonly thread: boolean; readonly transcript: boolean; } {
		const sequence = this._thread?.sequence ?? 0;
		const thread = result.thread.sequence >= this.durableSequence && (result.thread.sequence > sequence || result.thread.sequence === sequence && request >= this.snapshotRequest);
		const incoming = new Set(result.thread.turns.map(turn => turn.turnId));
		// A rejected anchor means the loaded prefix may have been retired by a history move.
		const overlap = replaceHistory ? -1 : this._thread?.turns.findIndex(turn => incoming.has(turn.turnId)) ?? -1;
		const prefix = result.history && overlap > 0 ? this._thread!.turns.slice(0, overlap) : [];
		if (thread) {
			this._thread = { ...result.thread, turns: [...prefix, ...result.thread.turns] };
			void this.refreshModelAvailability();
			if (!prefix.length) this.historyBoundary = result.history;
			this.durableSequence = Math.max(this.durableSequence, result.thread.sequence);
			this.snapshotRequest = Math.max(this.snapshotRequest, request);
			void this.refreshChanges();
		}
		// A bounded stale snapshot cannot describe Turns already added past its tail.
		// Recover with a fresh window rather than erasing their transcript entries.
		const transcript = result.transcript.revision >= this.transcriptRevision && (thread || !result.history);
		if (!thread && result.history && (result.thread.sequence < this.durableSequence || result.transcript.revision > this.transcriptRevision)) {
			if (!refresh) this.scheduleRefresh();
			else if (!this.threadRead?.invalidated) {
				// A response alone must not keep the refresh loop alive when the
				// backend repeatedly returns a checkpoint behind our known history.
				this.setHistoryError(new Error(localize('chat.history.changed', 'Chat history changed. Try loading again.')), 'live');
			}
		}
		if (transcript) {
			const retained = new Set(prefix.map(turn => turn.turnId));
			const retainedItems = new Set(prefix.flatMap(turn => turn.items.map(item => item.itemId)));
			const entries = this.transcriptEntries.filter(entry => entry.type === 'voiceTranscript'
				? prefix.length > 0 && (!entry.transcript.afterItemId || retainedItems.has(entry.transcript.afterItemId))
				: retained.has(entry.turnId));
			this.transcriptEntries = mergeTranscriptEntries(entries, result.transcript.entries.map(cloneTranscriptEntry));
			this.transcriptRevision = result.transcript.revision;
		}
		return { thread, transcript };
	}

	/** Reconnection can skip more than one window. Fill that gap in bounded reads before
	 * joining an already loaded prefix, so no middle Turns silently disappear. */
	private async bridgeHistoryGap(snapshot: ThreadRead, generation: number): Promise<ThreadRead> {
		if (snapshot.thread.sequence < this.durableSequence) return snapshot;
		const existing = new Set(this._thread?.turns.map(turn => turn.turnId));
		const pages: ThreadRead[] = [snapshot];
		let oldest = snapshot;
		while (existing.size && oldest.history?.hasOlderTurns && oldest.history.oldestTurnId
			&& !oldest.thread.turns.some(turn => existing.has(turn.turnId))) {
			const cursor = oldest.history.oldestTurnId;
			const page = await this.chatService.readThread(snapshot.thread.sessionId, snapshot.thread.threadId, { type: 'before', turnId: cursor, turnLimit: historyPageTurns });
			if (this.isDisposed || generation !== this.generation) return snapshot;
			if (page.thread.sequence < snapshot.thread.sequence || page.history?.oldestTurnId === cursor) {
				throw new Error(localize('chat.history.changed', 'Chat history changed. Try loading again.'));
			}
			pages.push(page);
			oldest = page;
		}
		if (pages.length === 1) return snapshot;
		pages.reverse();
		return {
			...snapshot,
			thread: { ...snapshot.thread, turns: pages.flatMap(page => page.thread.turns) },
			transcript: { ...snapshot.transcript, entries: mergeTranscriptEntries([], pages.flatMap(page => page.transcript.entries)) },
			history: oldest.history,
		};
	}

	private setState(state: ChatWidgetState, error?: string): void {
		this._state = state;
		this._error = error;
		this._onDidChange.fire();
	}

	private setError(error: unknown): void {
		if (this.historyStatus) {
			this.setState('error');
			return;
		}
		this.setState(
			'error',
			error instanceof Error ? error.message : 'Chat is unavailable.',
		);
	}

	private get activeSession(): IActiveSessionThread | undefined {
		return this.selection.kind === 'session' ? this.selection.active : undefined;
	}

	private requireChangeOwner(): { readonly sessionId: SessionId; readonly threadId: ThreadId; } {
		const active = this.activeSession;
		if (!active) throw new Error('Turn changes require a durable Session and Thread');
		return { sessionId: active.session.sessionId, threadId: active.threadId };
	}


	private captureOperation(options?: ChatSubmissionOptions): { readonly generation: number; identity: string; readonly signal?: AbortSignal; } {
		if (options?.source && (options.source.sessionId !== this.sessionId || options.source.threadId !== this.threadId)) throw canceled();
		return { generation: this.composerGeneration, identity: this.composerIdentity, signal: options?.signal };
	}


	private async awaitOperationPreparation<T>(pending: Promise<T>, operation: ReturnType<ChatWidgetModel['captureOperation']>): Promise<T> {
		const result = operation.signal ? await raceCancellationError(pending, operation.signal) : await pending;
		this.requireCurrentOperation(operation);
		return result;
	}

	private isCurrentTarget(operation: ReturnType<ChatWidgetModel['captureOperation']>): boolean {
		return !this.isDisposed && operation.generation === this.composerGeneration && operation.identity === this.composerIdentity;
	}

	private isCurrentOperation(operation: ReturnType<ChatWidgetModel['captureOperation']>): boolean {
		return !operation.signal?.aborted && this.isCurrentTarget(operation);
	}

	private recoverCancelledSubmission(operation: ReturnType<ChatWidgetModel['captureOperation']>, stateRequest: number): void {
		if (operation.signal?.aborted && stateRequest === this.stateRequest && this.isCurrentTarget(operation) && this._state === 'submitting') this.setState('ready');
	}

	private requireCurrentOperation(operation: ReturnType<ChatWidgetModel['captureOperation']>): void {
		this.assertAIEnabled();
		if (!this.isCurrentOperation(operation)) throw canceled();
	}

	private async ensureActiveSession(signal?: AbortSignal, forVoice = false): Promise<IActiveSessionThread> {
		this.assertWorkspaceSelected();
		if (this.selection.kind === 'session') return this.selection.active;
		const untitledSession = this.selection.session;
		const generation = this.composerGeneration;
		return commitChatSession({
			resolve: () => this.sessionService.materializeUntitledSession(untitledSession.untitledSessionId, signal),
			isCurrent: () => !this.isDisposed && this.composerGeneration === generation,
			adopt: created => {
				// Voice needs a durable Thread before listening, even though the composer is still empty.
				if (forVoice) this.voiceDraft = { id: untitledSession.untitledSessionId, generation };
				// Catalog notifications may create a durable pane before the create response.
				const composer = untitledSession.kind === 'chat' || this.sessionService.activeUntitledSession?.untitledSessionId === untitledSession.untitledSessionId
					? { untitledSessionId: untitledSession.untitledSessionId, generation, threadId: created.threadId }
					: undefined;
				this.materializingComposer = composer;
				this.adoptUntitledSession(untitledSession, created);
				return toDisposable(() => {
					if (this.materializingComposer === composer) this.materializingComposer = undefined;
				});
			},
			promote: created => this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created),
			subscribe: created => this.subscribe(created),
		});
	}

	private assertWorkspaceSelected(): void {
		if (this.requiresWorkspaceSelection) {
			throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.code.workspaceRequired' }, 'Choose a project before sending.'));
		}
	}

	/** Keep this composer's choices when organization gives its draft a durable identity. */
	private adoptUntitledSession(untitledSession: IUntitledChatSession, created: IActiveSessionThread): void {
		const currentDraft = this.sessionService.untitledSessions.find(draft => draft.untitledSessionId === untitledSession.untitledSessionId) ?? untitledSession;
		this.selection = { kind: 'session', active: created };
		// The durable Session may authorize directory Skills absent from the untitled catalog.
		this._skillSelectors = [];
		void this.loadSkillSelectors();
		const mode = this.selectedModes.get(untitledSession.untitledSessionId);
		if (mode) this.selectedModes.set(created.threadId, mode);
		this.selectedModes.delete(untitledSession.untitledSessionId);
		const approvalModes = new Map(this.selectedApprovalModes.get());
		const approvalMode = approvalModes.get(untitledSession.untitledSessionId);
		if (approvalMode) approvalModes.set(created.threadId, approvalMode);
		approvalModes.delete(untitledSession.untitledSessionId);
		this.selectedApprovalModes.set(approvalModes);
		this.selectedReasoningEfforts.set(created.threadId, { effort: draftReasoningEffort(currentDraft) });
		this.threadModelSelection.select(created.threadId, currentDraft.model);
	}

}

function draftReasoningEffort(draft: IUntitledChatSession): ModelReasoningEffort | undefined {
	return draft.reasoningEffortSelection === undefined ? draft.modelDefaults?.effort : draft.reasoningEffortSelection ?? undefined;
}

function activeTurn(thread: Thread | undefined): Turn | undefined {
	return [...(thread?.turns ?? [])].reverse().find(
		(turn) =>
			turn.status === 'created' ||
			turn.status === 'running' ||
			turn.status === 'waitingForApproval' ||
			turn.status === 'waitingForUserInput' ||
			turn.status === 'waitingForCapability' ||
			turn.status === 'cancelling',
	);
}

function isSteerableTurn(turn: Turn): boolean {
	return (turn.kind === undefined || turn.kind === 'coding' || turn.kind === 'review') && (turn.status === 'running' || turn.status === 'waitingForApproval' || turn.status === 'waitingForUserInput');
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
	return left?.provider === right?.provider && left?.model === right?.model;
}

function cloneTranscriptEntry(entry: ThreadTranscriptEntry): ThreadTranscriptEntry {
	switch (entry.type) {
		case 'voiceTranscript': return { ...entry, transcript: { ...entry.transcript } };
		case 'skillLoad': return { ...entry, skill: { ...entry.skill } };
		case 'hookRun': return { ...entry, run: { ...entry.run, status: { ...entry.run.status } } };
		case 'item': return { ...entry, item: { ...entry.item } };
		case 'turnPlan': return { ...entry, plan: { explanation: entry.plan.explanation, steps: entry.plan.steps.map((step) => ({ ...step })) } };
		case 'turnError': return { ...entry, error: { ...entry.error } };
		case 'toolOutput': return { ...entry };
	}
}

/** Stable IDs deduplicate speech and overlaps. Callers clone incoming entries only,
 * retaining the owned prefix without copying every previously loaded page. */
function mergeTranscriptEntries(older: readonly ThreadTranscriptEntry[], newer: readonly ThreadTranscriptEntry[]): ThreadTranscriptEntry[] {
	const entries = new Map(older.map(entry => [entry.entryId, entry]));
	for (const entry of newer) entries.set(entry.entryId, entry);
	return [...entries.values()];
}

function isTransientTranscriptEntry(entry: ThreadTranscriptEntry): boolean {
	return entry.type === 'toolOutput' || entry.type === 'item' && entry.transient;
}
