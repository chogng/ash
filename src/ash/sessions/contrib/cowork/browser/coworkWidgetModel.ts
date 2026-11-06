import { SessionModelSelection } from '../../../browser/sessionModelSelection.js';
import { findLastIdx } from '../../../../base/common/arraysFind.js';
import { ChatRequestQueueKind } from '../../../../workbench/services/chat/common/chatService.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { IAgentExecutionSettingsService } from '../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { toSkillSelectors } from '../../../../workbench/contrib/chat/common/skillSelectors.js';
import { ILanguageModelsService } from '../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { AgentInteractionDecision, ChatAgent, ChatMode, ChatSubmissionOptions, IChatService, ModelCatalogEntry, SkillSelectorDefinition, Thread, ThreadGoal, ThreadTranscriptEntry, ThreadTranscriptUpdateEnvelope, ThreadUpdateEnvelope, Turn, TurnChangeDetails, ThreadChangesSummary, TurnChangeSetSummary, TurnInteraction } from '../../../../workbench/services/chat/common/chatService.js';
import { localize } from '../../../../nls.js';
import type { SkillReference } from '../../../../platform/agentHost/common/appServerApi.js';
import type { ResolvedChatContext } from '../../../../workbench/services/chat/common/chatContextService.js';
import type { IActiveSessionThread, ISession, IUntitledChatSession, ModelRef, SessionId, ThreadId } from '../../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { chatQueuedMessageListItems, chatStreamingResponseUpdate, chatTranscriptListItems, type ChatStreamingResponseUpdate, type IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ChatHistoryRedoModel } from '../../../../workbench/contrib/chat/common/model/chatHistoryRedoModel.js';
import type { ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { modelRefIdentity, type ModelReasoningEffort } from '../../../../workbench/services/chat/common/modelCatalog.js';
import type { ApprovalMode } from '../../../../workbench/services/chat/common/chatService.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export type ChatWidgetState =
	| 'loading'
	| 'ready'
	| 'submitting'
	| 'error';

/** The local or durable identity currently displayed by a Chat pane. */
export type ChatWidgetSelection =
	| { readonly kind: 'session'; readonly active: IActiveSessionThread; }
	| { readonly kind: 'untitled'; readonly session: IUntitledChatSession; };

/**
 * State for one Chat tab, before or after it acquires a durable Thread.
 *
 * Canonical committed state is refreshed from `session/thread/read`. Transcript
 * entries arrive already assembled by App Server and are applied by stable ID.
 */
export class CoworkWidgetModel extends Disposable {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<ChatStreamingResponseUpdate | void>());
	private readonly _onDidChangeComposer = this._register(new Emitter<void>());
	private transcriptEntries: ThreadTranscriptEntry[] = [];
	private transcriptRevision = 0;
	private selection: ChatWidgetSelection;
	private _thread: Thread | undefined;
	private _state: ChatWidgetState = 'loading';
	// A late local completion cannot release a newer operation's busy state.
	private stateRequest = 0;
	private _error: string | undefined;
	private generation = 0;
	private _composerGeneration = 0;
	private readPending: number | undefined;
	private readRequest = 0;
	private threadRead: { readonly generation: number; promise: Promise<void>; invalidated: boolean; } | undefined;
	private durableSequence = 0;
	private snapshotRequest = 0;
	private initializePromise: Promise<void> | undefined;
	private subscriptionThreadId: ThreadId | undefined;
	private subscriptionPromise: Promise<void> | undefined;
	private _models: readonly ModelCatalogEntry[] = [];
	private modelsError: string | undefined;
	private readonly selectedModes = new Map<string, ChatMode>();
	private queue: Awaited<ReturnType<IChatService['readQueue']>> = [];
	private readonly historyRedo: ChatHistoryRedoModel;
	private queueGeneration = 0;
	private readonly threadModelSelection = new SessionModelSelection();
	private readonly draftModelSelection = observableValue<{ readonly model?: ModelRef; readonly manual: boolean; }>(this, { manual: false });
	private readonly defaultApprovalMode = observableValue<ApprovalMode>(this, 'manual');
	private approvalGeneration = 0;
	private readonly selectedApprovalModes = observableValue<ReadonlyMap<string, ApprovalMode>>(this, new Map());
	// A New Chat's key is replaced with its Thread ID when the first message materializes it.
	private readonly selectedReasoningEfforts = new Map<string, { effort: ModelReasoningEffort | undefined; }>();
	private _skillSelectors: readonly SkillSelectorDefinition[] = [];
	private skillCatalogGeneration = 0;
	private readonly skillSelectorsLoading = observableValue(this, false);
	private _changeSets: readonly TurnChangeSetSummary[] = [];
	private readonly changeDetails = new Map<string, TurnChangeDetails>();
	private changesGeneration = 0;
	private threadChanges: ThreadChangesSummary | undefined;
	private threadChangesError: string | undefined;
	private summaryRequest = 0;

	readonly onDidChangePresentation = this._onDidChange.event;
	readonly onDidChange = Event.map(this.onDidChangePresentation, () => undefined);
	readonly onDidChangeComposer: Event<void> = this._onDidChangeComposer.event;

	constructor(chatService: IChatService, selection: ChatWidgetSelection, sessionService: ISessionsManagementService, @IPromptsService private readonly skills: IPromptsService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService, @ILanguageModelsConfigurationService private readonly modelPreferences: ILanguageModelsConfigurationService, @IAgentExecutionSettingsService private readonly execution: IAgentExecutionSettingsService, @IConfigurationService private readonly configuration: IConfigurationService) {
		super();
		this.chatService = chatService;
		this.historyRedo = this._register(new ChatHistoryRedoModel(chatService, () => this._onDidChange.fire()));
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
		this._register(this.modelPreferences.onDidChangeModels(() => void this.loadModels()));
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
		}));
		void this.initialize();
	}

	get state(): ChatWidgetState {
		return this._state;
	}

	get inputState(): ChatInputState {
		const pendingInteraction = activeTurn(this._thread)?.pendingInteraction;
		return {
			draftIdentity: { id: this.composerIdentity, generation: this.composerGeneration },
			inputBlocked: this.configuration.getValue<boolean>(ChatAIDisabledSettingId),
			aiDisabled: this.configuration.getValue<boolean>(ChatAIDisabledSettingId),
			mode: this.mode,
			activeMode: activeTurn(this._thread)?.mode,
			queuedMessages: this.queue.filter(message => message.status !== 'rejected').length,
			phase: this._state,
			error: this._error,
			canInterrupt: this.canInterrupt,
			changes: this.threadChanges?.statistics,
			changesRevision: this.threadChanges?.revision,
			changesScope: this.selection.kind === 'session' ? 'conversation' : 'workspace',
			changesError: this.threadChangesError,
			approvalMode: this.selectedApprovalModes.get().get(this.composerIdentity) ?? this._thread?.turns.at(-1)?.approvalMode ?? this.defaultApprovalMode.get(),
			models: this._models,
			modelsError: this.modelsError,
			slashCommands: [],
			skillSelectors: this._skillSelectors,
			skillSelectorsLoading: this.skillSelectorsLoading.get(),
			selectedModel: this.selectedModel,
			selectedReasoningEffort: this.selectedReasoningEffort,
			isAutomaticModel: this.isAutomaticModel,
			selectedAgent: this.selection.kind === 'untitled' ? this.selection.session.agent : undefined,
			agentName: this.selection.kind === 'session' ? this.selection.active.session.agentTree?.find(node => node.threadId === this.threadId)?.role?.name : undefined,
			canSelectAgent: this.selection.kind === 'untitled',
			interaction: this.interaction,
			pendingUserInputRequestId: pendingInteraction?.kind === 'userInput' ? pendingInteraction.requestId : undefined,
		};
	}

	get error(): string | undefined {
		return this._error;
	}

	get thread(): Thread | undefined {
		return this._thread;
	}

	get goal(): ThreadGoal | undefined {
		return this._thread?.goal ?? undefined;
	}

	get composerGeneration(): number { return this._composerGeneration; }
	get sessionId(): SessionId | undefined {
		return this.activeSession?.session.sessionId;
	}

	get session(): ISession | undefined {
		return this.selection.kind === 'session' ? this.selection.active.session : undefined;
	}

	get untitledSessionId(): string | undefined {
		return this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : undefined;
	}

	get threadId(): ThreadId | undefined {
		return this.activeSession?.threadId;
	}

	get models(): readonly ModelCatalogEntry[] {
		return this._models;
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
			? this.draftModelSelection.get().model
			: this.threadModelSelection.resolveModel(this.selection.active, this._thread);
	}

	get isAutomaticModel(): boolean {
		return this.selection.kind === 'untitled'
			? this.draftModelSelection.get().model === undefined
			: this.threadModelSelection.isAutomatic(this.selection.active.threadId);
	}

	get selectedReasoningEffort(): ModelReasoningEffort | undefined {
		const model = this.selectedModel;
		const key = this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
		if (this.isAutomaticModel || !model) return undefined;
		const identity = modelRefIdentity(model);
		const selection = this.selectedReasoningEfforts.get(key);
		// A local "Default" choice must override the last durable Turn's explicit effort.
		const effort = selection ? selection.effort : this._thread?.turns.at(-1)?.reasoningEffort;
		const entry = this._models.find(candidate => modelRefIdentity(candidate.model) === identity);
		return effort && entry?.supportedReasoningEfforts?.some(option => option.effort === effort) ? effort : undefined;
	}

	get items(): readonly IChatListItem[] {
		const latestTurnId = this._thread?.turns.at(-1)?.turnId;
		const source = this.sessionId && this.threadId ? { sessionId: this.sessionId, threadId: this.threadId } : undefined;
		const transcript = chatTranscriptListItems(this.transcriptEntries, latestTurnId, this._thread?.turns, source, { archived: this._thread?.status === 'archived' });
		const redo = this.historyRedo.item(this._thread);
		const queued = this.queue.length && this._thread?.status === 'active' ? chatQueuedMessageListItems(this.queue) : [];
		return redo || queued.length ? [...transcript, ...(redo ? [redo] : []), ...queued] : transcript;
	}

	get interaction(): TurnInteraction | undefined {
		const active = this.activeSession;
		if (!active) return undefined;
		const offer = this.chatService.getInteractionOffer(active.session.sessionId, active.threadId);
		return offer && offer.turnId === activeTurn(this._thread)?.turnId ? offer.interaction : undefined;
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
			throw new Error(`CoworkWidgetModel cannot select a Thread from another Session: ${active.session.sessionId}`);
		}
		const previousThreadId = current.threadId;
		const previousModel = current.session.model;
		if (previousThreadId !== active.threadId) {
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
			throw new Error(`CoworkWidgetModel cannot select another Untitled Chat Session: ${session.untitledSessionId}`);
		}
		this.selection = { kind: 'untitled', session };
		void this.loadModels();
	}

	async selectModel(model: ModelRef): Promise<void> {
		if (this.selection.kind === 'untitled') {
			this.draftModelSelection.set({ model, manual: true });
		} else {
			this.threadModelSelection.select(this.selection.active.threadId, model);
		}
		this.modelPreferences.rememberSelectedModel(model);
		this._onDidChange.fire();
	}

	async selectAutomaticModel(): Promise<void> {
		if (this.selection.kind === 'untitled') {
			this.draftModelSelection.set({ manual: true });
		} else {
			this.threadModelSelection.select(this.selection.active.threadId, undefined);
		}
		this.modelPreferences.rememberSelectedModel(undefined);
		this._onDidChange.fire();
	}

	async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const model = this.selectedModel;
		if (!model || this.isAutomaticModel) throw new Error('Select a model before setting its thinking effort');
		const entry = this._models.find(candidate => modelRefIdentity(candidate.model) === modelRefIdentity(model));
		if (!entry || (effort !== undefined && !entry.supportedReasoningEfforts?.some(option => option.effort === effort))) {
			throw new Error('The selected model does not support this thinking effort');
		}
		const key = this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
		this.selectedReasoningEfforts.set(key, { effort });
		this._onDidChange.fire();
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

	/** Materializes the existing Untitled owner without submitting an empty model Turn. */
	async prepareConversation(signal?: AbortSignal): Promise<{ readonly sessionId: string; readonly threadId: string; }> {
		this.assertAIEnabled();
		if (signal?.aborted) throw canceled();
		const identity = this.threadId ?? this.untitledSessionId;
		await (signal ? raceCancellationError(this.initialize(), signal) : this.initialize());
		if (this.isDisposed || signal?.aborted || identity !== (this.threadId ?? this.untitledSessionId)) throw canceled();
		this.assertAIEnabled();
		const active = await this.ensureActiveSession(signal);
		if (this.isDisposed || signal?.aborted || this.sessionId !== active.session.sessionId || this.threadId !== active.threadId) throw canceled();
		return { sessionId: active.session.sessionId, threadId: active.threadId };
	}

	async send(text: string, mode: ChatMode = this.mode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions): Promise<void> {
		if (!text.trim() && !contexts?.length) return;
		this.assertAIEnabled();
		const operation = this.captureOperation(options);
		const stateRequest = ++this.stateRequest;
		try {
			this.requireCurrentOperation(operation);
			await this.initialize();
			this.requireCurrentOperation(operation);
			// Once accepted, this request keeps its model even if the picker changes during preparation.
			const model = this.isAutomaticModel ? undefined : this.selectedModel;
			const reasoningEffort = this.selectedReasoningEffort;
			this.setState('submitting');
			this.requireCurrentOperation(operation);
			const active = await this.ensureActiveSession(operation.signal);
			if (this.isDisposed || operation.signal?.aborted || operation.generation !== this.composerGeneration || active.session.sessionId !== this.sessionId || active.threadId !== this.threadId) throw canceled();
			operation.identity = active.threadId;
			if (this._thread?.threadId !== active.threadId) {
				await this.subscribe(active);
			}
			this.requireCurrentOperation(operation);
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error('Chat Thread is not available');
			}
			this.requireCurrentOperation(operation);
			const turn = activeTurn(thread);
			const submission = {
				isNewSession: thread.turns.length === 0,
				sessionId: active.session.sessionId,
				threadId: active.threadId,
				expectedSequence: thread.sequence,
				// Reference offsets belong to the exact composer text, including leading whitespace.
				text,
				mode,
				commandInterpretation: 'literal' as const,
				approvalMode: this.inputState.approvalMode,
				model,
				reasoningEffort,
				contexts,
				signal: operation.signal,
				commandId: options?.commandId,
				source: options?.source,
				skills,
			};
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
			if (!this.isCurrentTarget(operation) || stateRequest !== this.stateRequest) throw error;
			if (operation.signal?.aborted || isCancellationError(error)) {
				if (this._state === 'submitting') this.setState('ready');
				throw error;
			}
			if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
				this.setState('ready');
				throw error;
			}
			this.setError(error);
			throw error;
		}
	}

	selectApprovalMode(mode: ApprovalMode): void {
		this.selectedApprovalModes.set(new Map(this.selectedApprovalModes.get()).set(this.composerIdentity, mode));
		this._onDidChange.fire();
	}

	private get composerIdentity(): string {
		return this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
	}

	async retryFailedTurn(turnId: string): Promise<void> {
		const turns = this._thread?.turns ?? [];
		const turn = turns.at(-1);
		if (turn?.turnId !== turnId || turn.status !== 'failed' || turn.error?.retryable !== true) {
			throw new Error('Only the latest retryable failed Turn can be retried');
		}
		await this.send('Try again.', turn.mode);
	}

	async interrupt(): Promise<void> {
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
		const turn = activeTurn(thread);
		if (!thread || !turn || !offer || !interaction || offer.turnId !== turn.turnId) return;
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
				turnId: turn.turnId,
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
		const [models] = await Promise.allSettled([this.modelEntries(), this.loadSkillSelectors(), this.loadDefaultApprovalMode()]);
		if (this.isDisposed) return;
		if (models.status === 'fulfilled') {
			this._models = models.value;
			this.modelsError = undefined;
			this.applyDefaultNewChatModel();
		} else {
			this.modelsError = String(models.reason);
		}
		this._onDidChange.fire();
	}

	private async loadModels(): Promise<void> {
		try {
			this._models = await this.modelEntries();
			this.modelsError = undefined;
			this.applyDefaultNewChatModel();
			this._onDidChange.fire();
		} catch (error) {
			this.modelsError = String(error);
			this._onDidChange.fire();
		}
	}

	private async modelEntries(): Promise<readonly ModelCatalogEntry[]> {
		return this.languageModels.listModels();
	}

	private applyDefaultNewChatModel(): void {
		if (this.selection.kind !== 'untitled' || this.draftModelSelection.get().manual) return;
		const model = this.modelPreferences.getDefaultNewChatModel(this._models);
		// The draft identity and text are shared with Code; its model choice is owned by that UI.
		this.draftModelSelection.set({ model, manual: false });
	}

	private async loadSkillSelectors(): Promise<void> {
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

	private async performSubscribe(active: IActiveSessionThread): Promise<void> {
		const generation = ++this.generation;
		const oldThreadId = this._thread?.threadId;
		const request = ++this.readRequest;
		// The new connection supplies authority. Keep the last readable snapshot
		// for the same thread so a pending question retains its draft during hydration.
		if (this._thread?.sessionId !== active.session.sessionId || oldThreadId !== active.threadId) {
			this._thread = undefined;
		}
		this.transcriptEntries = [];
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
		this.setState('loading');
		if (oldThreadId && oldThreadId !== active.threadId) {
			void this.chatService.unsubscribeThread(active.session.sessionId, oldThreadId, this);
		}
		try {
			const result = await this.chatService.subscribeThread(active.session.sessionId, active.threadId, 0, this);
			if (this.isDisposed || generation !== this.generation) return;
			const snapshot = this.acceptThreadSnapshot(result, request);
			const currentThread = this.thread;
			if (currentThread && !this.selectedModes.has(active.threadId)) {
				this.selectedModes.set(active.threadId, currentThread.turns.at(-1)?.mode ?? 'agent');
			}
			for (const update of result.updates) {
				if (update.durableSequence > (currentThread?.sequence ?? this.durableSequence)) {
					this.acceptUpdate(update);
				}
			}
			if (snapshot.thread) this.setState('ready');
			else if (snapshot.transcript) this._onDidChange.fire();
			void this.loadTurnChanges(generation);
			void this.loadQueue();
			if (currentThread?.status === 'active') void this.historyRedo.refresh(currentThread.sessionId, currentThread.threadId);
		} catch (error) {
			if (this.isDisposed || generation !== this.generation || request !== this.readRequest) return;
			this.setError(error);
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

	async refreshChanges(): Promise<void> {
		const owner = this.activeSession;
		if (!owner) return;
		const generation = this.generation;
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
						if (update.changes.length === 1) streamingResponse = chatStreamingResponseUpdate(this.transcriptEntries[index], entry);
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

	private refreshThread(): Promise<void> {
		if (this.isDisposed || !this.activeSession) return Promise.resolve();
		const generation = this.generation;
		if (this.threadRead?.generation === generation) {
			this.threadRead.invalidated = true;
			// The pending result may still advance state, but its failure no longer
			// describes the refresh requested after this notification or mutation.
			this.readRequest++;
			return this.threadRead.promise;
		}
		const read = { generation, promise: Promise.resolve(), invalidated: false };
		this.threadRead = read;
		read.promise = (async () => {
			try {
				do {
					read.invalidated = false;
					await this.readThreadSnapshot();
					// Retire the original read before issuing one replacement for the
					// accumulated updates. Writes keep their own execution and result.
				} while (!this.isDisposed && generation === this.generation && read.invalidated);
			} finally {
				if (this.threadRead === read) this.threadRead = undefined;
			}
		})();
		return read.promise;
	}

	private async readThreadSnapshot(): Promise<void> {
		const active = this.activeSession;
		if (!active) return;
		const threadId = active.threadId;
		const generation = this.generation;
		const request = ++this.readRequest;
		try {
			const result = await this.chatService.readThread(active.session.sessionId, threadId);
			if (
				this.isDisposed ||
				generation !== this.generation ||
				(request !== this.readRequest && result.thread.sequence <= (this._thread?.sequence ?? 0) && result.transcript.revision <= this.transcriptRevision) ||
				result.thread.threadId !== this.threadId
			) return;
			const snapshot = this.acceptThreadSnapshot(result, request);
			if (!snapshot.thread) { if (snapshot.transcript) this._onDidChange.fire(); return; }
			this._error = undefined;
			this._state = 'ready';
			this._onDidChange.fire();
		} catch (error) {
			if (!this.isDisposed && generation === this.generation && request === this.readRequest) {
				this.setError(error);
			}
		}
	}


	/** Hydration and refresh obey the same sequence floor; streaming revisions advance independently. */
	private acceptThreadSnapshot(result: Awaited<ReturnType<IChatService['readThread']>>, request: number): { readonly thread: boolean; readonly transcript: boolean; } {
		const sequence = this._thread?.sequence ?? 0;
		const thread = result.thread.sequence >= this.durableSequence && (result.thread.sequence > sequence || result.thread.sequence === sequence && request >= this.snapshotRequest);
		if (thread) {
			this._thread = result.thread;
			this.durableSequence = Math.max(this.durableSequence, result.thread.sequence);
			this.snapshotRequest = Math.max(this.snapshotRequest, request);
			void this.refreshChanges();
		}
		const transcript = result.transcript.revision >= this.transcriptRevision;
		if (transcript) {
			this.transcriptEntries = result.transcript.entries.map(entry => cloneTranscriptEntry(entry));
			this.transcriptRevision = result.transcript.revision;
		}
		return { thread, transcript };
	}

	private setState(state: ChatWidgetState, error?: string): void {
		this._state = state;
		this._error = error;
		this._onDidChange.fire();
	}

	private setError(error: unknown): void {
		this.setState(
			'error',
			error instanceof Error ? error.message : 'Chat is unavailable.',
		);
	}

	private assertAIEnabled(): void {
		if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			throw new Error(localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.'));
		}
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


	private isCurrentTarget(operation: ReturnType<CoworkWidgetModel['captureOperation']>): boolean {
		return !this.isDisposed && operation.generation === this.composerGeneration && operation.identity === this.composerIdentity;
	}

	private isCurrentOperation(operation: ReturnType<CoworkWidgetModel['captureOperation']>): boolean {
		return !operation.signal?.aborted && this.isCurrentTarget(operation);
	}

	private recoverCancelledSubmission(operation: ReturnType<CoworkWidgetModel['captureOperation']>, stateRequest: number): void {
		if (operation.signal?.aborted && stateRequest === this.stateRequest && this.isCurrentTarget(operation) && this._state === 'submitting') this.setState('ready');
	}

	private requireCurrentOperation(operation: ReturnType<CoworkWidgetModel['captureOperation']>): void {
		this.assertAIEnabled();
		if (!this.isCurrentOperation(operation)) throw canceled();
	}

	private async ensureActiveSession(signal?: AbortSignal): Promise<IActiveSessionThread> {
		if (this.selection.kind === 'session') return this.selection.active;
		const untitledSession = this.selection.session;
		const created = await this.sessionService.materializeUntitledSession(untitledSession.untitledSessionId, signal);
		if (this.isDisposed || this.selection.kind !== 'untitled' || this.selection.session.untitledSessionId !== untitledSession.untitledSessionId) {
			// Keep the completed durable session, but never replace a newer conversation selection.
			this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created);
			throw canceled();
		}
		this.adoptUntitledSession(untitledSession, created);
		this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created);
		await this.subscribe(created);
		return created;
	}

	/** Keep this composer's choices when organization gives its draft a durable identity. */
	private adoptUntitledSession(untitledSession: IUntitledChatSession, created: IActiveSessionThread): void {
		const selectedModel = this.selectedModel;
		this.selection = { kind: 'session', active: created };
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
		this.threadModelSelection.select(created.threadId, selectedModel);
		this.draftModelSelection.set({ manual: false });
	}

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
		case 'hookRun': return { ...entry, run: { ...entry.run, status: { ...entry.run.status } } };
		case 'item': return { ...entry, item: { ...entry.item } };
		case 'turnPlan': return { ...entry, plan: { explanation: entry.plan.explanation, steps: entry.plan.steps.map((step) => ({ ...step })) } };
		case 'turnError': return { ...entry, error: { ...entry.error } };
		case 'toolOutput': return { ...entry };
	}
}

function isTransientTranscriptEntry(entry: ThreadTranscriptEntry): boolean {
	return entry.type === 'toolOutput' || entry.type === 'item' && entry.transient;
}
