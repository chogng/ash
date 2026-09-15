import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { attachWebAppServer, isAllowedWebOrigin } from '../../node/webAppServer.js';
import { WEB_APP_SERVER_PROTOCOL_VERSION, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT } from '../../common/appServerTransport.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

suite('Web App Server', function () {
	this.timeout(10_000);
	for (const disconnectFirst of [false, true]) {
		test(`releases connection processes and their workspace after ${disconnectFirst ? 'browser disconnect' : 'server shutdown'}`, async () => {
			const workspaceRoot = await mkdtemp(join(tmpdir(), 'ash-web-transport-'));
			// Node executes this fixture when the connection carrier is launched with "connect".
			await writeFile(join(workspaceRoot, 'connect'), 'require("node:fs").writeFileSync(process.pid + ".pid", ""); process.stdin.pipe(process.stdout);');
			const server = createServer();
			const dispose = attachWebAppServer(server, { workspaceRoot, profileRoot: join(workspaceRoot, 'profile'), executable: process.execPath, appServer: process.execPath, ripgrep: process.execPath });
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			const address = server.address();
			assert.ok(address && typeof address === 'object');
			const origin = `http://127.0.0.1:${address.port}`;
			const clients = [new WebSocket(`${origin}/ash/app-server`, { origin }), new WebSocket(`${origin}/ash/app-server`, { origin })];
			try {
				await Promise.all(clients.map(client => once(client, 'open')));
				for (const [index, client] of clients.entries()) {
					const connected = once(client, 'message');
					client.send(JSON.stringify({ event: WEB_APP_SERVER_CONNECT_EVENT, payload: { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION } }));
					const [message] = await connected;
					assert.equal(JSON.parse(message.toString()).event, WEB_APP_SERVER_CONNECTED_EVENT);
					const echoed = once(client, 'message');
					const frame = JSON.stringify({ id: index, method: 'fixture' });
					client.send(JSON.stringify({ event: WEB_APP_SERVER_FRAME_EVENT, payload: { frame } }));
					const [response] = await echoed;
					assert.deepEqual(JSON.parse(response.toString()), { event: WEB_APP_SERVER_FRAME_EVENT, payload: { frame } });
				}
				const closed = clients.map(client => once(client, 'close'));
				const pids = (await readdir(workspaceRoot)).filter(name => name.endsWith('.pid')).map(name => Number(name.slice(0, -4)));
				assert.equal(pids.length, 2);
				if (disconnectFirst) {
					for (const client of clients) client.close();
					await Promise.all(closed);
				}
				const disposal = dispose();
				assert.equal(dispose(), disposal);
				await disposal;
				await Promise.all(closed);
				for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
			} finally {
				await dispose();
				for (const client of clients) client.terminate();
				await new Promise<void>(resolve => server.close(() => resolve()));
				await rm(workspaceRoot, { recursive: true, force: true });
			}
		});
	}

	test('rejects cross-origin upgrades before opening a backend connection', async () => {
		const server = createServer();
		const dispose = attachWebAppServer(server, { workspaceRoot: tmpdir(), profileRoot: tmpdir(), appServer: process.execPath, executable: process.execPath, ripgrep: process.execPath });
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}/ash/app-server`, { origin: 'https://example.com' });
		try {
			const [error] = await once(client, 'error');
			assert.match(error.message, /403/);
		} finally {
			client.terminate();
			await dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('reports startup failure and rejects malformed transport messages', async () => {
		const server = createServer();
		const dispose = attachWebAppServer(server, { workspaceRoot: tmpdir(), profileRoot: tmpdir(), appServer: process.execPath, executable: join(tmpdir(), 'ash-missing-carrier', 'missing'), ripgrep: process.execPath });
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		const origin = `http://127.0.0.1:${address.port}`;
		const client = new WebSocket(`${origin}/ash/app-server`, { origin });
		try {
			await once(client, 'open');
			const failed = once(client, 'message');
			client.send(JSON.stringify({ event: WEB_APP_SERVER_CONNECT_EVENT, payload: { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION } }));
			const [message] = await failed;
			assert.match(JSON.parse(message.toString()).payload.message, /Packaged Ash binary is missing/);
			const closed = once(client, 'close');
			client.send('{');
			const [code] = await closed;
			assert.equal(code, 1008);
		} finally {
			client.terminate();
			await dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("accepts only same-origin loopback WebSocket clients", () => {
		assert.equal(isAllowedWebOrigin("http://127.0.0.1:5173", "127.0.0.1:5173"), true);
		assert.equal(isAllowedWebOrigin("http://localhost:5173", "localhost:5173"), true);
		assert.equal(isAllowedWebOrigin("http://127.0.0.1:5174", "127.0.0.1:5173"), false);
		assert.equal(isAllowedWebOrigin("https://example.com", "example.com"), false);
		assert.equal(isAllowedWebOrigin(undefined, "127.0.0.1:5173"), false);
	});
});
