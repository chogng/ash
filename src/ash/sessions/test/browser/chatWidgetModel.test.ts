import { observableValue } from '../../../base/common/observable.js';
import { TestConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../base/common/errors.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ChatWidgetModel } from '../../browser/chatWidgetModel.js';
import { CoworkWidgetModel } from '../../contrib/cowork/browser/coworkWidgetModel.js';
import { SessionsChatService } from '../../browser/agentHost/sessionsChatService.js';
import type { ISessionProviderScope, ISessionProviderScopeService } from '../../browser/agentHost/sessionProviderScopeService.js';
import { ChatService } from '../../../workbench/services/chat/browser/chatService.js';
import { createDisconnectedAgentThreadService } from '../../../platform/agentHost/browser/appServerAgentService.js';
import type { IAgentTurnService } from '../../../platform/agentHost/common/agentService.js';
import type { AgentInteractionOffer, ThreadRead, ThreadSubscription, ThreadUpdateEnvelope, ThreadTranscriptUpdateEnvelope, SessionOperationInput } from '../../../platform/agentHost/common/agent.js';
import type { AdvisorConfig, IAgentModelsService } from '../../../platform/agentHost/common/agentModels.js';
import type { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { IAppServerApi, IServerEventApi, AppServerConnectionState } from '../../../platform/agentHost/common/appServerApi.js';
import type { ITurnChangesApi } from '../../../platform/turnChanges/common/turnChangesApi.js';
import type { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import type { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import type { ILanguageModelsConfigurationService } from '../../contrib/cowork/common/languageModelsConfiguration.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../services/sessions/common/session.js';
import { resolveChatContextAttachment, type ChatContextAttachment } from '../../../workbench/services/chat/common/chatContextService.js';
import { resetNlsResolver, setNlsMessages } from '../../../nls.js';

function snapshot(threadId: string, sequence = 1, waiting = false): ThreadRead {
	const usage = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
	return { thread: { advisor: { type: 'default' }, agentId: 'agent', origin: { type: 'root' }, sessionId: 'session', threadId, title: `Sequence ${sequence}`, status: 'active', sequence, usage, turns: waiting ? [{ turnId: `turn-${threadId}`, status: 'waitingForApproval', mode: 'agent', kind: 'coding', approvalMode: 'manual', usage, items: [] }] : [] }, transcript: { sessionId: 'session', threadId, durableSequence: sequence, revision: sequence, entries: [] } };
}

function messageHistory(threadId: string, sequence: number, text: string): ThreadRead {
	const value = snapshot(threadId, sequence, true);
	const item = { type: 'agentMessage' as const, itemId: 'shared-id', turnId: 'shared-turn', text };
	return {
		thread: { ...value.thread, turns: [{ ...value.thread.turns[0], turnId: item.turnId, status: 'completed', items: [item] }] },
		transcript: { ...value.transcript, entries: [{ type: 'item', entryId: 'item:shared-id', turnId: item.turnId, item: { ...item }, transient: false }] },
	};
}

function fixture(kind: 'Code' | 'Cowork', subscribe?: (threadId: string) => Promise<ThreadSubscription>, waiting = false, routed = false) {
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
	const changeApi = { list: async () => ({ changeSets: [] }), summary: async () => ({ sequence: 1, revision: 'initial', statistics: { files: 0, additions: 0, deletions: 0 }, repositories: [], warnings: [] }) } as unknown as ITurnChangesApi;
	const events = { subscribe: () => ({ dispose() { } }) } as IServerEventApi;
	const chat = resources.add(new ChatService(modelApi, threadApi, turnApi, changeApi, appServer, events, execution, resources.add(new TestConfigurationService())));
	const scope = { services: { chat }, identity: (value: string) => value, backendIdentity: (value: string) => value, assertCurrent() { } } as unknown as ISessionProviderScope;
	const routedChat = routed ? resources.add(new SessionsChatService({ onDidChangeScopes: Event.None, getScopes: () => [scope], getScope: () => scope } as unknown as ISessionProviderScopeService)) : chat;
	const prompts = { onDidChangeSkills: Event.None, findAgentSkills: async () => [] } as unknown as IPromptsService;
	const models = { onDidChangeModels: Event.None, listModels: async () => [], readModelDefaults: async () => ({ revision: 1, model: null, reasoningEffort: null }) } as unknown as ILanguageModelsService;
	const preferences = { onDidChangeModels: Event.None } as ILanguageModelsConfigurationService;
	const session: ISession = { sessionId: 'session', title: 'Session', status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'A', origin: { type: 'root' }, status: 'active' }, { threadId: 'B', origin: { type: 'fork', parentThreadId: 'A', parentSequence: 1 }, status: 'active' }] };
	const sessions = {} as ISessionsManagementService;
	const selection = { kind: 'session' as const, active: { session, threadId: 'A' } };
	const model = resources.add(kind === 'Code' ? new ChatWidgetModel(routedChat, selection, sessions, prompts, models, execution, resources.add(new TestConfigurationService())) : new CoworkWidgetModel(routedChat, selection, sessions, prompts, models, preferences, execution, resources.add(new TestConfigurationService())));
	return { resources, model, chat, routedChat, models, prompts, executionSettings: execution, threadApi, turnApi, modelApi, execution, starts, queues, steers, consults, compacts, updates, transcripts, offers, session, reconnect: () => { generation++; connection.fire('ready'); } };
}

async function turnTask(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }
async function waitFor(condition: () => boolean): Promise<void> { for (let i = 0; i < 200 && !condition(); i++) await turnTask(); assert.ok(condition(), 'expected deferred operation reached'); }
function approval(requestId: string): AgentInteractionOffer { return { connectionGeneration: 1, sessionId: 'session', threadId: 'A', turnId: 'turn-A', interaction: { requestId, request: { type: 'approval', request: { reason: requestId, capabilities: [{ kind: 'fileWrite', scope: '/owned/file' }] } } } }; }

for (const kind of ['Code', 'Cowork'] as const) {
	for (const route of ['start', 'queue', 'steer'] as const) {
		test(`${kind} ${route} interleaves text and typed snapshots in composer order`, async () => {
			const f = fixture(kind, undefined, route !== 'start');
			using resources = f.resources;
			await f.model.initialize();
			const text = ' \nBefore🙂 log.txt\nBetween image.png\nAfter log.txt\nDone  \n';
			const first = text.indexOf('log.txt');
			const image = text.indexOf('image.png');
			const last = text.lastIndexOf('log.txt');
			const contexts = [
				{ name: 'log.txt', content: 'Second captured version', reference: { start: last, end: last + 7 } },
				{ name: 'image.png', content: 'data:image/png;base64,captured', kind: 'image' as const, reference: { start: image, end: image + 9 } },
				{ name: 'log.txt', content: 'First captured version', reference: { start: first, end: first + 7 } },
			];
			await f.model.send(text, route === 'queue' ? 'plan' : 'agent', undefined, contexts);
			const requests = route === 'start' ? f.starts : route === 'queue' ? f.queues : f.steers;
			assert.equal(requests.length, 1);
			assert.deepEqual(requests[0].input, [
				{ type: 'text', text: ' \nBefore🙂 ' },
				{ type: 'context', name: 'log.txt', content: 'First captured version' },
				{ type: 'text', text: '\nBetween ' },
				{ type: 'image', url: 'data:image/png;base64,captured' },
				{ type: 'text', text: '\nAfter ' },
				{ type: 'context', name: 'log.txt', content: 'Second captured version' },
				{ type: 'text', text: '\nDone  \n' },
			]);
		});
	}
}

test('resolved attachments carry positions without mutating shared snapshots or following completion order', async () => {
	const first = new DeferredPromise<{ name: string; content: string; }>();
	const second = new DeferredPromise<{ name: string; content: string; }>();
	const attachments: ChatContextAttachment[] = [
		{ id: 'first', kind: 'file', name: 'same.txt', reference: { start: 0, end: 8 }, resolve: () => first.p },
		{ id: 'second', kind: 'file', name: 'same.txt', reference: { start: 9, end: 17 }, resolve: () => second.p },
	];
	const resolving = Promise.all(attachments.map(resolveChatContextAttachment));
	await second.complete({ name: 'same.txt', content: 'Second' });
	const snapshot = Object.freeze({ name: 'same.txt', content: 'First' });
	await first.complete(snapshot);
	assert.deepEqual(await resolving, [
		{ ...snapshot, reference: attachments[0].reference },
		{ name: 'same.txt', content: 'Second', reference: attachments[1].reference },
	]);
	assert.equal('reference' in snapshot, false);
});

test('legacy contexts retain prefix placement and adjacent inline attachments omit empty text items', async () => {
	const f = fixture('Code');
	using resources = f.resources;
	await f.chat.startTurn({
		sessionId: 'session', threadId: 'A', expectedSequence: 1, mode: 'agent', text: 'a b ', contexts: [
			{ name: 'b', content: 'B', reference: { start: 2, end: 3 } },
			{ name: 'legacy', content: 'Without a position' },
			{ name: 'a', content: 'A', reference: { start: 0, end: 1 } },
		]
	});
	assert.deepEqual(f.starts[0].input, [
		{ type: 'context', name: 'legacy', content: 'Without a position' },
		{ type: 'context', name: 'a', content: 'A' },
		{ type: 'context', name: 'b', content: 'B' },
	]);
});

test('invalid attachment spans fail before start queue or steering can dispatch', async () => {
	const f = fixture('Code');
	using resources = f.resources;
	for (const reference of [{ start: -1, end: 2 }, { start: 0.5, end: 2 }, { start: 0, end: 4 }, { start: 1, end: 1 }, { start: NaN, end: 2 }]) {
		const options = { sessionId: 'session', threadId: 'A', expectedSequence: 1, mode: 'agent' as const, approvalMode: 'manual' as const, text: 'abc', contexts: [{ name: 'bad', content: 'Captured', reference }] };
		await assert.rejects(f.chat.startTurn(options), /attachment position/);
		await assert.rejects(f.chat.queueTurn(options), /attachment position/);
		await assert.rejects(f.chat.steerTurn({ ...options, turnId: 'turn-A' }), /attachment position/);
	}
	await assert.rejects(f.chat.startTurn({
		sessionId: 'session', threadId: 'A', expectedSequence: 1, mode: 'agent', text: 'abc', contexts: [
			{ name: 'a', content: 'A', reference: { start: 0, end: 2 } },
			{ name: 'b', content: 'B', reference: { start: 1, end: 3 } },
		]
	}), /attachment position/);
	assert.deepEqual([f.starts, f.queues, f.steers], [[], [], []]);
});

test('invalid attachment positions explain recovery in Chinese', async () => {
	const f = fixture('Code');
	using resources = f.resources;
	const messages = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8'));
	setNlsMessages('zh-CN', messages);
	try {
		await assert.rejects(f.chat.startTurn({
			sessionId: 'session', threadId: 'A', expectedSequence: 1, mode: 'agent', text: 'abc', contexts: [
				{ name: 'bad', content: 'Captured', reference: { start: 0, end: 4 } },
			]
		}), { message: '附件位置已与这条消息不匹配。请移除附件后重新添加。' });
	} finally {
		resetNlsResolver();
	}
});

test('Code transcript updates preserve live body revisions across stale reads and same-ID navigation', async () => {
	const original = messageHistory('A', 1, 'Committed body');
	const f = fixture('Code', async threadId => ({ ...(threadId === 'A' ? original : messageHistory(threadId, 1, 'Other thread body')), updates: [] }));
	using resources = f.resources;
	await f.model.initialize();
	const oldRead = new DeferredPromise<ThreadRead>();
	let readStarted = false;
	f.threadApi.read = async () => { readStarted = true; return oldRead.p; };
	f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: 2, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'shared-turn' } } });
	await waitFor(() => readStarted);
	const live = { type: 'item' as const, entryId: 'item:shared-id', turnId: 'shared-turn', item: { type: 'agentMessage' as const, itemId: 'shared-id', turnId: 'shared-turn', text: 'Live body with appended output' }, transient: true };
	f.transcripts.fire({ sessionId: 'session', threadId: 'A', durableSequence: 2, revision: 2, changes: [{ type: 'upsert', entry: live }] });
	const stale = messageHistory('A', 2, 'Older read body');
	await oldRead.complete({ ...stale, transcript: { ...stale.transcript, revision: 1 } });
	await waitFor(() => f.model.thread?.sequence === 2);
	assert.equal(f.model.items[0].text, live.item.text);
	assert.equal(original.thread.turns[0].items[0].type === 'agentMessage' && original.thread.turns[0].items[0].text, 'Committed body');
	await f.model.selectThread({ session: f.session, threadId: 'B' });
	assert.equal(f.model.items[0].text, 'Other thread body');
	f.transcripts.fire({ sessionId: 'session', threadId: 'A', durableSequence: 3, revision: 3, changes: [{ type: 'upsert', entry: { ...live, item: { ...live.item, text: 'Late body for retired A' } } }] });
	assert.equal(f.model.items[0].text, 'Other thread body');
	await f.model.selectThread({ session: f.session, threadId: 'A' });
	assert.equal(f.model.items[0].text, 'Committed body');
});

