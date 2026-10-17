import { equals } from '../../../src/ash/base/common/objects.js';
import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS, type AppServerMethod } from '../../../.build/protocol/typescript/index.js';
import { AppServerFrameDecoder } from '../../../src/ash/platform/agentHost/browser/appServerFrameDecoder.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { decodeAppServerFrame, decodeAppServerMessage, readDecodedAppServerFrame, type AppServerDecodeContext, type DecodedAppServerFrame } from '../../../src/ash/platform/agentHost/browser/appServerProtocolDecoding.js';
import { AppServerFrame, type AppServerTransport, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';
import { BrowserWorkerClientPort } from '../../../src/ash/platform/webWorker/browser/browserWorkerClientPort.js';
import { WebWorkerClient } from '../../../src/ash/base/common/worker/webWorker.js';
import { encodePrototype, normalizePrototype, parsePrototype } from './protobufPrototype/codecAdapter.js';
import { numericWorkload, threadWorkload } from './protobufPrototype/workload.js';
import { decodePrototypeInput } from './protobufPrototype/decode.js';
import { ashCodecPrototype } from './protobufPrototype/codec.js';

type Codec = 'json' | 'json-bytes' | 'protobuf';
interface Input { codec: Codec; input: string | ArrayBuffer; bytes: number; }
interface Timing { parseMs: number; normalizeMs: number; validateMs: number; workerReceivedAt: number; }
interface JobStats { inputSendMs: number; inputDetached: boolean; inputSentAt: number; synchronous?: boolean; timing?: Timing; returnDeliveryMs?: number; serializeMs?: number; metrics: Promise<void>; finishMetrics(): void; }
const absoluteNow = (): number => performance.timeOrigin + performance.now();
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** A test-only handoff from the carrier to the injected decoder. No base64 or
 * JSON conversion is charged to Protobuf; queue bytes are the actual wire bytes.
 * The production protocol client still owns all pending, ordering and retirement.
 */
class PrototypeDecoder extends AppServerFrameDecoder {
	private next = 0;
	private readonly inputs = new Map<string, Input>();
	private client: WebWorkerClient | undefined;
	private readonly stats = new Map<number, JobStats>();
	private held: unknown[] = [];
	private port: BrowserWorkerClientPort | undefined;
	private metricsListener: { dispose(): void; } | undefined;
	public paused = false;
	public latest: JobStats | undefined;
	public enqueue(input: Input): AppServerFrame {
		const token = `codec-frame:${++this.next}`;
		this.inputs.set(token, input);
		return new AppServerFrame(token, input.bytes);
	}
	public release(): void { this.paused = false; for (const message of this.held.splice(0)) this.post(message); }
	private post(message: unknown): void {
		const job = message as { requestId: number; input?: string | ArrayBuffer; };
		const stats = this.stats.get(job.requestId);
		const start = performance.now();
		if (stats) stats.inputSentAt = absoluteNow();
		this.port!.send(message, job.input instanceof ArrayBuffer ? [job.input] : []);
		if (stats) { stats.inputSendMs = performance.now() - start; stats.inputDetached = job.input instanceof ArrayBuffer && job.input.byteLength === 0; }
	}
	public override decode(frame: string, _bytes: number, context: AppServerDecodeContext): DecodedAppServerFrame | Promise<DecodedAppServerFrame> {
		const input = this.inputs.get(frame);
		if (!input) return decodeAppServerFrame(frame, context); // Normal initialization handshake.
		this.inputs.delete(frame);
		if (input.bytes < 256 * 1024) {
			const result = decodePrototypeInput(input.codec, input.input, context);
			this.latest = { inputSendMs: 0, inputDetached: false, inputSentAt: 0, synchronous: true, timing: result.timing, returnDeliveryMs: 0, serializeMs: 0, metrics: Promise.resolve(), finishMetrics() { } };
			return result.decoded;
		}
		if (!this.client) {
			this.port = new BrowserWorkerClientPort(new Worker(new URL('./protobufPrototype/worker.ts', import.meta.url), { type: 'module', name: 'ash-codec-prototype' }));
			this.metricsListener = this.port.onMessage(message => {
				const value = message as { protocol?: string; requestId: number; serializeMs: number; };
				if (value.protocol !== 'ash.codec.prototype.metrics') return;
				const stats = this.stats.get(value.requestId);
				if (stats) { stats.serializeMs = value.serializeMs; stats.finishMetrics(); this.stats.delete(value.requestId); }
			});
			this.client = new WebWorkerClient({
				onMessage: this.port.onMessage, onFailure: this.port.onFailure,
				send: message => { if (this.paused) this.held.push(message); else this.post(message); },
				dispose: () => this.port!.dispose(),
				[Symbol.dispose]: () => this.port!.dispose(),
			}, { protocol: 'ash.codec.prototype', version: 1 });
		}
		let finishMetrics!: () => void;
		const metrics = new Promise<void>(resolve => { finishMetrics = resolve; });
		const stats: JobStats = { metrics, finishMetrics, inputSendMs: 0, inputDetached: false, inputSentAt: 0 };
		const id = ++this.next;
		this.stats.set(id, stats);
		this.latest = stats;
		return this.client.request(id, { codec: input.codec, input: input.input, context }, new AbortController().signal).then(value => {
			const result = value as { decoded: unknown; timing: Timing; returnStartedAt: number; };
			stats.returnDeliveryMs = absoluteNow() - result.returnStartedAt;
			stats.timing = result.timing;
			return readDecodedAppServerFrame(result.decoded, context);
		});
	}
	public override reset(): void {
		this.metricsListener?.dispose(); this.metricsListener = undefined;
		this.client?.dispose(); this.client = undefined;
		this.inputs.clear(); this.held = [];
		for (const stats of this.stats.values()) stats.finishMetrics();
		this.stats.clear(); super.reset();
	}
	public override dispose(): void { this.reset(); super.dispose(); }
}

class Carrier implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	public requestId = 0;
	public readonly replies: unknown[] = [];
	public on(event: string, listener: (value: unknown) => void): void { let listeners = this.listeners.get(event); if (!listeners) this.listeners.set(event, listeners = new Set()); listeners.add(listener); }
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	public emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' });
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const message = JSON.parse((payload as { frame: string; }).frame) as { id: number; method?: string; };
		if (!message.method) { this.replies.push(message); return; }
		this.requestId = message.id;
		if (message.method === 'initialize') this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: createTestInitializeResult() }) });
	}
}

