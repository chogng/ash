import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { IDirPermissionsService, type DirPermission } from '../../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceContextService } from '../../browser/workspaceContextService.js';
import { WorkspaceTrustManagementService } from '../../common/workspaceTrust.js';

test('Workspace Trust reads current Rust permissions for each workspace folder', async () => {
	using changes = new Emitter<void>();
	using workspace = new WorkspaceContextService({ id: 'empty' });
	const allowed = new Map<string, readonly DirPermission[]>();
	const reads: string[] = [];
	const permissions: IDirPermissionsService = {
		onDidChangePermissions: changes.event,
		list: async () => ({ revision: 0, entries: [] }),
		read: async path => { reads.push(path); return allowed.get(path); },
		set: async () => { throw new Error('Unexpected permission write'); },
		forget: async () => { throw new Error('Unexpected permission deletion'); },
	};
	using services = new ServiceContainer();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IDirPermissionsService, permissions);
	using trust = services.createInstance(WorkspaceTrustManagementService);
	let notifications = 0;
	using listener = trust.onDidChangeTrust(() => notifications += 1);
	assert.equal(await trust.getWorkspaceTrustInfo(), undefined);

	const first = URI.file('/workspaces/first');
	workspace.updateWorkspace({ id: 'first', uri: first });
	assert.equal(await trust.getWorkspaceTrustInfo(), undefined);
	allowed.set(first.fsPath, READ_DIR_PERMISSIONS);
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: true });
	assert.deepEqual(reads, [first.fsPath, first.fsPath]);

	allowed.set(first.fsPath, [...READ_DIR_PERMISSIONS, 'executeCommands']);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	allowed.set(first.fsPath, [...READ_DIR_PERMISSIONS, 'writeFiles']);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	allowed.set(first.fsPath, DEVELOPMENT_DIR_PERMISSIONS);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: true, isReadOnly: false });

	const second = URI.file('/workspaces/second');
	allowed.set(second.fsPath, READ_DIR_PERMISSIONS);
	workspace.updateWorkspace({
		id: 'both',
		folders: [
			{ id: 'first', uri: first, name: 'first', index: 0 },
			{ id: 'second', uri: second, name: 'second', index: 1 },
		],
	});
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	assert.equal(notifications, 5);
	assert.deepEqual(reads.slice(-2), [first.fsPath, second.fsPath]);
});
