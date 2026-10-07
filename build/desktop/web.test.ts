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
				setImmediate(() => child.stdout!.emit('data', JSON.stringify({ endpoint: 'http://127.0.0.1:1234', ticket: 'b'.repeat(64), pid: 42 }) + '\n'));
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
