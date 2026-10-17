import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerRequestParams } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { isRecord } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { parseWorkspace } from '../../workspace/common/workspace.js';
import type { IWorkspaceContextApi } from '../../workspace/common/workspaceIpc.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../remote/common/remote.js';
import type { EnvDirSetEntry, PermissionDto } from '../../../../../.build/protocol/typescript/index.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type IWorkspaceTrustApi, type IWorkspaceTrustRequestService } from '../../workspace/common/workspaceTrust.js';

export async function initializeWorkspace(client: AppServerProtocolClient, workspaceTrust: IWorkspaceTrustRequestService, trustApi: IWorkspaceTrustApi, workspaceApi: IWorkspaceContextApi): Promise<void> {
	const workspace = parseWorkspace(await workspaceApi.getWorkspace());
	const dirs: EnvDirSetEntry[] = [];
	for (const folder of workspace.folders) {
		const path = isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath;
		const existing = await trustApi.readDirectory(path);
		if (existing.permissions !== undefined) {
			dirs.push({ id: folder.id, path, grant: { type: 'config' } });
			continue;
		}
		const choice = await workspaceTrust.requestWorkspaceTrust(path);
		if (choice === 'cancel') { throw new Error('Directory permission selection cancelled'); }
		if (choice !== 'development' && choice !== 'readOnly') { throw new TypeError('Invalid directory permission selection'); }
		const permissions: PermissionDto[] = [...(choice === 'readOnly' ? READ_DIR_PERMISSIONS : DEVELOPMENT_DIR_PERMISSIONS)];
		const grant = await trustApi.createGrant(path, permissions);
		await client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs: [...dirs, { id: folder.id, path, grant: { ...grant, permissions: [...grant.permissions] } }] });
		dirs.push({ id: folder.id, path, grant: { type: 'config' } });
	}
	if (dirs.length) { await client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs }); }
}

export function registerAppServerWorkspaceHost(client: AppServerProtocolClient, ready: () => Promise<void>, workspaceTrust: IWorkspaceTrustRequestService, trustApi: IWorkspaceTrustApi, validateFolders: (folders: readonly URI[]) => void = () => { }): IDisposable {
	const subscription = subscribe('ash:workspace:operation', (value: unknown) => {
		if (!isRecord(value) || typeof value.nonce !== 'string' || !isRecord(value.params)) { return; }
		const { nonce, operation, params } = value;
		const execute = async (): Promise<unknown> => {
			await ready();
			switch (operation) {
				case 'selectPermissions': {
					if (typeof params.path !== 'string') throw new TypeError('Invalid directory path');
					return workspaceTrust.requestWorkspaceTrust(params.path);
				}
				case 'readPermissions': {
					const request = decodeAppServerRequestParams('config/directoryGrants/read', params);
					return (await trustApi.readDirectory(request.path)).permissions;
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
					validateFolders(request.dirs.map(folder => URI.file(folder.path)));
					return;
				}
				case 'setFolders': return client.request(APP_SERVER_METHODS['env/dirs/set'], decodeAppServerRequestParams('env/dirs/set', { dirs: params.folders }));
				default: throw new Error('Unknown workspace operation');
			}
		};
		void execute().then(result => invoke('ash:workspace:completed', { nonce, result }), error => invoke('ash:workspace:completed', { nonce, error: error instanceof Error ? error.message : 'Workspace operation failed', failure: error instanceof AppServerRemoteError ? error.errorName : undefined })).catch(console.error);
	});
	return toDisposable(() => subscription.dispose());
}
