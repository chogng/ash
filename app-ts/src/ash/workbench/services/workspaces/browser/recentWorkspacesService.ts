import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { IWorkspacesService, recentWorkspaceUri, type IRecent } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IRecentWorkspacesService, type IRecentWorkspace } from '../common/recentWorkspacesService.js';
import { IWorkspaceOpenService } from './workspaceOpenService.js';

/** Adapts the host-owned history to the Welcome page and its open command. */
export class RecentWorkspacesService extends Disposable implements IRecentWorkspacesService {
	private readonly changed = this._register(new Emitter<readonly IRecentWorkspace[]>());
	public readonly onDidChange = this.changed.event;
	private entries: readonly IRecentWorkspace[] = [];
	private recording: Promise<void> = Promise.resolve();

	constructor(
		@IWorkspacesService private readonly history: IWorkspacesService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IWorkspaceOpenService private readonly workspaceOpen: IWorkspaceOpenService,
	) {
		super();
		this._register(history.onDidChangeRecentlyOpened(() => {
			void this.refresh().catch(error => console.error('Failed to refresh recent projects', error));
		}));
		this._register(workspaceContext.onDidChangeWorkspace(() => {
			void this.recordCurrentWorkspace().catch(error => console.error('Failed to record recent project', error));
		}));
	}

	public async initialize(): Promise<void> {
		await this.refresh();
		await this.recordCurrentWorkspace();
	}

	public get recentWorkspaces(): readonly IRecentWorkspace[] {
		return this.entries;
	}

	public openWorkspace(root: string): Promise<void> {
		return this.workspaceOpen.openWorkspace(root);
	}

	private async refresh(): Promise<void> {
		const recents = await this.history.getRecentlyOpened();
		if (this.isDisposed) {
			return;
		}
		this.entries = recents.workspaces.map(recent => {
			const uri = recentWorkspaceUri(recent);
			return { name: recent.label ?? basename(uri), path: uri.fsPath, root: uri.fsPath };
		});
		this.changed.fire(this.entries);
	}

	private recordCurrentWorkspace(): Promise<void> {
		const workspace = this.workspaceContext.getWorkspace();
		let recent: IRecent;
		if (workspace.configuration?.scheme === Schemas.file) {
			recent = { workspace: { id: workspace.id, configPath: workspace.configuration }, label: workspace.name ?? basename(workspace.configuration) };
		} else {
			const folder = workspace.folders.length === 1 ? workspace.folders[0] : undefined;
			if (folder?.uri.scheme !== Schemas.file) {
				return this.recording;
			}
			recent = { folderUri: folder.uri, label: folder.name };
		}
		// Capture each transition now; reading the context later would lose fast A → B switches.
		const previous = this.recording;
		this.recording = (async () => {
			await previous;
			if (this.isDisposed) {
				return;
			}
			await this.history.addRecentlyOpened([recent]);
			await this.refresh();
		})();
		return this.recording;
	}
}