for (const kind of ['Code', 'Cowork'] as const) test(`${kind} model releases both body projections and ignores a snapshot completing after disposal`, async () => {
	const f = fixture(kind, async () => ({ ...messageHistory('A', 1, 'Retained body'.repeat(1024)), updates: [] }));
	using resources = f.resources;
	await f.model.initialize();
	assert.equal(f.model.items.length, 1);
	const pending = new DeferredPromise<ThreadRead>();
	let reads = 0;
	f.threadApi.read = async () => { reads++; return pending.p; };
	let unsubscribed = 0;
	f.threadApi.unsubscribe = async () => { unsubscribed++; };
	f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: 2, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'shared-turn' } } });
	await waitFor(() => reads === 1);
	f.transcripts.fire({ sessionId: 'session', threadId: 'A', durableSequence: 2, revision: 4, changes: [] });
	await turnTask();
	f.model.dispose();
	assert.equal(f.model.thread, undefined);
	assert.deepEqual(f.model.items, []);
	if (f.model instanceof ChatWidgetModel) assert.equal(f.model.olderHistory, undefined);
	await pending.complete(messageHistory('A', 2, 'Late replacement body'));
	await waitFor(() => unsubscribed === 1);
	await turnTask();
	assert.equal(reads, 1);
	assert.equal(f.model.thread, undefined);
	assert.deepEqual(f.model.items, []);
});

