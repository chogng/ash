import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { Event } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IWorkspaceTrustApi, WorkspaceTrustCommandResult, WorkspaceTrustPermission } from '../common/workspaceTrust.js';

export function createDisconnectedWorkspaceTrustApi(unavailable: UnavailableOperation): IWorkspaceTrustApi {
	return {
		onDidChangeTrust: Event.None,
		readWorkspaceDirectory: () => unavailable('workspaceTrust.readWorkspaceDirectory'),
		readDirectory: () => unavailable('workspaceTrust.readDirectory'),
		listDirectories: () => unavailable('workspaceTrust.listDirectories'),
		setDirectoryPermissions: () => unavailable('workspaceTrust.setDirectoryPermissions'),
		forgetDirectory: () => unavailable('workspaceTrust.forgetDirectory'),
		createGrant: () => unavailable('workspaceTrust.createGrant'),
		persistGrant: () => unavailable('workspaceTrust.persistGrant'),
	};
}

/** The existing Rust protocol remains an adapter detail while directory trust moves to its owner. */
export function createAppServerWorkspaceTrustApi(connection: AppServerProtocolClient): IWorkspaceTrustApi {
	const writePermissions = async (path: string, permissions: readonly WorkspaceTrustPermission[], expectedRevision: number, commandId: string): Promise<WorkspaceTrustCommandResult> => {
		const result = await appServerRequest(connection, 'config/directoryGrants/set', {
			path,
			commandId,
			expectedRevision,
			permissions: [...permissions],
		});
		return { revision: result.revision, generation: result.generation, disposition: result.disposition };
	};
	return {
		onDidChangeTrust: (listener, thisArgs, disposables) => {
			const subscription = connection.onNotification(event => {
				if (event.method === 'config/changed') {
					listener.call(thisArgs, undefined);
				}
			});
			if (Array.isArray(disposables)) {
				disposables.push(subscription);
			} else {
				disposables?.add(subscription);
			}
			return subscription;
		},
		readWorkspaceDirectory: async dirId => {
			try {
				const result = await appServerRequest(connection, 'env/dir/read', { dirId });
				return result.permissions;
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'PermissionRequired') return undefined;
				throw error;
			}
		},
		readDirectory: async path => {
			const result = await appServerRequest(connection, 'config/directoryGrants/read', { path });
			return { dir: result.dir, permissions: result.permissions ?? undefined };
		},
		listDirectories: async () => {
			const result = await appServerRequest(connection, 'config/directoryGrants/list', {});
			return {
				revision: result.revision,
				entries: result.entries.map(entry => ({
					dir: entry.dir,
					path: entry.path ?? undefined,
					permissions: entry.permissions,
				})),
			};
		},
		setDirectoryPermissions: (path, permissions, expectedRevision) => writePermissions(path, permissions, expectedRevision, generateUuid()),
		forgetDirectory: async (dir, expectedRevision) => {
			const result = await appServerRequest(connection, 'config/directoryGrants/forget', {
				dir,
				expectedRevision,
				commandId: generateUuid(),
			});
			return { revision: result.revision, generation: result.generation, disposition: result.disposition };
		},
		createGrant: async (_path, permissions) => {
			// The revision belongs to the backend snapshot, not a cached frontend permission draft.
			const config = await appServerRequest(connection, 'config/read', {});
			return {
				type: 'user',
				commandId: generateUuid(),
				expectedRevision: config.revision,
				permissions: [...permissions],
			};
		},
		persistGrant: async (path, grant) => {
			if (grant.type === 'config') {
				return;
			}
			if (grant.type !== 'user') {
				throw new TypeError('Invalid directory grant');
			}
			await writePermissions(path, grant.permissions, grant.expectedRevision, grant.commandId);
		},
	};
}
