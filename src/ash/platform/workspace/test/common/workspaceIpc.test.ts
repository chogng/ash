import assert from 'node:assert/strict';
import { test } from 'mocha';
import { validateDirectoryPermissionRequest } from '../../common/workspaceIpc.js';

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
