import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import { decodeAppServerRequestParams } from '../../app-server/common/generated/AppServerProtocolDecoder.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { isRecord } from '../../../base/common/types.js';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { parseWorkspace } from '../../workspace/common/workspace.js';
import { createWorkspaceContextApi } from '../../workspace/electron-browser/workspaceContextApi.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../remote/common/remote.js';
import type { EnvDirSetEntry, PermissionDto } from '../../app-server/common/generated/index.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type IWorkspaceTrustRequestService } from '../../workspace/common/workspaceTrust.js';

export async function initializeWorkspace(client: AppServerProtocolClient, workspaceTrust: IWorkspaceTrustRequestService): Promise<void> {
	const workspace = parseWorkspace(await createWorkspaceContextApi().getWorkspace());
	const dirs: EnvDirSetEntry[] = [];
	for (const folder of workspace.folders) {
		const path = isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath;
		const existing = await client.request(APP_SERVER_METHODS['config/dirPermissions/read'], { path });
		if (existing.permissions !== null && existing.permissions !== undefined) {
			dirs.push({ id: folder.id, path, grant: { type: 'config' } });
			continue;
		}
		const choice = await workspaceTrust.requestWorkspaceTrust(path);
		if (choice === 'cancel') { throw new Error('Directory permission selection cancelled'); }
		if (choice !== 'development' && choice !== 'readOnly') { throw new TypeError('Invalid directory permission selection'); }
		const permissions: PermissionDto[] = [...(choice === 'readOnly' ? READ_DIR_PERMISSIONS : DEVELOPMENT_DIR_PERMISSIONS)];
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		const grant = { type: 'user' as const, commandId: generateUuid(), expectedRevision: config.revision, permissions };
		await client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs: [...dirs, { id: folder.id, path, grant }] });
		dirs.push({ id: folder.id, path, grant: { type: 'config' } });
	}
	if (dirs.length) { await client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs }); }
}

export function registerAppServerWorkspaceHost(client: AppServerProtocolClient, ready: () => Promise<void>, workspaceTrust: IWorkspaceTrustRequestService): IDisposable {
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
					const request = decodeAppServerRequestParams('config/dirPermissions/read', params);
					return (await client.request(APP_SERVER_METHODS['config/dirPermissions/read'], request)).permissions ?? undefined;
				}
				case 'createGrant': {
					const config = await client.request(APP_SERVER_METHODS['config/read'], {});
					const checked = decodeAppServerRequestParams('config/dirPermissions/set', { commandId: generateUuid(), expectedRevision: config.revision, path: params.path, permissions: params.permissions });
					return { type: 'user', commandId: checked.commandId, expectedRevision: checked.expectedRevision, permissions: checked.permissions };
				}
				case 'switchWorkspace': {
					const request = decodeAppServerRequestParams('env/dirs/set', { dirs: [{ id: 'root', path: params.path, grant: params.grant }] });
					await client.request(APP_SERVER_METHODS['env/cwd/set'], decodeAppServerRequestParams('env/cwd/set', { cwd: params.path }));
					return client.request(APP_SERVER_METHODS['env/dirs/set'], request);
				}
				case 'setFolders': return client.request(APP_SERVER_METHODS['env/dirs/set'], decodeAppServerRequestParams('env/dirs/set', { dirs: params.folders }));
				default: throw new Error('Unknown workspace operation');
			}
		};
		void execute().then(result => invoke('ash:workspace:completed', { nonce, result }), error => invoke('ash:workspace:completed', { nonce, error: error instanceof Error ? error.message : 'Workspace operation failed', failure: error instanceof AppServerRemoteError ? error.errorName : undefined })).catch(console.error);
	});
	return toDisposable(() => subscription.dispose());
}
