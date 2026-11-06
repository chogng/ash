import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IBackupWorkspace } from '../../../../platform/backup/common/backup.js';

export interface WorkingCopyBackup {
	readonly resource: URI;
	readonly kind: 'text' | 'structuredDocument';
	readonly content: string;
	readonly updatedAt: number;
	readonly languageId?: string;
	readonly contentType?: string;
	readonly label?: string;
}

/** Durable, workspace-scoped crash backups for dirty working copies. */
export interface IWorkingCopyBackupService extends IDisposable {
	/** The caller can exclude resources already being recovered by an editor. */
	list(exclude?: ReadonlySet<string>): Promise<readonly WorkingCopyBackup[]>;
	resolve(resource: URI): Promise<WorkingCopyBackup | undefined>;
	store(backup: WorkingCopyBackup): Promise<void>;
	delete(resource: URI): Promise<void>;
	/** Desktop entry copies recovery durably before retiring the old scope. Producers must be paused. */
	moveBackups?(target: IBackupWorkspace): Promise<void>;
	/** Selects a recovery scope without discarding the previous workspace's durable backups. */
	switchWorkspace(workspaceId: string): void;
}

export const IWorkingCopyBackupService = createServiceIdentifier<IWorkingCopyBackupService>('workingCopyBackupService');

/** Keeps recovery semantics intact in an ephemeral Workbench host. */
export class InMemoryWorkingCopyBackupService extends Disposable implements IWorkingCopyBackupService {
	private readonly workspaces = new Map<string, Map<string, WorkingCopyBackup>>();
	constructor(private workspaceId: string) { super(); }
	private get backups(): Map<string, WorkingCopyBackup> {
		this.assertNotDisposed();
		let backups = this.workspaces.get(this.workspaceId);
		if (!backups) this.workspaces.set(this.workspaceId, backups = new Map());
		return backups;
	}
	async list(exclude?: ReadonlySet<string>): Promise<readonly WorkingCopyBackup[]> {
		return [...this.backups.values()].filter(backup => !exclude?.has(backup.resource.toString())).map(backup => ({ ...backup }));
	}
	async resolve(resource: URI): Promise<WorkingCopyBackup | undefined> {
		const backup = this.backups.get(resource.toString());
		return backup && { ...backup };
	}
	async store(backup: WorkingCopyBackup): Promise<void> { this.backups.set(backup.resource.toString(), { ...backup }); }
	async delete(resource: URI): Promise<void> { this.backups.delete(resource.toString()); }
	switchWorkspace(workspaceId: string): void { this.assertNotDisposed(); this.workspaceId = workspaceId; }
	protected override disposeCore(): void { this.workspaces.clear(); super.disposeCore(); }
}
