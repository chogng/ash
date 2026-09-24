import assert from 'node:assert/strict';
import { test } from 'mocha';
import { decodeTrace, exportTrace, TraceBuffer, traceEndpoint } from '../../browser/traceConnection.js';

function request(id = 1, name = 'rpc') {
	return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ash' } }] }, schemaUrl: 'resource-schema',
		scopeSpans: [{ scope: { name: 'ash' }, schemaUrl: 'scope-schema', spans: [{
			traceId: '0123456789abcdef0123456789abcdef', spanId: id.toString(16).padStart(16, '0'), parentSpanId: '00000000000000ff',
			name, startTimeUnixNano: '1700000000000000100', endTimeUnixNano: '1700000000000004300',
			status: { code: 1 }, attributes: [{ key: 'outcome', value: { stringValue: 'succeeded' } }],
		}] }],
	}] };
}

test('OTLP timestamps retain precision and export preserves resource, scope, status and parent IDs', () => {
	const input = request();
	const spans = decodeTrace(input);
	assert.equal(spans[0]!.end - spans[0]!.start, 4200n);
	assert.equal(spans[0]!.parentSpanId, '00000000000000ff');
	assert.equal(spans[0]!.outcome, 'succeeded');
	assert.deepEqual(JSON.parse(exportTrace(spans)), input);
});

test('retention evicts oldest spans by count and bytes and clearing resets loss', () => {
	const buffer = new TraceBuffer();
	for (let id = 1; id <= 2005; id++) { buffer.append(decodeTrace(request(id))); }
	assert.equal(buffer.spans.length, 2000);
	assert.equal(buffer.dropped, 5);
	buffer.append(decodeTrace(request(2005)));
	assert.equal(buffer.spans.length, 2000);
	assert.equal(buffer.dropped, 5);
	buffer.clear();
	for (let id = 1; id <= 300; id++) { buffer.append(decodeTrace(request(id, 'x'.repeat(60000)))); }
	assert.ok(buffer.spans.length < 150);
	assert.equal(buffer.spans.length + buffer.dropped, 300);
	buffer.clear();
	assert.equal(buffer.spans.length, 0);
	assert.equal(buffer.dropped, 0);
	assert.deepEqual(JSON.parse(exportTrace([])), { resourceSpans: [] });
});

test('untrusted trace data rejects invalid IDs, timestamps, structure and backwards spans', () => {
	for (const value of [null, {}, { resourceSpans: {} }, { resourceSpans: [null] }]) { assert.throws(() => decodeTrace(value)); }
	for (const update of [
		{ traceId: '00000000000000000000000000000000' }, { spanId: '../secret' }, { parentSpanId: 2 },
		{ startTimeUnixNano: 1700000000000000100 }, { startTimeUnixNano: '-1' },
		{ endTimeUnixNano: '18446744073709551616' }, { endTimeUnixNano: '0' },
	]) {
		const value = request();
		Object.assign(value.resourceSpans[0]!.scopeSpans[0]!.spans[0]!, update);
		assert.throws(() => decodeTrace(value));
	}
});

test('trace endpoint accepts numeric loopback only and never embeds authentication', () => {
	const token = 'a'.repeat(64);
	assert.equal(traceEndpoint('ws://127.0.0.1:4319/', token).href, 'ws://127.0.0.1:4319/');
	assert.equal(traceEndpoint('ws://[::1]:4319/', token).hostname, '[::1]');
	for (const address of ['wss://example.test/', 'ws://example.test/', 'ws://localhost/', 'ws://127.0.0.1/?token=x', 'ws://x@127.0.0.1/', 'ws://127.0.0.1/traces', 'ws://127.0.0.1/#x']) {
		assert.throws(() => traceEndpoint(address, token));
	}
	assert.throws(() => traceEndpoint('ws://127.0.0.1/', 'secret'), error => error instanceof Error && !error.message.includes('secret'));
});
