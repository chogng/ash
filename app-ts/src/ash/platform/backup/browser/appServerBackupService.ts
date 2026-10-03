import { URI } from '../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import { APP_SERVER_METHODS, type BackupRecordDto } from '../../app-server/common/generated/index.js';
import { BackupError, type IBackupContent, type IBackupRecord, type IBackupService, type IBackupWorkspace } from '../common/backup.js';

/** Uses the renderer's existing connection; backups survive that connection's lifetime. */
export class AppServerBackupService implements IBackupService {
	constructor(private readonly client: AppServerProtocolClient, private readonly clientId: string) {}

	async getWorkspaces(): Promise<readonly IBackupWorkspace[]> {
		const result = await this.client.request(APP_SERVER_METHODS['backup/workspaces'], { clientId: this.clientId }).catch(explain);
		return result.workspaces.map(workspace => ({ id: workspace.id, folders: workspace.folders.map(folder => URI.parse(folder)), ...(workspace.configuration ? { configuration: URI.parse(workspace.configuration) } : {}), ...(workspace.remoteAuthority ? { remoteAuthority: workspace.remoteAuthority } : {}) }));
	}

	async list(workspaceId: string): Promise<readonly IBackupRecord[]> {
		const result = await this.client.request(APP_SERVER_METHODS['backup/list'], { clientId: this.clientId, workspaceId }).catch(explain);
		return result.backups.map(revive);
	}

	async store(workspace: IBackupWorkspace, content: IBackupContent, expectedRevision?: string): Promise<IBackupRecord> {
		return revive(await this.client.request(APP_SERVER_METHODS['backup/write'], {
			clientId: this.clientId,
			workspace: { id: workspace.id, folders: workspace.folders.map(folder => folder.toString()), configuration: workspace.configuration?.toString() ?? null, remoteAuthority: workspace.remoteAuthority ?? null },
			content: { ...content, resource: content.resource.toString() }, expectedRevision: expectedRevision ?? null,
		}).catch(explain));
	}

	async discard(workspaceId: string, resource: URI, expectedRevision: string): Promise<void> {
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
