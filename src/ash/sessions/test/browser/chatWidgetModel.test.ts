import { TestConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../base/common/errors.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ChatWidgetModel } from '../../browser/chatWidgetModel.js';
import { CoworkWidgetModel } from '../../contrib/cowork/browser/coworkWidgetModel.js';
import { ChatService } from '../../../workbench/services/chat/browser/chatService.js';
import { createDisconnectedAgentThreadService } from '../../../platform/agentHost/browser/appServerAgentService.js';
import type { AgentInteractionOffer, IAgentTurnService, ThreadRead, ThreadSubscription, ThreadUpdateEnvelope, ThreadTranscriptUpdateEnvelope, SessionOperationInput } from '../../../platform/agentHost/common/agentService.js';
import type { AdvisorConfig, IAgentModelsService } from '../../../platform/agentHost/common/agentModels.js';
import type { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { IAppServerApi, IServerEventApi, AppServerConnectionState } from '../../../platform/agentHost/common/appServerApi.js';
import type { ITurnChangesApi } from '../../../platform/turnChanges/common/turnChangesApi.js';
import type { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import type { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import type { ILanguageModelsConfigurationService } from '../../contrib/cowork/common/languageModelsConfiguration.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../services/sessions/common/session.js';

function snapshot(threadId: string, sequence = 1, waiting = false): ThreadRead {
	const usage = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
	return { thread: { advisor: { type: 'default' }, agentId: 'agent', origin: { type: 'root' }, sessionId: 'session', threadId, title: `Sequence ${sequence}`, status: 'active', sequence, usage, turns: waiting ? [{ turnId: `turn-${threadId}`, status: 'waitingForApproval', mode: 'agent', kind: 'coding', approvalMode: 'manual', usage, items: [] }] : [] }, transcript: { sessionId: 'session', threadId, durableSequence: sequence, revision: sequence, entries: [] } };
}

function fixture(kind: 'Code' | 'Cowork', subscribe?: (threadId: string) => Promise<ThreadSubscription>, waiting = false) {
	const resources = new DisposableStore();
	const updates = resources.add(new Emitter<ThreadUpdateEnvelope>());
	const transcripts = resources.add(new Emitter<ThreadTranscriptUpdateEnvelope>());
	const offers = resources.add(new Emitter<AgentInteractionOffer>());
	const connection = resources.add(new Emitter<AppServerConnectionState>());
	const starts: SessionOperationInput<'startTurn'>[] = [];
	const queues: Parameters<IAgentTurnService['enqueue']>[0][] = [];
	const steers: SessionOperationInput<'steerTurn'>[] = [];
	const consults: SessionOperationInput<'consultAdvisor'>[] = [];
	const compacts: SessionOperationInput<'compactContext'>[] = [];
	let generation = 1;
	const threadApi = {
		...createDisconnectedAgentThreadService(async operation => { throw new Error(`Unexpected ${operation}`); }), onDidOfferInteraction: offers.event, onDidUpdateThread: updates.event, onDidUpdateThreadTranscript: transcripts.event,
		read: async ({ threadId }: { threadId: string; }) => snapshot(threadId, 1, waiting),
		subscribe: async ({ threadId }: { threadId: string; }) => subscribe ? subscribe(threadId) : { ...snapshot(threadId, 1, waiting), updates: [] }, unsubscribe: async () => { }, readContext: async () => ({ context: { estimatedTokens: 0, categories: [] } }),
	};
	const modelApi = { readAdvisorDefault: async (): Promise<AdvisorConfig | null> => ({ model: { provider: 'provider', model: 'advisor' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 }) } as IAgentModelsService;
	const turnApi = { start: async (input: SessionOperationInput<'startTurn'>) => { starts.push(input); return { turnId: 'started', sequence: 2 }; }, enqueue: async (input: Parameters<IAgentTurnService['enqueue']>[0]) => { queues.push(input); return { status: 'pending' as const }; }, listQueued: async () => ({ messages: [] }), steer: async (input: SessionOperationInput<'steerTurn'>) => { steers.push(input); return { turnId: input.turnId, sequence: 2 }; }, consultAdvisor: async (input: SessionOperationInput<'consultAdvisor'>) => { consults.push(input); return { turnId: 'consultation', sequence: 2 }; }, compact: async (input: SessionOperationInput<'compactContext'>) => { compacts.push(input); return { turnId: 'compacted', sequence: 2 }; }, interrupt: async () => ({ sequence: 2 }), resolveInteraction: async () => ({ sequence: 2 }) } as IAgentTurnService;
	const execution: IAgentExecutionSettingsService = { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } };
	const appServer = { get connectionGeneration() { return generation; }, getConnectionState: async () => 'ready', onConnectionState: connection.event, getSlashCommands: async () => [] } as IAppServerApi;
	const changeApi = { list: async () => ({ changeSets: [] }) } as unknown as ITurnChangesApi;
	const events = { subscribe: () => ({ dispose() { } }) } as IServerEventApi;
	const chat = resources.add(new ChatService(modelApi, threadApi, turnApi, changeApi, appServer, events, execution, resources.add(new TestConfigurationService())));
	const prompts = { onDidChangeSkills: Event.None, findAgentSkills: async () => [] } as unknown as IPromptsService;
	const models = { onDidChangeModels: Event.None, listModels: async () => [], readModelDefaults: async () => ({ revision: 1, model: null, reasoningEffort: null }) } as unknown as ILanguageModelsService;
	const preferences = { onDidChangeModels: Event.None } as ILanguageModelsConfigurationService;
	const session: ISession = { sessionId: 'session', title: 'Session', status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'A', origin: { type: 'root' }, status: 'active' }, { threadId: 'B', origin: { type: 'fork', parentThreadId: 'A', parentSequence: 1 }, status: 'active' }] };
	const sessions = {} as ISessionsManagementService;
	const selection = { kind: 'session' as const, active: { session, threadId: 'A' } };
	const model = resources.add(kind === 'Code' ? new ChatWidgetModel(chat, selection, sessions, prompts, models, execution, resources.add(new TestConfigurationService())) : new CoworkWidgetModel(chat, selection, sessions, prompts, models, preferences, execution, resources.add(new TestConfigurationService())));
	return { resources, model, chat, models, prompts, executionSettings: execution, threadApi, turnApi, modelApi, execution, starts, queues, steers, consults, compacts, updates, transcripts, offers, session, reconnect: () => { generation++; connection.fire('ready'); } };
}

async function turnTask(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }
async function waitFor(condition: () => boolean): Promise<void> { for (let i = 0; i < 200 && !condition(); i++) await turnTask(); assert.ok(condition(), 'expected deferred operation reached'); }
function approval(requestId: string): AgentInteractionOffer { return { connectionGeneration: 1, sessionId: 'session', threadId: 'A', turnId: 'turn-A', interaction: { requestId, request: { type: 'approval', request: { reason: requestId, capabilities: [{ kind: 'fileWrite', scope: '/owned/file' }] } } } }; }

for (const kind of ['Code', 'Cowork'] as const) {
	for (const aba of [false, true]) {
		test(`${kind} advisor lifetime cancels a delayed question on ${aba ? 'A-B-A' : 'A-B'}`, async () => {
			const f = fixture(kind); using resources = f.resources; await f.model.initialize();
			const pending = new DeferredPromise<AdvisorConfig | null>(); const started = new DeferredPromise<void>();
			f.modelApi.readAdvisorDefault = () => { void started.complete(); return pending.p; };
			const result = f.model.executeServerCommand('advisor', 'Private A question').then(() => undefined, error => error);
			await started.p; await f.model.selectThread({ session: f.session, threadId: 'B' }); if (aba) await f.model.selectThread({ session: f.session, threadId: 'A' });
			const state = f.model.state; const error = f.model.error;
			await pending.complete({ model: { provider: 'provider', model: 'advisor' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 });
			assert.ok(isCancellationError(await result)); assert.equal(f.consults.length, 0); assert.equal(f.model.state, state); assert.equal(f.model.error, error);
		});
		test(`${kind} compact lifetime cancels a delayed subscription on ${aba ? 'A-B-A' : 'A-B'}`, async () => {
			const pending = new DeferredPromise<ThreadSubscription>(); let first = true;
			const f = fixture(kind, async threadId => { if (first) { first = false; return pending.p; } return { ...snapshot(threadId), updates: [] }; }); using resources = f.resources;
			const result = f.model.executeServerCommand('compact', '').then(() => undefined, error => error);
			await f.model.selectThread({ session: f.session, threadId: 'B' }); if (aba) await f.model.selectThread({ session: f.session, threadId: 'A' });
			const state = f.model.state; const error = f.model.error;
			await pending.complete({ ...snapshot('A'), updates: [] });
			assert.ok(isCancellationError(await result)); assert.equal(f.compacts.length, 0); assert.equal(f.model.state, state); assert.equal(f.model.error, error);
		});
	}
	test(`${kind} captured submission rejects cancellation and preserves its supplied identity`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		const signal = new AbortController(); signal.abort();
		await assert.rejects(Reflect.apply(f.model.send, f.model, ['Retired speech', 'agent', undefined, undefined, { commandId: 'voice-task', source: { sessionId: 'session', threadId: 'A' }, signal: signal.signal }]), isCancellationError);
		assert.equal(f.starts.length, 0);
		await Reflect.apply(f.model.send, f.model, ['Owned speech', 'agent', undefined, undefined, { commandId: 'voice-task', source: { sessionId: 'session', threadId: 'A' } }]);
		assert.equal(f.starts.length, 1); assert.equal(f.starts[0]!.commandId, 'voice-task'); assert.equal('source' in f.starts[0]!, false); assert.equal('signal' in f.starts[0]!, false);
	});
	for (const failed of [false, true]) {
		test(`${kind} snapshot lifetime ignores an earlier ${failed ? 'error' : 'snapshot'} after a newer read`, async () => {
			const f = fixture(kind); using resources = f.resources; await f.model.initialize();
			const reads: DeferredPromise<ThreadRead>[] = []; f.threadApi.read = () => { const read = new DeferredPromise<ThreadRead>(); reads.push(read); return read.p; };
			const emit = (sequence: number) => f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
			emit(2); await waitFor(() => reads.length === 1); emit(3); await waitFor(() => reads.length === 2);
			await reads[1]!.complete(snapshot('A', 3)); await waitFor(() => f.model.thread?.sequence === 3);
			if (failed) await reads[0]!.error(new Error('Old snapshot failure')); else await reads[0]!.complete(snapshot('A', 2));
			await turnTask(); assert.equal(f.model.thread?.sequence, 3); assert.equal(f.model.thread?.title, 'Sequence 3'); assert.equal(f.model.error, undefined); assert.equal(f.model.state, 'ready');
		});
	}
	test(`${kind} owner offer received before subscribe survives hydration and retires on reconnect`, async () => {
		const pending = new DeferredPromise<ThreadSubscription>(); const f = fixture(kind, () => pending.p, true); using resources = f.resources;
		f.offers.fire(approval('owned')); assert.equal(f.model.interaction, undefined);
		await pending.complete({ ...snapshot('A', 1, true), updates: [] }); await f.model.initialize(); assert.equal(f.model.inputState.interaction?.requestId, 'owned');
		f.reconnect(); await turnTask(); assert.equal(f.model.interaction, undefined);
	});
	for (const failed of [false, true]) {
		test(`${kind} old approval ${failed ? 'error' : 'completion'} cannot erase the next A-B-A offer`, async () => {
			const f = fixture(kind, undefined, true); using resources = f.resources; await f.model.initialize();
			const pending = new DeferredPromise<{ sequence: number; }>(); f.turnApi.resolveInteraction = () => pending.p;
			f.offers.fire(approval('old')); const result = f.model.resolveInteraction({ type: 'approval', response: { decision: 'decline' } }).then(() => undefined, error => error);
			await f.model.selectThread({ session: f.session, threadId: 'B' }); await f.model.selectThread({ session: f.session, threadId: 'A' }); f.offers.fire(approval('new')); const phase = f.model.state;
			if (failed) await pending.error(new Error('Old response failed')); else await pending.complete({ sequence: 2 }); await result;
			assert.equal(f.model.interaction?.requestId, 'new'); assert.equal(f.model.inputState.interaction?.requestId, 'new'); assert.equal(f.model.state, phase); assert.equal(f.model.error, undefined);
		});
	}
	test(`${kind} voice transcript survives live updates and reconnect snapshots`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		const speech = { itemId: 'speech', voiceSessionId: 'voice', mediaEpoch: 1, speaker: 'user' as const, text: 'Spoken task', startMs: 0, endMs: 100, afterItemId: null };
		f.transcripts.fire({ sessionId: 'session', threadId: 'A', durableSequence: 1, revision: 2, changes: [{ type: 'upsert', entry: { type: 'voiceTranscript', entryId: 'voice:speech', transcript: speech } }] });
		assert.deepEqual(f.model.items.map(item => [item.id, item.type, item.text]), [['voice:speech', 'voiceTranscript', 'Spoken task']]);
		f.threadApi.subscribe = async () => { const value = snapshot('A', 3); return { ...value, transcript: { ...value.transcript, entries: [{ type: 'voiceTranscript', entryId: 'voice:speech', transcript: { ...speech, text: 'Restored task' } }] }, updates: [] }; };
		f.reconnect(); await waitFor(() => f.model.items[0]?.text === 'Restored task'); assert.equal(f.model.items[0]?.type, 'voiceTranscript');
	});
}

