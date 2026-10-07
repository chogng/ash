import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IBackupService, type IBackupContent, type IBackupRecord, type IBackupWorkspace } from '../../../../platform/backup/common/backup.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IWorkingCopyBackupService, WorkingCopyBackup } from '../common/workingCopyBackupService.js';
import { IndexedDbWorkingCopyBackupService } from './indexedDbWorkingCopyBackupService.js';

const CONTENT_FORMAT = 'ash.working-copy.v1';

/** The editor owns content serialization; Rust owns its durable version and workspace catalog. */
export class WorkingCopyBackupService extends Disposable implements IWorkingCopyBackupService {
	private workspaceId: string;
	private readonly revisions = new Map<string, string>();
	private readonly legacyConflicts = new Map<string, WorkingCopyBackup>();
	private readonly legacy: IndexedDbWorkingCopyBackupService;
	private preparation: Promise<void> | undefined;

	constructor(
		@IBackupService private readonly backups: IBackupService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.workspaceId = workspaceContext.getWorkspace().id;
		this.legacy = this._register(new IndexedDbWorkingCopyBackupService(this.workspaceId));
	}

	async list(): Promise<readonly WorkingCopyBackup[]> {
		await this.prepare();
		const records = await this.backups.list(this.workspaceId);
		const result: WorkingCopyBackup[] = [];
		for (const record of records) {
			try {
				result.push(deserialize(record));
				this.revisions.set(record.content.resource.toString(), record.revision);
			} catch (error) {
				this.logService.error('workingCopy', `Unable to interpret backup '${record.content.resource.toString()}'`, error);
			}
		}
		return result;
	}

	async store(backup: WorkingCopyBackup): Promise<void> {
		await this.prepare();
		const key = backup.resource.toString();
		const record = await this.backups.store(this.workspace(), serialize(backup), this.revisions.get(key));
		this.revisions.set(key, record.revision);
	}

	async delete(resource: URI): Promise<void> {
		await this.prepare();
		const key = resource.toString();
		const revision = this.revisions.get(key);
		// Opening a clean editor before recovery must not remove an unobserved backup.
		if (revision === undefined) return;
		await this.backups.discard(this.workspaceId, resource, revision);
		const legacy = this.legacyConflicts.get(key);
		if (legacy) {
			// Explicit save/revert also discards the observed older version, preventing its resurrection.
			await this.legacy.deleteIfUnchanged(legacy);
			this.legacyConflicts.delete(key);
		}
		this.revisions.delete(key);
	}

	switchWorkspace(workspaceId: string): void {
		this.workspaceId = workspaceId;
		this.revisions.clear();
		this.legacyConflicts.clear();
		this.preparation = undefined;
		this.legacy.switchWorkspace(workspaceId);
	}

	private workspace(): IBackupWorkspace {
		const workspace = this.workspaceContext.getWorkspace();
		if (workspace.id !== this.workspaceId) throw new Error('Backup workspace does not match the current workspace');
		return { id: workspace.id, folders: workspace.folders.map(folder => folder.uri), ...(workspace.configuration ? { configuration: workspace.configuration } : {}), ...(workspace.remoteAuthority ? { remoteAuthority: workspace.remoteAuthority } : {}) };
	}

	private prepare(): Promise<void> {
		return this.preparation ??= this.migrate().catch(error => { this.preparation = undefined; throw error; });
	}

	private async migrate(): Promise<void> {
		const records = await this.backups.list(this.workspaceId);
		const existing = new Map(records.map(record => [record.content.resource.toString(), record]));
		for (const backup of await this.legacy.list()) {
			const content = serialize(backup);
			const stored = existing.get(backup.resource.toString());
			// A different durable backup belongs to a newer writer. Retain the old source for inspection.
			if (stored && (stored.content.format !== content.format || stored.content.content !== content.content)) {
				this.legacyConflicts.set(backup.resource.toString(), backup);
				continue;
			}
			const record = stored ?? await this.backups.store(this.workspace(), content);
			existing.set(backup.resource.toString(), record);
			await this.legacy.deleteIfUnchanged(backup);
			this.revisions.set(backup.resource.toString(), record.revision);
		}
	}
}

function serialize(backup: WorkingCopyBackup): IBackupContent {
	return { resource: backup.resource, format: CONTENT_FORMAT, content: JSON.stringify({ kind: backup.kind, content: backup.content, ...(backup.languageId !== undefined ? { languageId: backup.languageId } : {}), ...(backup.contentType !== undefined ? { contentType: backup.contentType } : {}), ...(backup.label !== undefined ? { label: backup.label } : {}) }) };
}

function deserialize(record: IBackupRecord): WorkingCopyBackup {
	if (record.content.format !== CONTENT_FORMAT) throw new Error(`Unsupported working-copy backup format: ${record.content.format}`);
	const payload: unknown = JSON.parse(record.content.content);
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid working-copy backup');
	const value = payload as Record<string, unknown>;
	if ((value.kind !== 'text' && value.kind !== 'structuredDocument') || typeof value.content !== 'string'
		|| ['languageId', 'contentType', 'label'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) throw new Error('Invalid working-copy backup content');
	return {
		resource: record.content.resource, kind: value.kind, content: value.content, updatedAt: record.updatedAt,
		...(typeof value.languageId === 'string' ? { languageId: value.languageId } : {}),
		...(typeof value.contentType === 'string' ? { contentType: value.contentType } : {}),
		...(typeof value.label === 'string' ? { label: value.label } : {}),
	};
}
