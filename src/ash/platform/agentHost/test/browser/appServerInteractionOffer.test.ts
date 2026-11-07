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

for (const required of [undefined, false, true]) {
	test(`owner-directed user input preserves required=${String(required)} through the real decoder and domain adapter`, async () => {
		const transport = new InteractionTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		const api = createAppServerAgentThreadService(client);
		const offers: AgentInteractionOffer[] = [];
		using listener = api.onDidOfferInteraction(offer => offers.push(offer));
		await client.connect();
		const question = { id: 'answer', header: 'Answer', question: 'A form answer', allowFreeForm: true, ...(required === undefined ? {} : { required }) };
		transport.frame({ method: 'agent/request', params: { ...identity, interaction: { ...interaction, request: { type: 'userInput', request: { questions: [question] } } } } });
		assert.equal(client.state, 'ready');
		assert.equal(offers.length, 1);
		assert.deepEqual({ sessionId: offers[0].sessionId, threadId: offers[0].threadId, turnId: offers[0].turnId, connectionGeneration: offers[0].connectionGeneration }, { ...identity, connectionGeneration: 1 });
		const request = offers[0].interaction.request;
		assert.equal(request.type, 'userInput');
		if (request.type !== 'userInput') throw new Error('Missing user input offer');
		assert.deepEqual(request.request.questions, [{ ...question, required: required ?? true, options: undefined }]);
	});
}

test('result review decodes captured content only through the owner-directed offer', async () => {
	const transport = new InteractionTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const api = createAppServerAgentThreadService(client);
	const offers: AgentInteractionOffer[] = [];
	using listener = api.onDidOfferInteraction(offer => offers.push(offer));
	await client.connect();
	const request = {
		...interaction, requestId: 'review', request: {
			type: 'toolResultReview', request: {
				toolCallId: 'executed-call', toolName: 'read_private', review: { reason: 'Review captured evidence', content: [{ type: 'text', text: 'private <img src=x>' }], isError: true },
			}
		}
	};
	transport.frame({ method: 'session/thread/update', params: { sessionId: 'session', threadId: 'thread', durableSequence: 2, streamCursor: null, update: { type: 'committed', event: { type: 'interactionRequested', ...identity, interaction: request } } } });
	assert.equal(offers.length, 0);
	transport.frame({ method: 'agent/request', params: { ...identity, interaction: request } });
	assert.equal(client.state, 'ready');
	assert.equal(offers.length, 1);
	assert.deepEqual(offers[0].interaction.request, request.request);
	assert.equal(offers[0].interaction.requestId, 'review');
});

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

test('sandbox approval preserves captured enforcement evidence without exposing authority fields', async () => {
	const transport = new InteractionTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const api = createAppServerAgentThreadService(client);
	const offers: AgentInteractionOffer[] = [];
	using listener = api.onDidOfferInteraction(offer => offers.push(offer));
	await client.connect();
	const sandboxDenial = {
		reason: 'Network access denied', replaySafety: 'safeToRetry',
		output: { exitStatus: { type: 'code', code: 1 }, stdout: '<script>literal</script>', stderr: 'denied', aggregatedOutput: 'denied\n<script>literal</script>' },
	};
	transport.frame({
		method: 'agent/request', params: {
			...identity, interaction: {
				...interaction, request: { type: 'approval', request: { ...interaction.request.request, sandboxDenial, riskAssessment: { assessmentId: 'assessment', riskLevel: 'high', reason: 'publishes externally' } } },
			},
		},
	});
	assert.equal(client.state, 'ready');
	assert.equal(offers.length, 1);
	assert.deepEqual(offers[0].interaction.request, {
		type: 'approval', request: {
			reason: 'Approve access', allowedDecisions: undefined, command: undefined, sessionCommandPrefix: undefined, sandboxDenial,
			riskAssessment: { riskLevel: 'high', reason: 'publishes externally' },
			capabilities: [{ kind: 'network', scope: 'example.test' }],
		},
	});
});

test('tool execution start preserves the exact Turn and Call through the real decoder', async () => {
	const transport = new InteractionTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const api = createAppServerAgentThreadService(client);
	const updates: ThreadUpdateEnvelope[] = [];
	using listener = api.onDidUpdateThread(update => updates.push(update));
	await client.connect();
	transport.frame({
		method: 'session/thread/update', params: {
			sessionId: 'session', threadId: 'thread', durableSequence: 3, update: {
				type: 'committed', event: {
					type: 'toolExecutionStarted', threadId: 'thread', turnId: 'turn', toolCallId: 'call',
					actionDigest: 'digest', policyRevision: 'policy', authority: { type: 'sandboxed' },
				}
			},
		}
	});
	assert.equal(client.state, 'ready');
	assert.deepEqual(updates[0].update, { type: 'committed', event: { type: 'toolExecutionStarted', turnId: 'turn', toolCallId: 'call' } });
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