test('queued submission cannot dispatch after cancellation during its permission read', async () => {
	const f = fixture('Code'); using resources = f.resources; await f.model.initialize();
	const pending = new DeferredPromise<Awaited<ReturnType<IAgentExecutionSettingsService['read']>>>(); f.execution.read = () => pending.p;
	const signal = new AbortController(); const submitting = f.chat.queueTurn({ sessionId: 'session', threadId: 'A', expectedSequence: 1, text: 'Old queue', mode: 'agent', signal: signal.signal });
	const rejected = assert.rejects(submitting, isCancellationError); signal.abort(); await pending.complete({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }); await rejected; assert.equal(f.queues.length, 0);
});

test('queue and steering preserve the source-owned idempotency key', async () => {
	const f = fixture('Code'); using resources = f.resources; await f.model.initialize();
	await f.chat.queueTurn({ sessionId: 'session', threadId: 'A', expectedSequence: 1, text: 'Queue', mode: 'agent', approvalMode: 'manual', commandId: 'owned-queue' });
	await f.chat.steerTurn({ sessionId: 'session', threadId: 'A', expectedSequence: 1, turnId: 'turn-A', text: 'Steer', commandId: 'owned-steer' });
	assert.equal(f.queues[0]!.commandId, 'owned-queue'); assert.equal(f.steers[0]!.commandId, 'owned-steer');
});