test('Code a repeatedly stale bounded snapshot stops at the replacement read and exposes an explicit retry', async () => {
	const f = fixture('Code');
	using resources = f.resources;
	await f.model.initialize();
	assert.ok(f.model instanceof ChatWidgetModel);
	const model = f.model;
	const pending = new DeferredPromise<ThreadRead>();
	const unexpected = new DeferredPromise<ThreadRead>();
	const stale = { ...snapshot('A', 2), history: { hasOlderTurns: false } };
	let reads = 0;
	f.threadApi.read = () => {
		reads++;
		if (reads === 1) return pending.p;
		if (reads === 2) return Promise.resolve(stale);
		// Bound the failing behavior too: an automatic third read must fail
		// the count assertion instead of starving the test runner's event loop.
		return unexpected.p;
	};
	const notify = (sequence: number) => f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
	notify(2);
	await waitFor(() => reads === 1);
	notify(3);
	await turnTask();
	await pending.complete(stale);
	await waitFor(() => model.historyStatus !== undefined || reads > 2);
	assert.equal(reads, 2);
	assert.equal(model.historyStatus?.kind, 'live');
	assert.equal(model.state, 'error');
	assert.equal(model.thread?.sequence, 1);
	await turnTask();
	assert.equal(reads, 2);
	f.threadApi.read = async () => {
		reads++;
		return { ...snapshot('A', 3), history: { hasOlderTurns: false } };
	};
	await model.historyStatus!.action.run();
	assert.equal(reads, 3);
	assert.equal(model.historyStatus, undefined);
	assert.equal(model.thread?.sequence, 3);
	assert.equal(model.state, 'ready');
	assert.equal(f.starts.length, 0);
});

