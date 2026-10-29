import { IAgentExecutionSettingsService } from '../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import type { ChatContextUsage, IChatRequestSubmittedEvent, RewriteChatRequestOptions } from '../common/chatService.js';
import type {
	AgentInteractionOffer,
	AgentInput,
	ThreadRead,
	ThreadSnapshotHistory,
} from '../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../nls.js';
import type {
	TurnChangeSetSummary as TurnChangeSetSummaryDto,
	TurnChangesReadResult as TurnChangesReadResultDto,
} from '../../../../../../.build/protocol/typescript/index.js';
import { Emitter } from '../../../../base/common/event.js';
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { IAppServerApi, IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { IAgentThreadService, IAgentTurnService } from '../../../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../../../platform/agentHost/common/agentModels.js';
import { ITurnChangesApi } from '../../../../platform/turnChanges/common/turnChangesApi.js';
import type { ModelRef, SessionId, ThreadId } from '../common/chatService.js';
import type {
	AdvisorConfig,
	ChatSubmissionOptions,
	ChatInteractionOfferChange,
	ConfigureAdvisorOptions,
	ConsultAdvisorOptions,
	CompactContextOptions,
	IChatService,
	InterruptTurnOptions,
	ResolveInteractionOptions,
	SlashCommandDefinition,
	StartTurnOptions,
	SteerTurnOptions,
	Thread,
	ThreadGoalUpdate,
	ThreadItem,
	ThreadSubscription,
	ThreadTranscriptEntry,
	ThreadTranscriptSnapshot,
	ThreadTranscriptUpdateEnvelope,
	ThreadUpdate,
	ThreadUpdateEnvelope,
	TurnChangeDetails,
	TurnChangeSetSummary,
	TurnCommitSelection,
	TurnCommitPreview,
	TurnChangesUpdate,
} from '../common/chatService.js';
import type { ResolvedChatContext } from '../common/chatContextService.js';
import type { ChatCheckpoint, RestoreChatCheckpointOptions } from '../common/chatService.js';
import type { ThreadChangesSummary, TurnChangeFileContents } from '../common/chatService.js';

interface SharedThreadSubscription {
	readonly generation: number;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly owners: Set<object>;
	readonly pending: Set<Promise<ThreadSubscription>>;
	offer?: AgentInteractionOffer;
	offerExpiry?: ReturnType<typeof setTimeout>;
}
/** App Server-backed implementation of the frontend Chat service. */
export class ChatService extends Disposable implements IChatService {
	private readonly submitted = this._register(new Emitter<IChatRequestSubmittedEvent>());
	readonly onDidSubmitRequest = this.submitted.event;
	private readonly _onDidChangeInteractionOffer = this._register(new Emitter<ChatInteractionOfferChange>());
	readonly onDidChangeInteractionOffer = this._onDidChangeInteractionOffer.event;
	private readonly _onDidChangeSession = this._register(
		new Emitter<{ readonly sessionId: SessionId; readonly agentTreeChanged: boolean }>(),
	);
	private readonly _onDidUpdateThread = this._register(new Emitter<ThreadUpdateEnvelope>());
	private readonly _onDidUpdateThreadTranscript = this._register(new Emitter<ThreadTranscriptUpdateEnvelope>());
	private readonly _onDidUpdateGoal = this._register(new Emitter<ThreadGoalUpdate>());
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	private readonly _onDidUpdateTurnChanges = this._register(new Emitter<TurnChangesUpdate>());
	private readonly _onDidChangeQueue = this._register(new Emitter<void>());
	private readonly threadSubscriptions = new Map<string, SharedThreadSubscription>();

	readonly onDidChangeSession = this._onDidChangeSession.event;
	readonly onDidUpdateThread = this._onDidUpdateThread.event;
	readonly onDidUpdateThreadTranscript = this._onDidUpdateThreadTranscript.event;
	readonly onDidUpdateGoal = this._onDidUpdateGoal.event;
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	readonly onDidUpdateTurnChanges = this._onDidUpdateTurnChanges.event;
	readonly onDidChangeQueue = this._onDidChangeQueue.event;

	private connectionEpoch = 0;

	constructor(
		@IAgentModelsService private readonly modelApi: IAgentModelsService,
		@IAgentThreadService private readonly threadApi: IAgentThreadService,
		@IAgentTurnService private readonly turnApi: IAgentTurnService,
		@ITurnChangesApi private readonly turnChangesApi: ITurnChangesApi,
		@IAppServerApi private readonly appServerApi: IAppServerApi,
		@IServerEventApi eventApi: IServerEventApi,
		@IAgentExecutionSettingsService private readonly execution: IAgentExecutionSettingsService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(threadApi.onDidOfferInteraction(offer => this.acceptInteractionOffer(offer)));
		this._register(
			threadApi.onDidUpdateThread(event => {
				this.retireCommittedInteraction(event);
				this._onDidUpdateThread.fire(event);
			}),
		);
		this._register(threadApi.onDidUpdateThreadTranscript(event => this._onDidUpdateThreadTranscript.fire(event)));
		const events = eventApi.subscribe(event => {
			if (event.method === 'session/changed') this._onDidChangeSession.fire({ ...event.params });
			if (event.method === 'queue/changed') this._onDidChangeQueue.fire();
			if (event.method === 'thread/goal/updated')
				this._onDidUpdateGoal.fire({ threadId: event.params.threadId, goal: { ...event.params.goal } });
			if (event.method === 'thread/goal/cleared') this._onDidUpdateGoal.fire({ threadId: event.params.threadId });
			if (event.method === 'turnChanges/changed')
				this._onDidUpdateTurnChanges.fire({
					sessionId: event.params.sessionId,
					threadId: event.params.threadId,
					changeSets: event.params.changeSets.map(toTurnChangeSummary),
				});
		});
		this._register(toDisposable(() => events.dispose()));
		const connection = appServerApi.onConnectionState(state => {
			this.connectionEpoch++;
			if (state !== 'ready') {
				// Backend subscriptions belong to the connection that created them.
				const subscriptions = [...this.threadSubscriptions.values()];
				this.threadSubscriptions.clear();
				for (const subscription of subscriptions) this.retireInteractionOffer(subscription);
				return;
			}
			for (const [key, subscription] of this.threadSubscriptions) {
				if (subscription.generation !== appServerApi.connectionGeneration) {
					this.threadSubscriptions.delete(key);
					this.retireInteractionOffer(subscription);
				}
			}
			this._onDidBecomeReady.fire();
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(
			toDisposable(() => {
				for (const [key, subscription] of this.threadSubscriptions) {
					this.retireInteractionOffer(subscription);
					subscription.owners.clear();
					void this.releaseThreadSubscription(key, subscription).catch(onUnexpectedError);
				}
			}),
		);
	}

	getInteractionOffer(sessionId: SessionId, threadId: ThreadId): AgentInteractionOffer | undefined {
		const subscription = this.threadSubscriptions.get(JSON.stringify([sessionId, threadId]));
		if (
			!subscription ||
			subscription.owners.size === 0 ||
			subscription.generation !== this.appServerApi.connectionGeneration
		)
			return undefined;
		if (
			subscription.offer?.interaction.deadline &&
			subscription.offer.interaction.deadline.expiresAtUnixMs <= Date.now()
		)
			this.retireInteractionOffer(subscription);
		return subscription.offer;
	}

	private acceptInteractionOffer(offer: AgentInteractionOffer): void {
		const subscription = this.threadSubscriptions.get(JSON.stringify([offer.sessionId, offer.threadId]));
		if (
			this.isDisposed ||
			!subscription ||
			subscription.owners.size === 0 ||
			subscription.generation !== offer.connectionGeneration ||
			offer.connectionGeneration !== this.appServerApi.connectionGeneration
		)
			return;
		if (offer.interaction.deadline && offer.interaction.deadline.expiresAtUnixMs <= Date.now()) return;
		clearTimeout(subscription.offerExpiry);
		subscription.offer = offer;
		this.scheduleInteractionExpiry(subscription);
		this._onDidChangeInteractionOffer.fire({ sessionId: offer.sessionId, threadId: offer.threadId, offer });
	}

	private scheduleInteractionExpiry(subscription: SharedThreadSubscription): void {
		const expires = subscription.offer?.interaction.deadline?.expiresAtUnixMs;
		if (expires === undefined) return;
		// Long deadlines exceed the carrier timer range; recheck the absolute deadline each time.
		subscription.offerExpiry = setTimeout(
			() => {
				if (expires <= Date.now()) this.retireInteractionOffer(subscription);
				else this.scheduleInteractionExpiry(subscription);
			},
			Math.min(2_147_483_647, Math.max(0, expires - Date.now())),
		);
	}

	private retireInteractionOffer(subscription: SharedThreadSubscription): void {
		if (!subscription.offer) return;
		subscription.offer = undefined;
		clearTimeout(subscription.offerExpiry);
		subscription.offerExpiry = undefined;
		if (subscription.owners.size > 0)
			this._onDidChangeInteractionOffer.fire({
				sessionId: subscription.sessionId,
				threadId: subscription.threadId,
			});
	}

	private retireCommittedInteraction(update: ThreadUpdateEnvelope): void {
		if (update.update.type !== 'committed') return;
		const subscription = this.threadSubscriptions.get(JSON.stringify([update.sessionId, update.threadId]));
		const offer = subscription?.offer;
		if (!subscription || !offer) return;
		const event = update.update.event;
		switch (event.type) {
			case 'interactionResolved':
			case 'interactionCancelled':
				if (event.turnId === offer.turnId && event.requestId === offer.interaction.requestId)
					this.retireInteractionOffer(subscription);
				break;
			case 'turnCompleted':
			case 'turnFailed':
			case 'turnInterrupted':
				if (event.turnId === offer.turnId) this.retireInteractionOffer(subscription);
				break;
		}
	}

	async listSlashCommands(): Promise<readonly SlashCommandDefinition[]> {
		const commands = await this.appServerApi.getSlashCommands();
		return commands.map(command => ({ ...command }));
	}

	async readCheckpoints(sessionId: SessionId, threadId: ThreadId): Promise<readonly ChatCheckpoint[]> {
		return this.threadApi.checkpoints({ sessionId, threadId });
	}

	async renameThread(sessionId: SessionId, threadId: ThreadId, title: string): Promise<void> {
		await this.threadApi.rename({ sessionId, threadId, title, source: 'manual', commandId: createUuid() });
	}

	async readHistoryState(sessionId: SessionId, threadId: ThreadId) {
		return this.threadApi.readHistoryState({ sessionId, threadId });
	}

	async rewriteRequest(
		options: RewriteChatRequestOptions,
	): Promise<{ readonly sessionId: SessionId; readonly threadId: ThreadId }> {
		this.assertAIEnabled();
		this.requireSubmissionOwner(options);
		const epoch = this.connectionEpoch;
		const { thread } = await this.readThread(options.sessionId, options.threadId);
		const turn = thread.turns.find(turn => turn.turnId === options.turnId);
		const firstMessage = turn?.items.find(item => item.type === 'userMessage');
		if (
			!turn ||
			firstMessage?.type !== 'userMessage' ||
			firstMessage.itemId !== options.itemId ||
			!firstMessage.clientId
		) {
			throw new Error(localize('chat.edit.unavailable', 'This request is no longer available for editing.'));
		}
		const input: AgentInput[] = [];
		// Submission identity separates the original input from steering, including context-only
		// steering received before the agent produces its first output. Legacy items lack this identity.
		for (const item of turn.items) {
			if (!('clientId' in item) || item.clientId !== firstMessage.clientId) continue;
			switch (item.type) {
				case 'userMessage':
					input.push({ type: 'text', text: item.itemId === firstMessage.itemId ? options.text : item.text });
					break;
				case 'userContext':
					input.push({ type: 'context', name: item.name, content: item.content });
					break;
				case 'userImage':
					input.push({ type: 'image', url: item.url });
					break;
				case 'userImageAttachment':
					input.push({ type: 'imageAttachment', attachment: item.attachment });
					break;
				case 'userAudioAttachment':
					input.push({ type: 'audioAttachment', attachment: item.attachment });
					break;
				default:
					break;
			}
		}
		if (this.isDisposed || epoch !== this.connectionEpoch) throw canceled();
		this.assertAIEnabled();
		this.requireSubmissionOwner(options);
		const result = await this.threadApi.rewrite(
			{
				sessionId: options.sessionId,
				threadId: options.threadId,
				beforeTurnId: options.turnId,
				commandId: options.commandId,
				title: thread.title,
				input,
			},
			options.signal,
		);
		if (this.isDisposed || epoch !== this.connectionEpoch) throw canceled();
		return result;
	}

	async moveHistory(options: {
		readonly sessionId: SessionId;
		readonly threadId: ThreadId;
		readonly expectedSequence: number;
		readonly direction: 'undo' | 'redo';
	}): Promise<void> {
		await this.threadApi.moveHistory({ ...options, commandId: createUuid() });
	}

	async restoreCheckpoint(
		options: RestoreChatCheckpointOptions,
	): Promise<{ readonly sessionId: SessionId; readonly threadId: ThreadId }> {
		return this.threadApi.restoreMessage({ ...options, commandId: createUuid() });
	}

	async readContextUsage(sessionId: SessionId, threadId: ThreadId): Promise<ChatContextUsage> {
		const { context } = await this.threadApi.readContext({ sessionId, threadId });
		return {
			estimatedTokens: context.estimatedTokens,
			contextWindow: context.allocation?.contextWindow,
			autoCompactAt: context.allocation?.autoCompactAt,
			model: context.model ?? undefined,
			latestRequestTokens: context.latestRequest?.usedTokens,
			categories: context.categories.map(({ category, tokens }) => ({ category, tokens })),
		};
	}

	async readThread(sessionId: SessionId, threadId: ThreadId, history?: ThreadSnapshotHistory): Promise<ThreadRead> {
		return this.threadApi.read({ sessionId, threadId, ...(history ? { history } : {}) });
	}

	async subscribeThread(
		sessionId: SessionId,
		threadId: ThreadId,
		afterSequence: number,
		owner: object,
		history?: ThreadSnapshotHistory,
	): Promise<ThreadSubscription> {
		this.assertNotDisposed();
		const key = JSON.stringify([sessionId, threadId]);
		let subscription = this.threadSubscriptions.get(key);
		if (!subscription) {
			subscription = {
				generation: this.appServerApi.connectionGeneration,
				sessionId,
				threadId,
				owners: new Set(),
				pending: new Set(),
			};
			this.threadSubscriptions.set(key, subscription);
		}
		subscription.owners.add(owner);
		const offeredBeforeSubscribe = subscription.offer;
		const pending = this.threadApi.subscribe({
			sessionId,
			threadId,
			afterSequence,
			...(history ? { history } : {}),
		});
		subscription.pending.add(pending);
		try {
			const result = await pending;
			if (
				this.isDisposed ||
				subscription.generation !== this.appServerApi.connectionGeneration ||
				this.threadSubscriptions.get(key) !== subscription
			) {
				throw canceled();
			}
			// A notification arriving during this RPC can describe newer state than its snapshot.
			// Only an offer that predates the RPC can be retired by that snapshot.
			if (subscription.offer && subscription.offer === offeredBeforeSubscribe) {
				const turn = result.thread.turns.find(turn => turn.turnId === subscription.offer?.turnId);
				// An omitted Turn in a bounded window says nothing about its pending interaction.
				if (
					turn
						? !['waitingForApproval', 'waitingForUserInput', 'waitingForCapability'].includes(turn.status)
						: !result.history
				)
					this.retireInteractionOffer(subscription);
			}
			return result;
		} finally {
			subscription.pending.delete(pending);
		}
	}

	async unsubscribeThread(sessionId: SessionId, threadId: ThreadId, owner: object): Promise<void> {
		const key = JSON.stringify([sessionId, threadId]);
		const subscription = this.threadSubscriptions.get(key);
		if (!subscription || !subscription.owners.delete(owner) || subscription.owners.size > 0) return;
		// Hide authority immediately. Retain the still-open connection lease until release
		// settles so a same-connection reacquisition does not require a duplicate server offer.
		if (subscription.offer) this._onDidChangeInteractionOffer.fire({ sessionId, threadId });
		await this.releaseThreadSubscription(key, subscription);
	}

	private async releaseThreadSubscription(key: string, subscription: SharedThreadSubscription): Promise<void> {
		// A pane may close while subscribe is in flight. Release only after that request, and only if no other pane acquired it.
		await Promise.allSettled(subscription.pending);
		const state = await this.appServerApi.getConnectionState();
		if (subscription.owners.size > 0 || this.threadSubscriptions.get(key) !== subscription) return;
		this.threadSubscriptions.delete(key);
		this.retireInteractionOffer(subscription);
		if (state !== 'ready' || subscription.generation !== this.appServerApi.connectionGeneration) return;
		try {
			await this.threadApi.unsubscribe({ sessionId: subscription.sessionId, threadId: subscription.threadId });
		} catch (error) {
			// Window teardown can close the owning connection after the readiness check.
			// Disconnection already releases its subscriptions; active-connection failures still surface.
			if (
				subscription.generation === this.appServerApi.connectionGeneration &&
				(await this.appServerApi.getConnectionState()) === 'ready'
			)
				throw error;
		}
	}

	private requireSubmissionOwner(
		options: ChatSubmissionOptions & { readonly sessionId: SessionId; readonly threadId: ThreadId },
	): void {
		if (
			options.signal?.aborted ||
			(options.source &&
				(options.source.sessionId !== options.sessionId || options.source.threadId !== options.threadId))
		)
			throw canceled();
	}

	async startTurn(options: StartTurnOptions): Promise<void> {
		this.assertAIEnabled();
		this.requireSubmissionOwner(options);
		const epoch = this.connectionEpoch;
		const input = turnInput(options);
		const started = await this.turnApi.start(
			{
				commandId: options.commandId ?? commandId('turn'),
				sessionId: options.sessionId,
				threadId: options.threadId,
				expectedSequence: options.expectedSequence,
				mode: options.mode,
				approvalMode: options.approvalMode,
				model: options.model,
				reasoningEffort: options.reasoningEffort,
				input,
			},
			options.signal,
		);
		if (options.isNewSession && !this.isDisposed && epoch === this.connectionEpoch) {
			const title = Array.from(options.text.trim().replace(/\s+/gu, ' ')).slice(0, 80).join('');
			if (title) {
				// Initial naming is best effort after admission. Core arbitrates a racing
				// manual name, and a failed title write must never resend the Turn.
				void Promise.resolve()
					.then(() => {
						if (this.isDisposed || epoch !== this.connectionEpoch) return;
						return this.threadApi.rename({
							sessionId: options.sessionId,
							threadId: options.threadId,
							title,
							source: 'automatic',
							commandId: `initial-title-${started.turnId}`,
						});
					})
					.catch(() => {});
			}
		}
		if (!this.isDisposed && epoch === this.connectionEpoch)
			this.submitted.fire({
				sessionId: options.sessionId,
				threadId: options.threadId,
				isNewSession: options.isNewSession === true,
				requestSequence: options.expectedSequence,
			});
	}

	async queueTurn(options: StartTurnOptions): Promise<void> {
		this.assertAIEnabled();
		this.requireSubmissionOwner(options);
		const epoch = this.connectionEpoch;
		const generation = this.appServerApi.connectionGeneration;
		const approvalMode = options.approvalMode ?? (await this.execution.read()).settings.approvalMode;
		if (this.isDisposed || epoch !== this.connectionEpoch || generation !== this.appServerApi.connectionGeneration)
			throw canceled();
		this.assertAIEnabled();
		this.requireSubmissionOwner(options);
		await this.turnApi.enqueue(
			{
				commandId: options.commandId ?? commandId('queued-turn'),
				sessionId: options.sessionId,
				threadId: options.threadId,
				mode: options.mode,
				model: options.model,
				reasoningEffort: options.reasoningEffort,
				input: turnInput(options),
				approvalMode,
			},
			options.signal,
		);
		if (!this.isDisposed && epoch === this.connectionEpoch)
			this.submitted.fire({
				sessionId: options.sessionId,
				threadId: options.threadId,
				isNewSession: false,
				requestSequence: options.expectedSequence,
			});
	}

	async queuedMessageCount(sessionId: SessionId, threadId: ThreadId): Promise<number> {
		const result = await this.turnApi.listQueued({ sessionId, threadId });
		return result.messages.filter(
			message => message.status === 'pending' || message.status === 'paused' || message.status === 'delivering',
		).length;
	}

	async configureAdvisor(options: ConfigureAdvisorOptions): Promise<void> {
		await this.threadApi.configureAdvisor({ commandId: commandId('advisor-config'), ...options });
	}

	async consultAdvisor(options: ConsultAdvisorOptions): Promise<void> {
		this.assertAIEnabled();
		const epoch = this.connectionEpoch;
		const { isNewSession, ...request } = options;
		await this.turnApi.consultAdvisor({ commandId: commandId('advisor-ask'), ...request });
		if (!this.isDisposed && epoch === this.connectionEpoch)
			this.submitted.fire({
				sessionId: options.sessionId,
				threadId: options.threadId,
				isNewSession: isNewSession === true,
				requestSequence: options.expectedSequence,
			});
	}

	readAdvisorDefault(): Promise<AdvisorConfig | null> {
		return this.modelApi.readAdvisorDefault();
	}

	saveAdvisorDefault(advisor: AdvisorConfig | null): Promise<void> {
		return this.modelApi.setAdvisorDefault({ commandId: commandId('advisor-default'), advisor });
	}

	async compactContext(options: CompactContextOptions): Promise<void> {
		this.assertAIEnabled();
		await this.turnApi.compact({
			commandId: commandId('compact'),
			sessionId: options.sessionId,
			threadId: options.threadId,
			expectedSequence: options.expectedSequence,
			retentionPrompt: options.retentionPrompt,
		});
	}

	async steerTurn(options: SteerTurnOptions): Promise<void> {
		this.assertAIEnabled();
		this.requireSubmissionOwner(options);
		const epoch = this.connectionEpoch;
		await this.turnApi.steer(
			{
				commandId: options.commandId ?? commandId('steer'),
				sessionId: options.sessionId,
				threadId: options.threadId,
				turnId: options.turnId,
				expectedSequence: options.expectedSequence,
				input: messageInput(options.text, options.contexts),
			},
			options.signal,
		);
		if (!this.isDisposed && epoch === this.connectionEpoch)
			this.submitted.fire({
				sessionId: options.sessionId,
				threadId: options.threadId,
				isNewSession: false,
				requestSequence: options.expectedSequence,
			});
	}

	async interruptTurn(options: InterruptTurnOptions): Promise<void> {
		await this.turnApi.interrupt({ commandId: commandId('interrupt'), ...options });
	}

	private assertAIEnabled(): void {
		if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			throw new Error(
				localize(
					'chat.ai.disabled.message',
					'AI features are disabled. Turn off Disable AI features in Settings to send messages.',
				),
			);
		}
	}

	async resolveInteraction(options: ResolveInteractionOptions): Promise<void> {
		await this.turnApi.resolveInteraction({
			commandId: commandId('interaction'),
			...options,
			response: options.response,
		});
	}

	async listTurnChanges(sessionId: SessionId, threadId: ThreadId): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.list({ sessionId, threadId });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async readThreadChanges(sessionId: SessionId, threadId: ThreadId): Promise<ThreadChangesSummary> {
		const result = await this.turnChangesApi.summary({ sessionId, threadId });
		return {
			sequence: result.sequence,
			revision: result.revision,
			statistics: { ...result.statistics },
			repositories: result.repositories.map(repository => ({
				repositoryId: repository.repositoryId,
				files: repository.files.map(file => ({ ...file })),
			})),
			warnings: [...result.warnings],
		};
	}

	async readThreadChangeFile(
		sessionId: SessionId,
		threadId: ThreadId,
		revision: string,
		repositoryId: string,
		path: string,
	): Promise<TurnChangeFileContents> {
		return { ...(await this.turnChangesApi.summaryFile({ sessionId, threadId, revision, repositoryId, path })) };
	}

	async readTurnChange(sessionId: SessionId, threadId: ThreadId, changeSetId: string): Promise<TurnChangeDetails> {
		return toTurnChangeDetails(await this.turnChangesApi.read({ sessionId, threadId, changeSetId }));
	}

	async readTurnChangeFile(sessionId: SessionId, threadId: ThreadId, changeSetId: string, path: string) {
		return { ...(await this.turnChangesApi.readFile({ sessionId, threadId, changeSetId, path })) };
	}

	async generateTurnChangeMessage(
		sessionId: SessionId,
		threadId: ThreadId,
		changeSetId: string,
		expectedRevision: number,
	): Promise<readonly TurnChangeSetSummary[]> {
		this.assertAIEnabled();
		const result = await this.turnChangesApi.generateMessage({
			commandId: commandId('turn-changes-message'),
			sessionId,
			threadId,
			changeSetId,
			expectedRevision,
		});
		return result.changeSets.map(toTurnChangeSummary);
	}

	async updateTurnChangeDraft(
		sessionId: SessionId,
		threadId: ThreadId,
		changeSetId: string,
		expectedRevision: number,
		message: string,
	): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.updateDraft({
			commandId: commandId('turn-changes-draft'),
			sessionId,
			threadId,
			changeSetId,
			expectedRevision,
			message,
		});
		return result.changeSets.map(toTurnChangeSummary);
	}

	async prepareTurnCommit(
		sessionId: SessionId,
		threadId: ThreadId,
		selections: readonly TurnCommitSelection[],
		message: string,
	): Promise<TurnCommitPreview> {
		const result = await this.turnChangesApi.prepareCommit({
			commandId: commandId('turn-changes-prepare'),
			sessionId,
			threadId,
			selections: selections.map(selection => ({ ...selection, paths: [...selection.paths] })),
			message,
		});
		return { ...result, files: result.files.map(file => ({ ...file })), warnings: [...result.warnings] };
	}

	async readTurnCommit(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<TurnCommitPreview> {
		const result = await this.turnChangesApi.readCommit({ sessionId, threadId, commitId });
		return { ...result, files: result.files.map(file => ({ ...file })), warnings: [...result.warnings] };
	}

	async readTurnCommitFile(sessionId: SessionId, threadId: ThreadId, commitId: string, path: string) {
		return { ...(await this.turnChangesApi.readCommitFile({ sessionId, threadId, commitId, path })) };
	}

	async commitTurnChange(
		sessionId: SessionId,
		threadId: ThreadId,
		commitId: string,
	): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.commit({
			commandId: commandId('turn-changes-commit'),
			sessionId,
			threadId,
			commitId,
		});
		return result.changeSets.map(toTurnChangeSummary);
	}

	async discardThreadChanges(
		sessionId: SessionId,
		threadId: ThreadId,
		expectedRevision: number,
	): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.discardThread({
			commandId: commandId('turn-changes-discard'),
			sessionId,
			threadId,
			expectedRevision,
			confirmed: true,
		});
		return result.changeSets.map(toTurnChangeSummary);
	}
}

