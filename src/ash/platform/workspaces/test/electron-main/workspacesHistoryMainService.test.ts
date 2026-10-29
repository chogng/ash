import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IStateService } from '../../../state/node/state.js';
import { StateService } from '../../../state/node/stateService.js';
import { MAX_RECENT_WORKSPACES, recentWorkspaceUri, restoreRecentlyOpened, toStoreData } from '../../common/workspaces.js';
import { WorkspacesHistoryMainService, workspacesHistoryChannel } from '../../electron-main/workspacesHistoryMainService.js';

test('Main history retains concurrent window additions, persists workspace kinds, and removes shared entries', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-history-'));
	try {
		const path = join(directory, 'state.json');
		const state = await StateService.create(path);
		using services = new InstantiationService();
		services.registerInstance(IStateService, state);
		using history = services.createInstance(WorkspacesHistoryMainService);
		const channel = workspacesHistoryChannel(history);
		let changes = 0;
		using subscription = channel.listen('window:1', 'onDidChangeRecentlyOpened')(() => changes++);
		const alpha = URI.file(join(directory, 'alpha'));
		const beta = URI.file(join(directory, 'beta'));
		const team = { workspace: { id: 'team', configPath: URI.file(join(directory, 'Team.code-workspace')) }, label: 'Team' };
		await Promise.all([
			channel.call('window:1', 'addRecentlyOpened', toStoreData({ workspaces: [{ folderUri: alpha }] })),
			channel.call('window:2', 'addRecentlyOpened', toStoreData({ workspaces: [{ folderUri: beta }] })),
			channel.call('window:2', 'addRecentlyOpened', toStoreData({ workspaces: [team] })),
		]);
		await history.addRecentlyOpened([{ folderUri: alpha }]);
		const expected = { workspaces: [{ folderUri: alpha }, team, { folderUri: beta, label: undefined }] };
		assert.deepEqual(await history.getRecentlyOpened(), expected);
		assert.deepEqual(await channel.call('window:2', 'getRecentlyOpened'), toStoreData(expected));
		await assert.rejects(channel.call('window:1', 'clearRecentlyOpened', { windowId: 2 }), /takes no arguments/);
		assert.deepEqual(toStoreData(restoreRecentlyOpened(toStoreData(expected))), toStoreData(expected));
		assert.equal(changes, 4);
		await state.close();

		const reopenedState = await StateService.create(path);
		using restoredServices = new InstantiationService();
		restoredServices.registerInstance(IStateService, reopenedState);
		using restored = restoredServices.createInstance(WorkspacesHistoryMainService);
		assert.deepEqual(toStoreData(await restored.getRecentlyOpened()), toStoreData(expected));
		await restored.removeRecentlyOpened([alpha]);
		assert.deepEqual((await restored.getRecentlyOpened()).workspaces.map(recentWorkspaceUri), [team.workspace.configPath, beta]);
		await restored.clearRecentlyOpened();
		await reopenedState.close();
		const clearedState = await StateService.create(path);
		using clearedServices = new InstantiationService();
		clearedServices.registerInstance(IStateService, clearedState);
		using cleared = clearedServices.createInstance(WorkspacesHistoryMainService);
		assert.deepEqual(await cleared.getRecentlyOpened(), { workspaces: [] });
		await clearedState.close();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('Main history keeps the most recent projects within its shared limit', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-history-'));
	try {
		const state = await StateService.create(join(directory, 'state.json'));
		using services = new InstantiationService();
		services.registerInstance(IStateService, state);
		using history = services.createInstance(WorkspacesHistoryMainService);
		const folders = Array.from({ length: MAX_RECENT_WORKSPACES + 3 }, (_, index) => ({ folderUri: URI.file(join(directory, String(index))) }));
		await history.addRecentlyOpened(folders);
		assert.deepEqual((await history.getRecentlyOpened()).workspaces, folders.slice(0, MAX_RECENT_WORKSPACES));
		await state.close();
	} finally { await rm(directory, { recursive: true, force: true }); }
});
