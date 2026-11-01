import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import { IPCClient, type IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BrowserNetworkProxy } from '../../electron-main/browserNetworkProxy.js';

test('native SOCKS preserves remote DNS, fragmented frames, write backpressure and half close', async () => {
	const writes: number[] = [];
	const bytes: number[] = [];
	let ended = false;
	let responseSent = false;
	let closed = false;
	const channel: IChannel = {
		listen: () => { throw new Error('Unexpected event'); },
		call: async <T>(_command: string, value?: unknown): Promise<T> => {
			const arg = value as { host: string; port: number; dataBase64: string; };
			if (_command === 'open') { assert.equal(arg.host, 'remote.internal'); assert.equal(arg.port, 3000); }
			if (_command === 'write') { const data = Buffer.from(arg.dataBase64, 'base64'); const count = Math.min(3, data.length); bytes.push(...data.subarray(0, count)); writes.push(count); return count as T; }
			if (_command === 'end') { ended = true; }
			if (_command === 'close') { closed = true; }
			if (_command === 'read') {
				if (!ended) { return { dataBase64: '', eof: false } as T; }
				const value = responseSent ? new Uint8Array() : Buffer.from('reply after FIN');
				responseSent = true;
				return { dataBase64: Buffer.from(value).toString('base64'), eof: true } as T;
			}
			return undefined as T;
		},
	};
	using toMain = new Emitter<VSBuffer>();
	using toRenderer = new Emitter<VSBuffer>();
	using main = new IPCClient({ onMessage: toMain.event, send: bytes => toRenderer.fire(bytes) }, 'window');
	using renderer = new IPCClient({ onMessage: toRenderer.event, send: bytes => toMain.fire(bytes) }, 'main');
	renderer.registerChannel('network', { call: (_context, command, value) => channel.call(command, value), listen: () => { throw new Error('Unexpected event'); } });
	using lease = await new BrowserNetworkProxy(main.getChannel('network'), { authority: 'wsl+fixture' }).openProxy(new AbortController().signal);
	const socket = connect({ host: '127.0.0.1', port: lease.localPort, allowHalfOpen: true });
	const read = socket[Symbol.asyncIterator]();
	try {
		socket.write(Buffer.from([5])); socket.write(Buffer.from([1, 0]));
		assert.deepEqual((await read.next()).value, Buffer.from([5, 0]));
		const host = Buffer.from('remote.internal');
		socket.write(Buffer.from([5, 1, 0, 3, host.length])); socket.write(host); socket.write(Buffer.from([11, 184]));
		const handshake = await read.next();
		assert.equal(handshake.value[1], 0);
		socket.end(Buffer.from('request content'));
		const response: Buffer[] = [];
		for (let item = await read.next(); !item.done; item = await read.next()) { response.push(item.value); }
		assert.equal(Buffer.concat(response).toString(), 'reply after FIN');
		assert.equal(Buffer.from(bytes).toString(), 'request content');
		assert.equal(writes.length, 5);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(closed, true);
	} finally { socket.destroy(); }
});
