import type { AgentResponse as AgentResponseDto, InputItem, SkillRef as SkillRefDto, Thread as ThreadDto, ThreadItem as ThreadItemDto, ThreadTranscriptEntry as ThreadTranscriptEntryDto, ThreadTranscriptSnapshot as ThreadTranscriptSnapshotDto, ThreadTranscriptUpdateEnvelope as ThreadTranscriptUpdateEnvelopeDto, ThreadUpdateEnvelope as ThreadUpdateEnvelopeDto, TurnChangeSetSummary as TurnChangeSetSummaryDto, TurnChangesReadResult as TurnChangesReadResultDto } from "../../../../../../.build/protocol/typescript/index.js";
import { Emitter } from "../../../../base/common/event.js";
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { createUuid } from "../../../../base/common/uuid.js";
import { IAppServerApi, IServerEventApi } from "../../../../platform/agentHost/common/appServerApi.js";
import { IModelApi, IThreadApi, ITurnApi } from "../../../../platform/sessions/common/sessionApi.js";
import { ISkillService } from "../../../../platform/skills/common/skillService.js";
import { ITurnChangesApi } from "../../../../platform/turnChanges/common/turnChangesApi.js";
import type { ModelRef, SessionId, ThreadId } from "../common/chatService.js";
import type { AdvisorConfig, ConfigureAdvisorOptions, ConsultAdvisorOptions, CompactContextOptions, IChatService, InterruptTurnOptions, ResolveInteractionOptions, SkillSelectorDefinition, SlashCommandDefinition, StartTurnOptions, SteerTurnOptions, Thread, ThreadGoalUpdate, ThreadItem, ThreadSubscription, ThreadTranscriptEntry, ThreadTranscriptSnapshot, ThreadTranscriptUpdateEnvelope, ThreadUpdate, ThreadUpdateEnvelope, TurnChangeDetails, TurnChangeSetSummary, TurnCommitSelection, TurnCommitPreview, TurnChangesUpdate } from "../common/chatService.js";
import type { ResolvedChatContext } from '../common/chatContextService.js';
import { parseAgentTracePage, parseAgentTraceDiagnosticPage, parseAgentTraceGraph, type AgentTracePage, type AgentTraceDiagnosticPage, type AgentTraceGraph } from '../common/agentTrace.js';

interface SharedThreadSubscription {
	readonly generation: number;
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly owners: Set<object>;
	readonly pending: Set<Promise<ThreadSubscription>>;
}
/** App Server-backed implementation of the frontend Chat service. */
export class ChatService extends Disposable implements IChatService {
	private readonly _onDidChangeSession = this._register(new Emitter<{ readonly sessionId: SessionId; readonly agentTreeChanged: boolean; }>());
	private readonly _onDidUpdateThread = this._register(new Emitter<ThreadUpdateEnvelope>());
	private readonly _onDidUpdateThreadTranscript = this._register(new Emitter<ThreadTranscriptUpdateEnvelope>());
	private readonly _onDidUpdateGoal = this._register(new Emitter<ThreadGoalUpdate>());
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	private readonly _onDidChangeSkills = this._register(new Emitter<void>());
	private readonly _onDidUpdateTurnChanges = this._register(new Emitter<TurnChangesUpdate>());
	private readonly _onDidChangeQueue = this._register(new Emitter<void>());
	private readonly threadSubscriptions = new Map<string, SharedThreadSubscription>();

	readonly onDidChangeSession = this._onDidChangeSession.event;
	readonly onDidUpdateThread = this._onDidUpdateThread.event;
	readonly onDidUpdateThreadTranscript = this._onDidUpdateThreadTranscript.event;
	readonly onDidUpdateGoal = this._onDidUpdateGoal.event;
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	readonly onDidChangeSkills = this._onDidChangeSkills.event;
	readonly onDidUpdateTurnChanges = this._onDidUpdateTurnChanges.event;
	readonly onDidChangeQueue = this._onDidChangeQueue.event;

