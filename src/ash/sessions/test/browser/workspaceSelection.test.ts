import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../base/common/uri.js';
import { createSshRemoteWorkspaceUri } from '../../../platform/remote/common/remote.js';
import type { IWorkspace } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceSelection, selectionFromWorkspace } from '../../browser/workspaceSelection.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { IQuickInputService, type IQuickPick, type IQuickPickDidAcceptEvent, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService, type IRecentlyOpened } from '../../../platform/workspaces/common/workspaces.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { createProviderRemoteWorkspaceUri } from '../../../platform/remote/common/remote.js';

function workspace(...folders: readonly { name: string; uri: URI; }[]): IWorkspace {
	return { id: 'workspace', folders: folders.map((folder, index) => ({ ...folder, id: String(index), index })) };
}

test('Session Workspace selection preserves every local and SSH root', () => {
	const local = { name: 'source', uri: URI.file('/work/source') };
	const remote = { name: 'build', uri: createSshRemoteWorkspaceUri('build-host', '/work/build') };
	assert.deepEqual(selectionFromWorkspace(workspace()), { type: 'current' });
	assert.deepEqual(selectionFromWorkspace(workspace(local)), { type: 'local', root: local.uri.fsPath });
	assert.deepEqual(selectionFromWorkspace(workspace(remote)), { type: 'ssh', host: 'build-host', root: '/work/build' });
	assert.deepEqual(selectionFromWorkspace(workspace(local, remote)), {
		type: 'multiple',
		folders: [
			{ label: 'source', target: { type: 'local', root: local.uri.fsPath } },
			{ label: 'build', target: { type: 'ssh', host: 'build-host', root: '/work/build' } },
		],
	});
});

test('an existing container workspace retains its source when another container draft is selected', () => {
	const resource = createProviderRemoteWorkspaceUri('ash.dev-containers', 'C:\\source', '/workspace');
	assert.deepEqual(selectionFromWorkspace(workspace({ name: 'Container', uri: resource })), { type: 'provider', providerId: 'ash.dev-containers', workspace: 'C:\\source', root: '/workspace' });
});

test('workspace history merges choices, rejects unrelated authorities and cannot resurrect a closed picker', async () => {
	using services = new InstantiationService();
	using accepted = new Emitter<IQuickPickDidAcceptEvent>();
	using hidden = new Emitter<void>();
	const history = new DeferredPromise<IRecentlyOpened>();
	type Item = IQuickPickItem & { folderUri: URI; };
	let disposed = 0;
	const picker = { items: [] as readonly Item[], selectedItems: [] as readonly Item[], busy: false, onDidAccept: accepted.event, onDidHide: hidden.event, show() { }, dispose() { disposed++; }, [Symbol.dispose]() { disposed++; } } as unknown as IQuickPick<Item>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	services.registerInstance(IWorkspacesService, { getRecentlyOpened: () => history.p } as IWorkspacesService);
	using selection = services.createInstance(WorkspaceSelection);
	const current = URI.file('/current');
	const result = selection.pick([{ label: 'Current', target: { type: 'local', root: current.fsPath } }]);
	await history.complete({ workspaces: [{ folderUri: current }, { folderUri: URI.file('/recent') }, { folderUri: URI.parse('ash-remote://unknown/work') }] });
	assert.equal(picker.busy, false);
	assert.equal(picker.items.length, 2);
	picker.selectedItems = [picker.items[1] as Item];
	accepted.fire({ inBackground: false });
	assert.deepEqual(await result, { type: 'local', root: URI.file('/recent').fsPath });
	assert.equal(disposed, 1);

	const late = new DeferredPromise<IRecentlyOpened>();
	using laterServices = new InstantiationService();
	laterServices.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	laterServices.registerInstance(IWorkspacesService, { getRecentlyOpened: () => late.p } as IWorkspacesService);
	using closed = laterServices.createInstance(WorkspaceSelection);
	const pending = closed.pick([]);
	hidden.fire();
	assert.equal(await pending, undefined);
	await late.complete({ workspaces: [{ folderUri: URI.file('/late') }] });
	assert.equal(picker.items.length, 0);
});

test('container source selection filters both window folders and recent remote targets', async () => {
	using services = new InstantiationService();
	using accepted = new Emitter<IQuickPickDidAcceptEvent>();
	using hidden = new Emitter<void>();
	const history = new DeferredPromise<IRecentlyOpened>();
	const picker = { items: [] as readonly IQuickPickItem[], onDidAccept: accepted.event, onDidHide: hidden.event, show() { }, dispose() { }, [Symbol.dispose]() { } } as unknown as IQuickPick<IQuickPickItem>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	services.registerInstance(IWorkspacesService, { getRecentlyOpened: () => history.p } as IWorkspacesService);
	using selection = services.createInstance(WorkspaceSelection);
	const pending = selection.pick([{ label: 'SSH', target: { type: 'ssh', host: 'build', root: '/work' } }], target => target.type === 'local');
	await history.complete({ workspaces: [{ folderUri: URI.file('/source') }, { folderUri: createSshRemoteWorkspaceUri('build', '/work') }, { folderUri: createProviderRemoteWorkspaceUri('ash.dev-containers', 'C:\\source', '/work') }] });
	assert.equal(picker.items.length, 1);
	const item = picker.items[0];
	assert.ok(item && 'description' in item);
	assert.equal(item.description, '/source');
	hidden.fire();
	assert.equal(await pending, undefined);
});