for (const kind of ['Code', 'Cowork'] as const) {
	for (const failed of [false, true]) {
		test(`${kind} interrupt ${failed ? 'error' : 'completion'} cannot rewrite a new A-B-A operation`, async () => {
			const f = fixture(kind, undefined, true); using resources = f.resources; await f.model.initialize();
			const pending = new DeferredPromise<{ sequence: number; }>();
			const targets: Parameters<IAgentTurnService['interrupt']>[0][] = [];
			f.turnApi.interrupt = input => { targets.push(input); return pending.p; };
			const interrupting = f.model.interrupt();
			await f.model.selectThread({ session: f.session, threadId: 'B' }); await f.model.selectThread({ session: f.session, threadId: 'A' });
			f.offers.fire(approval('next-operation')); const state = f.model.state;
			if (failed) await pending.error(new Error('Retired interrupt failed')); else await pending.complete({ sequence: 2 });
			await interrupting; assert.equal(targets.length, 1); assert.equal(targets[0]!.threadId, 'A'); assert.equal(targets[0]!.turnId, 'turn-A');
			assert.equal(f.model.interaction?.requestId, 'next-operation'); assert.equal(f.model.state, state); assert.equal(f.model.error, undefined);
		});
		test(`${kind} approval ${failed ? 'error' : 'completion'} retains a replacement request in the same Thread`, async () => {
			const f = fixture(kind, undefined, true); using resources = f.resources; await f.model.initialize();
			const pending = new DeferredPromise<{ sequence: number; }>(); f.turnApi.resolveInteraction = () => pending.p;
			f.offers.fire(approval('first')); const resolving = f.model.resolveInteraction({ type: 'approval', response: { decision: 'approveOnce' } }).then(() => undefined, error => error);
			f.offers.fire(approval('replacement')); const state = f.model.state;
			if (failed) await pending.error(new Error('First request failed')); else await pending.complete({ sequence: 2 }); await resolving;
			assert.equal(f.model.interaction?.requestId, 'replacement'); assert.equal(f.model.state, state); assert.equal(f.model.error, undefined);
		});
	}
	test(`${kind} snapshot ordering accepts a genuinely newer sequence from an earlier issued read`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		const reads: DeferredPromise<ThreadRead>[] = []; f.threadApi.read = () => { const read = new DeferredPromise<ThreadRead>(); reads.push(read); return read.p; };
		const emit = (sequence: number) => f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
		emit(2); await waitFor(() => reads.length === 1); emit(3); await waitFor(() => reads.length === 2);
		await reads[1]!.complete(snapshot('A', 3)); await waitFor(() => f.model.thread?.sequence === 3);
		await reads[0]!.complete(snapshot('A', 4)); await waitFor(() => f.model.thread?.sequence === 4);
		assert.equal(f.model.thread?.title, 'Sequence 4'); assert.equal(f.model.error, undefined);
	});
	test(`${kind} submission cannot borrow a different Thread source identity`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		await assert.rejects(Reflect.apply(f.model.send, f.model, ['A request', 'agent', undefined, undefined, { source: { sessionId: 'session', threadId: 'B' }, commandId: 'foreign-source' }]), isCancellationError);
		assert.equal(f.starts.length, 0); assert.equal(f.model.threadId, 'A'); assert.equal(f.model.state, 'ready'); assert.equal(f.model.error, undefined);
	});
}

