import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { BrowserSocketFactory, type IWebSocketCloseEvent } from '../../browser/browserSocketFactory.js';
import { WebSocketRemoteConnection } from '../../common/remoteAuthorityResolver.js';

test('browser socket preserves byte boundaries and closes failed and established connections', async () => {
	using data = new Emitter<ArrayBuffer>();
	using opened = new Emitter<void>();
	using closed = new Emitter<IWebSocketCloseEvent>();
	using errors = new Emitter<unknown>();
	let closes = 0;
	let url = '';
	const writes: Uint8Array[] = [];
	const factory = new BrowserSocketFactory({
		create(endpoint) {
			url = endpoint;
			return { onData: data.event, onOpen: opened.event, onClose: closed.event, onError: errors.event, close: () => { closes++; }, send: bytes => writes.push(new Uint8Array(bytes as ArrayBuffer)) };
		}
	});
	const connecting = factory.connect(new WebSocketRemoteConnection('::1', 9000), '/ash/app-server', 'connectionToken=capability', 'test');
	opened.fire();
	using socket = await connecting;
	assert.equal(url, 'ws://[::1]:9000/ash/app-server?connectionToken=capability');
	const received: Uint8Array[] = [];
	using listener = socket.onData(bytes => received.push(bytes.buffer));
	data.fire(Uint8Array.of(0, 255, 10).buffer);
	socket.write(VSBuffer.wrap(Uint8Array.of(240, 159, 152, 128)));
	assert.deepEqual(received, [Uint8Array.of(0, 255, 10)]);
	assert.deepEqual(writes, [Uint8Array.of(240, 159, 152, 128)]);
	socket.dispose();
	const failed = factory.connect(new WebSocketRemoteConnection('localhost', 9000), '', '', 'test');
	errors.fire(new Error('unreachable'));
	await assert.rejects(failed, /unreachable/);
	assert.equal(closes, 2);
});
