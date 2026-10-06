import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { IStateService } from '../../state/node/state.js';
import { mergeRecentlyOpened, recentWorkspaceUri, restoreRecentlyOpened, toStoreData, RECENTLY_OPENED_STORAGE_KEY, type IRecent, type IRecentlyOpened, type IWorkspacesService } from '../common/workspaces.js';
import { basename } from 'node:path';
import type { JumpListCategory } from 'electron';
import { windowsCommandLine } from '../../environment/node/argvHelper.js';

export interface IWindowsJumpListOptions {
	readonly executable: string;
	readonly launchArguments: readonly string[];
	readonly iconPath: string;
	readonly recentProjectsTitle: string;
	readonly tasks: readonly { readonly title: string; readonly description: string; readonly argument: string; }[];
}

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

	public async updateWindowsJumpList(options: IWindowsJumpListOptions): Promise<void> {
		this.assertNotDisposed();
		const { app } = await import('electron/main');
		const { executable, launchArguments, iconPath } = options;
		const categories: JumpListCategory[] = [{
			type: 'tasks',
			items: options.tasks.map(task => ({
				type: 'task',
				program: executable,
				args: windowsCommandLine([...launchArguments, task.argument]),
				iconPath,
				iconIndex: 0,
				title: task.title,
				description: task.description,
			})),
		}];
		const settings = app.getJumpListSettings();
		const removed = this.recentlyOpened.workspaces.filter(recent => settings.removedItems.some(item => item.args === windowsCommandLine([...launchArguments, ...this.getWorkspaceLaunchArguments(recent)])));
		// Explorer rejects a whole category if it contains an item the user removed.
		if (removed.length > 0) await this.removeRecentlyOpened(removed.map(recentWorkspaceUri));
		const items = this.recentlyOpened.workspaces.slice(0, settings.minItems).map(recent => ({
			type: 'task' as const,
			program: executable,
			args: windowsCommandLine([...launchArguments, ...this.getWorkspaceLaunchArguments(recent)]),
			iconPath,
			iconIndex: 0,
			title: (recent.label ?? basename(recentWorkspaceUri(recent).fsPath)).slice(0, 255),
			description: recentWorkspaceUri(recent).fsPath.slice(0, 255),
		}));
		if (items.length > 0) categories.push({ type: 'custom', name: options.recentProjectsTitle, items });
		categories.push({ type: 'recent' });
		if (this.isDisposed) return;
		const result = app.setJumpList(categories);
		if (result !== 'ok') console.error(`Failed to update Windows Jump List: ${result}`);
	}

	public getWorkspaceLaunchArguments(recent: IRecent): string[] {
		return 'workspace' in recent ? ['--workspace', recent.workspace.configPath.fsPath] : ['--folder-uri', recent.folderUri.toString()];
	}

	private async save(): Promise<void> {
		// Mutate before awaiting disk I/O so simultaneous window requests cannot overwrite one another.
		this.state.setItem(RECENTLY_OPENED_STORAGE_KEY, toStoreData(this.recentlyOpened));
		this.changed.fire();
		await this.state.flush();
	}
}
