import { WebWorkerService } from '../../../src/ash/platform/webWorker/browser/webWorkerServiceImpl.js';
import { createAppServerFrameDecoder } from '../../../src/ash/platform/agentHost/browser/appServerFrameDecoder.js';
import { APP_SERVER_METHODS, type SessionThreadReadResult } from '../../../.build/protocol/typescript/index.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import {
	AppServerFrame,
	type AppServerTransport,
	WEB_APP_SERVER_CLOSED_EVENT,
	WEB_APP_SERVER_CONNECTED_EVENT,
	WEB_APP_SERVER_CONNECT_EVENT,
	WEB_APP_SERVER_FRAME_EVENT,
} from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';
function threadWorkload(turns: number, textBytes: number): SessionThreadReadResult {
	const count = { reported: 0, complete: true };
	const usage = {
		modelInvocations: 0,
		inputTokens: { ...count },
		outputTokens: { ...count },
		cachedInputTokens: { ...count },
		cacheWriteInputTokens: { ...count },
		reasoningTokens: { ...count },
	};
	const items = Array.from({ length: turns }, (_, index) => ({
		type: 'agentMessage' as const,
		itemId: `answer-${index}`,
		turnId: `turn-${index}`,
		text: 'x'.repeat(textBytes),
	}));
	return {
		thread: {
			sessionId: 'session',
			threadId: 'thread',
			agentId: 'agent',
			origin: { type: 'root' },
			title: 'Decode workload',
			status: 'active',
			sequence: turns,
			advisor: { type: 'off' },
			usage,
			referenceCost: { knownAmounts: [], complete: true },
			hookRuns: [],
			turns: items.map(item => ({
				turnId: item.turnId,
				status: 'completed',
				kind: 'coding',
				mode: 'agent',
				toolMode: 'direct',
				approvalMode: 'manual',
				usage,
				items: [item],
			})),
		},
		transcript: {
			sessionId: 'session',
			threadId: 'thread',
			durableSequence: turns,
			revision: turns,
			entries: items.map(item => ({
				type: 'item',
				entryId: `item:${item.itemId}`,
				turnId: item.turnId,
				item,
				transient: false,
			})),
		},
	};
}

class ResponseTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	public requestId = 0;
	public on(event: string, listener: (value: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) this.listeners.set(event, (listeners = new Set()));
		listeners.add(listener);
	}
	public off(event: string, listener: (value: unknown) => void): void {
		this.listeners.get(event)?.delete(listener);
	}
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT)
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, {
				protocolVersion: 1,
				workspaceId: 'test',
				workspaceRoot: '/test',
			});
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const message = JSON.parse((payload as { frame: string }).frame) as { id: number; method: string };
		this.requestId = message.id;
		if (message.method === 'initialize')
			this.emit(WEB_APP_SERVER_FRAME_EVENT, {
				frame: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: createTestInitializeResult() }),
			});
	}
	public emit(event: string, value: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(value);
	}
}

let connection: { client: AppServerProtocolClient; transport: ResponseTransport } | undefined;
let wireResult = '';
let expectedTurns = 0;
let expectedTextBytes = 0;

async function prepare(turns: number, textBytes: number): Promise<void> {
	connection?.client.dispose();
	expectedTurns = turns;
	expectedTextBytes = textBytes;
	const result = threadWorkload(turns, textBytes);
	wireResult = JSON.stringify(result);
	const transport = new ResponseTransport();
	const client = new AppServerProtocolClient(transport, {}, createAppServerFrameDecoder(new WebWorkerService()));
	connection = { client, transport };
	await client.connect();
}

async function run() {
	const { client, transport } = connection!;
	const pending = client.request(APP_SERVER_METHODS['session/thread/read'], {
		sessionId: 'session',
		threadId: 'thread',
	});
	const frame = `{"jsonrpc":"2.0","id":${transport.requestId},"result":${wireResult}}`;
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, new AppServerFrame(frame, new TextEncoder().encode(frame).byteLength));
	const result = await pending;
	if (result.thread.turns.length !== expectedTurns || result.transcript.entries.length !== expectedTurns)
		throw new Error('Decode workload did not complete');
	const last = result.thread.turns.at(-1)!.items[0];
	if (last.type !== 'agentMessage' || last.text !== 'x'.repeat(expectedTextBytes))
		throw new Error('Decode content changed');
	return { turns: result.thread.turns.length, textBytes: last.text.length, state: client.state };
}

async function burst() {
	const { client, transport } = connection!;
	const received: string[] = [];
	let completed!: () => void;
	const done = new Promise<void>(resolve => {
		completed = resolve;
	});
	let yielded!: (count: number) => void;
	const timer = new Promise<number>(resolve => {
		yielded = resolve;
	});
	using subscription = client.onNotification(notification => {
		if (notification.method !== 'session/deleted') throw new Error('Unexpected burst notification');
		received.push(notification.params.sessionId);
		// Give this functional yield scenario enough listener work to cross the
		// drain budget even on fast machines.
		if (received.length % 100 === 0) {
			const start = performance.now();
			while (performance.now() - start < 1) {
				/* Test-owned listener work. */
			}
		}
		if (received.length === 1) setTimeout(() => yielded(received.length), 0);
		if (received.length === 2000) completed();
	});
	const pending = client.request(APP_SERVER_METHODS['session/thread/read'], {
		sessionId: 'session',
		threadId: 'thread',
	});
	const frame = `{"jsonrpc":"2.0","id":${transport.requestId},"result":${wireResult}}`;
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, new AppServerFrame(frame, new TextEncoder().encode(frame).byteLength));
	for (let index = 0; index < 2000; index++)
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, {
			frame: JSON.stringify({ jsonrpc: '2.0', method: 'session/deleted', params: { sessionId: String(index) } }),
		});
	transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Burst peer ended' });
	const result = await pending;
	await done;
	return {
		yieldedAfter: await timer,
		count: received.length,
		ordered: received.every((value, index) => value === String(index)),
		turns: result.thread.turns.length,
		state: client.state,
	};
}

declare global {
	interface Window {
		ashAppServerDecodeIntegration: {
			prepare: typeof prepare;
			run: typeof run;
			burst: typeof burst;
			dispose(): void;
		};
	}
}
window.ashAppServerDecodeIntegration = {
	prepare,
	run,
	burst,
	dispose: () => {
		connection?.client.dispose();
		connection = undefined;
	},
};
