import { addDisposableListener } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';

export type TableArtifactKind = 'sheet' | 'data';

export class ArtifactTableDraft {
	constructor(
		public readonly id: string,
		public readonly kind: TableArtifactKind,
		private readonly cells: string[][],
		public revision: string | undefined,
		private readonly onChange: (draft: ArtifactTableDraft) => void,
	) { }

	public get rows(): readonly (readonly string[])[] { return this.cells; }
	public get columnCount(): number { return this.cells[0].length; }

	public setCell(row: number, column: number, value: string): void {
		if (this.cells[row][column] === value) { return; }
		this.cells[row][column] = value;
		this.onChange(this);
	}

	public addRow(): void {
		this.cells.push(Array<string>(this.columnCount).fill(''));
		this.onChange(this);
	}

	public addColumn(): void {
		for (const row of this.cells) { row.push(''); }
		this.onChange(this);
	}
}

/** Owns editable tables and their workspace-local copies. The gallery lists these same drafts. */
export class ArtifactTableDrafts extends Disposable {
	private readonly home: URI;
	private readonly catalog = observableValue<ReadonlyMap<string, ArtifactTableDraft>>(this, new Map());
	public readonly drafts: IObservable<ReadonlyMap<string, ArtifactTableDraft>> = this.catalog;
	public readonly ready: Promise<void>;
	private readonly pending = new Set<ArtifactTableDraft>();
	private saving: Promise<void> | undefined;
	private readonly saveSoon = this._register(new RunOnceScheduler(() => {
		void this.flush().catch(error => {
			this.log.error('creator', 'Failed to save table drafts', error);
			if (!this.isDisposed) this.notifications.error(localize({ bundle: 'ash.artifacts', key: 'tableSaveFailed' }, 'Could not save table changes. Your edits are still open in Artifacts.'));
		});
	}, 150));

	constructor(
		ownerWindow: Window,
		@IFileService private readonly files: IFileService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IUserDataProfileService profiles: IUserDataProfileService,
	) {
		super();
		this.home = URI.joinPath(profiles.currentProfile.location, 'creator', encodeURIComponent(workspace.getWorkspace().id), 'tables');
		this.ready = this.restore().catch(error => this.log.error('creator', 'Failed to load table drafts', error));
		this._register(lifecycle.onWillShutdown(event => {
			event.join(() => this.flush(), 'Save artifact table drafts', () => !this.saving && this.pending.size === 0);
		}));
		this._register(addDisposableListener(ownerWindow, 'beforeunload', (event: BeforeUnloadEvent) => {
			if (!lifecycle.willShutdown && (this.saving || this.pending.size > 0)) {
				event.preventDefault();
				event.returnValue = '';
			}
		}));
	}

	public create(kind: TableArtifactKind): ArtifactTableDraft {
		const draft = new ArtifactTableDraft(generateUuid(), kind, [['', '', '']], undefined, this.queueSave);
		this.catalog.set(new Map(this.catalog.get()).set(draft.id, draft), undefined);
		this.queueSave(draft);
		return draft;
	}

	private readonly queueSave = (draft: ArtifactTableDraft): void => {
		this.pending.add(draft);
		this.saveSoon.schedule();
	};

	private async restore(): Promise<void> {
		const entries = await this.files.readDirectory(this.home).catch(error => {
			if (error instanceof FileNotFoundError) { return []; }
			throw error;
		});
		const restored = new Map<string, ArtifactTableDraft>();
		for (const entry of entries) {
			if (this.isDisposed) { return; }
			if (entry.kind !== FileKind.File || !entry.name.endsWith('.json')) { continue; }
			const id = entry.name.slice(0, -'.json'.length);
			if (!isUuid(id)) { continue; }
			try {
				const { content, revision } = await this.files.readFile(entry.resource);
				const value: unknown = JSON.parse(content);
				if (!isRecord(value) || (value.kind !== 'sheet' && value.kind !== 'data') || !isTableRows(value.rows)) {
					throw new TypeError('Invalid artifact table draft');
				}
				restored.set(id, new ArtifactTableDraft(id, value.kind, value.rows, revision, this.queueSave));
			} catch (error) {
				this.log.warn('creator', 'Could not restore table draft', entry.resource.toString(), error);
			}
		}
		// A user can create a draft while the existing files are still loading.
		if (!this.isDisposed && restored.size > 0) this.catalog.set(new Map([...restored, ...this.catalog.get()]), undefined);
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
			const batch = [...this.pending];
			this.pending.clear();
			const results = await Promise.allSettled(batch.map(async draft => {
				const resource = this.home.joinPathSegment(`${draft.id}.json`);
				const content = JSON.stringify({ kind: draft.kind, rows: draft.rows });
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
