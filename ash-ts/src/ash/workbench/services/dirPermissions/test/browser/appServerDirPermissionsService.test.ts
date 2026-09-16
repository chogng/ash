import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { IDirPermissionsApi } from '../../../../../platform/dirPermissions/common/dirPermissionsApi.js';
import type { DirPermission } from '../../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { AppServerDirPermissionsService } from '../../browser/appServerDirPermissionsService.js';

test('directory permission service normalizes missing paths and preserves revision-checked writes', async () => {
	let submitted: Parameters<IDirPermissionsApi['set']>[0] | undefined;
	const api: IDirPermissionsApi = {
		list: async () => ({ revision: 4, entries: [{ dir: 'dir-1', path: null, permissions: ['readFiles'] }] }),
		read: async () => ({ dir: 'dir-1', permissions: null }),
		set: async params => { submitted = params; return { revision: 5, generation: 2, disposition: 'updated' }; },
		forget: async () => { throw new Error('Unexpected forget'); },
	};
	const service = new AppServerDirPermissionsService(api);
	assert.deepEqual(await service.list(), { revision: 4, entries: [{ dir: 'dir-1', path: undefined, permissions: ['readFiles'] }] });
	assert.equal(await service.read('/workspace'), undefined);
	const permissions: readonly DirPermission[] = Object.freeze(['readFiles', 'writeFiles']);
	assert.deepEqual(await service.set('/workspace', permissions, 4), { revision: 5, generation: 2, disposition: 'updated' });
	assert.ok(submitted);
	assert.match(submitted.commandId, /^desktop-dir-permissions-set-/);
	assert.deepEqual({ ...submitted, commandId: 'command' }, { commandId: 'command', path: '/workspace', expectedRevision: 4, permissions });
	assert.notEqual(submitted.permissions, permissions);
	const conflict = new Error('Revision conflict');
	api.set = async () => { throw conflict; };
	await assert.rejects(service.set('/workspace', permissions, 4), error => error === conflict);
});
