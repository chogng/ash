import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ChatService } from '../../../../services/chat/browser/chatService.js';
import type { IAgentThreadService, IAgentTurnService } from '../../../../../platform/agentHost/common/agentService.js';
import type { AgentInteractionOffer, ThreadSubscription, ThreadUpdateEnvelope } from '../../../../../platform/agentHost/common/agent.js';
import type { IAgentModelsService } from '../../../../../platform/agentHost/common/agentModels.js';
import type { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { AppServerConnectionState, IAppServerApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { ITurnChangesApi } from '../../../../../platform/turnChanges/common/turnChangesApi.js';

const offer: AgentInteractionOffer = { connectionGeneration: 1, sessionId: 'session', threadId: 'thread', turnId: 'turn', interaction: { requestId: 'request', request: { type: 'approval', request: { reason: 'Approve access', capabilities: [{ kind: 'network', scope: 'example.test' }] } } } };

function fixture() {
	const lifetime = new DisposableStore();
	const offers = lifetime.add(new Emitter<AgentInteractionOffer>());
	const updates = lifetime.add(new Emitter<ThreadUpdateEnvelope>());
	const states = lifetime.add(new Emitter<AppServerConnectionState>());
	let state: AppServerConnectionState = 'ready';
	let generation = 1;
	let pending: Promise<ThreadSubscription> = Promise.resolve(snapshot());
	let subscriptions = 0; let unsubscriptions = 0;
	const api = { get connectionGeneration() { return generation; }, getConnectionState: async () => state, onConnectionState: states.event } as unknown as IAppServerApi;
	const threads = { onDidOfferInteraction: offers.event, onDidUpdateThread: updates.event, onDidUpdateThreadTranscript: Event.None, subscribe: () => { subscriptions++; return pending; }, unsubscribe: async () => { unsubscriptions++; } } as unknown as IAgentThreadService;
	const service = lifetime.add(new ChatService({} as IAgentModelsService, threads, {} as IAgentTurnService, {} as ITurnChangesApi, api, { subscribe: () => ({ dispose() { } }) } as IServerEventApi, {} as IAgentExecutionSettingsService, lifetime.add(new TestConfigurationService())));
	return { lifetime, service, offers, updates, setState(value: AppServerConnectionState, next = generation) { state = value; generation = next; states.fire(value); }, setPending(value: Promise<ThreadSubscription>) { pending = value; }, count: () => ({ subscriptions, unsubscriptions }) };
}
function snapshot(): ThreadSubscription { return { thread: { sessionId: 'session', threadId: 'thread', sequence: 2, turns: [{ turnId: 'turn', status: 'waitingForApproval' }] }, transcript: { entries: [], revision: 0 }, updates: [] } as unknown as ThreadSubscription; }

// The backend can deliver agent/request synchronously before the subscribe response resumes.
test('an owned pending interaction survives subscribe response ordering and a window reopen', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	const owner = {};
	const pending = new DeferredPromise<ThreadSubscription>(); f.setPending(pending.p);
	const subscribing = f.service.subscribeThread('session', 'thread', 0, owner);
	f.offers.fire(offer);
	assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
	await pending.complete(snapshot()); await subscribing;
	assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
	await f.service.unsubscribeThread('session', 'thread', owner);
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	await f.service.subscribeThread('session', 'thread', 0, {});
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	f.offers.fire(offer);
	assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
});

test('a same-generation close retires authority immediately and old offers cannot authorize reconnect', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	await f.service.subscribeThread('session', 'thread', 0, {}); f.offers.fire(offer);
	f.setState('crashed');
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	f.offers.fire(offer);
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	f.setState('ready', 2); await f.service.subscribeThread('session', 'thread', 0, {});
	f.offers.fire(offer); assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	f.offers.fire({ ...offer, connectionGeneration: 2 });
	assert.equal(f.service.getInteractionOffer('session', 'thread')?.connectionGeneration, 2);
});