	constructor(
		@IModelApi private readonly modelApi: IModelApi,
		@IThreadApi private readonly threadApi: IThreadApi,
		@ITurnApi private readonly turnApi: ITurnApi,
		@ITurnChangesApi private readonly turnChangesApi: ITurnChangesApi,
		@ISkillService private readonly skillApi: ISkillService,
		@IAppServerApi private readonly appServerApi: IAppServerApi,
		@IServerEventApi eventApi: IServerEventApi,
	) {
		super();
		const events = eventApi.subscribe((event) => {
			if (event.method === 'session/changed') this._onDidChangeSession.fire({ ...event.params });
			if (event.method === "queue/changed") this._onDidChangeQueue.fire();
			if (event.method === "session/thread/update") this._onDidUpdateThread.fire(toThreadUpdate(event.params));
			if (event.method === "session/thread/transcript/update") this._onDidUpdateThreadTranscript.fire(toThreadTranscriptUpdate(event.params));
			if (event.method === "thread/goal/updated") this._onDidUpdateGoal.fire({ threadId: event.params.threadId, goal: { ...event.params.goal } });
			if (event.method === "thread/goal/cleared") this._onDidUpdateGoal.fire({ threadId: event.params.threadId });
			if (event.method === "skills/changed") this._onDidChangeSkills.fire();
			if (event.method === "turnChanges/changed") this._onDidUpdateTurnChanges.fire({
				sessionId: event.params.sessionId,
				threadId: event.params.threadId,
				changeSets: event.params.changeSets.map(toTurnChangeSummary),
			});
		});
		this._register(toDisposable(() => events.dispose()));
		const connection = appServerApi.onConnectionState((state) => {
			if (state !== "ready") {
				// Backend subscriptions belong to the connection that created them.
				this.threadSubscriptions.clear();
				return;
			}
			for (const [key, subscription] of this.threadSubscriptions) {
				if (subscription.generation !== appServerApi.connectionGeneration) this.threadSubscriptions.delete(key);
			}
			this._onDidBecomeReady.fire();
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => {
			for (const [key, subscription] of this.threadSubscriptions) {
				subscription.owners.clear();
				void this.releaseThreadSubscription(key, subscription).catch(onUnexpectedError);
			}
		}));
	}

	async listSlashCommands(): Promise<readonly SlashCommandDefinition[]> {
		const commands = await this.appServerApi.getSlashCommands();
		return commands.map((command) => ({ ...command }));
	}

	async listSkillSelectors(): Promise<readonly SkillSelectorDefinition[]> {
		const catalog = await this.skillApi.list("cached");
		const counts = new Map<string, number>();
		for (const skill of catalog.skills.filter(skill => skill.enabled && skill.compatible)) counts.set(skill.id.name, (counts.get(skill.id.name) ?? 0) + 1);
		return catalog.skills
			.filter(skill => skill.enabled && skill.compatible && counts.get(skill.id.name) === 1)
			.map(skill => ({
				name: skill.id.name,
				description: skill.description,
				source: skill.id.source,
				skill: { id: { ...skill.id }, version: { type: "pinnedDigest", digest: skill.contentDigest } },
			}));
	}

	async readThread(sessionId: SessionId, threadId: ThreadId): Promise<{ readonly thread: Thread; readonly transcript: ThreadTranscriptSnapshot; }> {
		const result = await this.threadApi.read({ sessionId, threadId });
		return { thread: toThread(result.thread), transcript: toThreadTranscriptSnapshot(result.transcript) };
	}

	async readTrace(sessionId: SessionId, after: Readonly<Record<string, number>>): Promise<AgentTracePage> {
		const page = await this.threadApi.readTrace({ sessionId, after: { ...after }, limit: 500 });
		return parseAgentTracePage(page.trace, page.cursors, page.hasMore, sessionId, after);
	}

	async readTraceDiagnostics(sessionId: SessionId, after: number): Promise<AgentTraceDiagnosticPage> {
		const page = await this.threadApi.readTraceDiagnostics({ sessionId, after, limit: 500 });
		return parseAgentTraceDiagnosticPage(page.diagnostics, page.cursor, page.hasMore, after);
	}

	async readTracePayload(sessionId: SessionId, captureId: string, payloadId: string): Promise<unknown> {
		return (await this.threadApi.readTracePayload({ sessionId, captureId, payloadId })).payload;
	}

	async readTraceGraph(sessionId: SessionId): Promise<AgentTraceGraph> {
		return parseAgentTraceGraph((await this.threadApi.readTraceGraph({ sessionId })).graph);
	}