for (const kind of ['Code', 'Cowork'] as const) {
	for (const newer of [false, true]) {
		test(`${kind} cancelled send ${newer ? 'retains the newer operation' : 'leaves the same composer usable'}`, async () => {
			const f = fixture(kind); using resources = f.resources; await f.model.initialize();
			const pending: DeferredPromise<{ turnId: string; sequence: number; }>[] = [];
			f.turnApi.start = () => { const request = new DeferredPromise<{ turnId: string; sequence: number; }>(); pending.push(request); return request.p; };
			const controller = new AbortController();
			const sending = Reflect.apply(f.model.send, f.model, ['Cancelled request', 'agent', undefined, undefined, { signal: controller.signal }]).then(() => undefined, (error: unknown) => error);
			await waitFor(() => pending.length === 1); controller.abort();
			const next = newer ? f.model.send('New request') : undefined;
			if (newer) await waitFor(() => pending.length === 2);
			await pending[0]!.error(canceled()); assert.ok(isCancellationError(await sending));
			assert.equal(f.model.state, newer ? 'submitting' : 'ready'); assert.equal(f.model.error, undefined);
			if (newer) { await pending[1]!.complete({ turnId: 'next', sequence: 2 }); await next; assert.equal(f.model.state, 'ready'); }
		});
	}
}