for (const kind of ['Code', 'Cowork'] as const) {
	test(`${kind} a queued notification cannot refresh another selection or suppress its new generation`, async () => {
		const f = fixture(kind);
		using resources = f.resources;
		await f.model.initialize();
		const reads: string[] = [];
		f.threadApi.read = async ({ threadId }) => {
			reads.push(threadId);
			return snapshot(threadId, 2);
		};
		const notify = (threadId: string) => f.updates.fire({ sessionId: 'session', threadId, durableSequence: 2, update: { type: 'committed', event: { type: 'turnCompleted', turnId: `turn-${threadId}` } } });
		notify('A');
		await f.model.selectThread({ session: f.session, threadId: 'B' });
		await turnTask();
		assert.deepEqual(reads, []);
		notify('B');
		const selecting = f.model.selectThread({ session: f.session, threadId: 'A' });
		notify('A');
		await selecting;
		await waitFor(() => f.model.thread?.sequence === 2);
		assert.deepEqual(reads, ['A']);
		assert.equal(f.model.threadId, 'A');
		assert.equal(f.model.error, undefined);
	});

	test(`${kind} Thread and transcript notification bursts share one read and one replacement`, async () => {
		const f = fixture(kind);
		using resources = f.resources;
		await f.model.initialize();
		const reads: DeferredPromise<ThreadRead>[] = [];
		f.threadApi.read = () => {
			const read = new DeferredPromise<ThreadRead>();
			reads.push(read);
			return read.p;
		};
		for (let sequence = 2; sequence <= 151; sequence++) {
			f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
			f.transcripts.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, revision: sequence + 2, changes: [] });
			// Separate scheduling turns reproduce a burst that microtask-only
			// coalescing cannot contain while the backend read is still pending.
			if (sequence % 10 === 0) await turnTask();
		}
		await turnTask();
		assert.equal(reads.length, 1);
		await reads[0]!.complete(snapshot('A', 2));
		await waitFor(() => reads.length === 2);
		await reads[1]!.complete(snapshot('A', 151));
		await waitFor(() => f.model.thread?.sequence === 151);
		await turnTask();
		assert.equal(reads.length, 2);
		assert.equal(f.model.error, undefined);
	});

	for (const failed of [false, true]) {
		test(`${kind} a queued post-write refresh ${failed ? 'reports its own error without retrying the write' : 'waits for a fresh snapshot without repeating the write'}`, async () => {
			const f = fixture(kind);
			using resources = f.resources;
			await f.model.initialize();
			const reads: DeferredPromise<ThreadRead>[] = [];
			f.threadApi.read = () => {
				const read = new DeferredPromise<ThreadRead>();
				reads.push(read);
				return read.p;
			};
			f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: 2, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
			await waitFor(() => reads.length === 1);
			let submitted = false;
			const submitting = f.model.send('Write once').then(() => { submitted = true; });
			await waitFor(() => f.starts.length === 1);
			await turnTask();
			assert.equal(reads.length, 1);
			assert.equal(submitted, false);
			await reads[0]!.error(new Error('Obsolete read failed'));
			await waitFor(() => reads.length === 2);
			assert.equal(f.model.error, undefined);
			if (failed) await reads[1]!.error(new Error('Post-write read failed'));
			else await reads[1]!.complete(snapshot('A', 3));
			await submitting;
			await turnTask();
			assert.equal(f.starts.length, 1);
			assert.equal(reads.length, 2);
			assert.equal(f.model.state, failed ? 'error' : 'ready');
			if (failed) assert.match(f.model.error ?? '', /Post-write read failed/);
			else assert.equal(f.model.thread?.sequence, 3);
		});
	}

	for (const failed of [false, true]) {
		test(`${kind} an invalidated read from an earlier A-B-A generation cannot drain or replace the current refresh after ${failed ? 'failure' : 'completion'}`, async () => {
			const f = fixture(kind);
			using resources = f.resources;
			await f.model.initialize();
			const reads: DeferredPromise<ThreadRead>[] = [];
			f.threadApi.read = () => {
				const read = new DeferredPromise<ThreadRead>();
				reads.push(read);
				return read.p;
			};
			const notify = (sequence: number) => f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
			notify(2);
			await waitFor(() => reads.length === 1);
			notify(3);
			await turnTask();
			assert.equal(reads.length, 1);
			await f.model.selectThread({ session: f.session, threadId: 'B' });
			await f.model.selectThread({ session: f.session, threadId: 'A' });
			notify(2);
			await waitFor(() => reads.length === 2);
			if (failed) await reads[0]!.error(new Error('Retired A failure'));
			else await reads[0]!.complete(messageHistory('A', 99, 'Retired A body'));
			await turnTask();
			assert.equal(reads.length, 2);
			assert.equal(f.model.thread?.sequence, 1);
			assert.equal(f.model.error, undefined);
			notify(3);
			await turnTask();
			assert.equal(reads.length, 2);
			await reads[1]!.complete(snapshot('A', 2));
			await waitFor(() => reads.length === 3);
			await reads[2]!.complete(snapshot('A', 3));
			await waitFor(() => f.model.thread?.sequence === 3);
			assert.deepEqual(f.model.items, []);
		});
	}
}

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
		test(`${kind} snapshot refresh retires an earlier ${failed ? 'error' : 'snapshot'} before reading accumulated updates`, async () => {
			const f = fixture(kind);
			using resources = f.resources;
			await f.model.initialize();
			const reads: DeferredPromise<ThreadRead>[] = [];
			f.threadApi.read = () => {
				const read = new DeferredPromise<ThreadRead>();
				reads.push(read);
				return read.p;
			};
			const emit = (sequence: number) => f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
			emit(2);
			await waitFor(() => reads.length === 1);
			emit(3);
			await turnTask();
			assert.equal(reads.length, 1);
			if (failed) await reads[0]!.error(new Error('Old snapshot failure')); else await reads[0]!.complete(snapshot('A', 2));
			await waitFor(() => reads.length === 2);
			assert.equal(f.model.error, undefined);
			await reads[1]!.complete(snapshot('A', 3)); await waitFor(() => f.model.thread?.sequence === 3);
			await turnTask(); assert.equal(f.model.thread?.sequence, 3); assert.equal(f.model.thread?.title, 'Sequence 3'); assert.equal(f.model.error, undefined); assert.equal(f.model.state, 'ready');
		});
	}
	test(`${kind} owner offer received before subscribe survives hydration and retires on reconnect`, async () => {
		const pending = new DeferredPromise<ThreadSubscription>();
		const f = fixture(kind, () => pending.p, true);
		using resources = f.resources;
		const offer = approval('owned');
		f.offers.fire(offer);
		// The service owns the offer while the widget's initial snapshot is in flight.
		assert.equal(f.chat.getInteractionOffer('session', 'A'), offer);
		await pending.complete({ ...snapshot('A', 1, true), updates: [] });
		await f.model.initialize();
		assert.equal(f.model.interaction, offer.interaction);
		assert.equal(f.model.inputState.interaction, offer.interaction);

		f.reconnect();
		assert.equal(f.chat.getInteractionOffer('session', 'A'), undefined);
		assert.equal(f.model.interaction, undefined);
		assert.equal(f.model.inputState.interaction, undefined);
		f.offers.fire(approval('retired-connection'));
		await turnTask();
		assert.equal(f.chat.getInteractionOffer('session', 'A'), undefined);
		assert.equal(f.model.interaction, undefined);
		assert.equal(f.model.inputState.interaction, undefined);
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
	test(`${kind} replacement refresh cannot roll back a newer sequence returned by the retired read`, async () => {
		const f = fixture(kind);
		using resources = f.resources;
		await f.model.initialize();
		const reads: DeferredPromise<ThreadRead>[] = [];
		f.threadApi.read = () => {
			const read = new DeferredPromise<ThreadRead>();
			reads.push(read);
			return read.p;
		};
		const emit = (sequence: number) => f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: sequence, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
		emit(2);
		await waitFor(() => reads.length === 1);
		emit(3);
		await turnTask();
		assert.equal(reads.length, 1);
		await reads[0]!.complete(snapshot('A', 4)); await waitFor(() => reads.length === 2);
		assert.equal(f.model.thread?.sequence, 4);
		await reads[1]!.complete(snapshot('A', 3)); await turnTask();
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

for (const kind of ['Code', 'Cowork'] as const) {
	for (const failed of [false, true]) test(`${kind} checkpoint summary retires immediately on undo and rejects a delayed ${failed ? 'error' : 'result'}`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		await waitFor(() => f.model.inputState.changesRevision === 'initial');
		const reads: DeferredPromise<Awaited<ReturnType<ChatService['readThreadChanges']>>>[] = [];
		f.chat.readThreadChanges = () => { const read = new DeferredPromise<Awaited<ReturnType<ChatService['readThreadChanges']>>>(); reads.push(read); return read.p; };
		let sequence = 2;
		f.threadApi.read = async ({ threadId }) => snapshot(threadId, sequence);
		f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: 2, update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn-A' } } });
		await waitFor(() => reads.length === 1);
		sequence = 3;
		f.updates.fire({ sessionId: 'session', threadId: 'A', durableSequence: 3, update: { type: 'committed', event: { type: 'threadHistoryMoved' } } });
		assert.equal(f.model.inputState.changes, undefined);
		assert.equal(f.model.inputState.changesRevision, undefined);
		let staleResultShown = false;
		let staleErrorShown = false;
		resources.add(f.model.onDidChange(() => {
			staleResultShown ||= f.model.inputState.changesRevision === 'old';
			staleErrorShown ||= f.model.inputState.changesError !== undefined;
		}));
		await waitFor(() => f.model.thread?.sequence === 3);
		// Code coalesces summary reads. Settle the invalidated read before
		// waiting for its replacement, while checking that it never becomes visible.
		if (kind === 'Code') assert.equal(reads.length, 1);
		if (failed) await reads[0]!.error(new Error('Old summary failure'));
		else await reads[0]!.complete({ sequence: 2, revision: 'old', statistics: { files: 30, additions: 100, deletions: 1 }, repositories: [], warnings: [] });
		await waitFor(() => reads.length === 2);
		assert.equal(f.model.inputState.changes, undefined);
		assert.equal(f.model.inputState.changesError, undefined);
		await reads[1]!.complete({ sequence: 3, revision: 'undone', statistics: { files: 0, additions: 0, deletions: 0 }, repositories: [], warnings: [] });
		await waitFor(() => f.model.inputState.changesRevision === 'undone');
		assert.deepEqual(f.model.inputState.changes, { files: 0, additions: 0, deletions: 0 });
		assert.equal(f.model.inputState.changesScope, 'conversation');
		assert.equal(f.model.inputState.changesRevision, 'undone');
		assert.equal(staleResultShown, false);
		assert.equal(staleErrorShown, false);
	});
	test(`${kind} summary cannot cross A-B-A navigation and failures do not show zero`, async () => {
		const f = fixture(kind); using resources = f.resources; await f.model.initialize();
		const pending = new DeferredPromise<Awaited<ReturnType<ChatService['readThreadChanges']>>>();
		f.chat.readThreadChanges = () => pending.p;
		await f.model.selectThread({ session: f.session, threadId: 'B' });
		f.chat.readThreadChanges = async () => { throw new Error('Capture unavailable'); };
		await f.model.selectThread({ session: f.session, threadId: 'A' });
		await waitFor(() => !!f.model.inputState.changesError);
		await pending.complete({ sequence: 1, revision: 'old-B', statistics: { files: 2, additions: 2, deletions: 2 }, repositories: [], warnings: [] });
		await turnTask();
		assert.equal(f.model.inputState.changes, undefined);
		assert.equal(f.model.inputState.changesRevision, undefined);
		assert.ok(f.model.inputState.changesError);
		assert.equal(f.model.error, undefined);
	});
}

for (const steering of ['afterOutput', 'early', 'contextOnly'] as const) test(`editing an accepted request excludes ${steering} steering`, async () => {
	const f = fixture('Code'); using resources = f.resources;
	const read = snapshot('A', 8, true);
	const turn = read.thread.turns[0];
	const image = { contentDigest: 'sha256:' + 'a'.repeat(64), mediaType: 'png' as const, encodedBytes: 128, width: 8, height: 8 };
	const audio = { contentDigest: 'sha256:' + 'b'.repeat(64), mediaType: 'wav' as const, encodedBytes: 256, durationMs: 100 };
	const items: typeof turn.items = [
		{ type: 'userContext', clientId: 'original-command', itemId: 'context', turnId: turn.turnId, name: 'Original file', content: 'Accepted snapshot' },
		{ type: 'userImageAttachment', clientId: 'original-command', itemId: 'image', turnId: turn.turnId, attachment: image },
		{ type: 'userAudioAttachment', clientId: 'original-command', itemId: 'audio', turnId: turn.turnId, attachment: audio },
		{ type: 'userMessage', clientId: 'original-command', itemId: 'original-input', turnId: turn.turnId, text: 'Original' },
		{ type: 'userMessage', clientId: 'original-command', itemId: 'following-input', turnId: turn.turnId, text: 'Following original text' },
		...(steering === 'afterOutput' ? [{ type: 'agentMessage' as const, itemId: 'reply', turnId: turn.turnId, text: 'Answer' }] : []),
		{ type: 'userContext', clientId: 'steering-command', itemId: 'steer-context', turnId: turn.turnId, name: 'Later context', content: 'Must not replay' },
		...(steering !== 'contextOnly' ? [
			{ type: 'userImage' as const, clientId: 'steering-command', itemId: 'steer-image', turnId: turn.turnId, url: 'https://example.test/later.png' },
			{ type: 'userImageAttachment' as const, clientId: 'steering-command', itemId: 'steer-attachment', turnId: turn.turnId, attachment: image },
			{ type: 'userAudioAttachment' as const, clientId: 'steering-command', itemId: 'steer-audio', turnId: turn.turnId, attachment: audio },
		] : []),
		...(steering !== 'contextOnly' ? [{ type: 'userMessage' as const, clientId: 'steering-command', itemId: 'steer', turnId: turn.turnId, text: 'Later steer' }] : []),
	];
	f.threadApi.read = async () => ({ ...read, thread: { ...read.thread, turns: [{ ...turn, items }] } });
	const rewrites: unknown[] = [];
	f.threadApi.rewrite = async options => { rewrites.push(options); return { sessionId: options.sessionId, threadId: 'edited' }; };
	assert.deepEqual(await f.chat.rewriteRequest({ sessionId: 'session', threadId: 'A', turnId: turn.turnId, itemId: 'original-input', text: 'Edited\nrequest', commandId: 'same-edit' }), { sessionId: 'session', threadId: 'edited' });
	assert.deepEqual(rewrites, [{
		sessionId: 'session', threadId: 'A', beforeTurnId: turn.turnId, commandId: 'same-edit', title: read.thread.title, input: [
			{ type: 'context', name: 'Original file', content: 'Accepted snapshot' },
			{ type: 'imageAttachment', attachment: image }, { type: 'audioAttachment', attachment: audio }, { type: 'text', text: 'Edited\nrequest' },
			{ type: 'text', text: 'Following original text' },
		]
	}]);
	await assert.rejects(f.chat.rewriteRequest({ sessionId: 'session', threadId: 'A', turnId: turn.turnId, itemId: 'steer', text: 'Changed steering', commandId: 'invalid-edit' }), /no longer available/);
	const legacyItems = items.map(item => { const { clientId: _, ...legacy } = item as typeof item & { clientId?: string; }; return legacy; });
	f.threadApi.read = async () => ({ ...read, thread: { ...read.thread, turns: [{ ...turn, items: legacyItems }] } });
	await assert.rejects(f.chat.rewriteRequest({ sessionId: 'session', threadId: 'A', turnId: turn.turnId, itemId: 'original-input', text: 'Legacy', commandId: 'legacy-edit' }), /no longer available/);
	assert.equal(rewrites.length, 1);
});

test('Chat preserves the composer cancellation signal through start, queue and steering domain dispatch', async () => {
	const f = fixture('Code');
	using resources = f.resources;
	await f.model.initialize();
	const controller = new AbortController();
	const signals: (AbortSignal | undefined)[] = [];
	f.turnApi.start = async (_params, signal) => { signals.push(signal); return { turnId: 'started', sequence: 2 }; };
	f.turnApi.enqueue = async (_params, signal) => { signals.push(signal); return { status: 'pending' }; };
	f.turnApi.steer = async (_params, signal) => { signals.push(signal); return { turnId: 'started', sequence: 2 }; };
	const options = { sessionId: 'session', threadId: 'A', text: 'Captured context', mode: 'agent' as const, expectedSequence: 1, signal: controller.signal };
	await f.chat.startTurn(options);
	await f.chat.queueTurn(options);
	await f.chat.steerTurn({ ...options, turnId: 'started' });
	assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
});


for (const kind of ['Code', 'Cowork'] as const) {
	test(`${kind} organization adopts only its canonical draft identity and preserves composer choices without sending`, async () => {
		const f = fixture(kind); using resources = f.resources;
		await f.model.initialize();
		const draft = { untitledSessionId: 'organized', title: 'Unsent', model: undefined, modelSelectionKind: 'manual' as const, agent: undefined, workspace: { type: 'current' as const } };
		const materialized = observableValue<ReadonlyMap<string, { sessionId: string; threadId: string; }>>('test materialization', new Map());
		const sessions = { untitledSessions: [draft], materializedSessions: materialized } as unknown as ISessionsManagementService;
		using configuration = new TestConfigurationService();
		using model = kind === 'Code'
			? new ChatWidgetModel(f.chat, { kind: 'untitled', session: draft }, sessions, f.prompts, f.models, f.execution, configuration)
			: new CoworkWidgetModel(f.chat, { kind: 'untitled', session: draft }, sessions, f.prompts, f.models, { onDidChangeModels: Event.None, getDefaultNewChatModel: () => undefined } as unknown as ILanguageModelsConfigurationService, f.execution, configuration);
		await model.initialize();
		model.selectMode('plan');
		model.selectApprovalMode('auto');
		const generation = model.composerGeneration;
		await assert.rejects(model.selectThread({ session: f.session, threadId: 'A' }), /another Session/);
		materialized.set(new Map([[draft.untitledSessionId, { sessionId: f.session.sessionId, threadId: 'A' }]]));
		await model.selectThread({ session: f.session, threadId: 'A' });
		assert.equal(model.sessionId, f.session.sessionId);
		assert.equal(model.composerGeneration, generation);
		assert.equal(model.inputState.mode, 'plan');
		assert.equal(model.inputState.approvalMode, 'auto');
		assert.equal(f.starts.length, 0, 'Giving a chat a durable identity must never start a Turn');
		await model.send('Send after organizing');
		assert.equal(f.starts.length, 1);
		assert.equal(f.starts[0]!.threadId, 'A', 'The first send must reuse the organized chat');
	});
}

for (const kind of ['Code', 'Cowork'] as const) {
	test(`${kind} submits approval through the scoped Chat facade and retires replaced offers`, async () => {
		const f = fixture(kind, undefined, true, true); using resources = f.resources;
		await f.model.initialize();
		const resolved: unknown[] = [];
		f.turnApi.resolveInteraction = async params => { resolved.push(params); return { sequence: 2 }; };
		let emitted: AgentInteractionOffer | undefined;
		resources.add(f.routedChat.onDidChangeInteractionOffer(event => { emitted = event.offer; }));
		f.offers.fire(approval('pdf-read'));
		const offered = f.routedChat.getInteractionOffer('session', 'A');
		assert.equal(offered, emitted);
		assert.equal(offered, f.routedChat.getInteractionOffer('session', 'A'));
		await f.model.resolveInteraction({ type: 'approval', response: { decision: 'approveOnce' } });
		assert.equal(resolved.length, 1, 'The real model must submit the approval through the facade');
		assert.equal((resolved[0] as { requestId: string; }).requestId, 'pdf-read');
		f.offers.fire(approval('replacement'));
		assert.notEqual(f.routedChat.getInteractionOffer('session', 'A'), offered);
		assert.equal(f.routedChat.getInteractionOffer('session', 'A'), emitted);
		f.reconnect();
		assert.equal(f.routedChat.getInteractionOffer('session', 'A'), undefined);
	});
}
