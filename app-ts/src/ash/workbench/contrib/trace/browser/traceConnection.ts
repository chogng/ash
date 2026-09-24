import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

type JsonObject = { readonly [key: string]: unknown };

export interface TraceSpan {
	readonly key: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId: string;
	readonly name: string;
	readonly outcome: string;
	readonly start: bigint;
	readonly end: bigint;
	readonly resource: JsonObject;
	readonly scope: JsonObject;
	readonly data: JsonObject;
	readonly bytes: number;
}

export type TraceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'configurationError' | 'connectionError' | 'protocolError';
const maxFrameBytes = 64 * 1024;
const maxSpans = 2000;
const maxRetainedBytes = 8 * 1024 * 1024;

/** Owns bounded local trace data. Timestamps stay as integers until converted to relative durations. */
export class TraceBuffer {
	private readonly entries = new Map<string, TraceSpan>();
	private bytes = 0;
	dropped = 0;

	get spans(): readonly TraceSpan[] { return [...this.entries.values()].sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.key.localeCompare(b.key)); }

	append(spans: readonly TraceSpan[]): void {
		for (const span of spans) {
			const previous = this.entries.get(span.key);
			if (previous) { this.bytes -= previous.bytes; this.entries.delete(span.key); }
			this.entries.set(span.key, span);
			this.bytes += span.bytes;
			while (this.entries.size > maxSpans || this.bytes > maxRetainedBytes) {
				const oldest = this.entries.values().next().value!;
				this.bytes -= oldest.bytes;
				this.entries.delete(oldest.key);
				this.dropped++;
			}
		}
	}

	clear(): void { this.entries.clear(); this.bytes = 0; this.dropped = 0; }
}

/** Standard OTLP ExportTraceServiceRequest JSON, including only the spans supplied by the caller. */
export function exportTrace(spans: readonly TraceSpan[]): string {
	return JSON.stringify({ resourceSpans: spans.map(span => ({
		...span.resource, scopeSpans: [{ ...span.scope, spans: [span.data] }],
	})) }, null, 2);
}

/** The wire boundary validates the values consumed by the viewer; unknown OTLP fields are preserved on export. */
export function decodeTrace(value: unknown): TraceSpan[] {
	const request = object(value);
	return array(request.resourceSpans).flatMap(resourceValue => {
		const resource = object(resourceValue);
		return array(resource.scopeSpans).flatMap(scopeValue => {
			const scope = object(scopeValue);
			return array(scope.spans).map(spanValue => {
				const data = object(spanValue);
				const traceId = identifier(data.traceId, 32);
				const spanId = identifier(data.spanId, 16);
				const parentSpanId = data.parentSpanId === undefined || data.parentSpanId === '' ? '' : identifier(data.parentSpanId, 16, true);
				const start = timestamp(data.startTimeUnixNano);
				const end = timestamp(data.endTimeUnixNano);
				if (end < start || typeof data.name !== 'string') { throw new Error('Invalid span'); }
				const attributes = data.attributes === undefined ? [] : array(data.attributes).map(object);
				const outcomeValue = attributes.find(attribute => attribute.key === 'outcome')?.value;
				const outcome = outcomeValue === undefined ? '' : object(outcomeValue).stringValue;
				if (typeof outcome !== 'string') { throw new Error('Invalid outcome'); }
				const { scopeSpans: _, ...resourceMetadata } = resource;
				const { spans: __, ...scopeMetadata } = scope;
				return {
					key: traceId + ':' + spanId, traceId, spanId, parentSpanId, name: data.name, outcome, start, end,
					resource: resourceMetadata, scope: scopeMetadata, data,
					bytes: new TextEncoder().encode(JSON.stringify([resourceMetadata, scopeMetadata, data])).byteLength,
				};
			});
		});
	});
}

export function traceEndpoint(address: string, token: string): URL {
	const url = new URL(address);
	if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
		url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[0-9a-fA-F]{64}$/.test(token)) {
		throw new Error('Invalid trace configuration');
	}
	return url;
}

/** A pane owns its live connection; no credentials or traces enter editor persistence. */
export class TraceConnection extends Disposable {
	readonly buffer = new TraceBuffer();
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private socket: WebSocket | undefined;
	private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
	state: TraceConnectionState = 'disconnected';

	connect(address: string, token: string): void {
		this.disconnect();
		let url: URL;
		try { url = traceEndpoint(address, token); }
		catch { this.state = 'configurationError'; this.changed.fire(); return; }
		this.buffer.clear();
		this.state = 'connecting';
		let socket: WebSocket;
		try { socket = new WebSocket(url, ['ash-trace-v2', 'ash-trace-token.' + token.toLowerCase()]); }
		catch { this.state = 'connectionError'; this.changed.fire(); return; }
		this.socket = socket;
		this.handshakeTimer = setTimeout(() => this.fail('connectionError'), 5000);
		socket.onmessage = event => {
			try {
				if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > maxFrameBytes) { throw new Error('Invalid frame'); }
				const value = object(JSON.parse(event.data));
				if (this.state === 'connecting') {
					if (socket.protocol !== 'ash-trace-v2' || value.type !== 'ready' || value.version !== 2 || value.format !== 'otlp-json') { throw new Error('Invalid handshake'); }
					clearTimeout(this.handshakeTimer);
					this.handshakeTimer = undefined;
					this.state = 'connected';
				} else if (value.type === 'lagged') {
					if (!Number.isSafeInteger(value.dropped) || (value.dropped as number) < 1) { throw new Error('Invalid loss count'); }
					this.buffer.dropped += value.dropped as number;
				} else {
					this.buffer.append(decodeTrace(value));
				}
				this.changed.fire();
			} catch { this.fail('protocolError'); }
		};
		socket.onerror = () => this.fail('connectionError');
		socket.onclose = () => { this.disconnect(); };
		this.changed.fire();
	}

	disconnect(): void {
		clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
		if (this.socket) {
			this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
			this.socket.close();
			this.socket = undefined;
		}
		this.state = 'disconnected';
		this.changed.fire();
	}

	clear(): void { this.buffer.clear(); this.changed.fire(); }
	private fail(state: TraceConnectionState): void { this.disconnect(); this.state = state; this.changed.fire(); }
	protected override disposeCore(): void { this.disconnect(); super.disposeCore(); }
}

function object(value: unknown): JsonObject {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('Expected object'); }
	return value as JsonObject;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) { throw new Error('Expected array'); }
	return value;
}
function identifier(value: unknown, length: number, allowZero = false): string {
	if (typeof value !== 'string' || value.length !== length || !/^[0-9a-fA-F]+$/.test(value) || (!allowZero && /^0+$/.test(value))) { throw new Error('Invalid identifier'); }
	return value.toLowerCase();
}
function timestamp(value: unknown): bigint {
	if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) { throw new Error('Invalid timestamp'); }
	const result = BigInt(value);
	if (result > 18446744073709551615n) { throw new Error('Invalid timestamp'); }
	return result;
}
