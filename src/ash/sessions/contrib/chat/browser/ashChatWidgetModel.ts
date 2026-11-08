import { canceled, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ModelReasoningEffort, ModelRef } from '../../../../platform/models/common/agentModels.js';
import type { ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { chatTranscriptListItems, type IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import type { SkillReference } from '../../../../platform/agentHost/common/appServerApi.js';
import type { ResolvedChatContext } from '../../../../workbench/services/chat/common/chatContextService.js';
import { ChatRequestQueueKind, type AgentInteractionDecision, type ChatMode, type ChatSubmissionOptions, type Thread, type ThreadRead, type ThreadTranscriptEntry, type ThreadTranscriptUpdateEnvelope, type Turn } from '../../../../workbench/services/chat/common/chatService.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { agentHostTurnDirectory } from '../../../common/agentHostSessionWorkspace.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { IAshChatSelectionService } from './ashChatSelectionService.js';
import { IAshChatSessionService } from './ashChatSessionService.js';
import type { IReplyChatEditorModel } from './replyChatEditor.js';

/** A second conversation source can offer its models for unsent drafts. */
export interface ChatDraftModelSource {
	readonly models: IObservable<readonly ModelCatalogEntry[]>;
	initialize(): void;
	selectModel(model: ModelRef, source: IReplyChatEditorModel): Promise<void>;
}

interface ThreadBinding {
	readonly sessionId: string;
	readonly threadId: string;
	thread?: Thread;
	entries: readonly ThreadTranscriptEntry[];
	revision: number;
	refreshing: boolean;
	refreshRequested: boolean;
}

export class AshChatWidgetModel extends Disposable implements IReplyChatEditorModel {
	private readonly changed = this._register(new Emitter<void>());
	private readonly composerChanged = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly onDidChangeComposer = this.composerChanged.event;

	private generation = 0;
	private identity: string | undefined;
	private promoting = false;
	private binding: ThreadBinding | undefined;
	private readonly catalog = observableValue<readonly ModelCatalogEntry[]>(this, []);
	private readonly draftModels: ChatDraftModelSource;
	private readonly pickerModels: IObservable<readonly ModelCatalogEntry[]>;
	private catalogRequest = 0;
	private catalogError: string | undefined;
	private error: string | undefined;
	private submitting = false;
	private sent = false;
	private renderedItems: readonly IChatListItem[] = [];

	constructor(
		draftModels: SyncDescriptor<ChatDraftModelSource>,
		@IAshChatSelectionService private readonly selection: IAshChatSelectionService,
		@ISessionPrimaryProviderServices private readonly primary: SessionProviderServices,
		@IAshChatSessionService private readonly sessions: IAshChatSessionService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.draftModels = instantiation.createInstance(draftModels);
		this.pickerModels = derived(reader => {
			const native = this.catalog.read(reader);
			return selection.selection.read(reader).kind === 'draft' ? [...native, ...this.draftModels.models.read(reader)] : native;
		});
		const chat = primary.chat;
		this._register(chat.onDidUpdateThread(update => {
			const binding = this.binding;
			if (binding && this.matches(binding, update) && update.update.type === 'committed') this.requestRefresh(binding);
		}));
		this._register(chat.onDidUpdateThreadTranscript(update => this.acceptTranscript(update)));
		this._register(chat.onDidChangeInteractionOffer(update => {
			if (this.binding && this.matches(this.binding, update)) this.changed.fire();
		}));
		this._register(chat.onDidBecomeReady(() => {
			if (this.binding) void this.subscribe(this.binding);
		}));
		this._register(primary.models.onDidChangeModels(() => void this.loadModels()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId)) this.changed.fire();
		}));
		this._register(toDisposable(() => this.releaseThread()));
		this._register(autorun(reader => {
			const current = selection.selection.read(reader);
			this.pickerModels.read(reader);
			const identity = current.kind === 'draft' ? current.id : current.threadId;
			if (identity !== this.identity) {
				this.identity = identity;
				if (current.kind === 'draft') this.draftModels.initialize();
				this.releaseThread();
				this.renderedItems = [];
				this.error = undefined;
				this.sent = false;
				if (!this.promoting) {
					this.generation++;
					this.submitting = false;
					this.composerChanged.fire();
				}
				if (current.kind === 'thread') {
					const binding: ThreadBinding = { sessionId: current.sessionId, threadId: current.threadId, entries: [], revision: 0, refreshing: false, refreshRequested: false };
					this.binding = binding;
					void this.subscribe(binding);
				}
			}
			this.changed.fire();
		}));
		void this.loadModels();
	}

	get composerGeneration(): number { return this.generation; }
	get sessionId(): string | undefined { return this.binding?.sessionId; }
	get threadId(): string | undefined { return this.binding?.threadId; }
	get untitledSessionId(): string | undefined {
		const current = this.selection.selection.get();
		return current.kind === 'draft' ? current.id : undefined;
	}
	get thread(): Thread | undefined { return this.binding?.thread; }
	get goal(): NonNullable<Thread['goal']> | undefined { return this.thread?.goal ?? undefined; }
	get items(): readonly IChatListItem[] { return this.renderedItems; }

	newChat(): void { void this.commands.executeCommand('sessions.open.new').catch(onUnexpectedError); }

	readWelcomeDraft(reader: IReader): { readonly id: string; readonly revision: number; } | undefined {
		const current = this.selection.selection.read(reader);
		return current.kind === 'draft' ? { id: current.id, revision: 0 } : undefined;
	}

	private get activeTurn(): Turn | undefined {
		const latest = this.thread?.turns.at(-1);
		return latest && !['completed', 'failed', 'interrupted'].includes(latest.status) ? latest : undefined;
	}

	private get selectedModel(): ModelRef | undefined {
		return this.selection.selection.get().model ?? this.thread?.turns.at(-1)?.model ?? undefined;
	}

	private get selectedEffort(): ModelReasoningEffort | undefined {
		const current = this.selection.selection.get();
		return current.model ? current.effort : this.thread?.turns.at(-1)?.reasoningEffort ?? undefined;
	}

	get inputState(): ChatInputState {
		const current = this.selection.selection.get();
		const disabled = this.configuration.getValue<boolean>(ChatAIDisabledSettingId);
		const loading = current.kind === 'thread' && !this.thread && !this.error;
		const selected = this.selectedModel;
		const offer = this.binding && this.primary.chat.getInteractionOffer(this.binding.sessionId, this.binding.threadId);
		return {
			draftIdentity: { id: this.identity!, generation: this.generation },
			conversation: this.binding && { sessionId: this.binding.sessionId, threadId: this.binding.threadId },
			mode: 'agent',
			phase: this.submitting ? 'submitting' : loading ? 'loading' : this.error ? 'error' : 'ready',
			inputBlocked: loading || !selected || !this.catalog.get().some(entry => modelRefIdentity(entry.model) === modelRefIdentity(selected)) || current.kind === 'thread' && !this.thread,
			aiDisabled: disabled,
			error: this.error,
			canInterrupt: this.sent || !!this.activeTurn,
			approvalMode: 'manual',
			queuedMessages: 0,
			models: this.pickerModels.get(),
			modelsError: this.catalogError,
			canSelectModel: !this.submitting,
			selectedModel: selected,
			selectedReasoningEffort: this.selectedEffort,
			isAutomaticModel: false,
			slashCommands: [],
			skillSelectors: [],
			canSelectAgent: false,
			interaction: offer?.interaction,
		};
	}

	async selectModel(model: ModelRef): Promise<void> {
		const current = this.selection.selection.get();
		if (current.kind === 'draft' && this.draftModels.models.get().some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
			await this.draftModels.selectModel(model, this);
			return;
		}
		this.requireModel(model);
		this.selection.select({ ...current, model, effort: undefined });
	}

	async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const model = this.requireModel(this.selectedModel);
		if (effort !== undefined && !model.supportedReasoningEfforts?.some(option => option.effort === effort)) {
			throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
		}
		this.selection.select({ ...this.selection.selection.get(), model: model.model, effort });
	}

	async send(text: string, _mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions): Promise<void> {
		if (!text.trim() && !contexts?.length) return;
		if (this.submitting || this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) throw canceled();
		const selected = this.selection.selection.get();
		const model = this.requireModel(this.selectedModel).model;
		const reasoningEffort = this.selectedEffort;
		const generation = this.generation;
		const assertCurrent = (): void => {
			if (this.isDisposed || generation !== this.generation || options?.signal?.aborted) throw canceled();
		};
		assertCurrent();
		this.submitting = true;
		this.error = undefined;
		this.changed.fire();
		try {
			let thread = this.thread;
			if (selected.kind === 'draft') {
				const created = await this.sessions.create(selected.id);
				assertCurrent();
				thread = (await this.primary.chat.readThread(created.sessionId, created.threadId)).thread;
			}
			assertCurrent();
			if (!thread) throw new Error(localize('sessions.create.noActiveChat', 'The new session has no active chat.'));
			const submission = {
				...options, sessionId: thread.sessionId, threadId: thread.threadId, expectedSequence: thread.sequence,
				mode: 'agent' as const, commandInterpretation: 'literal' as const, isNewSession: !thread.turns.length,
				text, skills, contexts, model, reasoningEffort,
			};
			const active = this.activeTurn;
			if (active && options?.queue === ChatRequestQueueKind.Steering) {
				await this.primary.chat.steerTurn({ ...submission, turnId: active.turnId });
			} else if (active) {
				await this.primary.chat.queueTurn({ ...submission, queue: ChatRequestQueueKind.Queued });
			} else {
				await this.primary.chat.startTurn(submission);
			}
			if (this.isDisposed || generation !== this.generation) return;
			if (selected.kind === 'draft') {
				this.promoting = true;
				try {
					this.selection.select({ kind: 'thread', sessionId: thread.sessionId, threadId: thread.threadId, model, effort: reasoningEffort });
				} finally { this.promoting = false; }
			}
			if (!active) this.sent = true;
			if (this.binding) this.requestRefresh(this.binding);
		} finally {
			if (!this.isDisposed && generation === this.generation) {
				this.submitting = false;
				this.changed.fire();
			}
		}
	}

	async interrupt(): Promise<void> {
		const binding = this.binding;
		const thread = binding?.thread;
		const turn = this.activeTurn;
		if (thread && turn) await this.primary.chat.interruptTurn({ sessionId: thread.sessionId, threadId: thread.threadId, expectedSequence: thread.sequence, turnId: turn.turnId });
	}

	async resolveInteraction(response: AgentInteractionDecision, expectedRequestId?: string): Promise<void> {
		const thread = this.thread;
		if (!thread) throw canceled();
		const offer = this.primary.chat.getInteractionOffer(thread.sessionId, thread.threadId);
		if (!offer || expectedRequestId && offer.interaction.requestId !== expectedRequestId) throw canceled();
		await this.primary.chat.resolveInteraction({ sessionId: thread.sessionId, threadId: thread.threadId, turnId: offer.turnId, expectedSequence: thread.sequence, requestId: offer.interaction.requestId, response });
	}

	private requireModel(model: ModelRef | undefined): ModelCatalogEntry {
		const entry = model && this.catalog.get().find(candidate => modelRefIdentity(candidate.model) === modelRefIdentity(model));
		if (!entry) throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
		return entry;
	}

	private async loadModels(): Promise<void> {
		const request = ++this.catalogRequest;
		try {
			const entries = await this.primary.models.listModelCatalog();
			if (this.isDisposed || request !== this.catalogRequest) return;
			this.catalogError = undefined;
			this.catalog.set(entries.filter(entry => this.primary.models.isModelVisible(entry.model)));
		} catch (error) {
			if (this.isDisposed || request !== this.catalogRequest) return;
			this.catalogError = String(error);
			this.changed.fire();
		}
	}

	private matches(binding: ThreadBinding, target: { readonly sessionId: string; readonly threadId: string; }): boolean {
		return target.sessionId === binding.sessionId && target.threadId === binding.threadId;
	}

	private async subscribe(binding: ThreadBinding): Promise<void> {
		try {
			const session = await this.sessions.read(binding.sessionId);
			if (this.binding !== binding) return;
			if (session?.status !== 'active' || !session.threads.some(thread => thread.threadId === binding.threadId && thread.status === 'active')) {
				throw new Error(localize('sessions.chat.ashHistoryUnavailable', 'This Ash Chat conversation is unavailable.'));
			}
			const result = await this.primary.chat.subscribeThread(binding.sessionId, binding.threadId, binding.thread?.sequence ?? 0, binding);
			this.acceptSnapshot(binding, result);
		} catch (error) { this.acceptError(binding, error); }
	}

	private releaseThread(): void {
		const binding = this.binding;
		this.binding = undefined;
		if (binding) void this.primary.chat.unsubscribeThread(binding.sessionId, binding.threadId, binding).catch(onUnexpectedError);
	}

	private requestRefresh(binding: ThreadBinding): void {
		binding.refreshRequested = true;
		if (!binding.refreshing) void this.refresh(binding);
	}

	private async refresh(binding: ThreadBinding): Promise<void> {
		binding.refreshing = true;
		try {
			while (binding.refreshRequested && this.binding === binding) {
				binding.refreshRequested = false;
				this.acceptSnapshot(binding, await this.primary.chat.readThread(binding.sessionId, binding.threadId));
			}
		} catch (error) { this.acceptError(binding, error); }
		finally { binding.refreshing = false; }
	}

	private acceptSnapshot(binding: ThreadBinding, result: ThreadRead): void {
		if (this.binding !== binding) return;
		if (result.thread.sequence >= (binding.thread?.sequence ?? 0)) {
			binding.thread = result.thread;
			if (result.thread.turns.length) this.sent = false;
		}
		if (result.transcript.revision >= binding.revision) {
			binding.entries = result.transcript.entries;
			binding.revision = result.transcript.revision;
		}
		this.error = undefined;
		this.render(binding);
	}

	private acceptError(binding: ThreadBinding, error: unknown): void {
		if (this.binding !== binding || isCancellationError(error)) return;
		this.error = String(error);
		this.changed.fire();
	}

	private acceptTranscript(update: ThreadTranscriptUpdateEnvelope): void {
		const binding = this.binding;
		if (!binding || !this.matches(binding, update) || update.revision <= binding.revision) return;
		if (update.revision !== binding.revision + 1) {
			this.requestRefresh(binding);
			return;
		}
		const entries = new Map(binding.entries.map(entry => [entry.entryId, entry]));
		for (const change of update.changes) {
			switch (change.type) {
				case 'upsert': entries.set(change.entry.entryId, change.entry); break;
				case 'remove': for (const id of change.entryIds) entries.delete(id); break;
				case 'clearTransient':
					for (const [id, entry] of entries) {
						if (entry.type === 'toolOutput' || entry.type === 'item' && entry.transient) entries.delete(id);
					}
					break;
			}
		}
		binding.entries = [...entries.values()];
		binding.revision = update.revision;
		this.render(binding);
	}

	private render(binding: ThreadBinding): void {
		const source = {
			sessionId: binding.sessionId, threadId: binding.threadId, commandTerminals: !!this.primary.host?.terminal?.commandSession,
			directoryForTurn: (turn: Turn) => agentHostTurnDirectory(binding.sessionId, turn.directory),
		};
		this.renderedItems = chatTranscriptListItems(binding.entries, binding.thread?.turns.at(-1)?.turnId, binding.thread?.turns, source, {
			archived: binding.thread?.status === 'archived',
		});
		this.changed.fire();
	}
}
