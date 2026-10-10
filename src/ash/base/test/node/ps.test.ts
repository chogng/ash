import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { suite, test } from 'mocha';
import { listProcesses } from '../../node/ps.js';

suite('Process snapshots', () => {
	test('includes a running child and reports resident bytes for the requested root', async () => {
		const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'pipe'] });
		try {
			await once(child.stdout, 'data');
			const root = await listProcesses(process.pid);
			assert.equal(root.pid, process.pid);
			assert.ok(root.mem > 0);
			assert.ok(root.children?.some(item => item.pid === child.pid && item.ppid === process.pid));
		} finally {
			const exited = once(child, 'exit');
			child.kill();
			await exited;
		}
	});

	test('rejects invalid roots before executing a host command', async () => {
		await assert.rejects(listProcesses(-1), TypeError);
	});
});
