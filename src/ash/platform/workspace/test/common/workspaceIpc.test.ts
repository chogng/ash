import assert from 'node:assert/strict';
import { test } from 'mocha';
import { validateDirectoryPermissionRequest, validateWorkspaceEdit } from '../../common/workspaceIpc.js';
import { getWorkspacePrimaryFolderUri, parseWorkspace, serializeWorkspace, type IWorkspace } from '../../common/workspace.js';
import { URI } from '../../../../base/common/uri.js';

test('directory prompt IPC keeps readable host labels separate from authorization paths', () => {
	assert.deepEqual(validateDirectoryPermissionRequest({ path: '/srv/project', remoteHostLabel: '  Build\n\n# Environment\t`one`  ' }),
		{ path: '/srv/project', remoteHostLabel: 'Build # Environment `one`' });
	assert.deepEqual(validateDirectoryPermissionRequest({ path: '/local/project' }), { path: '/local/project' });
	for (const request of [
		'/srv/project', null, {}, { path: '' }, { path: '/srv/\0project' },
		{ path: '/srv/project', remoteHostLabel: 42 }, { path: '/srv/project', remoteHostLabel: '\n\t' },
		{ path: '/srv/project', remoteHostLabel: 'host\0name' },
		{ path: '/srv/project', remoteHostLabel: 'x'.repeat(1025) },
		{ path: '/srv/project', permissions: ['executeCommands'] },
	]) {
		assert.throws(() => validateDirectoryPermissionRequest(request), /Invalid (directory permission request|remote environment label)/);
	}
});

test('folder location IPC preserves the primary identity and validates the active checkout', () => {
	const primary = URI.file('/project');
	const alternate = URI.file('/review');
	const metadata = { label: 'review', providerId: 'git-worktrees', builtIn: true };
	const request = {
		operation: 'folderLocation', workspaceId: 'project', current: primary.toString(),
		target: alternate.toString(), reason: 'user', alternate: metadata,
	};
	assert.deepEqual(validateWorkspaceEdit(request), request);
	assert.throws(() => validateWorkspaceEdit({ ...request, reason: 'other' }), /Invalid folder location edit/);
	assert.throws(() => validateWorkspaceEdit({ ...request, alternate: { ...metadata, grant: 'config' } }), /Invalid workspace folder location metadata/);

	const workspace: IWorkspace = {
		id: 'project',
		folders: [{ id: 'project', name: 'project', uri: alternate, index: 0 }],
		folderLocation: { primary, reason: 'user', alternate: metadata },
	};
	const roundTrip = parseWorkspace(serializeWorkspace(workspace));
	assert.deepEqual(serializeWorkspace(roundTrip), serializeWorkspace(workspace));
	assert.equal(getWorkspacePrimaryFolderUri(roundTrip)?.toString(), primary.toString());
	assert.throws(() => parseWorkspace(serializeWorkspace({ ...workspace, configuration: URI.file('/test.ash-workspace') })), /Invalid workspace folder location/);
});
