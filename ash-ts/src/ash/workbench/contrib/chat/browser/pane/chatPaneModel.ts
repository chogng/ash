import { Emitter, type Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { AgentResponse, IChatService, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, Thread, ThreadGoal, ThreadTranscriptEntry, ThreadTranscriptUpdateEnvelope, ThreadUpdateEnvelope, Turn, TurnChangeDetails, TurnChangeSetSummary, TurnInteraction } from "../../../../services/chat/common/chatService.js";
import type { SkillReference } from "../../../../../platform/skills/common/skillApi.js";
import type { InstructionReference } from '../../../../../platform/instructions/common/instructionApi.js';
import type { ResolvedChatContext } from "../../../../services/chat/common/chatContextService.js";
import type { IActiveSessionThread, ISession, IUntitledChatSession, ModelRef, SessionId, ThreadId } from "../../../../../sessions/services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagementService.js";
import { chatTranscriptListItem, type IChatListItem } from "../list/chatListItems.js";

export type ChatPaneState =
	| "loading"
	| "ready"
	| "submitting"
	| "error";

/** The local or durable identity currently displayed by a Chat pane. */
export type ChatPaneSelection =
	| { readonly kind: "session"; readonly active: IActiveSessionThread }
	| { readonly kind: "untitled"; readonly session: IUntitledChatSession };

/**
 * State for one Chat tab, before or after it acquires a durable Thread.
 *
 * Canonical committed state is refreshed from `session/thread/read`. Transcript
 * entries arrive already assembled by App Server and are applied by stable ID.
 */
export class ChatPaneModel extends Disposable {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	private transcriptEntries: ThreadTranscriptEntry[] = [];
	private transcriptRevision = 0;
	private selection: ChatPaneSelection;
	private _thread: Thread | undefined;
	private _interaction: TurnInteraction | undefined;
	private _state: ChatPaneState = "loading";
	private _error: string | undefined;
	private generation = 0;
	private readPending = false;
	private initializePromise: Promise<void> | undefined;
	private subscriptionThreadId: ThreadId | undefined;
	private subscriptionPromise: Promise<void> | undefined;
	private _models: readonly ModelCatalogEntry[] = [];
	private _slashCommands: readonly SlashCommandDefinition[] = [];
	private _skillSelectors: readonly SkillSelectorDefinition[] = [];
	private _changeSets: readonly TurnChangeSetSummary[] = [];
	private readonly changeDetails = new Map<string, TurnChangeDetails>();
	private changesGeneration = 0;

	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(chatService: IChatService, selection: ChatPaneSelection, sessionService: ISessionsManagementService) {
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
		this._register(chatService.onDidChangeModels(() => void this.loadModels()));
		this._register(chatService.onDidChangeSkills(() => void this.loadSkillSelectors()));
		this._register(chatService.onDidUpdateTurnChanges((update) => {
			if (update.sessionId !== this.sessionId || update.threadId !== this.threadId) return;
			this.acceptChangeSets(update.changeSets);
		}));
		this._register(toDisposable(() => {
			this.generation++;
			const active = this.activeSession;
			if (active) void this.chatService.unsubscribeThread(active.session.sessionId, active.threadId);
			this.transcriptEntries = [];
			this.transcriptRevision = 0;
		}));
		void this.initialize();
	}

	get state(): ChatPaneState {
		return this._state;
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

	get selectedModel(): ModelRef | undefined {
		return this.selection.kind === "untitled"
			? this.selection.session.model
			: this.selection.active.session.model ?? undefined;
	}

	get items(): readonly IChatListItem[] {
		const latestTurnId = this._thread?.turns.at(-1)?.turnId;
		return this.transcriptEntries.map((entry) => chatTranscriptListItem(entry, {
			actionsEnabled: entry.turnId === latestTurnId,
		}));
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

	async commitChange(changeSet: TurnChangeSetSummary): Promise<void> {
		const owner = this.requireChangeOwner();
		this.acceptChangeSets(await this.chatService.commitTurnChange(owner.sessionId, owner.threadId, changeSet.changeSetId, changeSet.revision));
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
			throw new Error(`ChatPaneModel cannot select a Thread from another Session: ${active.session.sessionId}`);
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
			void this.chatService.unsubscribeThread(current.session.sessionId, previousThreadId);
		}
		await this.subscribe(active);
	}

	selectUntitledSession(session: IUntitledChatSession): void {
		if (this.selection.kind !== "untitled" || this.selection.session.untitledSessionId !== session.untitledSessionId) {
			throw new Error(`ChatPaneModel cannot select another Untitled Chat Session: ${session.untitledSessionId}`);
		}
		this.selection = { kind: "untitled", session };
		void this.loadModels();
	}

	async selectModel(model: ModelRef): Promise<void> {
		if (this.selection.kind === "untitled") {
			this.sessionService.setUntitledSessionModel(this.selection.session.untitledSessionId, model);
			return;
		}
		await this.sessionService.setModel(model);
	}

	async send(text: string, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], instructions?: readonly InstructionReference[]): Promise<void> {
		const input = text.trim();
		if (!input) return;
		try {
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
			if (turn) {
				if (!isSteerableTurn(turn)) {
					throw new Error(`The active ${turn.status} Turn cannot accept steering`);
				}
				if (skills?.length) {
					throw new Error("Skills can only be selected when starting a new Turn");
				}
				await this.chatService.steerTurn({
					sessionId: active.session.sessionId,
					threadId: active.threadId,
					turnId: turn.turnId,
					expectedSequence: thread.sequence,
					text: input,
					contexts,
					instructions,
				});
			} else {
				await this.chatService.startTurn({
					sessionId: active.session.sessionId,
					threadId: active.threadId,
					expectedSequence: thread.sequence,
					text: input,
					contexts,
					instructions,
					skills,
				});
			}
			await this.refreshThread();
			this.setState("ready");
		} catch (error) {
			this.setError(error);
			throw error;
		}
	}

	async executeServerCommand(name: string, argumentsText: string): Promise<void> {
		if (name !== "compact") {
			await this.send(`/${name}${argumentsText ? ` ${argumentsText}` : ""}`);
			return;
		}
		try {
			this.setState("submitting");
			const active = await this.ensureActiveSession();
			if (this._thread?.threadId !== active.threadId) {
				await this.subscribe(active);
			}
			const thread = this._thread;
			if (!thread || thread.threadId !== active.threadId) {
				throw new Error("Chat Thread is not available");
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
		await this.send("Try again.");
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
		if (models.status === "fulfilled") this._models = models.value;
		if (slashCommands.status === "fulfilled") this._slashCommands = slashCommands.value;
		if (skillSelectors.status === "fulfilled") this._skillSelectors = skillSelectors.value;
		this._onDidChange.fire();
	}

	private async loadModels(): Promise<void> {
		try {
			this._models = await this.modelEntries();
			this._onDidChange.fire();
		} catch {
			// Keep the last valid catalog when a transient refresh fails.
		}
	}

	private async modelEntries(): Promise<readonly ModelCatalogEntry[]> {
		const [visible, catalog] = await Promise.all([this.chatService.listModels(), this.chatService.listModelCatalog()]);
		const selected = this.selectedModel;
		if (!selected || visible.some(entry => sameModel(entry.model, selected))) return visible;
		const selectedEntry = catalog.find(entry => sameModel(entry.model, selected)) ?? {
			model: selected,
			displayName: selected.model,
			access: "unknown" as const,
			outputTransport: "unary" as const,
		};
		return [...visible, selectedEntry];
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
		this.changeDetails.clear();
		this.changesGeneration++;
		this.setState("loading");
		if (oldThreadId && oldThreadId !== active.threadId) {
			void this.chatService.unsubscribeThread(active.session.sessionId, oldThreadId);
		}
		try {
			const result = await this.chatService.subscribeThread(active.session.sessionId, active.threadId, 0);
			if (this.isDisposed || generation !== this.generation) return;
			this._thread = result.thread;
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

	private setState(state: ChatPaneState, error?: string): void {
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