for (const kind of ['Code', 'Cowork'] as const) {
	for (const operation of ['interrupt', 'approval'] as const) {
		test(`${kind} ${operation} cannot dispatch after a submitting-state listener navigates away`, async () => {
			const f = fixture(kind, undefined, true); using resources = f.resources; await f.model.initialize();
			let calls = 0; let changed = false; let navigation: Promise<void> | undefined;
			f.turnApi.interrupt = async () => { calls++; return { sequence: 2 }; };
			f.turnApi.resolveInteraction = async () => { calls++; return { sequence: 2 }; };
			f.offers.fire(approval('owned'));
			using listener = f.model.onDidChange(() => { if (!changed && f.model.state === 'submitting') { changed = true; navigation = f.model.selectThread({ session: f.session, threadId: 'B' }); } });
			if (operation === 'interrupt') await f.model.interrupt();
			else await f.model.resolveInteraction({ type: 'approval', response: { decision: 'decline' } }).catch(() => { });
			await navigation;
			assert.equal(calls, 0); assert.equal(f.model.threadId, 'B'); assert.equal(f.model.state, 'ready'); assert.equal(f.model.error, undefined);
		});
	}
	test(`${kind} a latest refresh failure remains visible after an acknowledged submission`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		f.threadApi.read = async () => { throw new Error('Latest read failed'); };
		await f.model.send('Acknowledged input');
		assert.equal(f.starts.length, 1); assert.equal(f.model.state, 'error'); assert.equal(f.model.error, kind === 'Code' ? 'Could not refresh this chat: Error: Latest read failed' : 'Latest read failed');
	});
}

