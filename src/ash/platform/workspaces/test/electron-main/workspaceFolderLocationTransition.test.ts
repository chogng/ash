import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { WorkspaceContextMainService } from '../../../window/electron-main/window.js';
import type { WorkspaceTrustGrant } from '../../../workspace/common/workspaceTrust.js';
import { WorkspaceTransitionFailureKind, WorkspaceTransitionMainService, WorkspaceTransitionStatus } from '../../electron-main/workspaceTransitionMainService.js';
import { WorkspacesManagementMainService } from '../../electron-main/workspacesManagementMainService.js';
import { getSingleFolderWorkspaceIdentifier, WorkspacePathKind } from '../../node/workspaces.js';

test('local folder locations publish only after the runtime accepts the new root', async () => {
	const primary = URI.file(resolve('project'));
	const alternate = URI.file(resolve('review'));
	const identity = getSingleFolderWorkspaceIdentifier(primary);
	using context = new WorkspaceContextMainService(identity);
	const workspaces = new WorkspacesManagementMainService({
		async resolvePath(path) { return { kind: WorkspacePathKind.Directory, path }; },
	});
	const initial = context.getResolvedWorkspace();
	const switched: string[] = [];
	let fail = true;
	using transitions = new WorkspaceTransitionMainService({
		workspaces, context,
		runtime: {
			async switchWorkspace({ root, workspace }) {
				assert.equal(workspace.id, identity.id);
				switched.push(root);
				if (fail) throw new Error('Runtime refused the folder');
			},
		},
		classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeRejected,
	});
	const request = {
		operation: 'folderLocation', workspaceId: identity.id, current: primary.toString(), target: alternate.toString(),
		reason: 'user', alternate: { label: 'review', providerId: 'git-worktrees', builtIn: true },
	} as const;
	await assert.rejects(transitions.transitionToFolderLocation(request, async () => undefined), { name: 'CancellationError' });
	assert.deepEqual(switched, []);

	const authorize = async (): Promise<WorkspaceTrustGrant> => ({ type: 'config' });
	assert.equal((await transitions.transitionToFolderLocation(request, authorize)).status, WorkspaceTransitionStatus.Failed);
	assert.equal(context.getResolvedWorkspace(), initial);

	fail = false;
	assert.equal((await transitions.transitionToFolderLocation(request, authorize)).status, WorkspaceTransitionStatus.Applied);
	assert.equal(context.getWorkspace(), identity);
	const active = context.getResolvedWorkspace().folders[0]!.uri;
	assert.equal(active.fsPath, alternate.fsPath);
	assert.equal(context.getResolvedWorkspace().folderLocation?.primary.toString(), primary.toString());
	await assert.rejects(transitions.transitionToFolderLocation(request, authorize), { name: 'CancellationError' });

	await transitions.transitionToFolderLocation({
		operation: 'folderLocation', workspaceId: identity.id, current: active.toString(), target: primary.toString(), reason: 'user',
	}, authorize);
	assert.equal(context.getResolvedWorkspace().folders[0]?.uri.toString(), primary.toString());
	assert.equal(context.getResolvedWorkspace().folderLocation?.alternate, undefined);
	assert.deepEqual(switched, [alternate.fsPath, alternate.fsPath, primary.fsPath]);
});
