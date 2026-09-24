import type { AgentResponse as AgentResponseDto, InputItem, SkillRef as SkillRefDto, Thread as ThreadDto, ThreadItem as ThreadItemDto, ThreadTranscriptEntry as ThreadTranscriptEntryDto, ThreadTranscriptSnapshot as ThreadTranscriptSnapshotDto, ThreadTranscriptUpdateEnvelope as ThreadTranscriptUpdateEnvelopeDto, ThreadUpdateEnvelope as ThreadUpdateEnvelopeDto, TurnChangeSetSummary as TurnChangeSetSummaryDto, TurnChangesReadResult as TurnChangesReadResultDto } from "../../../../platform/app-server/common/generated/index.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { createUuid } from "../../../../base/common/uuid.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import type { IAppServerApi, IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { IModelApi, IThreadApi, ITurnApi } from "../../../../platform/sessions/common/sessionApi.js";
import type { ISkillApi } from "../../../../platform/skills/common/skillApi.js";
import type { ITurnChangesApi } from "../../../../platform/turnChanges/common/turnChangesApi.js";
import type { ModelRef, SessionId, ThreadId } from "../../../../sessions/services/sessions/common/session.js";
import type { AdvisorConfig, ConfigureAdvisorOptions, ConsultAdvisorOptions, CompactContextOptions, IChatService, InterruptTurnOptions, ModelCatalogEntry, ResolveInteractionOptions, SkillSelectorDefinition, SlashCommandDefinition, StartTurnOptions, SteerTurnOptions, Thread, ThreadGoalUpdate, ThreadItem, ThreadSubscription, ThreadTranscriptEntry, ThreadTranscriptSnapshot, ThreadTranscriptUpdateEnvelope, ThreadUpdate, ThreadUpdateEnvelope, TurnChangeDetails, TurnChangeSetSummary, TurnChangesUpdate } from "../common/chatService.js";
import type { ModelProviderCredentialStatus } from '../common/chatService.js';
import { ModelCatalogConfiguration, modelRefIdentity } from "../common/modelCatalog.js";

export interface ChatServiceOptions {
	readonly modelApi: IModelApi;
	readonly threadApi: IThreadApi;
	readonly turnApi: ITurnApi;
	readonly turnChangesApi: ITurnChangesApi;
	readonly skillApi: ISkillApi;
	readonly appServerApi: IAppServerApi;
	readonly eventApi: IServerEventApi;
	readonly configurationService?: IConfigurationService;
}

/** App Server-backed implementation of the frontend Chat service. */
export class ChatService extends Disposable implements IChatService {
	private readonly _onDidUpdateThread = this._register(new Emitter<ThreadUpdateEnvelope>());
	private readonly _onDidUpdateThreadTranscript = this._register(new Emitter<ThreadTranscriptUpdateEnvelope>());
	private readonly _onDidUpdateGoal = this._register(new Emitter<ThreadGoalUpdate>());
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	private readonly _onDidChangeSkills = this._register(new Emitter<void>());
	private readonly _onDidUpdateTurnChanges = this._register(new Emitter<TurnChangesUpdate>());
	private readonly hiddenModels = new Map<string, ModelRef>();
	private modelCatalog: readonly ModelCatalogEntry[] = [];
	private modelCatalogLoad: Promise<readonly ModelCatalogEntry[]> | undefined;
	private hasLoadedModelCatalog = false;

	readonly onDidUpdateThread = this._onDidUpdateThread.event;
	readonly onDidUpdateThreadTranscript = this._onDidUpdateThreadTranscript.event;
	readonly onDidUpdateGoal = this._onDidUpdateGoal.event;
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	readonly onDidChangeModels = this._onDidChangeModels.event;
	readonly onDidChangeSkills = this._onDidChangeSkills.event;
	readonly onDidUpdateTurnChanges = this._onDidUpdateTurnChanges.event;

	constructor(private readonly options: ChatServiceOptions) {
		super();
		const events = options.eventApi.subscribe((event) => {
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
			const refresh = this.refreshModels();
			this._onDidBecomeReady.fire();
			void refresh.catch(() => undefined);
		});
		this._register(toDisposable(() => connection.dispose()));
		this.acceptHiddenModels(options.configurationService?.getValue(ModelCatalogConfiguration.hiddenModels) ?? []);
		if (options.configurationService) {
			this._register(options.configurationService.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration(ModelCatalogConfiguration.hiddenModels)) return;
				this.acceptHiddenModels(options.configurationService!.getValue(ModelCatalogConfiguration.hiddenModels));
			}));
		}
	}

	async listModels(): Promise<readonly ModelCatalogEntry[]> {
		const catalog = await this.listModelCatalog();
		return catalog.filter(entry => this.isModelVisible(entry.model));
	}

	async listModelCatalog(): Promise<readonly ModelCatalogEntry[]> {
		if (this.hasLoadedModelCatalog) return this.modelCatalog;
		return this.refreshModels();
	}

	async listModelProviders(): Promise<readonly ModelProviderCredentialStatus[]> {
		const result = await this.options.modelApi.listProviders();
		return result.providers.map(provider => ({
			provider: provider.provider,
			displayName: provider.displayName,
			apiKeyPolicy: provider.apiKeyPolicy,
			apiKeyConfigured: provider.apiKeyConfigured,
		}));
	}

	async setModelProviderApiKey(provider: string, apiKey: string): Promise<void> {
		await this.options.modelApi.setProviderApiKey({ provider, apiKey });
	}

	async listAdvisorModels(): Promise<readonly ModelCatalogEntry[]> {
		const [models, providers] = await Promise.all([
			this.listModelCatalog(),
			this.options.modelApi.readConfiguredProviderIds(),
		]);
		const configured = new Set(providers);
		return models.filter(entry => configured.has(entry.model.provider));
	}

	async refreshModels(): Promise<readonly ModelCatalogEntry[]> {
		if (this.modelCatalogLoad) return this.modelCatalogLoad;
		const load = this.options.modelApi.list().then(result => this.acceptModelCatalog(result.models));
		this.modelCatalogLoad = load;
		try {
			return await load;
		} finally {
			if (this.modelCatalogLoad === load) this.modelCatalogLoad = undefined;
		}
	}

	isModelVisible(model: ModelRef): boolean {
		return !this.hiddenModels.has(modelRefIdentity(model));
	}

	async setModelVisible(model: ModelRef, visible: boolean): Promise<void> {
		const identity = modelRefIdentity(model);
		if (visible === !this.hiddenModels.has(identity)) return;
		const models = [...this.hiddenModels.values()].filter(candidate => modelRefIdentity(candidate) !== identity);
		if (!visible) models.push({ ...model });
		if (this.options.configurationService) {
			await this.options.configurationService.updateValue(ModelCatalogConfiguration.hiddenModels, models);
			return;
		}
		this.acceptHiddenModels(models);
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

	async readThread(sessionId: SessionId, threadId: ThreadId): Promise<{ readonly thread: Thread; readonly transcript: ThreadTranscriptSnapshot }> {
		const result = await this.options.threadApi.read({ sessionId, threadId });
		return { thread: toThread(result.thread), transcript: toThreadTranscriptSnapshot(result.transcript) };
	}

	async subscribeThread(sessionId: SessionId, threadId: ThreadId, afterSequence: number): Promise<ThreadSubscription> {
		const result = await this.options.threadApi.subscribe({ sessionId, threadId, afterSequence });
		return { thread: toThread(result.thread), transcript: toThreadTranscriptSnapshot(result.transcript), updates: result.updates.map(toThreadUpdate) };
	}

	unsubscribeThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		return this.options.threadApi.unsubscribe({ sessionId, threadId });
	}

	async startTurn(options: StartTurnOptions): Promise<void> {
		const input: InputItem[] = [
			...(options.skills ?? []).map(skill => ({ type: "skill" as const, skill: skill as SkillRefDto })),
			...(options.contexts ?? []).map(context => ({ type: "context" as const, name: context.name, content: context.content })),
			{ type: "text", text: options.text },
		];
		await this.options.turnApi.start({ commandId: commandId("turn"), sessionId: options.sessionId, threadId: options.threadId, expectedSequence: options.expectedSequence, approvalMode: "askPermissions", input });
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
				...(options.contexts ?? []).map(context => ({ type: "context" as const, name: context.name, content: context.content })),
				{ type: "text", text: options.text },
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

	async commitTurnChange(sessionId: SessionId, threadId: ThreadId, changeSetId: string, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.commit({ commandId: commandId("turn-changes-commit"), sessionId, threadId, changeSetIds: [changeSetId], expectedRevision });
		return result.changeSets.map(toTurnChangeSummary);
	}

	async discardThreadChanges(sessionId: SessionId, threadId: ThreadId, expectedRevision: number): Promise<readonly TurnChangeSetSummary[]> {
		const result = await this.options.turnChangesApi.discardThread({ commandId: commandId("turn-changes-discard"), sessionId, threadId, expectedRevision, confirmed: true });
		return result.changeSets.map(toTurnChangeSummary);
	}

	private acceptModelCatalog(entries: readonly {
		readonly model: ModelRef;
		readonly displayName: string;
		readonly access: ModelCatalogEntry["access"];
		readonly outputTransport: ModelCatalogEntry["outputTransport"];
	}[]): readonly ModelCatalogEntry[] {
		const identities = new Set<string>();
		const catalog = entries.map(entry => {
			const identity = modelRefIdentity(entry.model);
			if (identities.has(identity)) throw new Error(`Model catalog contains duplicate entry '${entry.model.provider}/${entry.model.model}'`);
			identities.add(identity);
			return Object.freeze({
				model: Object.freeze({ ...entry.model }),
				displayName: entry.displayName,
				access: entry.access,
				outputTransport: entry.outputTransport,
			});
		});
		const changed = !sameModelCatalog(this.modelCatalog, catalog);
		this.modelCatalog = Object.freeze(catalog);
		this.hasLoadedModelCatalog = true;
		if (changed) this._onDidChangeModels.fire();
		return this.modelCatalog;
	}

	private acceptHiddenModels(models: readonly ModelRef[]): void {
		const next = new Map(models.map(model => [modelRefIdentity(model), Object.freeze({ ...model })]));
		if (sameKeys(this.hiddenModels, next)) return;
		this.hiddenModels.clear();
		for (const [identity, model] of next) this.hiddenModels.set(identity, model);
		this._onDidChangeModels.fire();
	}
}

