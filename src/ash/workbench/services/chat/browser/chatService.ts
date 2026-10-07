import type { AgentResponse as AgentResponseDto, InputItem, SkillRef as SkillRefDto, Thread as ThreadDto, ThreadItem as ThreadItemDto, ThreadTranscriptEntry as ThreadTranscriptEntryDto, ThreadTranscriptSnapshot as ThreadTranscriptSnapshotDto, ThreadTranscriptUpdateEnvelope as ThreadTranscriptUpdateEnvelopeDto, ThreadUpdateEnvelope as ThreadUpdateEnvelopeDto, TurnChangeSetSummary as TurnChangeSetSummaryDto, TurnChangesReadResult as TurnChangesReadResultDto } from "../../../../../../.build/protocol/typescript/index.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { createUuid } from "../../../../base/common/uuid.js";
import type { IAppServerApi, IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { IModelApi, IThreadApi, ITurnApi } from "../../../../platform/sessions/common/sessionApi.js";
import type { ISkillApi } from "../../../../platform/skills/common/skillApi.js";
import type { ITurnChangesApi } from "../../../../platform/turnChanges/common/turnChangesApi.js";
import type { ModelRef, SessionId, ThreadId } from "../common/chatService.js";
import type { AdvisorConfig, ConfigureAdvisorOptions, ConsultAdvisorOptions, CompactContextOptions, IChatService, InterruptTurnOptions, ResolveInteractionOptions, SkillSelectorDefinition, SlashCommandDefinition, StartTurnOptions, SteerTurnOptions, Thread, ThreadGoalUpdate, ThreadItem, ThreadSubscription, ThreadTranscriptEntry, ThreadTranscriptSnapshot, ThreadTranscriptUpdateEnvelope, ThreadUpdate, ThreadUpdateEnvelope, TurnChangeDetails, TurnChangeSetSummary, TurnCommitSelection, TurnCommitPreview, TurnChangesUpdate } from "../common/chatService.js";
import type { ResolvedChatContext } from '../common/chatContextService.js';
import { parseAgentTracePage, parseAgentTraceDiagnosticPage, parseAgentTraceGraph, type AgentTracePage, type AgentTraceDiagnosticPage, type AgentTraceGraph } from '../common/agentTrace.js';

export interface ChatServiceOptions {
	readonly modelApi: IModelApi;
	readonly threadApi: IThreadApi;
	readonly turnApi: ITurnApi;
	readonly turnChangesApi: ITurnChangesApi;
	readonly skillApi: ISkillApi;
	readonly appServerApi: IAppServerApi;
	readonly eventApi: IServerEventApi;
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
	private readonly threadSubscriptions = new Map<string, { owners: Set<object>; pending: Set<Promise<ThreadSubscription>>; }>();

	readonly onDidChangeSession = this._onDidChangeSession.event;
	readonly onDidUpdateThread = this._onDidUpdateThread.event;
	readonly onDidUpdateThreadTranscript = this._onDidUpdateThreadTranscript.event;
	readonly onDidUpdateGoal = this._onDidUpdateGoal.event;
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	readonly onDidChangeSkills = this._onDidChangeSkills.event;
	readonly onDidUpdateTurnChanges = this._onDidUpdateTurnChanges.event;
	readonly onDidChangeQueue = this._onDidChangeQueue.event;

	constructor(private readonly options: ChatServiceOptions) {
		super();
		const events = options.eventApi.subscribe((event) => {
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
		const connection = options.appServerApi.onConnectionState((state) => {
			if (state !== "ready") return;
			this._onDidBecomeReady.fire();
		});
		this._register(toDisposable(() => connection.dispose()));

	}

	async listSlashCommands(): Promise<readonly SlashCommandDefinition[]> {
		const commands = await this.options.appServerApi.getSlashCommands();
		return commands.map((command) => ({ ...command }));
	}

	async listSkillSelectors(): Promise<readonly SkillSelectorDefinition[]> {
		const catalog = await this.options.skillApi.list("cached");
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
		const result = await this.options.threadApi.read({ sessionId, threadId });
		return { thread: toThread(result.thread), transcript: toThreadTranscriptSnapshot(result.transcript) };
	}

	async readTrace(sessionId: SessionId, after: Readonly<Record<string, number>>): Promise<AgentTracePage> {
		const page = await this.options.threadApi.readTrace({ sessionId, after: { ...after }, limit: 500 });
		return parseAgentTracePage(page.trace, page.cursors, page.hasMore, sessionId, after);
	}

	async readTraceDiagnostics(sessionId: SessionId, after: number): Promise<AgentTraceDiagnosticPage> {
		const page = await this.options.threadApi.readTraceDiagnostics({ sessionId, after, limit: 500 });
		return parseAgentTraceDiagnosticPage(page.diagnostics, page.cursor, page.hasMore, after);
	}

	async readTracePayload(sessionId: SessionId, captureId: string, payloadId: string): Promise<unknown> {
		return (await this.options.threadApi.readTracePayload({ sessionId, captureId, payloadId })).payload;
	}

	async readTraceGraph(sessionId: SessionId): Promise<AgentTraceGraph> {
		return parseAgentTraceGraph((await this.options.threadApi.readTraceGraph({ sessionId })).graph);
	}

	async subscribeThread(sessionId: SessionId, threadId: ThreadId, afterSequence: number, owner: object): Promise<ThreadSubscription> {
		const key = JSON.stringify([sessionId, threadId]);
		let subscription = this.threadSubscriptions.get(key);
		if (!subscription) {
			subscription = { owners: new Set(), pending: new Set() };
			this.threadSubscriptions.set(key, subscription);
		}
		subscription.owners.add(owner);
		const pending = this.options.threadApi.subscribe({ sessionId, threadId, afterSequence }).then(result => ({
			thread: toThread(result.thread), transcript: toThreadTranscriptSnapshot(result.transcript), updates: result.updates.map(toThreadUpdate),
		}));
		subscription.pending.add(pending);
		try {
			return await pending;
		} finally {
			subscription.pending.delete(pending);
		}
	}

	async unsubscribeThread(sessionId: SessionId, threadId: ThreadId, owner: object): Promise<void> {
		const key = JSON.stringify([sessionId, threadId]);
		const subscription = this.threadSubscriptions.get(key);
		if (!subscription || !subscription.owners.delete(owner) || subscription.owners.size > 0) return;
		// A pane may close while subscribe is in flight. Release only after that request, and only if no other pane acquired it.
		await Promise.allSettled(subscription.pending);
		if (subscription.owners.size > 0 || this.threadSubscriptions.get(key) !== subscription) return;
		this.threadSubscriptions.delete(key);
		await this.options.threadApi.unsubscribe({ sessionId, threadId });
	}

	async startTurn(options: StartTurnOptions): Promise<void> {
		const input = turnInput(options);
		await this.options.turnApi.start({ commandId: commandId("turn"), sessionId: options.sessionId, threadId: options.threadId, expectedSequence: options.expectedSequence, mode: options.mode, approvalMode: options.approvalMode ?? "manual", model: options.model, reasoningEffort: options.reasoningEffort, input });
	}

	async queueTurn(options: StartTurnOptions): Promise<void> {
		await this.options.turnApi.enqueue({ commandId: commandId("queued-turn"), sessionId: options.sessionId, threadId: options.threadId, mode: options.mode, model: options.model, reasoningEffort: options.reasoningEffort, input: turnInput(options), approvalMode: options.approvalMode ?? "manual" });
	}

	async queuedMessageCount(sessionId: SessionId, threadId: ThreadId): Promise<number> {
		const result = await this.options.turnApi.listQueued({ sessionId, threadId });
		return result.messages.filter(message => message.status === "pending" || message.status === "paused" || message.status === "delivering").length;
	}

	async configureAdvisor(options: ConfigureAdvisorOptions): Promise<void> {
		await this.options.threadApi.configureAdvisor({ commandId: commandId("advisor-config"), ...options });
	}

	async consultAdvisor(options: ConsultAdvisorOptions): Promise<void> {
		await this.options.turnApi.consultAdvisor({ commandId: commandId("advisor-ask"), ...options });
	}

	readAdvisorDefault(): Promise<AdvisorConfig | null> {
		return this.options.modelApi.readAdvisorDefault();
	}

	saveAdvisorDefault(advisor: AdvisorConfig | null): Promise<void> {
		return this.options.modelApi.setAdvisorDefault({ commandId: commandId("advisor-default"), advisor });
	}

	async compactContext(options: CompactContextOptions): Promise<void> {
		await this.options.turnApi.compact({
			commandId: commandId("compact"),
			sessionId: options.sessionId,
			threadId: options.threadId,
			expectedSequence: options.expectedSequence,
			retentionPrompt: options.retentionPrompt,
		});
	}

	async steerTurn(options: SteerTurnOptions): Promise<void> {
		await this.options.turnApi.steer({
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
		await this.options.turnApi.interrupt({ commandId: commandId("interrupt"), ...options });
	}

	async resolveInteraction(options: ResolveInteractionOptions): Promise<void> {
		await this.options.turnApi.resolveInteraction({ commandId: commandId("interaction"), ...options, response: toAgentResponse(options.response) });
	}

	async listTurnChanges(sessionId: SessionId, threadId: ThreadId): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.list({ sessionId, threadId });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async readTurnChange(sessionId: SessionId, threadId: ThreadId, changeSetId: string): Promise<TurnChangeDetails> {
		return toTurnChangeDetails(await this.options.turnChangesApi.read({ sessionId, threadId, changeSetId }));
	}

	async readTurnChangeFile(sessionId: SessionId, threadId: ThreadId, changeSetId: string, path: string) {
		return { ...await this.options.turnChangesApi.readFile({ sessionId, threadId, changeSetId, path }) };
	}

	async generateTurnChangeMessage(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.generateMessage({ commandId: commandId("turn-changes-message"), sessionId, threadId, changeSetId, expectedRevision });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async updateTurnChangeDraft(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number, message: string): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.updateDraft({ commandId: commandId("turn-changes-draft"), sessionId, threadId, changeSetId, expectedRevision, message });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async prepareTurnCommit(sessionId: SessionId, threadId: ThreadId, selections: readonly TurnCommitSelection[], message: string): Promise<TurnCommitPreview> {
		const result = await this.options.turnChangesApi.prepareCommit({ commandId: commandId("turn-changes-prepare"), sessionId, threadId, selections: selections.map(selection => ({ ...selection, paths: [...selection.paths] })), message });
		return { ...result, files: result.files.map(file => ({ ...file })), warnings: [...result.warnings] };
	}

	async readTurnCommit(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<TurnCommitPreview> {
		const result = await this.options.turnChangesApi.readCommit({ sessionId, threadId, commitId });
		return { ...result, files: result.files.map(file => ({ ...file })), warnings: [...result.warnings] };
	}

	async readTurnCommitFile(sessionId: SessionId, threadId: ThreadId, commitId: string, path: string) {
		return { ...await this.options.turnChangesApi.readCommitFile({ sessionId, threadId, commitId, path }) };
	}

	async commitTurnChange(sessionId: SessionId, threadId: ThreadId, commitId: string): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.commit({ commandId: commandId("turn-changes-commit"), sessionId, threadId, commitId });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async discardThreadChanges(sessionId: SessionId, threadId: ThreadId, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.discardThread({ commandId: commandId("turn-changes-discard"), sessionId, threadId, expectedRevision, confirmed: true });
		return result.changeSets.map(toTurnChangeSummary);
	}


}

function toContextInput(context: ResolvedChatContext): InputItem {
	return context.kind === 'image'
		? { type: 'image', url: context.content }
		: { type: 'context', name: context.name, content: context.content };
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
