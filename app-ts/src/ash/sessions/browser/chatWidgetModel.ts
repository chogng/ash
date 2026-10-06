import { ILanguageModelsService } from '../../workbench/contrib/chat/common/languageModels.js';
import { Emitter, type Event } from "../../base/common/event.js";
import { isCancellationError } from "../../base/common/errors.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import type { AgentResponse, ChatAgent, ChatMode, IChatService, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, Thread, ThreadGoal, ThreadTranscriptEntry, ThreadTranscriptUpdateEnvelope, ThreadUpdateEnvelope, Turn, TurnChangeDetails, TurnChangeSetSummary, TurnInteraction } from "../../workbench/services/chat/common/chatService.js";
import { localize } from "../../nls.js";
import type { SkillReference } from "../../platform/skills/common/skillApi.js";
import type { ResolvedChatContext } from "../../workbench/services/chat/common/chatContextService.js";
import type { IActiveSessionThread, ISession, IUntitledChatSession, ModelRef, SessionId, ThreadId } from "../services/sessions/common/session.js";
import type { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { chatTranscriptListItems, type IChatListItem } from "../../workbench/contrib/chat/browser/widget/chatListItems.js";
import type { ChatInputState } from '../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { modelRefIdentity, type ModelReasoningEffort } from '../../workbench/services/chat/common/modelCatalog.js';
import type { ApprovalMode } from '../../workbench/services/chat/common/chatService.js';
import { observableValue } from '../../base/common/observable.js';

export type ChatWidgetState =
	| "loading"
	| "ready"
	| "submitting"
	| "error";

/** The local or durable identity currently displayed by a Chat pane. */
export type ChatWidgetSelection =
	| { readonly kind: "session"; readonly active: IActiveSessionThread }
	| { readonly kind: "untitled"; readonly session: IUntitledChatSession };

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
	private transcriptEntries: ThreadTranscriptEntry[] = [];
	private transcriptRevision = 0;
	private selection: ChatWidgetSelection;
	private _thread: Thread | undefined;
	private _interaction: TurnInteraction | undefined;
	private _state: ChatWidgetState = "loading";
	private _error: string | undefined;
	private generation = 0;
	private readPending = false;
	private initializePromise: Promise<void> | undefined;
	private subscriptionThreadId: ThreadId | undefined;
	private subscriptionPromise: Promise<void> | undefined;
	private _models: readonly ModelCatalogEntry[] = [];
	private modelsError: string | undefined;
	private readonly selectedModes = new Map<string, ChatMode>();
	private queuedMessages = 0;
	private queueGeneration = 0;
	private readonly selectedModels = new Map<ThreadId, ModelRef>();
	private readonly selectedApprovalModes = observableValue<ReadonlyMap<string, ApprovalMode>>(this, new Map());
	private readonly automaticModels = new Set<ThreadId>();
	// A New Chat's key is replaced with its Thread ID when the first message materializes it.
	private readonly selectedReasoningEfforts = new Map<string, { model: string; effort: ModelReasoningEffort | undefined }>();
	private _slashCommands: readonly SlashCommandDefinition[] = [];
	private _skillSelectors: readonly SkillSelectorDefinition[] = [];
	private _changeSets: readonly TurnChangeSetSummary[] = [];
	private readonly changeDetails = new Map<string, TurnChangeDetails>();
	private changesGeneration = 0;

	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(chatService: IChatService, selection: ChatWidgetSelection, sessionService: ISessionsManagementService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService) {
		super();
		this.chatService = chatService;
		this.sessionService = sessionService;
		this.selection = selection;
		this._register(chatService.onDidUpdateThread((update) => this.acceptUpdate(update)));
		this._register(chatService.onDidUpdateThreadTranscript((update) => this.acceptTranscriptUpdate(update)));
		this._register(chatService.onDidUpdateGoal((update) => {
			if (update.threadId !== this.threadId || !this._thread) return;
			this._thread = { ...this._thread, goal: update.goal ?? null };
			this._onDidChange.fire();
		}));
		this._register(chatService.onDidBecomeReady(() => void this.reconnect()));
		this._register(this.languageModels.onDidChangeModels(() => void this.loadModels()));
		this._register(chatService.onDidChangeQueue(() => void this.loadQueue()));
		this._register(chatService.onDidChangeSkills(() => void this.loadSkillSelectors()));
		this._register(chatService.onDidUpdateTurnChanges((update) => {
			if (update.sessionId !== this.sessionId || update.threadId !== this.threadId) return;
			this.acceptChangeSets(update.changeSets);
		}));
		this._register(toDisposable(() => {
			this.generation++;
			const active = this.activeSession;
			if (active) void this.chatService.unsubscribeThread(active.session.sessionId, active.threadId, this);
			this.transcriptEntries = [];
			this.transcriptRevision = 0;
		}));
		void this.initialize();
	}

	get state(): ChatWidgetState {
		return this._state;
	}

	get inputState(): ChatInputState {
		return {
			mode: this.mode,
			activeMode: activeTurn(this._thread)?.mode,
			queuedMessages: this.queuedMessages,
			phase: this._state,
			error: this._error,
			canInterrupt: this.canInterrupt,
			approvalMode: this.selectedApprovalModes.get().get(this.composerIdentity) ?? this._thread?.turns.at(-1)?.approvalMode ?? 'manual',
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
			interaction: this._interaction,
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
				?? (this._thread?.threadId === this.selection.active.threadId ? this._thread.turns.at(-1)?.model ?? undefined : undefined)
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
			: lastTurn?.model && modelRefIdentity(lastTurn.model) === identity ? lastTurn.reasoningEffort ?? undefined : undefined;
		const entry = this._models.find(candidate => modelRefIdentity(candidate.model) === identity);
		return effort && entry?.supportedReasoningEfforts?.includes(effort) ? effort : undefined;
	}

	get items(): readonly IChatListItem[] {
		const latestTurnId = this._thread?.turns.at(-1)?.turnId;
		return chatTranscriptListItems(this.transcriptEntries, latestTurnId);
	}

	get interaction(): TurnInteraction | undefined {
		return this._interaction;
	}

	get changeSets(): readonly TurnChangeSetSummary[] {
		return this._changeSets;
	}

	turnChangeDetails(changeSetId: string): TurnChangeDetails | undefined {
		return this.changeDetails.get(changeSetId);
	}

	async generateChangeMessage(changeSet: TurnChangeSetSummary): Promise<void> {
		const owner = this.requireChangeOwner();
		this.acceptChangeSets(await this.chatService.generateTurnChangeMessage(owner.sessionId, owner.threadId, changeSet.changeSetId, changeSet.revision));
	}

	async updateChangeDraft(changeSet: TurnChangeSetSummary, message: string): Promise<void> {
		const owner = this.requireChangeOwner();
		this.acceptChangeSets(await this.chatService.updateTurnChangeDraft(owner.sessionId, owner.threadId, changeSet.changeSetId, changeSet.revision, message));
		await this.loadChangeDetails(changeSet.changeSetId, this.changesGeneration);
	}

	async discardChanges(): Promise<void> {
		const owner = this.requireChangeOwner();
		const expectedRevision = Math.max(0, ...this._changeSets.map((changeSet) => changeSet.revision));
		this.acceptChangeSets(await this.chatService.discardThreadChanges(owner.sessionId, owner.threadId, expectedRevision));
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
		this.selection = { kind: "session", active };
		if (previousThreadId === active.threadId && this._thread?.threadId === active.threadId) {
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
		if (this.selection.kind === "untitled") {
			this.sessionService.setUntitledSessionModel(this.selection.session.untitledSessionId, model);
			this.refreshUntitledSelection();
			this.languageModels.rememberSelectedModel(model);
			return;
		}
		this.selectedModels.set(this.selection.active.threadId, model);
		this.automaticModels.delete(this.selection.active.threadId);
		this.languageModels.rememberSelectedModel(model);
		this._onDidChange.fire();
	}

	async selectAutomaticModel(): Promise<void> {
		if (this.selection.kind === 'untitled') {
			this.sessionService.setUntitledSessionModel(this.selection.session.untitledSessionId, undefined);
			this.refreshUntitledSelection();
			this.languageModels.rememberSelectedModel(undefined);
			return;
		}
		this.selectedModels.delete(this.selection.active.threadId);
		this.automaticModels.add(this.selection.active.threadId);
		this.languageModels.rememberSelectedModel(undefined);
		this._onDidChange.fire();
	}

	async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const model = this.selectedModel;
		if (!model || this.isAutomaticModel) throw new Error('Select a model before setting its thinking effort');
		const entry = this._models.find(candidate => modelRefIdentity(candidate.model) === modelRefIdentity(model));
		if (!entry || (effort !== undefined && !entry.supportedReasoningEfforts?.includes(effort))) {
			throw new Error('The selected model does not support this thinking effort');
		}
		const key = this.selection.kind === 'untitled' ? this.selection.session.untitledSessionId : this.selection.active.threadId;
		this.selectedReasoningEfforts.set(key, { model: modelRefIdentity(model), effort });
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

	async send(text: string, mode: ChatMode = this.mode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[]): Promise<void> {
		const input = text.trim();
		if (!input && !contexts?.length) return;
		try {
			await this.initialize();
			this.setState("submitting");
			const active = await this.ensureActiveSession();
			if (this._thread?.threadId !== active.threadId) {
				await this.subscribe(active);
			}
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error("Chat Thread is not available");
			}
			const turn = activeTurn(thread);
			const submission = {
				sessionId: active.session.sessionId,
				threadId: active.threadId,
				expectedSequence: thread.sequence,
				text: input,
				mode,
				approvalMode: this.inputState.approvalMode,
				model: this.isAutomaticModel ? undefined : this.selectedModel,
				reasoningEffort: this.selectedReasoningEffort,
				contexts,
				skills,
			};
			if (turn && (turn.mode !== mode || skills?.length)) {
				// A frozen Turn keeps its approach. A new approach gets its own durable submission.
				await this.chatService.queueTurn(submission);
				await this.loadQueue();
			} else if (turn) {
				if (!isSteerableTurn(turn)) throw new Error(`The active ${turn.status} Turn cannot accept steering`);
				await this.chatService.steerTurn({ ...submission, turnId: turn.turnId });
			} else {
				await this.chatService.startTurn(submission);
			}
			await this.refreshThread();
			this.setState("ready");
		} catch (error) {
			if (isCancellationError(error)) {
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

	async executeServerCommand(name: string, argumentsText: string): Promise<void> {
		if (name !== "compact" && name !== "advisor") {
			await this.send(`/${name}${argumentsText ? ` ${argumentsText}` : ""}`);
			return;
		}
		try {
			this.setState("submitting");
			const argument = argumentsText.trim();
			const isModelSelection = /^[^/\s]+\/\S+$/.test(argument);
			const isAdvisorConfigArgument = argument === "off" || argument === "clear" || isModelSelection;
			if (name === "advisor" && isAdvisorConfigArgument) {
				const current = await this.chatService.readAdvisorDefault();
				if (argument === "clear") {
					await this.chatService.saveAdvisorDefault(null);
				} else if (argument === "off") {
					if (current) await this.chatService.saveAdvisorDefault({ ...current, enabled: false });
				} else {
					const models = await this.languageModels.listAdvisorModels();
					const chosen = models.find(entry => `${entry.model.provider}/${entry.model.model}` === argument);
					if (!chosen) throw new Error(localize('chat.advisor.modelUnavailable', 'Advisor model is unavailable: {0}', argument));
					const config = current?.model.provider === chosen.model.provider && current.model.model === chosen.model.model
						? { ...current, enabled: true }
						: { model: chosen.model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
					await this.chatService.saveAdvisorDefault(config);
				}
				this.setState("ready");
				return;
			}
			const advisorDefault = name === "advisor" ? await this.chatService.readAdvisorDefault() : null;
			if (name === "advisor" && !argument) throw new Error(localize('chat.advisor.questionRequired', 'Enter a question after /advisor'));
			if (name === "advisor" && this.selection.kind === "untitled" && (!advisorDefault || !advisorDefault.enabled)) {
				throw new Error(localize('chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'));
			}
			const active = await this.ensureActiveSession();
			if (this._thread?.threadId !== active.threadId) {
				await this.subscribe(active);
			}
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error("Chat Thread is not available");
			}
			if (name === "advisor") {
				const options = { sessionId: active.session.sessionId, threadId: active.threadId, expectedSequence: thread.sequence };
				if (activeTurn(thread)) throw new Error(localize('chat.advisor.turnActive', 'Wait for the active Turn to finish before starting a consultation'));
				if (!advisorDefault || !advisorDefault.enabled) throw new Error(localize('chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'));
				await this.chatService.consultAdvisor({ ...options, question: argument });
				await this.refreshThread();
				this.setState("ready");
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
			await this.refreshThread();
			this.setState("ready");
		} catch (error) {
			this.setError(error);
			throw error;
		}
	}

	async retryFailedTurn(turnId: string): Promise<void> {
		const turns = this._thread?.turns ?? [];
		const turn = turns.at(-1);
		if (turn?.turnId !== turnId || turn.status !== "failed" || turn.error?.retryable !== true) {
			throw new Error("Only the latest retryable failed Turn can be retried");
		}
		await this.send("Try again.", turn.mode);
	}

	async interrupt(): Promise<void> {
		const thread = this._thread;
		const turn = activeTurn(thread);
		if (!thread || !turn) return;
		try {
			this.setState("submitting");
			await this.chatService.interruptTurn({
				sessionId: thread.sessionId,
				threadId: thread.threadId,
				turnId: turn.turnId,
				expectedSequence: thread.sequence,
			});
			await this.refreshThread();
			this.setState("ready");
		} catch (error) {
			this.setError(error);
		}
	}

	async resolveInteraction(response: AgentResponse): Promise<void> {
		const thread = this._thread;
		const interaction = this._interaction;
		const turn = activeTurn(thread);
		if (!thread || !turn || !interaction) return;
		if (response.type !== interaction.request.type) {
			throw new Error("Interaction response kind does not match request");
		}
		try {
			this.setState("submitting");
			await this.chatService.resolveInteraction({
				sessionId: thread.sessionId,
				threadId: thread.threadId,
				turnId: turn.turnId,
				requestId: interaction.requestId,
				expectedSequence: thread.sequence,
				response,
			});
			this._interaction = undefined;
			await this.refreshThread();
			this.setState("ready");
		} catch (error) {
			this.setError(error);
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

	private async loadCatalogs(): Promise<void> {
		const [models, slashCommands, skillSelectors] = await Promise.allSettled([this.modelEntries(), this.chatService.listSlashCommands(), this.chatService.listSkillSelectors()]);
		if (models.status === "fulfilled") {
			this._models = models.value;
			this.modelsError = undefined;
			this.applyDefaultNewChatModel();
		} else {
			this.modelsError = String(models.reason);
		}
		if (slashCommands.status === "fulfilled") this._slashCommands = slashCommands.value;
		if (skillSelectors.status === "fulfilled") this._skillSelectors = skillSelectors.value;
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
		try {
			this._skillSelectors = await this.chatService.listSkillSelectors();
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
		this._thread = undefined;
		this._interaction = undefined;
		this.transcriptEntries = [];
		this.transcriptRevision = 0;
		this._changeSets = [];
		this.queuedMessages = 0;
		this.queueGeneration++;
		this.changeDetails.clear();
		this.changesGeneration++;
		this.setState("loading");
		if (oldThreadId && oldThreadId !== active.threadId) {
			void this.chatService.unsubscribeThread(active.session.sessionId, oldThreadId, this);
		}
		try {
			const result = await this.chatService.subscribeThread(active.session.sessionId, active.threadId, 0, this);
			if (this.isDisposed || generation !== this.generation) return;
			this._thread = result.thread;
			if (!this.selectedModes.has(active.threadId)) {
				this.selectedModes.set(active.threadId, result.thread.turns.at(-1)?.mode ?? 'agent');
			}
			if (result.transcript.revision >= this.transcriptRevision) {
				this.transcriptEntries = result.transcript.entries.map((entry) => cloneTranscriptEntry(entry));
				this.transcriptRevision = result.transcript.revision;
			}
			for (const update of result.updates) {
				if (update.durableSequence > result.thread.sequence) {
					this.acceptUpdate(update);
				}
			}
			this.setState("ready");
			void this.loadTurnChanges(generation);
			void this.loadQueue();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			this.setError(error);
		}
	}

	private acceptUpdate(update: ThreadUpdateEnvelope): void {
		const selectedThreadId = this._thread?.threadId ?? this.threadId;
		if (!selectedThreadId) return;
		if (update.threadId !== selectedThreadId) return;
		if (update.update.type !== "committed") return;
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
			const count = await this.chatService.queuedMessageCount(active.session.sessionId, active.threadId);
			if (this.isDisposed || generation !== this.queueGeneration || active.threadId !== this.threadId) return;
			this.queuedMessages = count;
			this._onDidChange.fire();
		} catch (error) {
			if (!this.isDisposed && generation === this.queueGeneration) this.setError(error);
		}
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
			case "interactionRequested":
				this._interaction = event.interaction;
				this._onDidChange.fire();
				break;
			case "interactionResolved":
			case "interactionCancelled":
			case "turnCompleted":
			case "turnFailed":
			case "turnInterrupted":
				this._interaction = undefined;
				this._onDidChange.fire();
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
		try {
			const result = await this.chatService.readThread(active.session.sessionId, threadId);
			if (
				this.isDisposed ||
				generation !== this.generation ||
				result.thread.threadId !== this.threadId
			) return;
			this._thread = result.thread;
			if (result.transcript.revision >= this.transcriptRevision) {
				this.transcriptEntries = result.transcript.entries.map((entry) => cloneTranscriptEntry(entry));
				this.transcriptRevision = result.transcript.revision;
			}
			this._error = undefined;
			this._state = "ready";
			this._onDidChange.fire();
		} catch (error) {
			if (!this.isDisposed && generation === this.generation) {
				this.setError(error);
			}
		}
	}

	private setState(state: ChatWidgetState, error?: string): void {
		this._state = state;
		this._error = error;
		this._onDidChange.fire();
	}

	private setError(error: unknown): void {
		this.setState(
			"error",
			error instanceof Error ? error.message : "Chat is unavailable.",
		);
	}

	private get activeSession(): IActiveSessionThread | undefined {
		return this.selection.kind === "session" ? this.selection.active : undefined;
	}

	private requireChangeOwner(): { readonly sessionId: SessionId; readonly threadId: ThreadId } {
		const active = this.activeSession;
		if (!active) throw new Error("Turn changes require a durable Session and Thread");
		return { sessionId: active.session.sessionId, threadId: active.threadId };
	}

	private async ensureActiveSession(): Promise<IActiveSessionThread> {
		if (this.selection.kind === "session") return this.selection.active;
		const untitledSession = this.selection.session;
		const created = await this.sessionService.materializeUntitledSession(untitledSession.untitledSessionId);
		if (this.isDisposed) {
			this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created);
			throw new Error("Untitled Chat Session was closed while its durable Session was being created");
		}
		this.selection = { kind: "session", active: created };
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
		this.sessionService.promoteUntitledSession(untitledSession.untitledSessionId, created);
		await this.subscribe(created);
		return created;
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
	return turn.status === "running" || turn.status === "waitingForApproval" || turn.status === "waitingForUserInput";
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
	return left?.provider === right?.provider && left?.model === right?.model;
}

function cloneTranscriptEntry(entry: ThreadTranscriptEntry): ThreadTranscriptEntry {
	switch (entry.type) {
		case "item": return { ...entry, item: { ...entry.item } };
		case "turnPlan": return { ...entry, plan: { explanation: entry.plan.explanation, steps: entry.plan.steps.map((step) => ({ ...step })) } };
		case "turnError": return { ...entry, error: { ...entry.error } };
		case "toolOutput": return { ...entry };
	}
}

function isTransientTranscriptEntry(entry: ThreadTranscriptEntry): boolean {
	return entry.type === "toolOutput" || entry.type === "item" && entry.transient;
}
