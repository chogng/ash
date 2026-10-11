import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startWeb } from './web.ts';

for (const succeeds of [true, false]) {
	test(`Web launch ${succeeds ? 'selects the newly prepared package before spawning the backend' : 'stops on preparation failure before reading or launching an old package'}`, async t => {
		const events: string[] = [];
		let prepared = false;
		let packageRoot = '';
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		t.mock.method(fs, 'readdirSync', (path: string) => {
			assert.equal(prepared, true);
			events.push('select');
			packageRoot = join(path, '..', 'packages', '0.1.0', 'a'.repeat(64));
			return ['00000000000000000001.json'];
		});
		t.mock.method(fs, 'readFileSync', () => JSON.stringify({ formatVersion: 1, sequence: 1, directory: `packages/0.1.0/${'a'.repeat(64)}` }));
		t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[]) => {
			const child = new ChildProcess();
			if (args.includes('build/prepare.py')) {
				events.push('prepare');
				setImmediate(() => { prepared = succeeds; child.emit('close', succeeds ? 0 : 1, null); });
			} else {
				assert.equal(command, join(packageRoot, 'bin', `ash-app-server${process.platform === 'win32' ? '.exe' : ''}`));
				events.push('launch');
				child.stdin = new PassThrough();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				child.stdin.once('finish', () => child.emit('close', 0, null));
				setImmediate(() => (child.stdout as PassThrough).write(JSON.stringify({ endpoint: 'http://127.0.0.1:1234', ticket: 'b'.repeat(64), pid: 42 }) + '\n'));
			}
			return child;
		});
		syncBuiltinESMExports();
		if (succeeds) {
			const launch = await startWeb({ port: 0, environment: {} });
			await launch.close();
		} else {
			await assert.rejects(startWeb({ port: 0, environment: {} }), /backend preparation exited with status 1/);
		}
		assert.deepEqual(events, succeeds ? ['prepare', 'select', 'launch'] : ['prepare']);
	});
}

test('Web close force-terminates an unresponsive listener and its descendants', { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
	const { mkdtemp, chmod, readFile, rm, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { promisify } = await import('node:util');
	const directory = await mkdtemp(join(tmpdir(), 'ash-web-close-'));
	const executable = join(directory, 'listener.cjs');
	const marker = join(directory, 'pids');
	await writeFile(executable, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
process.stdin.resume();
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('message', pid => {
 writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, pid]));
 console.log(JSON.stringify({ endpoint: 'http://127.0.0.1:1234', ticket: 'b'.repeat(64), pid: process.pid }));
});
setInterval(() => {}, 1000);
`);
	await chmod(executable, 0o755);
	const originalSpawn = childProcess.spawn;
	t.mock.method(fs, 'readdirSync', () => ['00000000000000000001.json']);
	t.mock.method(fs, 'readFileSync', () => JSON.stringify({ formatVersion: 1, sequence: 1, directory: `packages/0.1.0/${'a'.repeat(64)}` }));
	t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
		if (args.includes('build/prepare.py')) {
			const child = new ChildProcess();
			setImmediate(() => child.emit('close', 0, null));
			return child;
		}
		return originalSpawn(command, args, options);
	});
	syncBuiltinESMExports();
	let pids: number[] = [];
	t.after(async () => {
		t.mock.restoreAll(); syncBuiltinESMExports();
		for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
		await rm(directory, { recursive: true, force: true });
	});
	const launch = await startWeb({ port: 0, environment: { ASH_APP_SERVER_PATH: executable } });
	pids = JSON.parse(await readFile(marker, 'utf8'));
	await launch.close();
	for (const pid of pids) {
		const result = await promisify(childProcess.execFile)('ps', ['-p', String(pid), '-o', 'stat=']).catch(error => { if (error.code === 1) return { stdout: '' }; throw error; });
		assert.ok(!result.stdout.trim() || result.stdout.trim().startsWith('Z'), `Leaked listener PID ${pid}`);
	}
});
