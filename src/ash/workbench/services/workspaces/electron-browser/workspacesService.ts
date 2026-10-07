import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspacesService, LEGACY_RECENT_WORKSPACES_STORAGE_KEY, restoreRecentlyOpened, toStoreData, type IRecent, type IRecentlyOpened } from '../../../../platform/workspaces/common/workspaces.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

/** Desktop windows consume the shared history and import their old Welcome records once. */
export class ElectronWorkspacesService extends Disposable implements IWorkspacesService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeRecentlyOpened = this.changed.event;
	private migration: Promise<void> | undefined;
	private readonly history: IChannel;

	constructor(@IStorageService private readonly storage: IStorageService, @IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this.history = mainProcessService.getChannel('workspaces');
		const subscription = this.history.listen('onDidChangeRecentlyOpened')(() => this.changed.fire());
		this._register(toDisposable(() => subscription.dispose()));
	}

	public async getRecentlyOpened(): Promise<IRecentlyOpened> {
		await this.migrate();
		return restoreRecentlyOpened(await this.history.call('getRecentlyOpened'));
	}

	public async addRecentlyOpened(recents: readonly IRecent[]): Promise<void> {
		await this.migrate();
		await this.history.call('addRecentlyOpened', toStoreData({ workspaces: recents }));
	}

	public async removeRecentlyOpened(paths: readonly URI[]): Promise<void> {
		await this.migrate();
		await this.history.call('removeRecentlyOpened', paths.map(path => path.toString()));
	}

	public async clearRecentlyOpened(): Promise<void> {
		await this.migrate();
		await this.history.call('clearRecentlyOpened');
	}

	private migrate(): Promise<void> {
		this.migration ??= this.importLegacyHistory();
		return this.migration;
	}

	private async importLegacyHistory(): Promise<void> {
		const legacy = this.storage.get(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE);
		if (legacy === undefined) {
			return;
		}
		await this.history.call('addRecentlyOpened', toStoreData(restoreRecentlyOpened(JSON.parse(legacy))));
		this.storage.remove(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE);
		await this.storage.flush();
	}
}

registerSingleton(IWorkspacesService, ElectronWorkspacesService, InstantiationType.Delayed);