const clients = new Map<Codec, { client: AppServerProtocolClient; decoder: PrototypeDecoder; carrier: Carrier; }>();
let workload: unknown;
let method: 'session/thread/read' | 'syntax/query' = 'session/thread/read';
function wire(codec: Codec, message: unknown, resultMethod?: string): Input & { encodeMs: number; inputBackingCopyBytes: number; } {
	const started = performance.now();
	const encoded = codec === 'protobuf' ? encodePrototype(message, resultMethod) : JSON.stringify(message);
	const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded;
	// protobuf.js pools small outputs. Transferring that whole buffer would send
	// unrelated bytes and detach the allocator's pool. Include an owned copy in
	// encoding cost only when the returned view does not own its entire buffer.
	const needsCopy = codec !== 'json' && (bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.byteLength);
	const buffer = needsCopy ? bytes.slice().buffer : bytes.buffer;
	return { codec, bytes: bytes.byteLength, input: codec === 'json' ? encoded as string : buffer as ArrayBuffer, inputBackingCopyBytes: needsCopy ? bytes.byteLength : 0, encodeMs: performance.now() - started };
}
function dispose(): void { for (const { client } of clients.values()) client.dispose(); clients.clear(); }
async function prepare(scenario: { turns?: number; textBytes?: number; edits?: number; unicode?: boolean; semanticEdges?: boolean; }): Promise<void> {
	dispose();
	method = scenario.edits === undefined ? 'session/thread/read' : 'syntax/query';
	workload = scenario.edits === undefined ? threadWorkload(scenario.turns!, scenario.textBytes!, scenario.unicode) : numericWorkload(scenario.edits);
	if (scenario.semanticEdges) {
		const edge = workload as ReturnType<typeof threadWorkload>;
		edge.thread.title = 'Surrogate: \ud800';
		edge.thread.usage.inputTokens = { reported: Number.MAX_SAFE_INTEGER, complete: false };
		Object.assign(edge.thread.usage.inputTokens, { futureCounter: '18446744073709551615', '\udfff': 'surrogate-key' });
		Object.defineProperty(edge.thread.usage.inputTokens, '__proto__', { value: { safe: true }, enumerable: true });
	}
	for (const codec of ['json', 'json-bytes', 'protobuf'] as const) {
		const decoder = new PrototypeDecoder(); const carrier = new Carrier(); const client = new AppServerProtocolClient(carrier, {}, decoder);
		clients.set(codec, { decoder, carrier, client }); await client.connect();
	}
}
async function run(codec: Codec) {
	const { client, decoder, carrier } = clients.get(codec)!;
	const pending = method === 'session/thread/read' ? client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' })
		: client.request(APP_SERVER_METHODS['syntax/query'], { documentId: 'syntax', operationId: 'prototype', revision: 2, kind: 'highlight', factsRevision: null, factsTabSize: null, ranges: [], tabSize: 4, lineIndex: null, lines: [] });
	const encoded = wire(codec, { jsonrpc: '2.0', id: carrier.requestId, result: workload }, method);
	const frame = decoder.enqueue(encoded);
	const gaps: number[] = [];
	let previous = performance.now();
	const heartbeat = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 1);
	try {
		const start = performance.now();
		carrier.emit(WEB_APP_SERVER_FRAME_EVENT, frame);
		const dispatchMs = performance.now() - start;
		const result = await pending;
		const throughResponseMs = performance.now() - start;
		const maxTimerGapMs = Math.max(performance.now() - previous, 0, ...gaps);
		clearInterval(heartbeat);
		const stats = decoder.latest!;
		await stats.metrics;
		// Content comparison and timer tail are outside response timing. It checks
		// the complete result, including both repeated copies and optional fields.
		clearInterval(heartbeat);
		check(equals(result, workload), 'Codec changed the complete response');
		check(client.state === 'ready', 'Client did not stay ready');
		check(codec === 'json' || stats.synchronous || stats.inputDetached, 'Input buffer was copied instead of transferred');
		document.querySelector('output')!.textContent = `${codec}:${encoded.bytes}`;
		return { codec, bytes: encoded.bytes, encodeMs: encoded.encodeMs, inputBackingCopyBytes: encoded.inputBackingCopyBytes, workerUsed: !stats.synchronous, throughResponseMs, encodeAndResponseMs: encoded.encodeMs + throughResponseMs, dispatchMs, maxTimerGapMs, inputSendMs: stats.inputSendMs, inputDetached: stats.inputDetached, returnDeliveryMs: stats.returnDeliveryMs, serializeMs: stats.serializeMs, ...stats.timing };
	} finally { clearInterval(heartbeat); }
}

