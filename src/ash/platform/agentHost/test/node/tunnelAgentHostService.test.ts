import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IAppServerByteTransport } from '../../common/appServerTransport.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TunnelAgentHostService } from '../../node/tunnelAgentHostService.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('an authenticated Tunnel carrier has one relay owner and preserves flow-controlled JSONL bytes', async () => {
	const upgraded = new DeferredPromise<Duplex>();
	const sockets = new Set<Duplex>();
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ token: 'b'.repeat(64), workspaceId: 'one', workspaceRoot: '/repo', workspace: { id: 'one', configuration: null, folders: [{ id: 'one', path: '/repo', name: null }] } }));
	});
	server.on('upgrade', (request, socket) => {
		sockets.add(socket);
		assert.equal(request.headers['sec-websocket-protocol'], `ash-session.${'b'.repeat(64)}`);
		const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${request.headers['sec-websocket-protocol']}\r\n\r\n`);
		void upgraded.complete(socket);
	});
	try {
		server.listen(0, '127.0.0.1'); await once(server, 'listening');
		using service = new TunnelAgentHostService(`http://127.0.0.1:${(server.address() as { port: number; }).port}/`, 'a'.repeat(64));
		await service.acquire(new AbortController().signal);
		using relay = new MutableDisposable<IAppServerByteTransport>();
		relay.value = await service.openTransport();
		const socket = await upgraded.p;
		const received = new DeferredPromise<Uint8Array>();
		using listener = relay.value.onData(bytes => { void received.complete(bytes); });
		relay.value.pause();
		const text = '{"message":"中文"}';
		const payload = Buffer.from(text);
		socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
		relay.value.resume();
		assert.equal(Buffer.from(await received.p).toString(), `${text}\n`);
		relay.clear();
	} finally {
		for (const socket of sockets) socket.destroy();
		server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('Tunnel exchanges its ticket once, renews using a transient token, and rejects workspace changes and revocation', async () => {
	const requests: { origin: string | undefined; authorization: string | undefined; body: string; }[] = [];
	let workspaceRoot = '/repo';
	let revoked = false;
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const bytes of request) body += bytes;
		requests.push({ origin: request.headers.origin, authorization: request.headers.authorization, body });
		response.writeHead(revoked ? 401 : 200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ token: 'b'.repeat(64), workspaceId: 'one', workspaceRoot, workspace: { id: 'one', configuration: null, folders: [{ id: 'one', path: workspaceRoot, name: null }] } }));
	});
	try {
		server.listen(0, '127.0.0.1'); await once(server, 'listening');
		const endpoint = `http://127.0.0.1:${(server.address() as { port: number; }).port}/`;
		using service = new TunnelAgentHostService(endpoint, 'a'.repeat(64));
		assert.equal(await service.acquire(new AbortController().signal), '/repo');
		await service.validate();
		assert.deepEqual(requests, [
			{ origin: new URL(endpoint).origin, authorization: undefined, body: 'a'.repeat(64) },
			{ origin: new URL(endpoint).origin, authorization: `Bearer ${'b'.repeat(64)}`, body: '' },
		]);
		workspaceRoot = '/other';
		await assert.rejects(service.validate(), /workspace changed/);
		revoked = true;
		await assert.rejects(service.validate(), /expired or was revoked/);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Tunnel cancellation aborts outstanding authentication without retaining a connection', async () => {
	const entered = new DeferredPromise<void>();
	const server = createServer(() => { void entered.complete(); });
	try {
		server.listen(0, '127.0.0.1'); await once(server, 'listening');
		using service = new TunnelAgentHostService(`http://127.0.0.1:${(server.address() as { port: number; }).port}/`, 'a'.repeat(64));
		const controller = new AbortController();
		const result = service.acquire(controller.signal);
		const rejected = assert.rejects(result, error => error instanceof Error && error.name === 'AbortError');
		await entered.p;
		controller.abort();
		await rejected;
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
