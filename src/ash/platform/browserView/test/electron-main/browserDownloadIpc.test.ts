import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import type { IBrowserDownloadService } from '../../common/browserDownloads.js';
import { browserDownloadsChannel } from '../../electron-main/browserDownloadIpc.js';

test('download IPC accepts record IDs and rejects arbitrary filesystem operations', async () => {
	const operations: string[] = [];
	const service: IBrowserDownloadService = {
		onDidChange: Event.None, getState: async () => ({ directory: '/tmp', items: [] }),
		configure: async () => { }, chooseDirectory: async () => undefined,
		perform: async (id, action) => { operations.push(id + ':' + action); },
	};
	const channel = browserDownloadsChannel(service);
	const id = '00000000-0000-0000-0000-000000000001';
	await channel.call('window', 'perform', [id, 'deleteFile']);
	assert.deepEqual(operations, [id + ':deleteFile']);
	await assert.rejects(channel.call('window', 'perform', ['/tmp/private-file', 'deleteFile']));
	await assert.rejects(channel.call('window', 'perform', [id, 'deleteDirectory']));
	await assert.rejects(channel.call('window', 'perform', [id, 'open', '/tmp/private-file']));
	await assert.rejects(channel.call('window', 'configure', ['/tmp', 'false']));
	assert.equal(operations.length, 1);
});
