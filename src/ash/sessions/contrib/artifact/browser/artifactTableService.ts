import { ArtifactTableModel } from '../common/artifactTableModel.js';
import { IArtifactTableService } from '../common/artifactTableService.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { isUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { isArtifactName } from '../common/artifactWorkspace.js';

/** Owns editable tables and their workspace-local copies. The gallery lists these same drafts. */
export class ArtifactTableService extends Disposable implements IArtifactTableService {
	private readonly home: URI;
	private readonly catalog = observableValue<ReadonlyMap<string, ArtifactTableModel>>(this, new Map());
	public readonly drafts: IObservable<ReadonlyMap<string, ArtifactTableModel>> = this.catalog;
	public readonly ready: Promise<void>;
	private readonly restoring = observableValue(this, true);
	public readonly isRestoring: IObservable<boolean> = this.restoring;
	private readonly pending = new Set<ArtifactTableModel>();
	private readonly deleting = new Set<ArtifactTableModel>();
	private saving: Promise<void> | undefined;
	private readonly saveSoon = this._register(new RunOnceScheduler(() => {
		void this.flush().catch(error => {
			this.log.error('creator', 'Failed to save table drafts', error);
			if (!this.isDisposed) this.notifications.error(localize({ bundle: 'ash.artifacts', key: 'tableSaveFailed' }, 'Could not save table changes. Your edits are still open in Artifacts.'));
		});
	}, 150));

	constructor(
		@IFileService private readonly files: IFileService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IUserDataProfileService profiles: IUserDataProfileService,
	) {
		super();
		this.home = URI.joinPath(profiles.currentProfile.location, 'creator', encodeURIComponent(workspace.getWorkspace().id), 'tables');
		this.ready = this.restore().catch(error => this.log.error('creator', 'Failed to load table drafts', error))
			.finally(() => { if (!this.isDisposed) this.restoring.set(false); });
		this._register(lifecycle.onWillShutdown(event => {
			event.join(() => this.flush(), 'Save artifact table drafts', () => !this.saving && this.pending.size === 0);
		}));
		this._register(addDisposableListener(mainWindow, 'beforeunload', (event: BeforeUnloadEvent) => {
			if (!lifecycle.willShutdown && (this.saving || this.pending.size > 0)) {
				event.preventDefault();
				event.returnValue = '';
			}
		}));
	}

	private readonly queueSave = (draft: ArtifactTableModel): void => {
		if (this.deleting.has(draft)) return;
		this.pending.add(draft);
		this.saveSoon.schedule();
	};

	private async restore(): Promise<void> {
		const entries = await this.files.readDirectory(this.home).catch(error => {
			if (error instanceof FileNotFoundError) { return []; }
			throw error;
		});
		const restored = new Map<string, ArtifactTableModel>();
		for (const entry of entries) {
			if (this.isDisposed) { return; }
			if (entry.kind !== FileKind.File || !entry.name.endsWith('.json')) { continue; }
			const id = entry.name.slice(0, -'.json'.length);
			if (!isUuid(id)) { continue; }
			try {
				const { content, revision } = await this.files.readFile(entry.resource);
				const value: unknown = JSON.parse(content);
				if (!isRecord(value) || (value.kind !== 'sheet' && value.kind !== 'data') || !isTableRows(value.rows)
					|| value.title !== undefined && !isArtifactName(value.title)
					|| value.createdAt !== undefined && (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0)) {
					throw new TypeError('Invalid artifact table draft');
				}
				restored.set(id, new ArtifactTableModel(id, value.kind, value.rows, revision, this.queueSave, value.title, value.createdAt as number | undefined));
			} catch (error) {
				this.log.warn('creator', 'Could not restore table draft', entry.resource.toString(), error);
			}
		}
		if (!this.isDisposed) this.catalog.set(restored, undefined);
	}

	public resource(draft: ArtifactTableModel): URI { return this.home.joinPathSegment(`${draft.id}.json`); }

	public async rename(draft: ArtifactTableModel, title: string): Promise<void> {
		if (this.catalog.get().get(draft.id) !== draft || this.deleting.has(draft)) return;
		draft.rename(title);
		await this.flush();
	}

	public async delete(draft: ArtifactTableModel): Promise<void> {
		if (this.catalog.get().get(draft.id) !== draft || this.deleting.has(draft)) return;
		this.deleting.add(draft);
		try {
			await this.saving?.catch(() => undefined);
			this.pending.delete(draft);
			await this.files.delete(this.home.joinPathSegment(`${draft.id}.json`), 'ignore', 'fileOrEmptyDirectory');
			const remaining = new Map(this.catalog.get());
			remaining.delete(draft.id);
			this.catalog.set(remaining, undefined);
		} catch (error) {
			this.deleting.delete(draft);
			this.queueSave(draft);
			throw error;
		} finally {
			this.deleting.delete(draft);
		}
	}

	private flush(): Promise<void> {
		this.saveSoon.cancel();
		if (this.saving) { return this.saving; }
		if (this.pending.size === 0) { return Promise.resolve(); }
		this.saving = this.writePending().finally(() => { this.saving = undefined; });
		return this.saving;
	}

	private async writePending(): Promise<void> {
		await this.files.createDirectory(this.home);
		while (this.pending.size > 0) {
			const batch = [...this.pending].filter(draft => !this.deleting.has(draft));
			this.pending.clear();
			const results = await Promise.allSettled(batch.map(async draft => {
				const resource = this.home.joinPathSegment(`${draft.id}.json`);
				const content = JSON.stringify({ kind: draft.kind, rows: draft.rows, title: draft.title.get(), createdAt: draft.createdAt });
				try {
					const result = await this.files.writeFile({ resource, content, expectedRevision: draft.revision });
					draft.revision = result.revision;
				} catch (error) {
					this.pending.add(draft);
					throw error;
				}
			}));
			const failure = results.find(result => result.status === 'rejected');
			if (failure) { throw failure.reason; }
		}
	}
}

function isTableRows(value: unknown): value is string[][] {
	if (!Array.isArray(value) || !Array.isArray(value[0]) || value[0].length === 0) { return false; }
	const width = value[0].length;
	return value.every(row => Array.isArray(row) && row.length === width && row.every(cell => typeof cell === 'string'));
}
