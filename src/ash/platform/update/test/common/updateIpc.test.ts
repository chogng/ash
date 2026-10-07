import assert from 'node:assert/strict';
import { test } from 'mocha';
import { UpdateChannel } from '../../common/updateIpc.js';

test('update channel rejects invalid policies and install arguments before invoking the shared updater', async () => {
	const calls: string[] = [];
	const channel = new UpdateChannel({
		async checkForUpdates(policy) { calls.push(`check:${policy}`); return { status: 'current', version: '1' }; },
		async checkAutomatically(policy) { calls.push(`automatic:${policy}`); return undefined; },
		async downloadUpdate(policy) { calls.push(`download:${policy}`); return { version: '2' }; },
		async installUpdate() { calls.push('install'); },
	});
	await assert.rejects(channel.call('window:1', 'downloadUpdate', 'never'), /invalid/);
	await assert.rejects(channel.call('window:1', 'installUpdate', { path: '/unverified' }), /takes no renderer arguments/);
	await assert.rejects(channel.call('window:1', 'unknown'), /Unknown update command/);
	assert.deepEqual(calls, []);
	assert.deepEqual(await channel.call('window:1', 'checkForUpdates', 'stable'), { status: 'current', version: '1' });
	await channel.call('window:2', 'checkAutomatically', 'latest');
	await channel.call('window:2', 'downloadUpdate', 'stable');
	await channel.call('window:1', 'installUpdate');
	assert.deepEqual(calls, ['check:stable', 'automatic:latest', 'download:stable', 'install']);
});
