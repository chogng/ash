import { raceCancellationError } from '../../base/common/async.js';
import type { ChatContextUsage } from '../../workbench/services/chat/common/chatService.js';
import { IAgentExecutionSettingsService } from '../../platform/agentHost/common/agentExecutionSettingsService.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { IPromptsService } from '../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { toSkillSelectors } from '../../workbench/contrib/chat/common/skillSelectors.js';
import { ILanguageModelsService } from '../../workbench/contrib/chat/common/languageModels.js';
import { Emitter, type Event } from "../../base/common/event.js";
import { canceled, isCancellationError } from "../../base/common/errors.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import type { AgentResponse, ChatAgent, ChatMode, ChatSubmissionOptions, IChatService, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, Thread, ThreadGoal, ThreadTranscriptEntry, ThreadTranscriptUpdateEnvelope, ThreadUpdateEnvelope, Turn, TurnChangeDetails, ThreadChangesSummary, TurnChangeSetSummary, TurnInteraction } from "../../workbench/services/chat/common/chatService.js";
import { localize } from "../../nls.js";
import type { SkillReference } from "../../platform/agentHost/common/appServerApi.js";
import type { ResolvedChatContext } from "../../workbench/services/chat/common/chatContextService.js";
import type { IActiveSessionThread, ISession, IUntitledChatSession, ModelRef, SessionId, ThreadId } from "../services/sessions/common/session.js";
import type { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { chatTranscriptListItems, type IChatListItem } from "../../workbench/contrib/chat/browser/widget/chatListItems.js";
import type { ChatInputState } from '../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { modelRefIdentity, type ModelReasoningEffort } from '../../workbench/services/chat/common/modelCatalog.js';
import type { ApprovalMode } from '../../workbench/services/chat/common/chatService.js';
import type { AgentModelDefaults } from '../../platform/agentHost/common/agentModels.js';
import { observableValue } from '../../base/common/observable.js';
import type { IChatSessionHistoryStatus } from '../../platform/chat/common/chatSessionHistory.js';
import { ChatAIDisabledSettingId } from '../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { ThreadHistoryBoundary, ThreadRead } from '../../workbench/services/chat/common/chatService.js';

const historyPageTurns = 20;

export type ChatWidgetState =
	| "loading"
	| "ready"
	| "submitting"
	| "error";

/** The local or durable identity currently displayed by a Chat pane. */
export type ChatWidgetSelection =
	| { readonly kind: "session"; readonly active: IActiveSessionThread; }
	| { readonly kind: "untitled"; readonly session: IUntitledChatSession; };

/**
 * State for one Chat tab, before or after it acquires a durable Thread.
 *
 * Canonical committed state is refreshed from `session/thread/read`. Transcript
 * entries arrive already assembled by App Server and are applied by stable ID.
 */
export class ChatWidgetModel extends Disposable {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly _onDidChangeComposer = this._register(new Emitter<void>());
	private _composerGeneration = 0;
	private materializingComposer: { readonly untitledSessionId: string; readonly generation: number; readonly threadId: ThreadId; } | undefined;
	private transcriptEntries: ThreadTranscriptEntry[] = [];
	private transcriptRevision = 0;
	private historyBoundary: ThreadHistoryBoundary | undefined;
	private olderHistoryRequest: Promise<void> | undefined;
	private olderHistoryError: string | undefined;
	private selection: ChatWidgetSelection;
	private _thread: Thread | undefined;
	private contextUsage: ChatContextUsage | undefined;
	private contextUsageRequest = 0;
	private _state: ChatWidgetState = "loading";
	// A late local completion cannot release a newer operation's busy state.
	private stateRequest = 0;
	private _error: string | undefined;
	private readonly _historyStatus = observableValue<IChatSessionHistoryStatus | undefined>(this, undefined);
	private generation = 0;
	private readPending = false;
	private readRequest = 0;
	private durableSequence = 0;
	private snapshotRequest = 0;
	private initializePromise: Promise<void> | undefined;
	private subscriptionThreadId: ThreadId | undefined;
	private subscriptionPromise: Promise<void> | undefined;
	private _models: readonly ModelCatalogEntry[] = [];
	private modelsError: string | undefined;
	private modelsGeneration = 0;
	private defaults: AgentModelDefaults | undefined;
	private pendingModelSelection: Promise<void> | undefined;
	private readonly selectedModes = new Map<string, ChatMode>();
	private queuedMessages = 0;
	private queueGeneration = 0;
	private readonly selectedModels = new Map<ThreadId, ModelRef>();
	private readonly defaultApprovalMode = observableValue<ApprovalMode>(this, 'manual');
	private approvalGeneration = 0;
	private readonly selectedApprovalModes = observableValue<ReadonlyMap<string, ApprovalMode>>(this, new Map());
	private readonly automaticModels = new Set<ThreadId>();
	// A New Chat's key is replaced with its Thread ID when the first message materializes it.
	private readonly selectedReasoningEfforts = new Map<string, { model: string; effort: ModelReasoningEffort | undefined; }>();
	private _slashCommands: readonly SlashCommandDefinition[] = [];
	private _skillSelectors: readonly SkillSelectorDefinition[] = [];
	private skillCatalogGeneration = 0;
	private _changeSets: readonly TurnChangeSetSummary[] = [];
	private readonly changeDetails = new Map<string, TurnChangeDetails>();
	private changesGeneration = 0;
	private threadChanges: ThreadChangesSummary | undefined;
	private threadChangesError: string | undefined;
	private summaryRequest = 0;
	private summaryRead: { readonly generation: number; sequence: number; promise: Promise<void>; invalidated: boolean; } | undefined;

	readonly onDidChange: Event<void> = this._onDidChange.event;
	/** Navigation retires input synchronously, including A-B-A. First materialization keeps its composer. */
	readonly onDidChangeComposer: Event<void> = this._onDidChangeComposer.event;

	get composerGeneration(): number { return this._composerGeneration; }

	/** Only the selected initiating draft can replace an incidental early catalog pane. */
	get materializingUntitledSessionId(): string | undefined {
		const composer = this.materializingComposer;
		return composer?.generation === this.composerGeneration && composer.threadId === this.threadId ? composer.untitledSessionId : undefined;
	}

	constructor(chatService: IChatService, selection: ChatWidgetSelection, sessionService: ISessionsManagementService, @IPromptsService private readonly skills: IPromptsService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService, @IAgentExecutionSettingsService private readonly execution: IAgentExecutionSettingsService, @IConfigurationService private readonly configuration: IConfigurationService) {
		super();
		this.chatService = chatService;
		this.sessionService = sessionService;
		this.selection = selection;
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
		this._register(chatService.onDidBecomeReady(() => void this.reconnect()));
		this._register(execution.onDidChange(() => void this.loadDefaultApprovalMode()));
		this._register(this.languageModels.onDidChangeModels(() => void this.loadModels()));
		this._register(chatService.onDidChangeQueue(() => void this.loadQueue()));
		this._register(this.skills.onDidChangeSkills(() => void this.loadSkillSelectors()));
		this._register(chatService.onDidUpdateTurnChanges((update) => {
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
		return {
			draftIdentity: { id: this.composerIdentity, generation: this.composerGeneration },
			mode: this.mode,
			activeMode: activeTurn(this._thread)?.mode,
			queuedMessages: this.queuedMessages,
			phase: this._state,
			inputBlocked: this.historyStatus !== undefined || this.configuration.getValue<boolean>(ChatAIDisabledSettingId),
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
			selectedModel: this.selectedModel,
			selectedReasoningEffort: this.selectedReasoningEffort,
			isAutomaticModel: this.isAutomaticModel,
			selectedAgent: this.selection.kind === 'untitled' ? this.selection.session.agent : undefined,
			agentName: this.selection.kind === 'session' ? this.selection.active.session.agentTree?.find(node => node.threadId === this.threadId)?.role?.name : undefined,
			canSelectAgent: this.selection.kind === 'untitled',
			interaction: this.interaction,
		};
	}

	get error(): string | undefined {
		return this.historyStatus?.message ?? this._error;
	}

	get historyStatus(): IChatSessionHistoryStatus | undefined {
		return this._historyStatus.get();
	}

	get olderHistory(): { readonly loading: boolean; readonly error?: string; } | undefined {
		return this.historyBoundary?.hasOlderTurns && this.historyBoundary.oldestTurnId
			? { loading: !!this.olderHistoryRequest, error: this.olderHistoryError }
			: undefined;
	}

	/** Older pages never replace the live cursor, execution state or interaction offer. */
	loadOlderHistory(): Promise<void> {
		if (this.isDisposed) return Promise.resolve();
		if (this.olderHistoryRequest) return this.olderHistoryRequest;
		const active = this.activeSession;
		const boundary = this.historyBoundary;
		if (!active || !boundary?.hasOlderTurns || !boundary.oldestTurnId) return Promise.resolve();
		const generation = this.generation;
		this.olderHistoryError = undefined;
		const pending = Promise.resolve().then(async () => {
			try {
				const page = await this.chatService.readThread(active.session.sessionId, active.threadId, { type: 'before', turnId: boundary.oldestTurnId!, turnLimit: historyPageTurns });
				if (this.isDisposed || generation !== this.generation || this.historyBoundary !== boundary) return;
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
				if (!this.isDisposed && generation === this.generation && this.historyBoundary === boundary) {
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

	get sessionId(): SessionId | undefined {
		return this.activeSession?.session.sessionId;
	}

	get session(): ISession | undefined {
		return this.selection.kind === "session" ? this.selection.active.session : undefined;
	}

	get untitledSessionId(): string | undefined {
		return this.selection.kind === "untitled" ? this.selection.session.untitledSessionId : undefined;
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
		return this.selection.kind === "untitled"
			? this.selection.session.model
			: this.selectedModels.get(this.selection.active.threadId)
			?? (this._thread?.threadId === this.selection.active.threadId ? this._thread.turns.at(-1)?.model : undefined)
			?? this.selection.active.session.model ?? undefined;
	}

	get isAutomaticModel(): boolean {
		return this.selection.kind === 'untitled'
			? this.selection.session.model === undefined
			: this.automaticModels.has(this.selection.active.threadId);
	}

	get selectedReasoningEffort(): ModelReasoningEffort | undefined {
		const model = this.selectedModel;
		const key = this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
		if (this.isAutomaticModel || !model) return undefined;
		const identity = modelRefIdentity(model);
		const selection = this.selectedReasoningEfforts.get(key);
		const lastTurn = this._thread?.turns.at(-1);
		// A local "Default" choice must override the last durable Turn's explicit effort.
		const effort = selection
			? selection.model === identity ? selection.effort : undefined
			: lastTurn?.model && modelRefIdentity(lastTurn.model) === identity ? lastTurn.reasoningEffort ?? undefined
				: this.defaults?.model && modelRefIdentity(this.defaults.model) === identity ? this.defaults.reasoningEffort ?? undefined : undefined;
		const entry = this._models.find(candidate => modelRefIdentity(candidate.model) === identity);
		return effort && entry?.supportedReasoningEfforts?.some(option => option.effort === effort) ? effort : undefined;
	}

	get items(): readonly IChatListItem[] {
		const latestTurnId = this._thread?.turns.at(-1)?.turnId;
		return chatTranscriptListItems(this.transcriptEntries, latestTurnId, this._thread?.turns, this._thread);
	}

	get interaction(): TurnInteraction | undefined {
		const active = this.activeSession;
		if (!active) return undefined;
		const offer = this.chatService.getInteractionOffer(active.session.sessionId, active.threadId);
		return offer?.interaction;
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
		return activeTurn(this._thread) !== undefined;
	}

	async initialize(): Promise<void> {
		if (!this.initializePromise) {
			this.initializePromise = this._initialize();
		}
		return this.initializePromise;
	}

	async selectThread(active: IActiveSessionThread): Promise<void> {
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
		this.selection = { kind: "session", active };
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
		if (this.selection.kind !== "untitled" || this.selection.session.untitledSessionId !== session.untitledSessionId) {
			throw new Error(`ChatWidgetModel cannot select another Untitled Chat Session: ${session.untitledSessionId}`);
		}
		this.selection = { kind: "untitled", session };
		void this.loadModels();
	}

	async selectModel(model: ModelRef): Promise<void> {
		if (!this._models.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
			throw new Error(localize('chat.modelPicker.unavailable', 'The selected model is not available'));
		}
		const identity = this.composerIdentity;
		await this.saveModelSelection(() => this.languageModels.rememberSelectedModel(model), () => {
			if (this.isDisposed || identity !== this.composerIdentity) return;
			if (this.selection.kind === 'untitled') {
				this.sessionService.setUntitledSessionModel(this.selection.session.untitledSessionId, model);
				this.refreshUntitledSelection();
			} else {
				this.selectedModels.set(this.selection.active.threadId, model);
				this.automaticModels.delete(this.selection.active.threadId);
			}
			this._onDidChange.fire();
		});
	}

	async selectAutomaticModel(): Promise<void> {
		const identity = this.composerIdentity;
		await this.saveModelSelection(() => this.languageModels.rememberSelectedModel(undefined), () => {
			if (this.isDisposed || identity !== this.composerIdentity) return;
			if (this.selection.kind === 'untitled') {
				this.sessionService.setUntitledSessionModel(this.selection.session.untitledSessionId, undefined);
				this.refreshUntitledSelection();
			} else {
				this.selectedModels.delete(this.selection.active.threadId);
				this.automaticModels.add(this.selection.active.threadId);
			}
			this.selectedReasoningEfforts.delete(identity);
			this._onDidChange.fire();
		});
	}

	async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const model = this.selectedModel;
		if (!model || this.isAutomaticModel) throw new Error('Select a model before setting its thinking effort');
		const entry = this._models.find(candidate => modelRefIdentity(candidate.model) === modelRefIdentity(model));
		if (!entry || (effort !== undefined && !entry.supportedReasoningEfforts?.some(option => option.effort === effort))) {
			throw new Error('The selected model does not support this thinking effort');
		}
		const identity = this.composerIdentity;
		await this.saveModelSelection(() => this.languageModels.saveReasoningEffort(model, effort), () => {
			if (this.isDisposed || identity !== this.composerIdentity || !sameModel(model, this.selectedModel) || this.isAutomaticModel) return;
			this.selectedReasoningEfforts.set(identity, { model: modelRefIdentity(model), effort });
			this._onDidChange.fire();
		});
	}

	private async saveModelSelection(save: () => Promise<void>, apply: () => void): Promise<void> {
		const pending = save().then(apply);
		this.pendingModelSelection = pending;
		try { await pending; }
		finally { if (this.pendingModelSelection === pending) this.pendingModelSelection = undefined; }
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
		const input = text.trim();
		if (!input && !contexts?.length) return;
		this.assertAIEnabled();
		const operation = this.captureOperation(options);
		const stateRequest = ++this.stateRequest;
		try {
			this.requireCurrentOperation(operation);
			await this.waitForModelSelection(operation);
			this.requireCurrentOperation(operation);
			await this.initialize();
			this.requireCurrentOperation(operation);
			if (this.historyStatus) throw new Error(this.historyStatus.message);
			this.assertAIEnabled();
			this.setState("submitting");
			this.requireCurrentOperation(operation);
			const active = await this.ensureActiveSession();
			if (this.isDisposed || operation.signal?.aborted || operation.generation !== this.composerGeneration || active.session.sessionId !== this.sessionId || active.threadId !== this.threadId) throw canceled();
			// Materializing this composer changes its identity from draft to durable Thread.
			operation.identity = active.threadId;
			if (this._thread?.threadId !== active.threadId) {
				await this.subscribe(active);
			}
			this.requireCurrentOperation(operation);
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error("Chat Thread is not available");
			}
			if (options?.signal?.aborted || options?.source && (active.session.sessionId !== options.source.sessionId || active.threadId !== options.source.threadId)) throw canceled();
			const turn = activeTurn(thread);
			const submission = {
				isNewSession: thread.turns.length === 0,
				sessionId: active.session.sessionId,
				threadId: active.threadId,
				expectedSequence: thread.sequence,
				text: input,
				mode,
				// An unknown/default choice stays with the backend authority; only conversation choices override it.
				approvalMode: this.selectedApprovalModes.get().get(this.composerIdentity) ?? this._thread?.turns.at(-1)?.approvalMode,
				model: this.isAutomaticModel ? undefined : this.selectedModel,
				reasoningEffort: this.selectedReasoningEffort,
				contexts,
				signal: operation.signal,
				commandId: options?.commandId,
				source: options?.source,
				skills,
			};
			if (turn && (turn.kind !== undefined && turn.kind !== 'coding' && turn.kind !== 'review' || turn.mode !== mode || skills?.length)) {
				// A frozen Turn keeps its approach. A new approach gets its own durable submission.
				await this.chatService.queueTurn(submission);
				if (!this.isCurrentOperation(operation)) { this.recoverCancelledSubmission(operation, stateRequest); return; }
				await this.loadQueue();
			} else if (turn) {
				if (!isSteerableTurn(turn)) throw new Error(`The active ${turn.status} Turn cannot accept steering`);
				await this.chatService.steerTurn({ ...submission, turnId: turn.turnId });
			} else {
				await this.chatService.startTurn(submission);
			}
			if (!this.isCurrentOperation(operation)) { this.recoverCancelledSubmission(operation, stateRequest); return; }
			await this.refreshThread();

		} catch (error) {
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
		await this.waitForModelSelection(operation);
		await this.awaitOperationPreparation(this.initialize(), operation);
		this.requireCurrentOperation(operation);
		const active = await this.ensureActiveSession();
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

	async executeServerCommand(name: string, argumentsText: string, submissionSignal?: AbortSignal): Promise<void> {
		this.assertAIEnabled();
		if (name !== "compact" && name !== "advisor") {
			await this.send(`/${name}${argumentsText ? ` ${argumentsText}` : ""}`, this.mode, undefined, undefined, { signal: submissionSignal });
			return;
		}
		const operation = this.captureOperation({ signal: submissionSignal });
		const stateRequest = ++this.stateRequest;
		try {
			this.setState("submitting");
			this.requireCurrentOperation(operation);
			const argument = argumentsText.trim();
			const isModelSelection = /^[^/\s]+\/\S+$/.test(argument);
			const isAdvisorConfigArgument = argument === "off" || argument === "clear" || isModelSelection;
			if (name === "advisor" && isAdvisorConfigArgument) {
				const current = await this.awaitOperationPreparation(this.chatService.readAdvisorDefault(), operation);
				this.requireCurrentOperation(operation);
				if (argument === "clear") {
					await this.chatService.saveAdvisorDefault(null);
					this.requireCurrentOperation(operation);
				} else if (argument === "off") {
					if (current) await this.chatService.saveAdvisorDefault({ ...current, enabled: false });
					this.requireCurrentOperation(operation);
				} else {
					const models = await this.awaitOperationPreparation(this.languageModels.listAdvisorModels(), operation);
					this.requireCurrentOperation(operation);
					const chosen = models.find(entry => `${entry.model.provider}/${entry.model.model}` === argument);
					if (!chosen) throw new Error(localize('chat.advisor.modelUnavailable', 'Advisor model is unavailable: {0}', argument));
					const config = current?.model.provider === chosen.model.provider && current.model.model === chosen.model.model
						? { ...current, enabled: true }
						: { model: chosen.model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
					await this.chatService.saveAdvisorDefault(config);
					this.requireCurrentOperation(operation);
				}
				if (stateRequest === this.stateRequest) this.setState("ready");
				return;
			}
			const advisorDefault = name === "advisor" ? await this.awaitOperationPreparation(this.chatService.readAdvisorDefault(), operation) : null;
			this.requireCurrentOperation(operation);
			if (name === "advisor" && !argument) throw new Error(localize('chat.advisor.questionRequired', 'Enter a question after /advisor'));
			if (name === "advisor" && this.selection.kind === "untitled" && (!advisorDefault || !advisorDefault.enabled)) {
				throw new Error(localize('chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'));
			}
			const active = await this.ensureActiveSession();
			if (this.isDisposed || operation.generation !== this.composerGeneration || active.session.sessionId !== this.sessionId || active.threadId !== this.threadId) throw canceled();
			operation.identity = active.threadId;
			if (this._thread?.threadId !== active.threadId) {
				await this.awaitOperationPreparation(this.subscribe(active), operation);
				this.requireCurrentOperation(operation);
			}
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error("Chat Thread is not available");
			}
			if (name === "advisor") {
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
				throw new Error("Context can be compacted only when the active Turn has finished");
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
		if (turn?.turnId !== turnId || turn.status !== "failed" || turn.error?.retryable !== true || turn.kind !== undefined && turn.kind !== 'coding' && turn.kind !== 'review') {
			throw new Error("Only the latest retryable failed Turn can be retried");
		}
		await this.send("Try again.", turn.mode);
	}

	async interrupt(): Promise<void> {
		const thread = this._thread;
		const turn = activeTurn(thread);
		if (!thread || !turn) return;
		const operation = this.captureOperation();
		const stateRequest = ++this.stateRequest;
		const isCurrent = () => stateRequest === this.stateRequest && this.isCurrentOperation(operation) && activeTurn(this._thread)?.turnId === turn.turnId;
		try {
			this.setState("submitting");
			this.requireCurrentOperation(operation);
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
		}
	}

	async resolveInteraction(response: AgentResponse): Promise<void> {
		const thread = this._thread;
		const offer = thread ? this.chatService.getInteractionOffer(thread.sessionId, thread.threadId) : undefined;
		const interaction = offer?.interaction;
		if (!thread || !offer || !interaction) return;
		if (response.type !== interaction.request.type) {
			throw new Error("Interaction response kind does not match request");
		}
		const operation = this.captureOperation();
		const stateRequest = ++this.stateRequest;
		const isCurrent = () => stateRequest === this.stateRequest && this.isCurrentOperation(operation) && this.chatService.getInteractionOffer(thread.sessionId, thread.threadId) === offer;
		try {
			this.setState("submitting");
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
		this.setState("loading");
		if (this.selection.kind === "untitled") {
			await this.loadCatalogs();
			if (!this.isDisposed && this.selection.kind === "untitled") {
				this.setState("ready");
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
		const [models, slashCommands] = await Promise.allSettled([this.modelEntries(), this.chatService.listSlashCommands(), this.loadSkillSelectors(), this.loadDefaultApprovalMode(), this.loadModelDefaults()]);
		if (this.isDisposed) return;
		if (generation === this.modelsGeneration && models.status === "fulfilled") {
			this._models = models.value;
			this.modelsError = undefined;
			this.applyDefaultNewChatModel();
		} else if (generation === this.modelsGeneration && models.status === "rejected") {
			this.modelsError = String(models.reason);
		}
		if (slashCommands.status === "fulfilled") this._slashCommands = slashCommands.value;
		this._onDidChange.fire();
	}

	private async loadModels(): Promise<void> {
		const generation = ++this.modelsGeneration;
		try {
			const [models] = await Promise.all([this.modelEntries(), this.loadModelDefaults()]);
			if (this.isDisposed || generation !== this.modelsGeneration) return;
			this._models = models;
			this.modelsError = undefined;
			this.applyDefaultNewChatModel();
			this._onDidChange.fire();
		} catch (error) {
			if (this.isDisposed || generation !== this.modelsGeneration) return;
			this.modelsError = String(error);
			this._onDidChange.fire();
		}
	}

	private async loadModelDefaults(): Promise<void> {
		try {
			const defaults = await this.languageModels.readModelDefaults();
			if (!this.isDisposed) this.defaults = defaults;
		} catch { /* Keep the last backend snapshot until the connection recovers. */ }
	}

	private async modelEntries(): Promise<readonly ModelCatalogEntry[]> {
		return this.languageModels.listModels();
	}

	private applyDefaultNewChatModel(): void {
		if (this.selection.kind !== 'untitled' || this.selection.session.modelSelectionKind === 'manual') return;
		const model = this.languageModels.getDefaultNewChatModel(this._models);
		this.sessionService.setUntitledSessionDefaultModel(this.selection.session.untitledSessionId, model);
		this.refreshUntitledSelection();
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
		const generation = ++this.skillCatalogGeneration;
		const sessionId = this.sessionId;
		try {
			const catalog = await this.skills.findAgentSkills(CancellationToken.None, sessionId);
			if (this.isDisposed || generation !== this.skillCatalogGeneration || sessionId !== this.sessionId) return;
			this._skillSelectors = toSkillSelectors(catalog);
			this._onDidChange.fire();
		} catch {
			// Keep the last valid catalog when a transient refresh fails.
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

	private async performSubscribe(active: IActiveSessionThread): Promise<void> {
		const generation = ++this.generation;
		const oldThreadId = this._thread?.threadId;
		const request = ++this.readRequest;
		const sameThread = oldThreadId === active.threadId;
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
		this.queuedMessages = 0;
		this.queueGeneration++;
		this.changeDetails.clear();
		this.changesGeneration++;
		this.setState("loading");
		if (oldThreadId && oldThreadId !== active.threadId) {
			void this.chatService.unsubscribeThread(active.session.sessionId, oldThreadId, this);
		}
		try {
			const subscribed = await this.chatService.subscribeThread(active.session.sessionId, active.threadId, this.durableSequence, this, { type: 'latest', turnLimit: historyPageTurns });
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
			if (snapshot.thread) { this._historyStatus.set(undefined); this.setState("ready"); }
			else if (snapshot.transcript) this._onDidChange.fire();
			void this.loadTurnChanges(generation);
			void this.loadQueue();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation || request !== this.readRequest) return;
			this.setHistoryError(error, 'history');
		}
	}

	private acceptUpdate(update: ThreadUpdateEnvelope): void {
		const selectedThreadId = this._thread?.threadId ?? this.threadId;
		if (!selectedThreadId) return;
		if (update.threadId !== selectedThreadId || update.sessionId !== this.sessionId) return;
		if (update.update.type !== "committed") return;
		this.durableSequence = Math.max(this.durableSequence, update.durableSequence);
		if (update.update.event.type === 'voiceTranscriptRecorded' && this._thread && update.durableSequence === this._thread.sequence + 1) {
			// Speech changes the journal boundary, never execution state or model inputs.
			this._thread = { ...this._thread, sequence: update.durableSequence };
			return;
		}
		if (update.update.event.type === 'threadHistoryMoved') {
			// Retire the old checkpoint synchronously, before the replacement snapshot arrives.
			this.summaryRequest++;
			this.threadChanges = undefined;
			this.threadChangesError = undefined;
			this.changesGeneration++;
			this._changeSets = [];
			void this.loadTurnChanges(this.generation);
			this._onDidChange.fire();
		}
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
			const count = await this.chatService.queuedMessageCount(active.session.sessionId, active.threadId);
			if (this.isDisposed || generation !== this.queueGeneration || active.threadId !== this.threadId) return;
			this.queuedMessages = count;
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
		if (update.update.type !== "committed") return;
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
		const resetsTransientState = update.changes.some((change) => change.type === "clearTransient");
		if (!isNext && !resetsTransientState) {
			this.scheduleRefresh();
			return;
		}
		for (const change of update.changes) {
			switch (change.type) {
				case "upsert": {
					const index = this.transcriptEntries.findIndex((entry) => entry.entryId === change.entry.entryId);
					const entry = cloneTranscriptEntry(change.entry);
					if (index < 0) this.transcriptEntries.push(entry);
					else this.transcriptEntries[index] = entry;
					break;
				}
				case "remove": {
					const removed = new Set(change.entryIds);
					this.transcriptEntries = this.transcriptEntries.filter((entry) => !removed.has(entry.entryId));
					break;
				}
				case "clearTransient":
					this.transcriptEntries = this.transcriptEntries.filter((entry) => !isTransientTranscriptEntry(entry));
					break;
			}
		}
		this.transcriptRevision = update.revision;
		this._onDidChange.fire();
	}

	private scheduleRefresh(): void {
		if (this.readPending) return;
		this.readPending = true;
		queueMicrotask(() => {
			this.readPending = false;
			void this.refreshThread();
		});
	}

	private async refreshThread(): Promise<void> {
		const active = this.activeSession;
		if (!active) return;
		const threadId = active.threadId;
		const generation = this.generation;
		const request = ++this.readRequest;
		try {
			let result = await this.chatService.readThread(active.session.sessionId, threadId, { type: 'latest', turnLimit: historyPageTurns });
			if (this.isDisposed || generation !== this.generation) return;
			result = await this.bridgeHistoryGap(result, generation);
			if (
				this.isDisposed ||
				generation !== this.generation ||
				(request !== this.readRequest && result.thread.sequence <= (this._thread?.sequence ?? 0) && result.transcript.revision <= this.transcriptRevision) ||
				result.thread.threadId !== this.threadId
			) return;
			const snapshot = this.acceptThreadSnapshot(result, request);
			if (!snapshot.thread) { if (snapshot.transcript) this._onDidChange.fire(); return; }
			void this.loadContextUsage(generation);
			this._error = undefined;
			this._historyStatus.set(undefined);
			this._state = "ready";
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
	private acceptThreadSnapshot(result: Awaited<ReturnType<IChatService['readThread']>>, request: number): { readonly thread: boolean; readonly transcript: boolean; } {
		const sequence = this._thread?.sequence ?? 0;
		const thread = result.thread.sequence >= this.durableSequence && (result.thread.sequence > sequence || result.thread.sequence === sequence && request >= this.snapshotRequest);
		const incoming = new Set(result.thread.turns.map(turn => turn.turnId));
		const overlap = this._thread?.turns.findIndex(turn => incoming.has(turn.turnId)) ?? -1;
		const prefix = result.history && overlap > 0 ? this._thread!.turns.slice(0, overlap) : [];
		if (thread) {
			this._thread = { ...result.thread, turns: [...prefix, ...result.thread.turns] };
			if (!prefix.length) this.historyBoundary = result.history;
			this.durableSequence = Math.max(this.durableSequence, result.thread.sequence);
			this.snapshotRequest = Math.max(this.snapshotRequest, request);
			void this.refreshChanges();
		}
		// A bounded stale snapshot cannot describe Turns already added past its tail.
		// Recover with a fresh window rather than erasing their transcript entries.
		const transcript = result.transcript.revision >= this.transcriptRevision && (thread || !result.history);
		if (!thread && result.history && (result.thread.sequence < this.durableSequence || result.transcript.revision > this.transcriptRevision)) this.scheduleRefresh();
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
			"error",
			error instanceof Error ? error.message : "Chat is unavailable.",
		);
	}

	private get activeSession(): IActiveSessionThread | undefined {
		return this.selection.kind === "session" ? this.selection.active : undefined;
	}

	private requireChangeOwner(): { readonly sessionId: SessionId; readonly threadId: ThreadId; } {
		const active = this.activeSession;
		if (!active) throw new Error("Turn changes require a durable Session and Thread");
		return { sessionId: active.session.sessionId, threadId: active.threadId };
	}


	private captureOperation(options?: ChatSubmissionOptions): { readonly generation: number; identity: string; readonly signal?: AbortSignal; } {
		if (options?.source && (options.source.sessionId !== this.sessionId || options.source.threadId !== this.threadId)) throw canceled();
		return { generation: this.composerGeneration, identity: this.composerIdentity, signal: options?.signal };
	}


	private async waitForModelSelection(operation: ReturnType<ChatWidgetModel['captureOperation']>): Promise<void> {
		// A draft must retain the chosen model when preparation gives it a durable owner.
		while (this.pendingModelSelection) {
			await this.awaitOperationPreparation(this.pendingModelSelection, operation);
			this.requireCurrentOperation(operation);
		}
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

	private async ensureActiveSession(): Promise<IActiveSessionThread> {
		if (this.selection.kind === "session") return this.selection.active;
		const untitledSession = this.selection.session;
		const created = await this.sessionService.materializeUntitledSession(untitledSession.untitledSessionId);
		if (this.isDisposed || this.selection.kind !== 'untitled' || this.selection.session.untitledSessionId !== untitledSession.untitledSessionId) {
			// Keep the completed durable session, but never replace a newer conversation selection.
			this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created);
			throw canceled();
		}
		// A catalog notification can create a durable pane before the create response arrives.
		// Capture the authoritative draft selection before promotion removes its untitled key.
		this.materializingComposer = this.sessionService.activeUntitledSession?.untitledSessionId === untitledSession.untitledSessionId
			? { untitledSessionId: untitledSession.untitledSessionId, generation: this.composerGeneration, threadId: created.threadId }
			: undefined;
		this.selection = { kind: "session", active: created };
		// The durable Session may authorize directory Skills absent from the untitled catalog.
		this._skillSelectors = [];
		void this.loadSkillSelectors();
		const mode = this.selectedModes.get(untitledSession.untitledSessionId);
		if (mode) this.selectedModes.set(created.threadId, mode);
		this.selectedModes.delete(untitledSession.untitledSessionId);
		const effort = this.selectedReasoningEfforts.get(untitledSession.untitledSessionId);
		const approvalModes = new Map(this.selectedApprovalModes.get());
		const approvalMode = approvalModes.get(untitledSession.untitledSessionId);
		if (approvalMode) approvalModes.set(created.threadId, approvalMode);
		approvalModes.delete(untitledSession.untitledSessionId);
		this.selectedApprovalModes.set(approvalModes);
		if (effort) this.selectedReasoningEfforts.set(created.threadId, effort);
		this.selectedReasoningEfforts.delete(untitledSession.untitledSessionId);
		if (untitledSession.model) this.selectedModels.set(created.threadId, untitledSession.model);
		else this.automaticModels.add(created.threadId);
		try {
			this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created);
			await this.subscribe(created);
			return created;
		} finally {
			this.materializingComposer = undefined;
		}
	}
}

function activeTurn(thread: Thread | undefined): Turn | undefined {
	return [...(thread?.turns ?? [])].reverse().find(
		(turn) =>
			turn.status === "created" ||
			turn.status === "running" ||
			turn.status === "waitingForApproval" ||
			turn.status === "waitingForUserInput" ||
			turn.status === "waitingForCapability" ||
			turn.status === "cancelling",
	);
}

function isSteerableTurn(turn: Turn): boolean {
	return (turn.kind === undefined || turn.kind === 'coding' || turn.kind === 'review') && (turn.status === "running" || turn.status === "waitingForApproval" || turn.status === "waitingForUserInput");
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
	return left?.provider === right?.provider && left?.model === right?.model;
}

function cloneTranscriptEntry(entry: ThreadTranscriptEntry): ThreadTranscriptEntry {
	switch (entry.type) {
		case 'voiceTranscript': return { ...entry, transcript: { ...entry.transcript } };
		case 'hookRun': return { ...entry, run: { ...entry.run, status: { ...entry.run.status } } };
		case "item": return { ...entry, item: { ...entry.item } };
		case "turnPlan": return { ...entry, plan: { explanation: entry.plan.explanation, steps: entry.plan.steps.map((step) => ({ ...step })) } };
		case "turnError": return { ...entry, error: { ...entry.error } };
		case "toolOutput": return { ...entry };
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
	return entry.type === "toolOutput" || entry.type === "item" && entry.transient;
}
