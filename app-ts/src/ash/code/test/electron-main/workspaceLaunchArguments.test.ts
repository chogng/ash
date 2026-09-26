import assert from 'node:assert/strict';
import { test } from 'mocha';
import { WorkspaceOpenTargetKind } from '../../../platform/environment/common/argv.js';
import { parseWorkspaceLaunchArguments } from '../../../platform/environment/node/argvHelper.js';

test('workspace launch arguments distinguish automatic and named targets', () => {
	assert.equal(parseWorkspaceLaunchArguments([]), undefined);
	assert.deepEqual(parseWorkspaceLaunchArguments(['project']), { kind: WorkspaceOpenTargetKind.Automatic, path: 'project' });
	assert.deepEqual(parseWorkspaceLaunchArguments(['--folder', 'project']), { kind: WorkspaceOpenTargetKind.Folder, path: 'project' });
	assert.deepEqual(parseWorkspaceLaunchArguments(['--workspace=team.ash-workspace']), { kind: WorkspaceOpenTargetKind.Workspace, path: 'team.ash-workspace' });
	assert.deepEqual(parseWorkspaceLaunchArguments(['--', '-project']), { kind: WorkspaceOpenTargetKind.Automatic, path: '-project' });
	assert.deepEqual(parseWorkspaceLaunchArguments(['--remote-ssh', 'work-server', '--folder', '/home/ash/project']), {
		kind: WorkspaceOpenTargetKind.RemoteFolder,
		path: '/home/ash/project',
		sshHost: 'work-server',
	});
	assert.throws(() => parseWorkspaceLaunchArguments(['one', 'two']), /only one project/);
	assert.throws(() => parseWorkspaceLaunchArguments(['--folder']), /requires a path/);
	assert.throws(() => parseWorkspaceLaunchArguments(['--remote-ssh', 'work-server']), /requires a Remote folder/);
	assert.throws(() => parseWorkspaceLaunchArguments(['--remote-ssh', 'work-server', '--workspace', '/remote/team.ash-workspace']), /multi-root/);
});
