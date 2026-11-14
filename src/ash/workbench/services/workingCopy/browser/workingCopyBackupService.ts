import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
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
	private workspaceGeneration = 0;
	private readonly revisions = new Map<string, string>();
	private readonly legacyConflicts = new Map<string, WorkingCopyBackup>();
	private readonly preparedResources = new Set<string>();
	private readonly resolutions = new Map<string, Promise<WorkingCopyBackup | undefined>>();
	private readonly legacy: IndexedDbWorkingCopyBackupService;
	private preparation: Promise<void> | undefined;
	private movedRevisions: { workspaceId: string; revisions: ReadonlyMap<string, string>; } | undefined;

	constructor(
		private readonly fixedWorkspace: IBackupWorkspace | undefined,
		@IBackupService private readonly backups: IBackupService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.workspaceId = (fixedWorkspace ?? workspaceContext.getWorkspace()).id;
		this.legacy = this._register(new IndexedDbWorkingCopyBackupService(this.workspaceId));
	}

	async list(exclude?: ReadonlySet<string>): Promise<readonly WorkingCopyBackup[]> {
		const generation = this.workspaceGeneration;
		const workspaceId = this.workspaceId;
		await this.prepare(generation);
		this.assertCurrentWorkspace(generation);
		const records = await this.backups.list(workspaceId);
		this.assertCurrentWorkspace(generation);
		const result: WorkingCopyBackup[] = [];
		for (const record of records) {
			if (exclude?.has(record.content.resource.toString())) {
				continue;
			}
			try {
				result.push(deserialize(record));
				this.revisions.set(record.content.resource.toString(), record.revision);
			} catch (error) {
				this.logService.error('workingCopy', `Unable to interpret backup '${record.content.resource.toString()}'`, error);
			}
		}
		return result;
	}

	resolve(resource: URI): Promise<WorkingCopyBackup | undefined> {
		const key = resource.toString();
		const pending = this.resolutions.get(key);
		if (pending) {
			return pending;
		}
		const resolution = this.resolveResource(resource, this.workspaceGeneration).finally(() => {
			if (this.resolutions.get(key) === resolution) {
				this.resolutions.delete(key);
			}
		});
		this.resolutions.set(key, resolution);
		return resolution;
	}

	private async resolveResource(resource: URI, generation: number): Promise<WorkingCopyBackup | undefined> {
		const workspace = this.workspace();
		await this.preparation;
		this.assertCurrentWorkspace(generation);
		const key = resource.toString();
		const [stored, legacy] = await Promise.all([
			this.backups.read(workspace.id, resource),
			this.preparedResources.has(key) ? undefined : this.legacy.resolve(resource),
		]);
		this.assertCurrentWorkspace(generation);
		const record = legacy ? await this.migrateRecord(workspace, legacy, stored, generation) : stored;
		this.assertCurrentWorkspace(generation);
		const backup = record && deserialize(record);
		if (record) {
			this.revisions.set(key, record.revision);
		}
		this.preparedResources.add(key);
		return backup;
	}

	async store(backup: WorkingCopyBackup): Promise<void> {
		const generation = this.workspaceGeneration;
		const workspace = this.workspace();
		if (!this.preparedResources.has(backup.resource.toString())) {
			await this.prepare(generation);
		}
		this.assertCurrentWorkspace(generation);
		const key = backup.resource.toString();
		const record = await this.backups.store(workspace, serialize(backup), this.revisions.get(key));
		this.assertCurrentWorkspace(generation);
		this.revisions.set(key, record.revision);
	}

	async delete(resource: URI): Promise<void> {
		const generation = this.workspaceGeneration;
		const workspaceId = this.workspaceId;
		if (!this.preparedResources.has(resource.toString())) {
			await this.prepare(generation);
		}
		this.assertCurrentWorkspace(generation);
		const key = resource.toString();
		const revision = this.revisions.get(key);
		// Opening a clean editor before recovery must not remove an unobserved backup.
		if (revision === undefined) return;
		await this.backups.discard(workspaceId, resource, revision);
		this.assertCurrentWorkspace(generation);
		const legacy = this.legacyConflicts.get(key);
		if (legacy) {
			// Explicit save/revert also discards the observed older version, preventing its resurrection.
			await this.legacy.deleteIfUnchanged(legacy);
			this.assertCurrentWorkspace(generation);
			this.legacyConflicts.delete(key);
		}
		this.revisions.delete(key);
	}

	async moveBackups(target: IBackupWorkspace): Promise<void> {
		if (this.fixedWorkspace) {
			if (target.id !== this.fixedWorkspace.id) throw new Error('A fixed backup scope cannot move workspace');
			return;
		}
		if (target.id === this.workspaceId) return;
		const generation = this.workspaceGeneration;
		const sourceId = this.workspaceId;
		await this.prepare(generation);
		const source = await this.backups.list(sourceId);
		const observed = new Set(source.filter(record => this.revisions.get(record.content.resource.toString()) === record.revision).map(record => record.content.resource.toString()));
		const moved = await this.backups.move(sourceId, target, source.map(record => ({ resource: record.content.resource, revision: record.revision })));
		this.assertCurrentWorkspace(generation);
		// Moving bytes does not acknowledge recovery content. Retain only revisions
		// already observed by this editor; unknown formats and other writers' newer
		// source records still require explicit restoration in the destination.
		this.movedRevisions = { workspaceId: target.id, revisions: new Map(moved.filter(record => observed.has(record.resource.toString())).map(record => [record.resource.toString(), record.revision])) };
	}

	switchWorkspace(workspaceId: string): void {
		this.assertNotDisposed();
		if (this.fixedWorkspace && this.fixedWorkspace.id !== workspaceId) throw new Error('A fixed backup scope cannot switch workspace');
		this.legacy.switchWorkspace(workspaceId);
		this.workspaceId = workspaceId;
		this.workspaceGeneration++;
		this.revisions.clear();
		if (this.movedRevisions?.workspaceId === workspaceId) for (const [key, revision] of this.movedRevisions.revisions) this.revisions.set(key, revision);
		this.movedRevisions = undefined;
		this.legacyConflicts.clear();
		this.preparedResources.clear();
		this.resolutions.clear();
		this.preparation = undefined;
	}

	private assertCurrentWorkspace(generation: number): void {
		// An issued backend write can commit after replacement; its response must not update the new scope.
		if (this.isDisposed || generation !== this.workspaceGeneration) {
			throw new CancellationError();
		}
	}

	private workspace(): IBackupWorkspace {
		const workspace = this.fixedWorkspace;
		if (workspace) return workspace;
		const current = this.workspaceContext.getWorkspace();
		if (current.id !== this.workspaceId) throw new Error('Backup workspace does not match the current workspace');
		return { id: current.id, folders: current.folders.map(folder => folder.uri), ...(current.configuration ? { configuration: current.configuration } : {}), ...(current.remoteAuthority ? { remoteAuthority: current.remoteAuthority } : {}) };
	}

	private prepare(generation: number): Promise<void> {
		this.assertCurrentWorkspace(generation);
		return this.preparation ??= this.migrate(generation).catch(error => {
			if (generation === this.workspaceGeneration) {
				this.preparation = undefined;
			}
			throw error;
		});
	}

	private async migrate(generation: number): Promise<void> {
		const workspace = this.workspace();
		// Let already-issued point reads finish their own migration. Later point
		// reads join this preparation before looking up their resource.
		if (this.resolutions.size) {
			await Promise.allSettled(this.resolutions.values());
			this.assertCurrentWorkspace(generation);
		}
		const legacy = await this.legacy.list(this.preparedResources);
		this.assertCurrentWorkspace(generation);
		// The durable catalog is only needed to reconcile drafts that still need migration.
		if (legacy.length === 0) return;

		const records = await this.backups.list(workspace.id);
		this.assertCurrentWorkspace(generation);
		const existing = new Map(records.map(record => [record.content.resource.toString(), record]));
		for (const backup of legacy) {
			const key = backup.resource.toString();
			const record = await this.migrateRecord(workspace, backup, existing.get(key), generation);
			this.assertCurrentWorkspace(generation);
			this.preparedResources.add(key);
			if (!this.legacyConflicts.has(key)) {
				this.revisions.set(key, record.revision);
			}
		}
	}

	private async migrateRecord(workspace: IBackupWorkspace, backup: WorkingCopyBackup, stored: IBackupRecord | undefined, generation: number): Promise<IBackupRecord> {
		const content = serialize(backup);
		// A different durable backup belongs to a newer writer. Retain the old source for inspection.
		if (stored && (stored.content.format !== content.format || stored.content.content !== content.content)) {
			this.legacyConflicts.set(backup.resource.toString(), backup);
			return stored;
		}
		const record = stored ?? await this.backups.store(workspace, content);
		this.assertCurrentWorkspace(generation);
		await this.legacy.deleteIfUnchanged(backup);
		return record;
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