function contractChecks(): number {
	let checks = 0;
	function roundTrip(message: unknown, resultMethod?: AppServerMethod): unknown {
		const value = normalizePrototype(parsePrototype(encodePrototype(message, resultMethod)));
		check(equals(value, message), 'Prototype did not preserve the JSON value'); checks++; return value;
	}
	const read = threadWorkload(2, 8, true);
	Object.assign(read.thread.usage.inputTokens, { futureCounter: '18446744073709551615' });
	read.thread.usage.inputTokens.complete = false;
	Object.assign(read.thread.usage.inputTokens, { '\udfff': 'surrogate-key' });
	Object.defineProperty(read.thread.usage.inputTokens, '__proto__', { value: { safe: true }, enumerable: true });
	Object.assign(read.thread, { empty: '', off: false, zero: 0, explicitNull: null, nested: { list: [null, false, 0, '', '\ud800', '\udfff'] } });
	const negativeZero = threadWorkload(0, 0);
	negativeZero.thread.usage.inputTokens.reported = -0;
	for (const result of [read, threadWorkload(0, 0), negativeZero]) {
		const message = { jsonrpc: '2.0', id: 2, result };
		decodeAppServerMessage(roundTrip(message, 'session/thread/read'), { firstRequestId: 1, methods: [[2, 'session/thread/read']] });
	}
	roundTrip({ jsonrpc: '2.0', id: '18446744073709551615', error: { code: -32601, message: 'No method', data: null } });
	const malformed: unknown[] = [
		{ ...read, thread: { ...read.thread, turns: undefined } },
		{ ...read, thread: { ...read.thread, usage: { ...read.thread.usage, inputTokens: { reported: -1, complete: false } } } },
		{ ...read, thread: { ...read.thread, usage: { ...read.thread.usage, inputTokens: { reported: Number.MAX_SAFE_INTEGER + 1, complete: true } } } },
		{ ...read, thread: { ...read.thread, turns: [{ ...read.thread.turns[0], kind: 'future' }] } },
	];
	for (const result of malformed) {
		const message = JSON.parse(JSON.stringify({ jsonrpc: '2.0', id: 2, result }));
		for (const value of [message, roundTrip(message, 'session/thread/read')]) {
			let rejected = false; try { decodeAppServerMessage(value, { firstRequestId: 1, methods: [[2, 'session/thread/read']] }); } catch { rejected = true; }
			check(rejected, 'Malformed result passed schema validation'); checks++;
		}
	}
	for (const tuple of [[0, 0, 0], [0, 0, 0, 0, -1, 0], [0, 0, 0, 0, 0.5, 0], [0, 0, 0, 0, Number.MAX_SAFE_INTEGER + 1, 0]]) {
		const result = numericWorkload(1); Object.assign(result.facts!, { edits: [tuple] });
		const message = { jsonrpc: '2.0', id: 2, result };
		for (const value of [message, roundTrip(message, 'syntax/query')]) {
			let rejected = false; try { decodeAppServerMessage(value, { firstRequestId: 1, methods: [[2, 'syntax/query']] }); } catch { rejected = true; }
			check(rejected, 'Malformed packed coordinates passed schema validation'); checks++;
		}
	}
	const unsafe = parsePrototype(encodePrototype({ jsonrpc: '2.0', id: 2, result: threadWorkload(0, 0) }, 'session/thread/read')) as { threadRead: { thread: { usage: { inputTokens: { reported: unknown; }; }; }; }; };
	unsafe.threadRead.thread.usage.inputTokens.reported = '18446744073709551615';
	const unsafeValue = normalizePrototype(parsePrototype(ashCodecPrototype.Envelope.encode(unsafe).finish()));
	let unsafeRejected = false;
	try { decodeAppServerMessage(unsafeValue, { firstRequestId: 1, methods: [[2, 'session/thread/read']] }); }
	catch (error) { unsafeRejected = (error as { path?: string; }).path === '$.result.thread.usage.inputTokens.reported'; }
	check(unsafeRejected, 'Raw uint64 exceeded the unchanged safe-integer contract'); checks++;
	for (const invalid of [new Uint8Array([10, 1, 255]), new Uint8Array([10, 20, 65]), new Uint8Array([...encodePrototype({ jsonrpc: '2.0' }), 248, 127, 1])]) {
		let rejected = false; try { normalizePrototype(parsePrototype(invalid)); } catch { rejected = true; }
		check(rejected, 'Malformed Protobuf was accepted'); checks++;
	}
	return checks;
}

