import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ProcessRun } from './processes.ts';

const root = resolve(import.meta.dirname, '..');

async function observer() {
	const sockets = new Set<Socket>();
	const connected = Promise.withResolvers<{ socket: Socket; closed: Promise<unknown>; }>();
	const server = createServer(socket => {
		sockets.add(socket);
		connected.resolve({ socket, closed: once(socket, 'close') });
	});
	await new Promise<void>((resolveReady, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolveReady);
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return {
		port: address.port, connected: connected.promise,
		async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); },
	};
}

const enabled = { skip: process.platform === 'win32', timeout: 15_000 };

test('command group retains descendants after the command exits and leaves unrelated children alone', enabled, async t => {
	const connection = await observer();
	t.after(() => connection.close());
	const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
	t.after(async () => { if (unrelated.exitCode === null && unrelated.signalCode === null) { const exited = once(unrelated, 'exit'); unrelated.kill(); await exited; } });
	const run = new ProcessRun(root);
	t.after(() => run.close());
	const helper = `require('node:net').createConnection({host:'127.0.0.1', port:${connection.port}}); setInterval(() => {}, 1000);`;
	const result = await run.command(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio:'ignore'}); process.exit(0);`], process.env);
	assert.equal(result.code, 0);
	const { closed } = await connection.connected;
	await run.close();
	await closed;
	assert.equal(unrelated.exitCode, null);
	assert.equal(unrelated.signalCode, null);
});

test('command group force-stops a command that ignores graceful termination', enabled, async t => {
	const connection = await observer();
	t.after(() => connection.close());
	const run = new ProcessRun(root, undefined, 100);
	t.after(() => run.close());
	const pending = run.command(process.execPath, ['-e', `process.on('SIGTERM', () => {}); require('node:net').createConnection({host:'127.0.0.1',port:${connection.port}}); setInterval(() => {}, 1000);`], process.env);
	const { closed } = await connection.connected;
	await run.stop('SIGTERM');
	assert.equal((await pending).code, 143);
	await closed;
	await assert.rejects(run.command(process.execPath, ['-e', 'process.exit(0)'], process.env), /refusing to start/u);
});

test('command group forwards capture, cwd, environment and concurrent exit codes', enabled, async t => {
	const run = new ProcessRun(root);
	t.after(() => run.close());
	const results = await Promise.all([
		run.command(process.execPath, ['-e', 'console.log(process.cwd()); console.log(process.env.ASH_GROUP_FIXTURE); process.exit(7);'], { ...process.env, ASH_GROUP_FIXTURE: 'fixture-value' }, true),
		run.command(process.execPath, ['-e', 'console.log("second");'], process.env, true),
	]);
	assert.deepEqual(results, [{ code: 7, output: root + '\nfixture-value\n' }, { code: 0, output: 'second\n' }]);
});

test('invalid command startup leaves other owned commands supervised', enabled, async t => {
	const connection = await observer();
	t.after(() => connection.close());
	const run = new ProcessRun(root);
	t.after(() => run.close());
	const running = run.command(process.execPath, ['-e', `require('node:net').createConnection({host:'127.0.0.1',port:${connection.port}}); setInterval(() => {}, 1000);`], process.env);
	const { closed } = await connection.connected;
	await assert.rejects(run.command(process.execPath, ['invalid\0argument'], process.env), /null bytes/u);
	assert.deepEqual(await run.command(process.execPath, ['-e', 'console.log("still supervised")'], process.env, true), { code: 0, output: 'still supervised\n' });
	await run.close();
	await running;
	await closed;
});

test('command output streams before completion and preserves Unicode on both channels', enabled, async t => {
	const run = new ProcessRun(root);
	t.after(() => run.close());
	const ready = Promise.withResolvers<void>();
	const output = { stdout: '', stderr: '' };
	const pending = run.command(process.execPath, ['-e', `
process.stdout.write('编译');
process.stderr.write('诊断');
setInterval(() => {}, 1000);
`], process.env, false, 'ignore', (stream, data) => {
		output[stream] += data;
		if (output.stdout === '编译' && output.stderr === '诊断') ready.resolve();
	});
	await ready.promise;
	await run.stop('SIGTERM');
	assert.equal((await pending).code, 143);
	assert.deepEqual(output, { stdout: '编译', stderr: '诊断' });
});


test('command group tears down helpers when its owner is killed without cleanup', enabled, async t => {
	const connection = await observer();
	t.after(() => connection.close());
	const task = `require('node:net').createConnection({host:'127.0.0.1',port:${connection.port}}); setInterval(() => {}, 1000);`;
	const owner = spawn(process.execPath, ['--input-type=module', '-e', `
import { ProcessRun } from ${JSON.stringify(pathToFileURL(resolve(root, 'build/processes.ts')).href)};
await new ProcessRun(${JSON.stringify(root)}).command(process.execPath, ['-e', ${JSON.stringify(task)}], process.env);
`], { stdio: 'ignore' });
	t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited; } });
	const { closed } = await connection.connected;
	const exited = once(owner, 'exit');
	owner.kill('SIGKILL');
	await exited;
	await closed;
});
