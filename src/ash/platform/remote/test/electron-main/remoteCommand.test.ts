import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { isCancellationError } from '../../../../base/common/errors.js';
import { runRemoteCommand } from '../../../../platform/remote/electron-main/remoteCommand.js';

test('command observer failures reject the command instead of escaping the process event handler', async () => {
	await assert.rejects(
		runRemoteCommand(process.execPath, ['-e', "process.stderr.write('progress')"], process.env, {
			onStderrData: () => { throw new Error('invalid progress'); },
		}),
		/invalid progress/,
	);
});

test('command cancellation terminates the active local process and preserves its reason', async () => {
	const cancellation = new AbortController();
	const command = runRemoteCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, {
		onStderrData: () => { },
		signal: cancellation.signal,
	});
	cancellation.abort('user cancelled bootstrap');

	await assert.rejects(
		command,
		(error: unknown) => isCancellationError(error) && error.reason === 'user cancelled bootstrap',
	);
});

test('an already-cancelled command never starts', () => {
	const cancellation = new AbortController();
	cancellation.abort('cancelled before spawn');

	assert.throws(
		() => runRemoteCommand(process.execPath, ['-e', 'process.exit(99)'], process.env, {
			onStderrData: () => { },
			signal: cancellation.signal,
		}),
		(error: unknown) => isCancellationError(error) && error.reason === 'cancelled before spawn',
	);
});

test('cancelling an installer also terminates its SSH child', async () => {
	const cancellation = new AbortController();
	let childPid: number | undefined;
	let stderr = '';
	const script = `
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
		process.stderr.write(child.pid + '\\n');
		setInterval(() => {}, 1000);
	`;
	try {
		await assert.rejects(runRemoteCommand(process.execPath, ['-e', script], process.env, {
			signal: cancellation.signal,
			onStderrData: chunk => {
				stderr += chunk;
				if (!stderr.includes('\n')) return;
				childPid = Number(stderr.trim());
				assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
				cancellation.abort('cancel download');
			},
		}), isCancellationError);
		assert.ok(childPid);
		for (let attempt = 0; attempt < 100; attempt++) {
			try { process.kill(childPid, 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
					childPid = undefined;
					return;
				}
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		assert.fail('SSH child survived installer cancellation');
	} finally {
		cancellation.abort();
		if (childPid !== undefined && childPid > 1) {
			try { process.kill(childPid, 'SIGKILL'); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
		}
	}
});