async function interactionChecks(codec: Codec) {
	await prepare({ turns: 128, textBytes: 4096 });
	const { client, decoder, carrier } = clients.get(codec)!;
	const receive = (message: unknown, resultMethod?: string): AppServerFrame => {
		const frame = decoder.enqueue(wire(codec, message, resultMethod)); carrier.emit(WEB_APP_SERVER_FRAME_EVENT, frame); return frame;
	};
	let started!: () => void; const didStart = new Promise<void>(resolve => { started = resolve; });
	let finish!: (value: { targetId: string; }) => void;
	let signal: AbortSignal | undefined;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => { signal = context.signal; started(); return new Promise(resolve => { finish = resolve; }); });
	const host = receive({ jsonrpc: '2.0', id: 'approval', method: 'browser/create', params: { threadId: '00000000-0000-4000-8000-000000000001', url: 'https://example.test' } });
	await host.consumed; await didStart;
	decoder.paused = true;
	const pending = client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' });
	const first = receive({ jsonrpc: '2.0', id: carrier.requestId, result: workload }, 'session/thread/read');
	const cancel = receive({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'approval' } });
	check(!signal!.aborted, 'Cancellation overtook the held response');
	decoder.release();
	check(equals(await pending, workload), 'Response changed during cancellation'); await first.consumed; await cancel.consumed;
	check(signal!.aborted, 'Host approval was not cancelled'); finish({ targetId: 'late' });
	await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
	check(equals(carrier.replies, [{ jsonrpc: '2.0', id: 'approval', error: { code: -32800, message: 'Host request cancelled', data: null } }]), 'Late host completion sent a duplicate reply');
	decoder.paused = true;
	const retired = client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' }).then(() => false, () => true);
	const retiredId = carrier.requestId;
	const old = receive({ jsonrpc: '2.0', id: retiredId, result: workload }, 'session/thread/read');
	client.disconnect(); check(await retired, 'Retirement did not reject pending'); await old.consumed;
	await client.connect(); decoder.paused = false;
	await receive({ jsonrpc: '2.0', id: retiredId, result: workload }, 'session/thread/read').consumed;
	check(client.state === 'ready', 'Retired response affected the replacement connection');
	const broken = client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' }).then(() => false, () => true);
	const input: Input = codec === 'protobuf' ? { codec, input: new Uint8Array([10, 20, 65]).buffer, bytes: 3 } : { codec, input: codec === 'json' ? '{' : new TextEncoder().encode('{').buffer, bytes: 1 };
	const badFrame = decoder.enqueue(input); carrier.emit(WEB_APP_SERVER_FRAME_EVENT, badFrame);
	check(await broken, 'Malformed wire did not reject pending'); await badFrame.consumed;
	check(String(client.state) === 'crashed', 'Malformed wire did not close the connection');
	return { cancelledOnce: true, retired: true, malformedConsumptionSettled: true };
}

