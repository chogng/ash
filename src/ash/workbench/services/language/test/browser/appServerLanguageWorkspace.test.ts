import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IWorkspaceTrustManagementService, WorkspaceTrustPermission } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { resolveAppServerLanguageDirAccess } from '../../browser/appServerLanguageWorkspace.js';

test('language access requires both capabilities in every directory independently of the trust boolean', async () => {
	const first = URI.file('/first');
	const second = URI.file('/second');
	using workspace = new TestWorkspaceService({
		id: 'workspace', folders: [
			{ id: 'first', name: 'first', uri: first, index: 0 }, { id: 'second', name: 'second', uri: second, index: 1 },
		]
	});
	const permissions = new Map<string, readonly WorkspaceTrustPermission[] | undefined>([
		[first.toString(), ['useLanguageServices', 'executeCommands']], [second.toString(), ['executeCommands']],
	]);
	let trusted = true;
	const queries: URI[] = [];
	const trust: IWorkspaceTrustManagementService = {
		onDidChangeTrust: Event.None,
		getWorkspaceTrustInfo: async () => undefined,
		getUriTrustInfo: async uri => { queries.push(uri); return { uri, trusted, permissions: permissions.get(uri.toString()) }; },
	};
	assert.deepEqual(await resolveAppServerLanguageDirAccess(workspace, trust, true), { workspaceId: 'workspace', allowed: false });
	permissions.set(second.toString(), ['useLanguageServices']);
	assert.equal((await resolveAppServerLanguageDirAccess(workspace, trust, true)).allowed, false);
	permissions.set(second.toString(), []);
	assert.equal((await resolveAppServerLanguageDirAccess(workspace, trust, true)).allowed, false);
	permissions.set(second.toString(), undefined);
	assert.equal((await resolveAppServerLanguageDirAccess(workspace, trust, true)).allowed, false);
	trusted = false;
	permissions.set(second.toString(), ['useLanguageServices', 'executeCommands']);
	assert.deepEqual(await resolveAppServerLanguageDirAccess(workspace, trust, true), { workspaceId: 'workspace', allowed: true });
	assert.deepEqual(queries.slice(-2), [first, second]);
});

test('Web authorization stays in the backend and unsupported workspace identities cannot start language services', async () => {
	using workspace = new TestWorkspaceService({ id: 'workspace', uri: URI.file('/project') });
	const trust: IWorkspaceTrustManagementService = {
		onDidChangeTrust: Event.None,
		getWorkspaceTrustInfo: async () => undefined,
		getUriTrustInfo: async () => { throw new Error('Unexpected host grant inspection'); },
	};
	assert.deepEqual(await resolveAppServerLanguageDirAccess(workspace, trust, false), { workspaceId: 'workspace', allowed: true });
	for (const uri of [URI.file('/@browser/handle'), URI.parse('ash-remote://ssh+server/project')]) {
		workspace.updateWorkspace({ id: 'unsupported', uri });
		assert.deepEqual(await resolveAppServerLanguageDirAccess(workspace, trust, false), { workspaceId: 'unsupported', allowed: false });
	}
	workspace.updateWorkspace({ id: 'empty' });
	assert.deepEqual(await resolveAppServerLanguageDirAccess(workspace, trust, false), { workspaceId: 'empty', allowed: false });
});