	async subscribeThread(sessionId: SessionId, threadId: ThreadId, afterSequence: number, owner: object): Promise<ThreadSubscription> {
		this.assertNotDisposed();
		const key = JSON.stringify([sessionId, threadId]);
		let subscription = this.threadSubscriptions.get(key);
		if (!subscription) {
			subscription = { generation: this.appServerApi.connectionGeneration, sessionId, threadId, owners: new Set(), pending: new Set() };
			this.threadSubscriptions.set(key, subscription);
		}
		subscription.owners.add(owner);
		const pending = this.threadApi.subscribe({ sessionId, threadId, afterSequence }).then(result => ({
			thread: toThread(result.thread), transcript: toThreadTranscriptSnapshot(result.transcript), updates: result.updates.map(toThreadUpdate),
		}));
		subscription.pending.add(pending);
		try {
			const result = await pending;
			if (this.isDisposed || subscription.generation !== this.appServerApi.connectionGeneration || this.threadSubscriptions.get(key) !== subscription) { throw canceled(); }
			return result;
		} finally {
			subscription.pending.delete(pending);
		}
	}

	async unsubscribeThread(sessionId: SessionId, threadId: ThreadId, owner: object): Promise<void> {
		const key = JSON.stringify([sessionId, threadId]);
		const subscription = this.threadSubscriptions.get(key);
		if (!subscription || !subscription.owners.delete(owner) || subscription.owners.size > 0) return;
		await this.releaseThreadSubscription(key, subscription);
	}

	private async releaseThreadSubscription(key: string, subscription: SharedThreadSubscription): Promise<void> {
		// A pane may close while subscribe is in flight. Release only after that request, and only if no other pane acquired it.
		await Promise.allSettled(subscription.pending);
		if (subscription.owners.size > 0 || this.threadSubscriptions.get(key) !== subscription) return;
		this.threadSubscriptions.delete(key);
		if (subscription.generation !== this.appServerApi.connectionGeneration) return;
		await this.threadApi.unsubscribe({ sessionId: subscription.sessionId, threadId: subscription.threadId });
	}

	async startTurn(options: StartTurnOptions): Promise<void> {
		const input = turnInput(options);
		await this.turnApi.start({ commandId: commandId("turn"), sessionId: options.sessionId, threadId: options.threadId, expectedSequence: options.expectedSequence, mode: options.mode, approvalMode: options.approvalMode ?? "manual", model: options.model, reasoningEffort: options.reasoningEffort, input });
	}

	async queueTurn(options: StartTurnOptions): Promise<void> {
		await this.turnApi.enqueue({ commandId: commandId("queued-turn"), sessionId: options.sessionId, threadId: options.threadId, mode: options.mode, model: options.model, reasoningEffort: options.reasoningEffort, input: turnInput(options), approvalMode: options.approvalMode ?? "manual" });
	}

	async queuedMessageCount(sessionId: SessionId, threadId: ThreadId): Promise<number> {
		const result = await this.turnApi.listQueued({ sessionId, threadId });
		return result.messages.filter(message => message.status === "pending" || message.status === "paused" || message.status === "delivering").length;
	}

	async configureAdvisor(options: ConfigureAdvisorOptions): Promise<void> {
		await this.threadApi.configureAdvisor({ commandId: commandId("advisor-config"), ...options });
	}

	async consultAdvisor(options: ConsultAdvisorOptions): Promise<void> {
		await this.turnApi.consultAdvisor({ commandId: commandId("advisor-ask"), ...options });
	}

	readAdvisorDefault(): Promise<AdvisorConfig | null> {
		return this.modelApi.readAdvisorDefault();
	}

	saveAdvisorDefault(advisor: AdvisorConfig | null): Promise<void> {
		return this.modelApi.setAdvisorDefault({ commandId: commandId("advisor-default"), advisor });
	}

	async compactContext(options: CompactContextOptions): Promise<void> {
		await this.turnApi.compact({
			commandId: commandId("compact"),
			sessionId: options.sessionId,
			threadId: options.threadId,
			expectedSequence: options.expectedSequence,
			retentionPrompt: options.retentionPrompt,
		});
	}

	async steerTurn(options: SteerTurnOptions): Promise<void> {
		await this.turnApi.steer({
			commandId: commandId("steer"),
			sessionId: options.sessionId,
			threadId: options.threadId,
			turnId: options.turnId,
			expectedSequence: options.expectedSequence,
			input: [
				...(options.contexts ?? []).map(toContextInput),
				...(options.text.trim() ? [{ type: "text" as const, text: options.text }] : []),
			],
		});
	}

	async interruptTurn(options: InterruptTurnOptions): Promise<void> {
		await this.turnApi.interrupt({ commandId: commandId("interrupt"), ...options });
	}

