import assert from 'node:assert/strict';
import { test } from 'mocha';
import { PCM_FLUSH_ACK, wirePcmCapturePort, type IPcmCapturePort, type IPcmCaptureTimers } from '../../browser/pcmCaptureWorklet.js';

test('PCM flush shares its barrier, preserves earlier samples and handles synchronous acknowledgment', async () => {
	const received: number[][] = [];
	let requests = 0;
	const port: IPcmCapturePort = { onmessage: null, postMessage: () => { requests++; } };
	const send = (data: unknown) => port.onmessage?.call(port as MessagePort, { data } as MessageEvent);
	const capture = wirePcmCapturePort(port, globalThis as unknown as IPcmCaptureTimers, samples => received.push([...samples]));
	send(new Float32Array([0.25, -0.5]));
	const first = capture.flush();
	assert.equal(capture.flush(), first);
	send(new Float32Array([1]));
	send({ type: PCM_FLUSH_ACK });
	await first;
	port.postMessage = () => { requests++; send({ type: PCM_FLUSH_ACK }); };
	await capture.flush();
	await capture.flush();
	assert.equal(requests, 3);
	assert.deepEqual(received, [[0.25, -0.5], [1]]);
	port.onmessage = null;
});

test('PCM ignores malformed worker packets and flush timeout releases an unresponsive worklet', async () => {
	const chunks: number[][] = [];
	const port: IPcmCapturePort = { onmessage: null, postMessage: () => { } };
	const capture = wirePcmCapturePort(port, globalThis as unknown as IPcmCaptureTimers, samples => chunks.push([...samples]));
	for (const data of [new ArrayBuffer(3), new Float32Array([NaN]), new Float32Array(16001), { samples: [1] }, new Float32Array([0.5]).buffer]) {
		port.onmessage?.call(port as MessagePort, { data } as MessageEvent);
	}
	await capture.flush();
	assert.deepEqual(chunks, [[0.5]]);
	port.onmessage = null;
});