function sameModelCatalog(left: readonly ModelCatalogEntry[], right: readonly ModelCatalogEntry[]): boolean {
	return left.length === right.length && left.every((entry, index) => {
		const candidate = right[index];
		return candidate !== undefined
			&& entry.displayName === candidate.displayName
			&& entry.access === candidate.access
			&& entry.outputTransport === candidate.outputTransport
			&& modelRefIdentity(entry.model) === modelRefIdentity(candidate.model);
	});
}

function sameKeys(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): boolean {
	return left.size === right.size && [...left.keys()].every(key => right.has(key));
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
			approvalMode: turn.approvalMode,
			model: turn.model ? { ...turn.model } : turn.model,
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
		case "committed": return { type: "committed", event: update.event.type === "interactionRequested" ? { type: update.event.type, interaction: { ...update.event.interaction } } : { type: update.event.type } };
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
	switch (item.type) {
		case "userMessage": return { type: item.type, itemId: item.itemId, turnId: item.turnId, text: item.text };
		case "userContext": return { type: item.type, itemId: item.itemId, turnId: item.turnId, name: item.name, content: item.content };
		case "userImage": return { type: item.type, itemId: item.itemId, turnId: item.turnId, url: item.url };
		case "userImageAttachment": return { type: item.type, itemId: item.itemId, turnId: item.turnId, attachment: { ...item.attachment } };
		case "userAudioAttachment": return { type: item.type, itemId: item.itemId, turnId: item.turnId, attachment: { ...item.attachment } };
		case "agentMessage":
		case "reasoning":
		case "plan": return { type: item.type, itemId: item.itemId, turnId: item.turnId, text: item.text };
		case "toolCall": return { type: item.type, itemId: item.itemId, turnId: item.turnId, toolCallId: item.toolCallId, name: item.name, argumentsJson: item.argumentsJson };
		case "toolResult": return { type: item.type, itemId: item.itemId, turnId: item.turnId, toolCallId: item.toolCallId, text: item.text, isError: item.isError };
	}
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
	};
}

function toTurnChangeDetails(details: TurnChangesReadResultDto): TurnChangeDetails {
	return {
		summary: toTurnChangeSummary(details.summary),
		files: details.files.map((file) => ({
			path: file.path,
			previousPath: file.previousPath,
			kind: file.kind,
			binary: file.binary,
			additions: file.additions,
			deletions: file.deletions,
		})),
		generatedMessage: details.generatedMessage,
		draftMessage: details.draftMessage,
	};
}

function commandId(kind: string): string { return `desktop-${kind}-${createUuid()}`; }