async function creditAndOrdering(codec: Codec) {
	await prepare({ turns: 128, textBytes: 4096 });
	const { client, decoder, carrier } = clients.get(codec)!;
	decoder.paused = true;
	const received: string[] = [];
	using listener = client.onNotification(notification => { check(notification.method === 'session/deleted', 'Unexpected notification'); received.push(notification.params.sessionId); });
	const pending = client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: 'session', threadId: 'thread' });
	const packets = [wire(codec, { jsonrpc: '2.0', id: carrier.requestId, result: workload }, 'session/thread/read'), ...Array.from({ length: 20 }, (_, index) => wire(codec, { jsonrpc: '2.0', method: 'session/deleted', params: { sessionId: String(index) } }))];
	let cursor = 0; let outstanding = 0; let maxOutstanding = 0; let acknowledgements = 0;
	let finish!: () => void; let fail!: (error: Error) => void;
	const allConsumed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
	const completed = Promise.all([pending, allConsumed]);
	using state = client.onStateChange((value, error) => { if (value === 'crashed' && received.length !== 20) fail(error ?? new Error('Carrier failed before draining')); });
	const pump = (): void => {
		document.querySelector('output')!.textContent = `${codec}: sent=${cursor} ack=${acknowledgements} received=${received.length} state=${client.state}`;
		while (outstanding < 4 && cursor < packets.length) {
			const frame = decoder.enqueue(packets[cursor++]); outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
			check(client.state === 'ready', `Carrier resumed after unexpected close: ${codec}/${cursor}/${acknowledgements}`);
			carrier.emit(WEB_APP_SERVER_FRAME_EVENT, frame);
			void (frame.consumed ?? Promise.resolve()).then(() => { outstanding--; acknowledgements++; pump(); if (acknowledgements === packets.length) finish(); });
		}
		if (cursor === packets.length) carrier.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Peer EOF' });
	};
	pump();
	check(cursor === 4 && acknowledgements === 0 && received.length === 0, 'Held Worker prematurely returned read credit');
	decoder.release();
	const [result] = await completed;
	check(equals(result, workload), 'Response was lost before EOF');
	check(Number(received.length) === 20 && received.every((value, index) => value === String(index)), 'Notifications were reordered or dropped');
	check(client.state === 'crashed', 'EOF did not retire the connection');
	return { maxOutstanding, acknowledgements, notifications: received.length, state: client.state };
}

declare global { interface Window { ashAppServerCodec: { prepare: typeof prepare; run: typeof run; contractChecks: typeof contractChecks; creditAndOrdering: typeof creditAndOrdering; interactionChecks: typeof interactionChecks; dispose: typeof dispose; }; } }
window.ashAppServerCodec = { prepare, run, contractChecks, creditAndOrdering, interactionChecks, dispose };
