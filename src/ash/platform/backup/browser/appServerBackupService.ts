import { URI } from '../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { APP_SERVER_METHODS, type BackupListPageResult, type BackupRecordDto } from '../../../../../.build/protocol/typescript/index.js';
import { BackupError, type IBackupContent, type IBackupRecord, type IBackupService, type IBackupWorkspace, type IBackupRevision } from '../common/backup.js';

/** Uses the renderer's existing connection; backups survive that connection's lifetime. */
export class AppServerBackupService implements IBackupService {
	constructor(private readonly client: AppServerProtocolClient, private readonly clientId: string) { }

	async getWorkspaces(): Promise<readonly IBackupWorkspace[]> {
		await this.client.whenReady();
		const result = await this.client.request(APP_SERVER_METHODS['backup/workspaces'], { clientId: this.clientId }).catch(explain);
		return result.workspaces.map(workspace => ({ id: workspace.id, folders: workspace.folders.map(folder => URI.parse(folder)), ...(workspace.configuration ? { configuration: URI.parse(workspace.configuration) } : {}), ...(workspace.remoteAuthority ? { remoteAuthority: workspace.remoteAuthority } : {}) }));
	}

	async list(workspaceId: string): Promise<readonly IBackupRecord[]> {
		const backups: IBackupRecord[] = [];
		let afterResource: string | null = null;
		do {
			await this.client.whenReady();
			const result: BackupListPageResult = await this.client.request(APP_SERVER_METHODS['backup/listPage'], { clientId: this.clientId, workspaceId, afterResource }).catch(async error => {
				// Older servers expose only the original list contract.
				if (afterResource === null && error instanceof AppServerRemoteError && error.code === -32601) {
					const legacy = await this.client.request(APP_SERVER_METHODS['backup/list'], { clientId: this.clientId, workspaceId }).catch(explain);
					return { ...legacy, nextResource: null };
				}
				return explain(error);
			});
			backups.push(...result.backups.map(revive));
			if (result.nextResource !== null && (result.nextResource === afterResource || result.backups.at(-1)?.content.resource !== result.nextResource)) {
				throw new BackupError('failed');
			}
			afterResource = result.nextResource;
		} while (afterResource !== null);
		return backups;
	}

	async store(workspace: IBackupWorkspace, content: IBackupContent, expectedRevision?: string): Promise<IBackupRecord> {
		// Development replacement can overlap window shutdown. Wait before sending;
		// a write whose reply was lost must still fail rather than be replayed.
		await this.client.whenReady();
		return revive(await this.client.request(APP_SERVER_METHODS['backup/write'], {
			clientId: this.clientId,
			workspace: { id: workspace.id, folders: workspace.folders.map(folder => folder.toString()), configuration: workspace.configuration?.toString() ?? null, remoteAuthority: workspace.remoteAuthority ?? null },
			content: { ...content, resource: content.resource.toString() }, expectedRevision: expectedRevision ?? null,
		}).catch(explain));
	}

	async move(sourceWorkspaceId: string, workspace: IBackupWorkspace, backups: readonly IBackupRevision[]): Promise<readonly IBackupRevision[]> {
		await this.client.whenReady();
		const result = await this.client.request(APP_SERVER_METHODS['backup/move'], {
			clientId: this.clientId, sourceWorkspaceId,
			workspace: { id: workspace.id, folders: workspace.folders.map(folder => folder.toString()), configuration: workspace.configuration?.toString() ?? null, remoteAuthority: workspace.remoteAuthority ?? null },
			backups: backups.map(backup => ({ resource: backup.resource.toString(), revision: backup.revision })),
		}).catch(explain);
		return result.backups.map(backup => ({ resource: URI.parse(backup.resource), revision: backup.revision }));
	}

	async discard(workspaceId: string, resource: URI, expectedRevision: string): Promise<void> {
		await this.client.whenReady();
		await this.client.request(APP_SERVER_METHODS['backup/discard'], { clientId: this.clientId, workspaceId, resource: resource.toString(), expectedRevision }).catch(explain);
	}
}

function revive(record: BackupRecordDto): IBackupRecord {
	return { ...record, content: { ...record.content, resource: URI.parse(record.content.resource) } };
}

function explain(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'BackupRevisionConflict': throw new BackupError('conflict');
			case 'BackupUnavailable': throw new BackupError('unavailable');
			case 'BackupOperationFailed': throw new BackupError('failed');
		}
	}
	throw error;
}