function toContextInput(context: ResolvedChatContext): AgentInput {
	if (context.kind === 'image') {
		return { type: 'image', url: context.content };
	}
	if (context.kind === 'instruction') {
		return { type: 'instruction', path: context.content };
	}
	if (context.kind === 'toolSelection') {
		const disabled: unknown = JSON.parse(context.content);
		if (
			!Array.isArray(disabled) ||
			disabled.length > 4096 ||
			disabled.some(name => typeof name !== 'string' || !name.trim()) ||
			new Set(disabled).size !== disabled.length
		) {
			throw new Error(
				localize('chat.tools.invalidSelection', 'The tool selection is invalid. Configure tools again.'),
			);
		}
		return { type: 'toolSelection', disabled };
	}
	return { type: 'context', name: context.name, content: context.content };
}

function turnInput(options: StartTurnOptions): AgentInput[] {
	return [
		...(options.skills ?? []).map(skill => ({ type: 'skill' as const, skill })),
		...messageInput(options.text, options.contexts),
	];
}

function messageInput(text: string, contexts: readonly ResolvedChatContext[] = []): AgentInput[] {
	// Contexts without a composer position, including older drafts, retain their prefix placement.
	const input = contexts.filter(context => !context.reference).map(toContextInput);
	const inline = contexts
		.filter(context => context.reference)
		.sort((a, b) => a.reference!.start - b.reference!.start);
	let offset = 0;
	for (const context of inline) {
		const { start, end } = context.reference!;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < offset ||
			end <= start ||
			end > text.length
		) {
			throw new Error(
				localize(
					'chat.context.invalidReference',
					'An attachment position no longer matches this message. Remove the attachment and add it again.',
				),
			);
		}
		const before = text.slice(offset, start);
		// Core rejects empty text items. Preserve meaningful spans verbatim, but omit whitespace-only gaps.
		if (before.trim()) input.push({ type: 'text', text: before });
		input.push(toContextInput(context));
		offset = end;
	}
	const after = text.slice(offset);
	if (after.trim()) input.push({ type: 'text', text: after });
	return input;
}

function toTurnChangeSummary(summary: TurnChangeSetSummaryDto): TurnChangeSetSummary {
	return {
		...summary,
		statistics: { ...summary.statistics },
		dependencies: [...summary.dependencies],
		externalDependencyPaths: [...summary.externalDependencyPaths],
		warnings: [...summary.warnings],
		conflictPaths: [...summary.conflictPaths],
		committedPaths: [...summary.committedPaths],
	};
}

function toTurnChangeDetails(details: TurnChangesReadResultDto): TurnChangeDetails {
	return {
		summary: toTurnChangeSummary(details.summary),
		files: details.files.map(file => ({
			path: file.path,
			previousPath: file.previousPath,
			kind: file.kind,
			beforeMode: file.beforeMode,
			afterMode: file.afterMode,
			binary: file.binary,
			additions: file.additions,
			deletions: file.deletions,
		})),
		generatedMessage: details.generatedMessage,
		draftMessage: details.draftMessage,
	};
}

function commandId(kind: string): string {
	return `desktop-${kind}-${createUuid()}`;
}
