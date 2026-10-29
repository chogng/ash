import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { findWindowOnWorkspaceOrFolder } from '../../electron-main/windowsFinder.js';

test('window finder selects the first matching folder or workspace file', () => {
	const folder = { openedWorkspace: { id: 'folder', uri: URI.file('/repo/project') } };
	const workspace = { openedWorkspace: { id: 'workspace', configPath: URI.file('/repo/project.code-workspace') } };
	const other = { openedWorkspace: { id: 'other', uri: URI.file('/repo/other') } };
	assert.equal(findWindowOnWorkspaceOrFolder([other, folder, workspace], URI.file('/repo/project')), folder);
	assert.equal(findWindowOnWorkspaceOrFolder([other, folder, workspace], URI.file('/repo/project.code-workspace')), workspace);
	assert.equal(findWindowOnWorkspaceOrFolder([other, folder, workspace], URI.file('/repo/missing')), undefined);
});