test('voice source preparation waits for a pending model choice before materializing its untitled composer', async () => {
	const f = fixture('Code'); using resources = f.resources; await f.model.initialize();
	const selected = { provider: 'provider', model: 'chosen' };
	const saved = new DeferredPromise<void>();
	f.models.listModels = async () => [{ model: selected, displayName: 'Chosen model', longContext: false }];
	f.models.rememberSelectedModel = () => saved.p;
	let draft = { untitledSessionId: 'voice-draft', title: 'New Chat', model: undefined as typeof selected | undefined, modelSelectionKind: 'manual' as const, agent: undefined, workspace: { type: 'current' as const } };
	const materializedModels: (typeof selected | undefined)[] = [];
	const sessionService = {
		get untitledSessions() { return [draft]; }, get activeUntitledSession() { return draft; },
		setUntitledSessionModel: (_id: string, model: typeof selected) => { draft = { ...draft, model }; },
		materializeUntitledSession: async () => { materializedModels.push(draft.model); return { session: { ...f.session, model: draft.model }, threadId: 'A' }; },
		promoteUntitledSession: () => { },
	} as unknown as ISessionsManagementService;
	using model = new ChatWidgetModel(f.chat, { kind: 'untitled', session: draft }, sessionService, f.prompts, f.models, f.executionSettings, resources.add(new TestConfigurationService()));
	await model.initialize();
	const selecting = model.selectModel(selected);
	const preparing = model.prepareConversation();
	await turnTask(); assert.deepEqual(materializedModels, []);
	await saved.complete(); await selecting;
	assert.deepEqual(await preparing, { sessionId: 'session', threadId: 'A' });
	assert.deepEqual(materializedModels, [selected]); assert.deepEqual(model.selectedModel, selected);
});

for (const kind of ['Code', 'Cowork'] as const) {
	for (const failed of [false, true]) {
		test(`${kind} late subscribe ${failed ? 'error' : 'snapshot'} cannot roll back a newer read or hide its owner offer`, async () => {
			const pending = new DeferredPromise<ThreadSubscription>(); const f = fixture(kind, () => pending.p, true); using resources = f.resources;
			const newer = snapshot('A', 3, true);
			const current: ThreadRead = { ...newer, thread: { ...newer.thread, turns: newer.thread.turns.map(turn => ({ ...turn, turnId: 'next-turn' })) } };
			f.threadApi.read = async () => current;
			const offer = { ...approval('new-request'), turnId: 'next-turn' }; f.offers.fire(offer);
			f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: 3, update: { type: 'committed', event: { type: 'interactionRequested', interaction: offer.interaction } } });
			await waitFor(() => f.model.thread?.sequence === 3);
			assert.equal(f.model.inputState.interaction?.requestId, 'new-request');
			if (failed) await pending.error(new Error('Late initial subscribe failed')); else await pending.complete({ ...snapshot('A', 1, true), updates: [] });
			await f.model.initialize();
			assert.equal(f.model.thread?.sequence, 3); assert.equal(f.model.thread?.turns.at(-1)?.turnId, 'next-turn');
			assert.equal(f.model.inputState.interaction?.requestId, 'new-request'); assert.equal(f.model.state, 'ready'); assert.equal(f.model.error, undefined);
		});
	}
}

for (const kind of ['Code', 'Cowork'] as const) {
	for (const argument of ['Private question', 'off']) {
		test(`${kind} captured server command lifetime blocks ${argument === 'off' ? 'default mutation' : 'consultation'} after input cancellation`, async () => {
			const f = fixture(kind); using resources = f.resources; await f.model.initialize();
			const answer = new DeferredPromise<AdvisorConfig | null>(); const started = new DeferredPromise<void>(); let mutations = 0;
			f.modelApi.readAdvisorDefault = () => { void started.complete(); return answer.p; };
			f.modelApi.setAdvisorDefault = async () => { mutations++; };
			const signal = new AbortController();
			const command = Reflect.apply(f.model.executeServerCommand, f.model, ['advisor', argument, signal.signal]).then(() => undefined, (error: unknown) => error);
			await started.p; signal.abort();
			await answer.complete({ model: { provider: 'provider', model: 'advisor' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 });
			assert.ok(isCancellationError(await command)); assert.equal(f.consults.length, 0); assert.equal(mutations, 0);
			assert.equal(f.model.threadId, 'A'); assert.equal(f.model.state, 'ready'); assert.equal(f.model.error, undefined);
		});
	}
}