	async resolveInteraction(options: ResolveInteractionOptions): Promise<void> {
		await this.turnApi.resolveInteraction({ commandId: commandId("interaction"), ...options, response: toAgentResponse(options.response) });
	}

	async listTurnChanges(sessionId: SessionId, threadId: ThreadId): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.list({ sessionId, threadId });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async readTurnChange(sessionId: SessionId, threadId: ThreadId, changeSetId: string): Promise<TurnChangeDetails> {
		return toTurnChangeDetails(await this.turnChangesApi.read({ sessionId, threadId, changeSetId }));
	}

	async readTurnChangeFile(sessionId: SessionId, threadId: ThreadId, changeSetId: string, path: string) {
		return { ...await this.turnChangesApi.readFile({ sessionId, threadId, changeSetId, path }) };
	}

	async generateTurnChangeMessage(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.generateMessage({ commandId: commandId("turn-changes-message"), sessionId, threadId, changeSetId, expectedRevision });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async updateTurnChangeDraft(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number, message: string): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.updateDraft({ commandId: commandId("turn-changes-draft"), sessionId, threadId, changeSetId, expectedRevision, message });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async prepareTurnCommit(sessionId: SessionId, threadId: ThreadId, selections: readonly TurnCommitSelection[], message: string): Promise<TurnCommitPreview> {
		const result = await this.turnChangesApi.prepareCommit({ commandId: commandId("turn-changes-prepare"), sessionId, threadId, selections: selections.map(selection => ({ ...selection, paths: [...selection.paths] })), message });
		return { ...result, files: result.files.map(file => ({ ...file })), warnings: [...result.warnings] };
	}

	async readTurnCommit(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<TurnCommitPreview> {
		const result = await this.turnChangesApi.readCommit({ sessionId, threadId, commitId });
		return { ...result, files: result.files.map(file => ({ ...file })), warnings: [...result.warnings] };
	}

	async readTurnCommitFile(sessionId: SessionId, threadId: ThreadId, commitId: string, path: string) {
		return { ...await this.turnChangesApi.readCommitFile({ sessionId, threadId, commitId, path }) };
	}

	async commitTurnChange(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.commit({ commandId: commandId("turn-changes-commit"), sessionId, threadId, commitId });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async discardThreadChanges(sessionId: SessionId, threadId: ThreadId, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.turnChangesApi.discardThread({ commandId: commandId("turn-changes-discard"), sessionId, threadId, expectedRevision, confirmed: true });
		return result.changeSets.map(toTurnChangeSummary);
	}


}

function toContextInput(context: ResolvedChatContext): InputItem {
	if (context.kind === 'image') { return { type: 'image', url: context.content }; }
	if (context.kind === 'instruction') { return { type: 'instruction', path: context.content }; }
	return { type: 'context', name: context.name, content: context.content };
}

function toThread(thread: ThreadDto): Thread {
	return {
		agentId: thread.agentId,
		origin: thread.origin.type === "message" ? {
			type: "message", parentThreadId: thread.origin.parentThreadId, parentSequence: thread.origin.parentSequence,
			itemId: thread.origin.itemId, boundary: thread.origin.boundary,
		} : { ...thread.origin },
		sessionId: thread.sessionId,
		threadId: thread.threadId,
		title: thread.title,
		status: thread.status,
		sequence: thread.sequence,
		goal: thread.goal ? { ...thread.goal } : thread.goal,
		advisor: thread.advisor,
		usage: {
			modelInvocations: thread.usage.modelInvocations,
			inputTokens: { ...thread.usage.inputTokens },
			outputTokens: { ...thread.usage.outputTokens },
			cachedInputTokens: { ...thread.usage.cachedInputTokens },
			cacheWriteInputTokens: { ...thread.usage.cacheWriteInputTokens },
			reasoningTokens: { ...thread.usage.reasoningTokens },
		},
		turns: thread.turns.map((turn) => ({
			turnId: turn.turnId,
			status: turn.status,
			mode: turn.mode,
			approvalMode: turn.approvalMode,
			model: turn.model ? { ...turn.model } : turn.model,
			reasoningEffort: turn.reasoningEffort,
			plan: turn.plan ? {
				explanation: turn.plan.explanation,
				steps: turn.plan.steps.map((step) => ({ ...step })),
			} : turn.plan,
			usage: {
				modelInvocations: turn.usage.modelInvocations,
				inputTokens: { ...turn.usage.inputTokens },
				outputTokens: { ...turn.usage.outputTokens },
				cachedInputTokens: { ...turn.usage.cachedInputTokens },
				cacheWriteInputTokens: { ...turn.usage.cacheWriteInputTokens },
				reasoningTokens: { ...turn.usage.reasoningTokens },
			},
			items: turn.items.map(toThreadItem),
			error: turn.error ? { ...turn.error } : turn.error,
		})),
	};
}

function turnInput(options: StartTurnOptions): InputItem[] {
	return [
		...(options.skills ?? []).map(skill => ({ type: "skill" as const, skill: skill as SkillRefDto })),
		...(options.contexts ?? []).map(toContextInput),
		...(options.text.trim() ? [{ type: "text" as const, text: options.text }] : []),
	];
}

function toThreadUpdate(update: ThreadUpdateEnvelopeDto): ThreadUpdateEnvelope {
	return {
		sessionId: update.sessionId,
		threadId: update.threadId,
		durableSequence: update.durableSequence,
		streamCursor: update.streamCursor ? { ...update.streamCursor } : update.streamCursor,
		update: toThreadUpdateValue(update.update),
	};
}

function toThreadUpdateValue(update: ThreadUpdateEnvelopeDto["update"]): ThreadUpdate {
	switch (update.type) {
		case "committed": {
			const event = update.event;
			if (event.type === 'interactionRequested') return { type: 'committed', event: { type: event.type, interaction: { ...event.interaction } } };
			if (event.type === 'turnModeChanged') return { type: 'committed', event: { type: event.type, turnId: event.turnId, fromMode: event.fromMode, mode: event.mode } };
			return { type: 'committed', event: { type: event.type } };
		}
		case "itemStarted": return { type: "itemStarted", item: toThreadItem(update.item) };
		case "itemDelta": return { type: "itemDelta", itemId: update.itemId, delta: { ...update.delta } };
		case "toolOutputDelta": return { type: "toolOutputDelta", turnId: update.turnId, toolCallId: update.toolCallId, stream: update.stream, text: update.text };
	}
}

function toThreadTranscriptSnapshot(snapshot: ThreadTranscriptSnapshotDto): ThreadTranscriptSnapshot {
	return {
		sessionId: snapshot.sessionId,
		threadId: snapshot.threadId,
		durableSequence: snapshot.durableSequence,
		revision: snapshot.revision,
		entries: snapshot.entries.map(toThreadTranscriptEntry),
	};
}

function toThreadTranscriptUpdate(update: ThreadTranscriptUpdateEnvelopeDto): ThreadTranscriptUpdateEnvelope {
	return {
		sessionId: update.sessionId,
		threadId: update.threadId,
		durableSequence: update.durableSequence,
		revision: update.revision,
		changes: update.changes.map((change) => {
			switch (change.type) {
				case "upsert": return { type: "upsert", entry: toThreadTranscriptEntry(change.entry) };
				case "remove": return { type: "remove", entryIds: [...change.entryIds] };
				case "clearTransient": return { type: "clearTransient" };
			}
		}),
	};
}

function toThreadTranscriptEntry(entry: ThreadTranscriptEntryDto): ThreadTranscriptEntry {
	switch (entry.type) {
		case "item": return { type: "item", entryId: entry.entryId, turnId: entry.turnId, item: toThreadItem(entry.item), transient: entry.transient };
		case "turnPlan": return { type: "turnPlan", entryId: entry.entryId, turnId: entry.turnId, plan: { explanation: entry.plan.explanation, steps: entry.plan.steps.map((step) => ({ ...step })) } };
		case "turnError": return { type: "turnError", entryId: entry.entryId, turnId: entry.turnId, error: { ...entry.error } };
		case "toolOutput": return { type: "toolOutput", entryId: entry.entryId, turnId: entry.turnId, toolCallId: entry.toolCallId, stream: entry.stream, text: entry.text };
	}
}

function toThreadItem(item: ThreadItemDto): ThreadItem {
	return { ...item };
}

function toAgentResponse(response: ResolveInteractionOptions["response"]): AgentResponseDto {
	switch (response.type) {
		case "approval": return { type: "approval", response: { ...response.response } };
		case "userInput": return { type: "userInput", response: { answers: { ...response.response.answers } } };
		case "dynamicTool": return { type: "dynamicTool", response: { ...response.response, content: response.response.content.map((output) => ({ ...output })) } };
	}
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
		files: details.files.map((file) => ({
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

function commandId(kind: string): string { return `desktop-${kind}-${createUuid()}`; }
