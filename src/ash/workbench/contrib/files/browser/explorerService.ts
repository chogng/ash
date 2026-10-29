import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ExplorerModel, type ExplorerItem } from '../common/explorerModel.js';
import type { IExplorerClipboard, IExplorerClipboardItem, IExplorerService, IExplorerView } from './files.js';
import { WorkspaceWatcher } from './workspaceWatcher.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IExpression } from '../../../../base/common/glob.js';
import { ResourceGlobMatcher } from '../../../common/resources.js';
import { dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import '../../../services/filesConfiguration/common/filesConfigurationService.js';

/** Owns the Explorer model and exposes the active view to file commands. */
export class ExplorerService extends Disposable implements IExplorerService {
	declare readonly _serviceBrand: undefined;
	private view: IExplorerView | undefined;
	private readonly clipboardChanged = this._register(new Emitter<void>());
	private readonly model: ExplorerModel;
	private readonly watcher: WorkspaceWatcher;
	readonly onDidChangeClipboard = this.clipboardChanged.event;
	readonly onDidChangeRoot: Event<void>;
	readonly onDidChangeResources: Event<readonly URI[] | undefined>;
	private clipboard: IExplorerClipboard = { items: [], cut: false };
	private readonly revealExcludeMatcher: ResourceGlobMatcher;

	constructor(
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IFileService files: IFileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.model = this._register(new ExplorerModel(workspace));
		this.watcher = this._register(new WorkspaceWatcher(files, workspace));
		this.onDidChangeRoot = this.model.onDidChangeRoot;
		this.onDidChangeResources = this.watcher.onDidChange;
		this._register(workspace.onDidChangeWorkspace(() => this.setToCopy([], false)));
		this.revealExcludeMatcher = this._register(
			new ResourceGlobMatcher(
				() => configuration.getValue<IExpression>('explorer.autoRevealExclude'),
				event => event.affectsConfiguration('explorer.autoRevealExclude'),
				workspace,
				configuration,
			),
		);
	}

	public shouldAutoReveal(resource: URI, hasSibling?: (name: string) => boolean): boolean {
		if (
			!this.configuration.getValue<boolean | 'focusNoScroll'>('explorer.autoReveal') ||
			this.revealExcludeMatcher.matches(resource, hasSibling)
		)
			return false;
		const root = this.model.root;
		const folder =
			root?.children?.find(item => extUriBiasedIgnorePathCase.isEqualOrParent(resource, item.resource)) ?? root;
		if (!folder || !extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder.resource)) return true;
		for (
			let parent = dirname(resource);
			extUriBiasedIgnorePathCase.isEqualOrParent(parent, folder.resource) &&
			!extUriBiasedIgnorePathCase.isEqual(parent, folder.resource);
			parent = dirname(parent)
		) {
			if (this.revealExcludeMatcher.matches(parent)) return false;
		}
		return true;
	}

	public getRoot(): ExplorerItem | undefined {
		return this.model.root;
	}

	public async refresh(): Promise<void> {
		await this.view?.refresh(true);
	}

	public getToCopy(): IExplorerClipboard {
		return this.clipboard;
	}
	public setToCopy(items: readonly IExplorerClipboardItem[], cut: boolean): void {
		this.clipboard = { items: items.map(({ resource, name, kind }) => ({ resource, name, kind })), cut };
		this.clipboardChanged.fire();
	}

	public getContext(): readonly ExplorerItem[] {
		return this.view?.getContext() ?? [];
	}

	public hasViewFocus(): boolean {
		return this.view?.hasFocus() ?? false;
	}

	public select(resource: URI, reveal?: boolean | string): Promise<void> {
		if (!this.view) throw new Error('Open the Explorer view before selecting a resource.');
		return this.view.selectResource(resource, reveal);
	}

	public getAccessibleContent(): string | undefined {
		return this.view?.getAccessibleContent();
	}

	public focus(): void {
		this.view?.focus();
	}

	public registerView(view: IExplorerView): IDisposable {
		if (this.view) {
			throw new Error('An Explorer view is already registered.');
		}
		this.view = view;
		return toDisposable(() => {
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}
}
