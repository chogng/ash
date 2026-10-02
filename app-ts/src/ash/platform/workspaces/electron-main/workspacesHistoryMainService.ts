import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { IStateService } from '../../state/node/state.js';
import { mergeRecentlyOpened, recentWorkspaceUri, restoreRecentlyOpened, toStoreData, RECENTLY_OPENED_STORAGE_KEY, type IRecent, type IRecentlyOpened, type IWorkspacesService } from '../common/workspaces.js';

/** Owns the Desktop history shared by every window, the taskbar, and the tray. */
export class WorkspacesHistoryMainService extends Disposable implements IWorkspacesService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeRecentlyOpened = this.changed.event;
	private recentlyOpened: IRecentlyOpened;

	constructor(@IStateService private readonly state: IStateService) {
		super();
		this.recentlyOpened = restoreRecentlyOpened(state.getItem(RECENTLY_OPENED_STORAGE_KEY));
	}

	public async getRecentlyOpened(): Promise<IRecentlyOpened> {
		return this.recentlyOpened;
	}

	public async addRecentlyOpened(recents: readonly IRecent[]): Promise<void> {
		this.recentlyOpened = mergeRecentlyOpened(this.recentlyOpened, recents);
		await this.save();
	}

	public async removeRecentlyOpened(paths: readonly URI[]): Promise<void> {
		const workspaces = this.recentlyOpened.workspaces.filter(recent => !paths.some(path => extUriBiasedIgnorePathCase.isEqual(path, recentWorkspaceUri(recent))));
		if (workspaces.length === this.recentlyOpened.workspaces.length) {
			return;
		}
		this.recentlyOpened = { workspaces };
		await this.save();
	}

	public async clearRecentlyOpened(): Promise<void> {
		this.recentlyOpened = { workspaces: [] };
		await this.save();
	}

	private async save(): Promise<void> {
		// Mutate before awaiting disk I/O so simultaneous window requests cannot overwrite one another.
		this.state.setItem(RECENTLY_OPENED_STORAGE_KEY, toStoreData(this.recentlyOpened));
		this.changed.fire();
		await this.state.flush();
	}
}
