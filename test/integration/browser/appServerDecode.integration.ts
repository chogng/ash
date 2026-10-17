import { APP_SERVER_METHODS, type SessionThreadReadResult } from '../../../.build/protocol/typescript/index.js';
import { AppServerFrameDecoder } from '../../../src/ash/platform/agentHost/browser/appServerFrameDecoder.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { decodeAppServerFrame, type AppServerDecodeContext, type DecodedAppServerFrame } from '../../../src/ash/platform/agentHost/browser/appServerProtocolDecoding.js';
import { AppServerFrame, type AppServerTransport, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';

type Variant = 'before' | 'worker';
class BeforeDecoder extends AppServerFrameDecoder {
	public override decode(frame: string, _bytes: number, context: AppServerDecodeContext): DecodedAppServerFrame { return decodeAppServerFrame(frame, context); }
}

class ResponseTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	public requestId = 0;
	public on(event: string, listener: (value: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) this.listeners.set(event, listeners = new Set());
		listeners.add(listener);
	}
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' });
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const message = JSON.parse((payload as { frame: string; }).frame) as { id: number; method: string; };
		this.requestId = message.id;
		if (message.method === 'initialize') this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: createTestInitializeResult() }) });
	}
	public emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

const clients = new Map<Variant, { client: AppServerProtocolClient; transport: ResponseTransport; }>();
let wireResult = '';
let expectedTurns = 0;
let expectedTextBytes = 0;

async function prepare(turns: number, textBytes: number): Promise<void> {
	for (const { client } of clients.values()) client.dispose();
	clients.clear();
	expectedTurns = turns;
	expectedTextBytes = textBytes;
	const usage = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
	const items = Array.from({ length: turns }, (_, index) => ({ type: 'agentMessage' as const, itemId: `answer-${index}`, turnId: `turn-${index}`, text: 'x'.repeat(textBytes) }));
	const result: SessionThreadReadResult = {
		thread: { sessionId: 'session', threadId: 'thread', agentId: 'agent', origin: { type: 'root' }, title: 'Decode workload', status: 'active', sequence: turns, advisor: { type: 'off' }, usage, referenceCost: { knownAmounts: [], complete: true }, hookRuns: [], turns: items.map(item => ({ turnId: item.turnId, status: 'completed', kind: 'coding', mode: 'agent', toolMode: 'direct', approvalMode: 'manual', usage, items: [item] })) },
		transcript: { sessionId: 'session', threadId: 'thread', durableSequence: turns, revision: turns, entries: items.map(item => ({ type: 'item', entryId: `item:${item.itemId}`, turnId: item.turnId, item, transient: false })) },
	};
	wireResult = JSON.stringify(result);
	for (const variant of ['before', 'worker'] as const) {
		const transport = new ResponseTransport();
		const client = new AppServerProtocolClient(transport, {}, variant === 'before' ? new BeforeDecoder() : new AppServerFrameDecoder());
		clients.set(variant, { client, transport });
		await client.connect();
	}
}

async function run(variant: Variant) {
	const { client, transport } = clients.get(variant)!;
	const pending = client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' });
	const frame = `{"jsonrpc":"2.0","id":${transport.requestId},"result":${wireResult}}`;
	const payload = new AppServerFrame(frame, new TextEncoder().encode(frame).byteLength);
	const tasks: PerformanceEntry[] = [];
	const observer = new PerformanceObserver(list => tasks.push(...list.getEntries()));
	observer.observe({ type: 'longtask' });
	const gaps: number[] = [];
	let previous = performance.now();
	const heartbeat = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 1);
	let frames = 0;
	let responseAt = Infinity;
	let animation = 0;
	const animate = (): void => { if (performance.now() < responseAt) frames++; animation = requestAnimationFrame(animate); };
	try {
		await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		animation = requestAnimationFrame(animate);
		gaps.length = 0;
		previous = performance.now();
		const start = performance.now();
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, payload);
		const dispatchMs = performance.now() - start;
		const result = await pending;
		responseAt = performance.now();
		const throughResponseMs = responseAt - start;
		if (result.thread.turns.length !== expectedTurns || result.transcript.entries.length !== expectedTurns || result.thread.turns.at(-1)?.items[0]?.type !== 'agentMessage') throw new Error('Decode workload did not complete');
		const last = result.thread.turns.at(-1)!.items[0];
		if (last.type !== 'agentMessage' || last.text !== 'x'.repeat(expectedTextBytes)) throw new Error('Decode content changed');
		document.querySelector('output')!.textContent = `${variant}:${result.thread.turns.length}:${last.text.length}`;
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		const longTasks = tasks.filter(task => task.startTime + task.duration > start && task.startTime < responseAt);
		return { bytes: payload.byteLength, dispatchMs, throughResponseMs, maxTimerGapMs: Math.max(0, ...gaps), maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.duration)), longTaskCount: longTasks.length, animationFramesDuringDecode: frames, turns: result.thread.turns.length, textBytes: last.text.length, state: client.state };
	} finally { clearInterval(heartbeat); cancelAnimationFrame(animation); observer.disconnect(); }
}

async function burst() {
	const { client, transport } = clients.get('worker')!;
	const received: string[] = [];
	let completed!: () => void;
	const done = new Promise<void>(resolve => { completed = resolve; });
	let yielded!: (count: number) => void;
	const timer = new Promise<number>(resolve => { yielded = resolve; });
	using subscription = client.onNotification(notification => {
		if (notification.method !== 'session/deleted') throw new Error('Unexpected burst notification');
		received.push(notification.params.sessionId);
		if (received.length === 1) setTimeout(() => yielded(received.length), 0);
		if (received.length === 2000) completed();
	});
	const pending = client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' });
	const frame = `{"jsonrpc":"2.0","id":${transport.requestId},"result":${wireResult}}`;
	transport.emit(WEB_APP_SERVER_FRAME_EVENT, new AppServerFrame(frame, new TextEncoder().encode(frame).byteLength));
	for (let index = 0; index < 2000; index++) transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'session/deleted', params: { sessionId: String(index) } }) });
	transport.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Burst peer ended' });
	const result = await pending;
	await done;
	return { yieldedAfter: await timer, count: received.length, ordered: received.every((value, index) => value === String(index)), turns: result.thread.turns.length, state: client.state };
}

declare global {
	interface Window { ashAppServerDecodeIntegration: { prepare: typeof prepare; run: typeof run; burst: typeof burst; dispose(): void; }; }
}
window.ashAppServerDecodeIntegration = { prepare, run, burst, dispose: () => { for (const { client } of clients.values()) client.dispose(); clients.clear(); } };
