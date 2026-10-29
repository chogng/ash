import assert from 'node:assert/strict';
import { test } from 'mocha';
import { UpdateChannel } from '../../common/updateIpc.js';
import type { UpdateState } from '../../common/updateService.js';
import { Emitter } from '../../../../base/common/event.js';

test('update channel rejects invalid policies and install arguments before invoking the shared updater', async () => {
	const calls: string[] = [];
	using stateChanges = new Emitter<UpdateState>();
	const channel = new UpdateChannel({
		state: 'ready',
		onDidChangeState: stateChanges.event,
		async checkForUpdates(policy) { calls.push(`check:${policy}`); return { status: 'current', version: '1' }; },
		async checkAutomatically(policy) { calls.push(`automatic:${policy}`); return undefined; },
		async downloadUpdate(policy) { calls.push(`download:${policy}`); return { version: '2' }; },
		async installUpdate() { calls.push('install'); },
	});
	await assert.rejects(channel.call('window:1', 'downloadUpdate', 'never'), /invalid/);
	await assert.rejects(channel.call('window:1', 'installUpdate', { path: '/unverified' }), /takes no renderer arguments/);
	await assert.rejects(channel.call('window:1', 'unknown'), /Unknown update command/);
	assert.deepEqual(calls, []);
	assert.equal(await channel.call('window:2', 'state'), 'ready');
	const states: UpdateState[] = [];
	using subscription = channel.listen<UpdateState>('window:2', 'onDidChangeState')(state => states.push(state));
	assert.throws(() => channel.listen('window:1', 'unknown'), /Unknown update event/);
	stateChanges.fire('installing');
	assert.deepEqual(states, ['installing']);
	assert.deepEqual(await channel.call('window:1', 'checkForUpdates', 'stable'), { status: 'current', version: '1' });
	await channel.call('window:2', 'checkAutomatically', 'latest');
	await channel.call('window:2', 'downloadUpdate', 'stable');
	await channel.call('window:1', 'installUpdate');
	assert.deepEqual(calls, ['check:stable', 'automatic:latest', 'download:stable', 'install']);
});
