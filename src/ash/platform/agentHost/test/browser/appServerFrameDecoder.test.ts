import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AppServerFrameDecoder } from '../../browser/appServerFrameDecoder.js';
import {
	appServerDecodeHandler,
	decodeAppServerFrame,
	readDecodedAppServerFrame,
	type AppServerDecodeContext,
} from '../../browser/appServerProtocolDecoding.js';
import { TestAppServerDecodePort } from '../common/testAppServerDecoder.js';

ensureNoDisposablesAreLeakedInTestSuite();

const context: AppServerDecodeContext = { firstRequestId: 2, methods: [[2, 'session/list']] };
const response = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessions: [] } });

test('small frames decode synchronously and the Worker is lazy and reused for large frames', async () => {
	const ports: TestAppServerDecodePort[] = [];
	using decoder = new AppServerFrameDecoder(() => {
		const port = new TestAppServerDecodePort();
		ports.push(port);
		return port;
	});
	assert.deepEqual(decoder.decode(response, 256 * 1024 - 1, context), decodeAppServerFrame(response, context));
	assert.equal(ports.length, 0);
	for (let i = 0; i < 2; i++) {
		const result = decoder.decode(response, 256 * 1024, context);
		assert.ok(result instanceof Promise);
		assert.equal(ports.length, 1);
		await ports[0].release();
		assert.deepEqual(await result, decodeAppServerFrame(response, context));
	}
});

for (const value of [
	'{',
	JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessions: 'invalid' } }),
	JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessions: [] } }),
	JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: null } }),
])
	test('Worker rejects invalid JSON, schemas or response routing: ' + value.slice(0, 80), async () => {
		const port = new TestAppServerDecodePort();
		using decoder = new AppServerFrameDecoder(() => port);
		const rejected = assert.rejects(Promise.resolve(decoder.decode(value, 256 * 1024, context)));
		await port.release();
		await rejected;
	});

test('both paths preserve errors, cancellation, unknown host methods and retired responses', async () => {
	const port = new TestAppServerDecodePort();
	using decoder = new AppServerFrameDecoder(() => port);
	for (const value of [
		{ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'failure', data: { kind: 'InternalError' } } },
		{ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'approval' } },
		{
			jsonrpc: '2.0',
			id: 'approval',
			method: 'browser/create',
			params: { threadId: '00000000-0000-4000-8000-000000000001', url: 'https://example.test' },
		},
		{ jsonrpc: '2.0', id: 'future', method: 'future/method', params: {} },
		{ jsonrpc: '2.0', id: 1, result: {} },
	]) {
		const frame = JSON.stringify(value);
		const result = decoder.decode(frame, 256 * 1024, context);
		const completed = Promise.resolve(result).then(
			value => ({ value }),
			error => ({ error }),
		);
		await port.release();
		assert.deepEqual(await completed, { value: decodeAppServerFrame(frame, context) });
	}
});

test('Worker failure never falls back to synchronous parsing and reset retires pending work', async () => {
	const ports: TestAppServerDecodePort[] = [];
	using decoder = new AppServerFrameDecoder(() => {
		const port = new TestAppServerDecodePort();
		ports.push(port);
		return port;
	});
	const first = assert.rejects(Promise.resolve(decoder.decode(response, 256 * 1024, context)), /Worker failed/);
	ports[0].fail(new Error('Worker failed'));
	await first;
	decoder.reset();
	assert.equal(ports[0].isDisposed, true);
	const second = assert.rejects(Promise.resolve(decoder.decode(response, 256 * 1024, context)), /disposed/);
	decoder.reset();
	await second;
	assert.equal(ports[1].isDisposed, true);
	const third = decoder.decode(response, 256 * 1024, context);
	await ports[2].release();
	assert.deepEqual(await third, decodeAppServerFrame(response, context));
});

test('decode boundary rejects invalid context and result routing without walking typed payloads again', async () => {
	for (const invalid of [
		{ firstRequestId: 0, methods: [] },
		{ firstRequestId: 2, methods: [[2, 'unknown']] },
		{ firstRequestId: 2, methods: [[1, 'session/list']] },
	]) {
		await assert.rejects(
			appServerDecodeHandler.handleRequest({ frame: response, context: invalid }, new AbortController().signal),
		);
	}
	for (const invalid of [
		{ kind: 'retiredResponse', id: 2 },
		{ kind: 'response', method: 'session/list', response: { jsonrpc: '2.0', id: 3, result: {} } },
		{ kind: 'serverRequest', request: { jsonrpc: '2.0', id: 'x', method: 'unknown', params: {} } },
	]) {
		assert.throws(() => readDecodedAppServerFrame(invalid, context));
	}
});

test('canceled routing returns only an ID on both decoder paths and rejects unissued cancellation IDs', async () => {
	const canceled: AppServerDecodeContext = { ...context, canceledRequests: [2] };
	const frame = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ignored: 'x'.repeat(300_000) } });
	assert.deepEqual(decodeAppServerFrame(frame, canceled), { kind: 'retiredResponse', id: 2 });
	const port = new TestAppServerDecodePort();
	using decoder = new AppServerFrameDecoder(() => port);
	const result = decoder.decode(frame, 256 * 1024, canceled);
	await port.release();
	assert.deepEqual(await result, { kind: 'retiredResponse', id: 2 });
	for (const canceledRequests of [[3], 'invalid', [2, 3]]) {
		await assert.rejects(
			appServerDecodeHandler.handleRequest(
				{ frame, context: { ...context, canceledRequests } },
				new AbortController().signal,
			),
			/Invalid canceled/,
		);
	}
	assert.throws(() => readDecodedAppServerFrame({ kind: 'retiredResponse', id: 3 }, canceled));
	assert.throws(() =>
		decodeAppServerFrame(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {}, error: {} }), canceled),
	);
});
