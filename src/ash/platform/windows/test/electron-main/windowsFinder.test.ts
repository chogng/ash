import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { createProviderRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import { parseWorkspaceIdentifier, serializeWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { getSingleFolderWorkspaceIdentifier } from '../../../workspaces/node/workspaces.js';
import { findWindowOnWorkspaceOrFolder } from '../../electron-main/windowsFinder.js';

test('window finder selects the first matching folder or workspace file', () => {
	const folder = { openedWorkspace: { id: 'folder', uri: URI.file('/repo/project') } };
	const workspace = { openedWorkspace: { id: 'workspace', configPath: URI.file('/repo/project.code-workspace') } };
	const other = { openedWorkspace: { id: 'other', uri: URI.file('/repo/other') } };
	assert.equal(findWindowOnWorkspaceOrFolder([other, folder, workspace], URI.file('/repo/project')), folder);
	assert.equal(findWindowOnWorkspaceOrFolder([other, folder, workspace], URI.file('/repo/project.code-workspace')), workspace);
	assert.equal(findWindowOnWorkspaceOrFolder([other, folder, workspace], URI.file('/repo/missing')), undefined);
});

test('Dev Container windows retain separate Session directory owners after serializing', () => {
	const uri = createProviderRemoteWorkspaceUri('ash.dev-containers', '/source', '/workspace');
	const firstWorkspace = getSingleFolderWorkspaceIdentifier(uri, 'first');
	const secondWorkspace = getSingleFolderWorkspaceIdentifier(uri, 'second');
	const first = { openedWorkspace: parseWorkspaceIdentifier(serializeWorkspaceIdentifier(firstWorkspace)) };
	const second = { openedWorkspace: parseWorkspaceIdentifier(serializeWorkspaceIdentifier(secondWorkspace)) };
	const windows = [second, first];
	assert.notEqual(firstWorkspace.id, secondWorkspace.id);
	assert.equal(findWindowOnWorkspaceOrFolder(windows, uri, 'first'), first);
	assert.equal(findWindowOnWorkspaceOrFolder(windows, uri, 'second'), second);
	assert.equal(findWindowOnWorkspaceOrFolder(windows, uri), undefined);
});
