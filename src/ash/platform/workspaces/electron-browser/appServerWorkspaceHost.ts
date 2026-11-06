import { canceled } from '../../../base/common/errors.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerRequestParams } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { isRecord } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { parseWorkspace } from '../../workspace/common/workspace.js';
import { validateDirectoryPermissionRequest } from '../../workspace/common/workspaceIpc.js';
import type { IWorkspaceContextApi } from '../../workspace/common/workspaceIpc.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../remote/common/remote.js';
import type { EnvDirSetEntry, PermissionDto } from '../../../../../.build/protocol/typescript/index.js';
import { DEVELOPMENT_DIR_PERMISSIONS, RESTRICTED_DIR_PERMISSIONS, hasDevelopmentPermissions, type IWorkspaceTrustApi, type IDirectoryPermissionRequestService } from '../../workspace/common/workspaceTrust.js';

export async function initializeWorkspace(client: AppServerProtocolClient, workspaceTrust: IDirectoryPermissionRequestService, trustApi: IWorkspaceTrustApi, workspaceApi: IWorkspaceContextApi, options: { readonly remoteHostLabel?: string; readonly onBindingQueued?: () => void; } = {}): Promise<void> {
	const generation = client.generation;
	const workspace = parseWorkspace(await workspaceApi.getWorkspace());
	if (generation !== client.generation || client.state !== 'ready') throw canceled();
	await initializeWorkspaceDirectories(client, workspaceTrust, trustApi, workspace.folders.map(folder => ({
		id: folder.id,
		path: isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath,
		remoteHostLabel: options.remoteHostLabel,
	})), options.onBindingQueued);
}

/** Binds only these directories on this connection; a host label never affects authorization. */
export async function initializeWorkspaceDirectories(client: AppServerProtocolClient, workspaceTrust: IDirectoryPermissionRequestService, trustApi: IWorkspaceTrustApi, folders: readonly { readonly id: string; readonly path: string; readonly remoteHostLabel?: string; }[], onBindingQueued?: () => void): Promise<void> {
	const generation = client.generation;
	let retired = client.state !== 'ready';
	const cancellation = new AbortController();
	const connection = client.onStateChange(state => {
		if (state !== 'ready') {
			retired = true;
			cancellation.abort();
		}
	});
	const assertCurrent = (): void => {
		if (retired || client.generation !== generation) { throw canceled(); }
	};
	try {
		assertCurrent();
		const dirs: EnvDirSetEntry[] = [];
		for (const folder of folders) {
			const path = folder.path;
			const existing = await trustApi.readDirectory(path);
			assertCurrent();
			if (workspaceTrust.requiresDevelopmentTrust ? hasDevelopmentPermissions(existing.permissions) : existing.permissions !== undefined) {
				dirs.push({ id: folder.id, path, grant: { type: 'config' } });
				continue;
			}
			// The frontend prompt can outlive its connection; retiring setup must not wait for its answer.
			const choice = await raceCancellationError(workspaceTrust.requestDirectoryPermissions({ path, remoteHostLabel: folder.remoteHostLabel }, cancellation.signal), cancellation.signal);
			assertCurrent();
			if (choice === 'cancel' || workspaceTrust.requiresDevelopmentTrust && choice !== 'development') { throw canceled(); }
			if (choice !== 'development' && choice !== 'restricted') { throw new TypeError('Invalid directory permission selection'); }
			const permissions: PermissionDto[] = [...(choice === 'restricted' ? RESTRICTED_DIR_PERMISSIONS : DEVELOPMENT_DIR_PERMISSIONS)];
			const grant = await trustApi.createGrant(path, permissions);
			assertCurrent();
			if (workspaceTrust.requiresDevelopmentTrust) {
				await trustApi.persistGrant(path, grant);
			} else {
				await client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs: [...dirs, { id: folder.id, path, grant: { ...grant, permissions: [...grant.permissions] } }] });
			}
			assertCurrent();
			dirs.push({ id: folder.id, path, grant: { type: 'config' } });
		}
		if (dirs.length || workspaceTrust.requiresDevelopmentTrust) {
			const binding = client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs });
			onBindingQueued?.();
			await binding;
		}
		assertCurrent();
	} finally {
		connection.dispose();
	}
}

export function registerAppServerWorkspaceHost(ready: () => Promise<void>, workspaceTrust: IDirectoryPermissionRequestService, trustApi: IWorkspaceTrustApi, setFolders: (folders: readonly EnvDirSetEntry[]) => Promise<unknown>, validateFolders: (folders: readonly URI[]) => void = () => { }, resourceForPath: (path: string) => URI = URI.file): IDisposable {
	const subscription = subscribe('ash:workspace:operation', (value: unknown) => {
		if (!isRecord(value) || typeof value.nonce !== 'string' || !isRecord(value.params)) { return; }
		const { nonce, operation, params } = value;
		const execute = async (): Promise<unknown> => {
			await ready();
			switch (operation) {
				case 'selectPermissions': {
					return workspaceTrust.requestDirectoryPermissions(validateDirectoryPermissionRequest(params));
				}
				case 'readPermissions': {
					const request = decodeAppServerRequestParams('config/directoryGrants/read', params);
					const { permissions } = await trustApi.readDirectory(request.path);
					return !workspaceTrust.requiresDevelopmentTrust || hasDevelopmentPermissions(permissions) ? permissions : undefined;
				}
				case 'createGrant': {
					if (typeof params.path !== 'string' || !Array.isArray(params.permissions)
						|| !params.permissions.every(value => DEVELOPMENT_DIR_PERMISSIONS.some(permission => permission === value))) {
						throw new TypeError('Invalid workspace trust grant');
					}
					return trustApi.createGrant(params.path, params.permissions);
				}
				case 'persistDirectoryGrant': {
					if (!isRecord(params.grant)) throw new TypeError('Invalid directory grant');
					if (params.grant.type === 'config') return;
					if (params.grant.type !== 'user') throw new TypeError('Invalid directory grant');
					const request = decodeAppServerRequestParams('config/directoryGrants/set', {
						commandId: params.grant.commandId,
						expectedRevision: params.grant.expectedRevision,
						path: params.path,
						permissions: params.grant.permissions,
					});
					return trustApi.persistGrant(request.path, { type: 'user', commandId: request.commandId, expectedRevision: request.expectedRevision, permissions: request.permissions });
				}
				case 'validateFolders': {
					const request = decodeAppServerRequestParams('env/dirs/set', { dirs: params.folders });
					validateFolders(request.dirs.map(folder => resourceForPath(folder.path)));
					return;
				}
				case 'setFolders': {
					const { dirs } = decodeAppServerRequestParams('env/dirs/set', { dirs: params.folders });
					if (workspaceTrust.requiresDevelopmentTrust) {
						for (const { path, grant } of dirs) {
							const permissions = grant.type === 'config' ? (await trustApi.readDirectory(path)).permissions : grant.permissions;
							if (!hasDevelopmentPermissions(permissions)) throw canceled();
						}
					}
					return setFolders(dirs);
				}
				default: throw new Error('Unknown workspace operation');
			}
		};
		void execute().then(result => invoke('ash:workspace:completed', { nonce, result }), error => invoke('ash:workspace:completed', { nonce, error: error instanceof Error ? error.message : 'Workspace operation failed', failure: error instanceof AppServerRemoteError ? error.errorName : undefined })).catch(console.error);
	});
	return toDisposable(() => subscription.dispose());
}