test('peer committed history cannot grant authority and one shared owner cannot revoke its peer', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	const first = {}, second = {};
	await f.service.subscribeThread('session', 'thread', 0, first); await f.service.subscribeThread('session', 'thread', 0, second);
	f.updates.fire({ sessionId: 'session', threadId: 'thread', durableSequence: 2, update: { type: 'committed', event: { type: 'interactionRequested', interaction: offer.interaction } } });
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	f.offers.fire(offer);
	await f.service.unsubscribeThread('session', 'thread', first);
	assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
	assert.equal(f.count().unsubscriptions, 0);
	await f.service.unsubscribeThread('session', 'thread', second);
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	assert.equal(f.count().unsubscriptions, 1);
});

for (const type of ['interactionResolved', 'interactionCancelled', 'turnCompleted', 'turnFailed', 'turnInterrupted'] as const) {
	test(`${type} retires only the corresponding grant`, async () => {
		const f = fixture(); using cleanup = f.lifetime;
		await f.service.subscribeThread('session', 'thread', 0, {}); f.offers.fire(offer);
		const event = { type, turnId: 'other', ...(type.startsWith('interaction') ? { requestId: 'request' } : {}) };
		f.updates.fire({ sessionId: 'session', threadId: 'thread', durableSequence: 3, update: { type: 'committed', event } } as ThreadUpdateEnvelope);
		assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
		if (type.startsWith('interaction')) {
			f.updates.fire({ sessionId: 'session', threadId: 'thread', durableSequence: 3, update: { type: 'committed', event: { ...event, turnId: 'turn', requestId: 'other' } } } as ThreadUpdateEnvelope);
			assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
		}
		f.updates.fire({ sessionId: 'session', threadId: 'thread', durableSequence: 4, update: { type: 'committed', event: { ...event, turnId: 'turn', ...(type.startsWith('interaction') ? { requestId: 'request' } : {}) } } } as ThreadUpdateEnvelope);
		assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	});
}

test('an already expired offer cannot create actionable authority', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	await f.service.subscribeThread('session', 'thread', 0, {});
	f.offers.fire({ ...offer, interaction: { ...offer.interaction, deadline: { expiresAtUnixMs: Date.now() - 1 } } });
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
});

test('a pre-response owner offer is not retired by the earlier subscribe snapshot', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	const pending = new DeferredPromise<ThreadSubscription>(); f.setPending(pending.p);
	const subscribing = f.service.subscribeThread('session', 'thread', 0, {});
	f.offers.fire(offer);
	const earlier = snapshot();
	await pending.complete({ ...earlier, thread: { ...earlier.thread, turns: [] } });
	await subscribing;
	assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
});

test('same-connection reacquisition retains the still-open delivery lease without a duplicate server offer', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	const first = {}, replacement = {};
	const pending = new DeferredPromise<ThreadSubscription>(); f.setPending(pending.p);
	const original = f.service.subscribeThread('session', 'thread', 0, first);
	f.offers.fire(offer);
	const release = f.service.unsubscribeThread('session', 'thread', first);
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
	const acquiring = f.service.subscribeThread('session', 'thread', 0, replacement);
	await pending.complete(snapshot());
	await Promise.all([original, acquiring, release]);
	assert.deepEqual(f.service.getInteractionOffer('session', 'thread'), offer);
	assert.equal(f.count().unsubscriptions, 0);
});

test('a fresh terminal snapshot retires an offer that predates the refresh', async () => {
	const f = fixture(); using cleanup = f.lifetime;
	const owner = {};
	await f.service.subscribeThread('session', 'thread', 0, owner); f.offers.fire(offer);
	const before = snapshot();
	f.setPending(Promise.resolve({ ...before, thread: { ...before.thread, turns: [] } }));
	await f.service.subscribeThread('session', 'thread', 0, owner);
	assert.equal(f.service.getInteractionOffer('session', 'thread'), undefined);
});
