import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../base/common/uri.js';
import { createSshRemoteWorkspaceUri } from '../../../platform/remote/common/remote.js';
import type { IWorkspace } from '../../../platform/workspace/common/workspace.js';
import { selectionFromWorkspace } from '../../browser/workspaceSelection.js';

function workspace(...folders: readonly { name: string; uri: URI }[]): IWorkspace {
	return { id: 'workspace', folders: folders.map((folder, index) => ({ ...folder, id: String(index), index })) };
}

test('Session Workspace selection preserves every local and SSH root', () => {
	const local = { name: 'source', uri: URI.file('/work/source') };
	const remote = { name: 'build', uri: createSshRemoteWorkspaceUri('build-host', '/work/build') };
	assert.deepEqual(selectionFromWorkspace(workspace()), { type: 'current' });
	assert.deepEqual(selectionFromWorkspace(workspace(local)), { type: 'local', root: '/work/source' });
	assert.deepEqual(selectionFromWorkspace(workspace(remote)), { type: 'ssh', host: 'build-host', root: '/work/build' });
	assert.deepEqual(selectionFromWorkspace(workspace(local, remote)), {
		type: 'multiple',
		folders: [
			{ label: 'source', target: { type: 'local', root: '/work/source' } },
			{ label: 'build', target: { type: 'ssh', host: 'build-host', root: '/work/build' } },
		],
	});
});
