import assert from 'node:assert/strict';
import { test } from 'mocha';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import { createAppServerAgentThreadService } from '../../browser/appServerAgentService.js';
import type { AgentInteractionOffer, ThreadUpdateEnvelope } from '../../common/agent.js';
import { createTestInitializeResult } from '../common/testAppServerProtocol.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../common/appServerTransport.js';

const identity = { sessionId: 'session', threadId: 'thread', turnId: 'turn' };
const interaction = { requestId: 'approval', itemId: null, deadline: null, request: { type: 'approval' as const, request: { actionDigest: 'a'.repeat(64), policyRevision: 'policy', capabilities: [{ kind: 'network' as const, scope: 'example.test' }], reason: 'Approve access', sandboxDenial: null } } };

for (const kind of ['approval', 'userInput'] as const) {
	test(`owner-directed ${kind} offers use the real decoder and preserve connection identity`, async () => {
		const transport = new InteractionTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		const api = createAppServerAgentThreadService(client);
		const offers: AgentInteractionOffer[] = [];
		using listener = api.onDidOfferInteraction(offer => offers.push(offer));
		await client.connect();
		const request = kind === 'approval' ? interaction : { ...interaction, request: { type: 'userInput', request: { questions: [{ id: 'question', header: 'Choice', question: 'Continue?', allowFreeForm: true, options: [{ label: 'Yes', description: 'Continue' }] }] } } };
		transport.frame({ method: 'agent/request', params: { ...identity, interaction: request } });
		assert.equal(client.state, 'ready');
		assert.equal(offers.length, 1);
		assert.deepEqual({ ...offers[0], interaction: undefined }, { ...identity, connectionGeneration: 1, interaction: undefined });
		assert.equal(offers[0].interaction.requestId, 'approval');
		assert.equal(offers[0].interaction.request.type, kind);
		client.disconnect();
		transport.frame({ method: 'agent/request', params: { ...identity, interaction: request } });
		assert.equal(offers.length, 1);
		await client.connect();
		transport.frame({ method: 'agent/request', params: { ...identity, interaction: request } });
		assert.equal(offers.length, 2);
		assert.equal(offers[1].connectionGeneration, 2);
		listener.dispose();
		transport.frame({ method: 'agent/request', params: { ...identity, interaction: request } });
		assert.equal(offers.length, 2);
	});
}

test('committed interaction history never grants delivery ownership', async () => {
	const transport = new InteractionTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const api = createAppServerAgentThreadService(client);
	const offers: AgentInteractionOffer[] = [];
	using listener = api.onDidOfferInteraction(offer => offers.push(offer));
	await client.connect();
	transport.frame({ method: 'session/thread/update', params: { sessionId: 'session', threadId: 'thread', durableSequence: 2, streamCursor: null, update: { type: 'committed', event: { type: 'interactionRequested', ...identity, interaction } } } });
	assert.equal(client.state, 'ready');
	assert.deepEqual(offers, []);
});

for (const type of ['interactionResolved', 'interactionCancelled', 'turnCompleted', 'turnFailed', 'turnInterrupted'] as const) {
	test(`${type} retirement preserves the owning turn and request identity`, async () => {
		const transport = new InteractionTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		const api = createAppServerAgentThreadService(client);
		const updates: ThreadUpdateEnvelope[] = [];
		using listener = api.onDidUpdateThread(update => updates.push(update));
		await client.connect();
		const event = type === 'interactionResolved' ? { type, threadId: 'thread', turnId: 'turn', requestId: 'approval', response: { type: 'approval', response: { decision: 'approveOnce' } } } : type === 'interactionCancelled' ? { type, threadId: 'thread', turnId: 'turn', requestId: 'approval', reason: 'turnInterrupted' } : type === 'turnFailed' ? { type, threadId: 'thread', turnId: 'turn', error: { code: 'modelInvocationFailed', message: 'failed', retryable: true } } : { type, threadId: 'thread', turnId: 'turn' };
		transport.frame({ method: 'session/thread/update', params: { sessionId: 'session', threadId: 'thread', durableSequence: 3, streamCursor: null, update: { type: 'committed', event } } });
		assert.equal(client.state, 'ready');
		assert.equal(updates.length, 1);
		assert.deepEqual(updates[0].update, { type: 'committed', event: { type, turnId: 'turn', ...(type.startsWith('interaction') ? { requestId: 'approval' } : {}) } });
	});
}

class InteractionTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, listener: (payload: unknown) => void): void { let group = this.listeners.get(event); if (!group) this.listeners.set(event, group = new Set()); group.add(listener); }
	off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	send(event: string, payload: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'workspace', workspaceRoot: '/workspace' });
		else if (event === WEB_APP_SERVER_FRAME_EVENT) {
			const frame = JSON.parse((payload as { frame: string; }).frame);
			if (frame.method === 'initialize') this.frame({ id: frame.id, result: createTestInitializeResult() });
		} else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) throw new Error('Unexpected transport event');
	}
	frame(frame: Record<string, unknown>): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', ...frame }) }); }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(payload); }
}
