import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	IWorkspacesService,
	LEGACY_RECENT_WORKSPACES_STORAGE_KEY,
	RECENTLY_OPENED_STORAGE_KEY,
	mergeRecentlyOpened,
	recentWorkspaceUri,
	restoreRecentlyOpened,
	toStoreData,
	type IRecent,
	type IRecentlyOpened,
} from '../../../../platform/workspaces/common/workspaces.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';

/** Browser history stays in the browser profile; Desktop uses its Main-process owner. */
export class BrowserWorkspacesService extends Disposable implements IWorkspacesService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeRecentlyOpened = this.changed.event;
	private recentlyOpened: IRecentlyOpened;
	private recording: Promise<void> = Promise.resolve();

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly context: IWorkspaceContextService,
	) {
		super();
		this.recentlyOpened = this.readHistory();
		this._register(context.onDidChangeWorkspace(() => this.recordCurrentWorkspace()));
		this.recordCurrentWorkspace();
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === RECENTLY_OPENED_STORAGE_KEY) {
					this.recentlyOpened = this.readHistory();
					this.changed.fire();
				}
			}),
		);
	}

	public async getRecentlyOpened(): Promise<IRecentlyOpened> {
		await this.recording;
		return this.recentlyOpened;
	}

	private recordCurrentWorkspace(): void {
		const workspace = this.context.getWorkspace();
		const folder = workspace.folders.length === 1 ? workspace.folders[0] : undefined;
		const recent: IRecent | undefined =
			workspace.configuration?.scheme === Schemas.file
				? {
						workspace: { id: workspace.id, configPath: workspace.configuration },
						label: workspace.name ?? basename(workspace.configuration),
					}
				: folder?.uri.scheme === Schemas.file
					? { folderUri: folder.uri, label: folder.name }
					: undefined;
		if (!recent) return;
		// Capture each accepted transition before queuing persistence; fast A → B
		// switches must record both identities rather than reading B twice later.
		this.recording = this.recording.then(async () => {
			if (!this.isDisposed) await this.addRecentlyOpened([recent]);
		});
		void this.recording.catch(error => console.error('Failed to record recent project', error));
	}

	private readHistory(): IRecentlyOpened {
		const saved = this.storage.get(RECENTLY_OPENED_STORAGE_KEY, StorageScope.PROFILE);
		if (saved !== undefined) {
			return restoreRecentlyOpened(JSON.parse(saved));
		}
		const legacy = this.storage.get(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE);
		return restoreRecentlyOpened(legacy === undefined ? undefined : JSON.parse(legacy));
	}

	public async addRecentlyOpened(recents: readonly IRecent[]): Promise<void> {
		this.store(mergeRecentlyOpened(this.recentlyOpened, recents));
	}

	public async removeRecentlyOpened(paths: readonly URI[]): Promise<void> {
		const current = this.recentlyOpened;
		this.store({
			workspaces: current.workspaces.filter(
				recent => !paths.some(path => extUriBiasedIgnorePathCase.isEqual(path, recentWorkspaceUri(recent))),
			),
		});
	}

	public async clearRecentlyOpened(): Promise<void> {
		this.store({ workspaces: [] });
	}

	private store(recents: IRecentlyOpened): void {
		this.recentlyOpened = recents;
		this.storage.store(
			RECENTLY_OPENED_STORAGE_KEY,
			JSON.stringify(toStoreData(recents)),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
		this.storage.remove(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE);
	}
}

registerSingleton(IWorkspacesService, BrowserWorkspacesService, InstantiationType.Delayed);
