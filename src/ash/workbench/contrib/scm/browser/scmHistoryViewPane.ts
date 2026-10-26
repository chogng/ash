import { defaultListStyles, defaultFindWidgetStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { localize2, localize } from '../../../../nls.js';
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement, ObjectTreeNode } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { appendIcon } from "../../../../base/browser/ui/lxicons/lxicon.js";
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { ThemeIcon } from '../../../../base/common/themables.js';

import { equals } from '../../../../base/common/arrays.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ResourceTree, type IResourceNode } from '../../../../base/common/resourceTree.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { MenuWorkbenchToolBar, WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { getActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, type IQuickPickItem, type IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Action2, IMenuService, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { ContextKeyExpr, RawContextKey, type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService, type IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService, IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import { toOpenEditorOptions, type IOpenEditorOptions } from "../../../../platform/editor/browser/editor.js";
import { IHoverService, type IManagedHover } from "../../../../platform/hover/browser/hoverService.js";
import { IResourceLabelService, type ResourceLabels } from "../../../browser/labels.js";
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId, SCMHistoryUnavailableError, SCMHistoryItemUri, type ISCMHistoryItemComparison, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemRef, type ISCMHistoryItemViewModel, type ISCMHistoryProvider, type SCMHistoryItemChangeViewModelTreeElement, type SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { ISCMService, ISCMViewService } from '../common/scm.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from "../../../services/editor/common/editorService.js";
import type { IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ViewPane, ViewPaneShowActions } from "../../../browser/parts/views/viewPane.js";
import { createBinaryDiffEditorInput, createDiffEditorInput } from "../../../common/editor/diffEditorInput.js";
import { setupHistoryItemHover, toHistoryItemHoverContent, SWIMLANE_HEIGHT, SWIMLANE_WIDTH, renderSCMHistoryItemGraph, renderSCMHistoryGraphPlaceholder, toISCMHistoryItemViewModelArray } from './scmHistory.js';
import { SCMHistoryBusyContext, SCMHistoryProviderIdContext } from '../common/scm.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../multiDiffEditor/browser/multiDiffEditorInput.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.viewChanges',
			title: localize2({ bundle: 'ash', key: 'scm.history.openChanges' }, 'Open Changes'),
			icon: Lxicon.diffMultiple1,
			f1: false,
			menu: { id: MenuId.SCMHistoryItemContext, group: 'inline', order: 1 },
		});
	}

	public override async run(accessor: ServicesAccessor, element: SCMHistoryItemViewModelTreeElement | URI, comparison?: ISCMHistoryItemComparison | string, token: CancellationToken = CancellationToken.None): Promise<void> {
		if (!CancellationToken.isCancellationToken(token) || token.isCancellationRequested) return;
		const source = URI.isUri(element) ? SCMHistoryItemUri.fromUri(element) : undefined;
		if (URI.isUri(element) ? !source || source.path !== undefined : element?.type !== 'historyItemViewModel') return;
		const scm = accessor.get(ISCMService);
		const repository = scm.getRepository(source ? source.repositoryId : (element as SCMHistoryItemViewModelTreeElement).repository?.provider?.id);
		const provider = repository?.provider.historyProvider;
		if (!repository || !provider) {
			if (source) throw new SCMHistoryUnavailableError(localize('scm.history.sourceUnavailable', 'The original source control repository is unavailable. The saved attachment content is still available.'));
			return;
		}
		const historyItem = source ? undefined : (element as SCMHistoryItemViewModelTreeElement).historyItemViewModel.historyItem;
		const selectedComparison = typeof comparison === 'object' ? comparison : undefined;
		const revision = source?.revision ?? historyItem!.comparison?.revision ?? historyItem!.id;
		const baseRevision = source ? source.baseRevision : selectedComparison?.baseId ?? historyItem!.comparison?.baseRevision ?? historyItem!.parentIds[0];
		const title = source ? (typeof comparison === 'string' ? comparison : revision) : selectedComparison?.label ?? (historyItem!.comparison ? historyItem!.subject : `${historyItem!.displayId ?? historyItem!.id} · ${historyItem!.subject}`);
		const isCurrent = () => !token.isCancellationRequested && scm.getRepository(repository.id) === repository && repository.provider.historyProvider === provider;
		await accessor.get(IProgressService).withProgress({ location: 'ash.gitGraph', delay: 100 }, async () => {
			if (!isCurrent()) return;
			const changes = await provider.provideHistoryItemChanges(revision, baseRevision);
			if (!isCurrent()) return;
			if (!changes?.length) {
				if (changes) { accessor.get(INotificationService).info(localize('scm.history.noChanges', 'There are no changes between these versions.')); }
				return;
			}
			const items: MultiDiffEditorInputItem[] = [];
			// Bound provider traffic while overlapping independent extension round trips.
			// Batches keep Git order and stop scheduling further reads after a failure.
			for (let offset = 0; offset < changes.length; offset += 4) {
				const batch = await Promise.all(changes.slice(offset, offset + 4).map(async change => {
					const file = await provider.resolveHistoryItemChangeContents(revision, change);
					// Missing sides represent additions and deletions; their revision URIs keep empty models distinct.
					return {
						binary: file.original.kind === 'binary' || file.modified.kind === 'binary',
						label: change.originalPath ? `${change.originalPath} → ${change.path}` : change.path,
						original: { resource: source ? historyFileResource(source, change, true, file.parentId) : change.originalUri ?? change.uri, readOnly: true, initialText: file.original.kind === 'text' ? file.original.text : '' },
						modified: { resource: source ? historyFileResource(source, change, false) : change.modifiedUri ?? change.uri, readOnly: true, initialText: file.modified.kind === 'text' ? file.modified.text : '' },
					};
				}));
				if (!isCurrent()) return;
				items.push(...batch);
			}
			const resource = URI.from({ scheme: 'ash-multi-diff', path: `/scm-history/${repository.id}/${baseRevision ?? 'parent'}/${revision}` });
			await accessor.get(IEditorService).openEditor(createMultiDiffEditorInput(resource, items, title, { kind: 'snapshot', repositoryId: repository.id, label: historyItem?.displayId ?? revision }), { pinned: true });
		}).catch(error => {
			if (!isCurrent()) return;
			// The attachment owns source-action errors; menu invocations retain graph notifications.
			if (!source) accessor.get(INotificationService).error(error instanceof Error ? error : String(error));
			throw error;
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.openFile',
			title: localize2('scm.history.openFile', 'Open File'),
			icon: Lxicon.goToFile,
			f1: false,
			precondition: ContextKeyExpr.notEquals('scmHistoryItemChangeStatus', 'deleted'),
			menu: { id: MenuId.SCMHistoryItemChangeContext, group: 'inline', order: 1 },
		});
	}

	public override async run(accessor: ServicesAccessor, element: SCMHistoryItemChangeViewModelTreeElement | URI, _label?: string, token: CancellationToken = CancellationToken.None): Promise<void> {
		if (!CancellationToken.isCancellationToken(token) || token.isCancellationRequested) return;
		const source = URI.isUri(element) ? SCMHistoryItemUri.fromUri(element) : undefined;
		if (URI.isUri(element) ? !source?.path : element?.type !== 'historyItemChangeViewModel') return;
		const scm = source ? accessor.get(ISCMService) : undefined;
		const repository = source ? scm!.getRepository(source.repositoryId) : (element as SCMHistoryItemChangeViewModelTreeElement).repository;
		const provider = repository?.provider.historyProvider;
		if (!repository || !provider) {
			if (source) throw new SCMHistoryUnavailableError(localize('scm.history.sourceUnavailable', 'The original source control repository is unavailable. The saved attachment content is still available.'));
			return;
		}
		const isCurrent = () => !token.isCancellationRequested && (!source || scm!.getRepository(repository.id) === repository) && repository.provider.historyProvider === provider;
		const historyItem = source ? undefined : (element as SCMHistoryItemChangeViewModelTreeElement).historyItemViewModel.historyItem;
		const revision = source?.revision ?? historyItem!.comparison?.revision ?? historyItem!.id;
		const historyItemChange = source ? (await provider.provideHistoryItemChanges(revision, source.baseRevision))?.find(change => change.path === source.path) : (element as SCMHistoryItemChangeViewModelTreeElement).historyItemChange;
		if (!isCurrent() || !historyItemChange) return;
		const file = await provider.resolveHistoryItemChangeContents(revision, historyItemChange);
		if (!isCurrent()) return;
		// A copied deletion still has a historical file: use its captured parent, never the workspace.
		const original = !!source && file.modified.kind === 'missing';
		const contents = original ? file.original : file.modified;
		if (contents.kind === 'missing') return;
		if (contents.kind === 'binary' && !contents.bytes) {
			accessor.get(INotificationService).info(localize('scm.history.binaryUnavailable', 'The history provider did not supply binary file contents.'));
			return;
		}
		const name = historyItemChange.path.split('/').at(-1) ?? historyItemChange.path;
		await accessor.get(IEditorService).openEditor({
			resource: source ? historyFileResource(source, historyItemChange, original, file.parentId) : historyItemChange.modifiedUri ?? historyItemChange.uri,
			label: `${name} (${original ? (source?.baseRevision ?? file.parentId)?.slice(0, 7) ?? 'empty' : historyItem?.displayId ?? revision.slice(0, 7)})`,
			readOnly: true,
			...(contents.kind === 'text' ? { initialText: contents.text } : { initialBytes: contents.bytes, contentType: 'application/octet-stream' }),
		}, source ? { pinned: true } : undefined);
	}
});

/** Providers may omit revision URIs. Such snapshots must not borrow a working-file model or alias diff sides. */
function historyFileResource(source: NonNullable<ReturnType<typeof SCMHistoryItemUri.fromUri>>, change: ISCMHistoryItemChange, original: boolean, parentId?: string): URI {
	return (original ? change.originalUri : change.modifiedUri) ?? SCMHistoryItemUri.toUri({
		repositoryId: source.repositoryId,
		revision: original ? source.baseRevision ?? parentId ?? source.revision : source.revision,
		path: original ? change.originalPath ?? change.path : change.path,
	}).with({ fragment: original ? 'original' : 'modified' });
}

type HistoryItemRefsFilter = 'auto' | 'all' | readonly string[];
const HistoryViewMode = new RawContextKey<'list' | 'tree'>('scmHistoryViewMode', 'list');
const HistoryCurrentRefHasUpstream = new RawContextKey<boolean>('scmCurrentHistoryItemRefHasRemote', false);
const HistoryCurrentRefHasBase = new RawContextKey<boolean>('scmCurrentHistoryItemRefHasBase', false);
const HistoryCurrentRefHasCommit = new RawContextKey<boolean>('scmCurrentHistoryItemRefHasCommit', false);
const HistoryRefsAvailable = new RawContextKey<boolean>('scmHistoryRefsAvailable', false);

function getHistoryView(accessor: ServicesAccessor, target: unknown): SCMHistoryViewPane | null {
	return target instanceof SCMHistoryViewPane ? target : accessor.get(IViewsService).getActiveViewWithId<SCMHistoryViewPane>('ash.gitGraph');
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.pickHistoryItemRefs',
			title: localize2('scm.history.filter', 'Filter History References'),
			icon: Lxicon.gitBranch,
			precondition: HistoryRefsAvailable.isEqualTo(true),
			menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 1 },
		});
	}
	public override async run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		await getHistoryView(accessor, target)?.pickHistoryItemRef();
	}
});
for (const mode of ['list', 'tree'] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.scm.action.graph.set${mode === 'list' ? 'List' : 'Tree'}ViewMode`,
				title: mode === 'list' ? localize2('scm.history.viewAsList', 'View as List') : localize2('scm.history.viewAsTree', 'View as Tree'),
				icon: mode === 'list' ? Lxicon.listUnordered : Lxicon.folders,
				menu: { id: MenuId.SCMHistoryTitle, group: '9_viewmode', order: mode === 'list' ? 1 : 2 },
				toggled: HistoryViewMode.isEqualTo(mode),
			});
		}
		public override run(accessor: ServicesAccessor, target: unknown): void {
			getHistoryView(accessor, target)?.setViewMode(mode);
		}
	});
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.pickRepository',
			title: localize2('scm.history.repositoryPicker', 'Repository Picker'),
			icon: Lxicon.gitBranch,
			menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 0, when: ContextKeyExpr.greater('scm.historyProviderCount', 1) },
		});
	}
	public override async run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		await getHistoryView(accessor, target)?.pickRepository();
	}
});

const CurrentHistoryItemAvailable = new RawContextKey<boolean>('scmHistoryCurrentItemAvailable', false);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.revealCurrentHistoryItem',
			title: localize2('scm.history.goToCurrent', 'Go to Current History Item'),
			icon: Lxicon.target,
			precondition: ContextKeyExpr.and(CurrentHistoryItemAvailable.isEqualTo(true), SCMHistoryBusyContext.isEqualTo(false)),
			menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 2 },
		});
	}

	public override async run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		const view = getHistoryView(accessor, target);
		await view?.runTitleOperation(() => view.revealCurrentHistoryItem());
	}
});

type HistoryItemChanges =
	| { readonly state: "loading"; }
	| { readonly state: "ready"; readonly result: readonly ISCMHistoryItemChange[]; }
	| { readonly state: "error"; readonly message: string; };

interface HistoryPage {
	readonly items: readonly ISCMHistoryItem[];
	readonly hasMore: boolean;
}

interface HistoryCommitElement {
	readonly id: string;
	readonly kind: 'commit';
	model: ISCMHistoryItemViewModel;
}

type HistoryTreeElement = HistoryCommitElement
	| { readonly id: string; readonly kind: 'file'; readonly model: ISCMHistoryItemViewModel; readonly change: ISCMHistoryItemChange; }
	| { readonly id: string; readonly kind: 'folder'; readonly model: ISCMHistoryItemViewModel; readonly folder: IResourceNode<ISCMHistoryItemChange, ISCMHistoryItemViewModel>; }
	| { readonly id: string; readonly kind: 'state'; readonly model: ISCMHistoryItemViewModel; readonly message: string; }
	| { readonly id: string; readonly kind: 'more'; };

// Each rendered commit owns its actions and hover independently of viewport updates.
class HistoryItemRow extends Disposable {
	public readonly element: HTMLDivElement;
	public readonly resources = this._register(new DisposableStore());
	public readonly references = this._register(new DisposableStore());
	public referenceLabels: HTMLSpanElement | undefined;
	public visibleReferences: readonly ISCMHistoryItemRef[] = [];
	public headReferenceId: string | undefined;
	public scope: IScopedContextKeyService | undefined;
	public target: SCMHistoryItemViewModelTreeElement | undefined;
	public hover: IManagedHover | undefined;
	public focusDetails: (() => void) | undefined;

	constructor(public historyItemViewModel: ISCMHistoryItemViewModel, public graph: SVGSVGElement, document: Document) {
		super();
		this.element = h(document, 'div');
		this._register(toDisposable(() => this.element.remove()));
	}
}

/** Paged SCM history rendered as a compact graph. */
export class SCMHistoryViewPane extends ViewPane {
	private readonly loadingProgress = this._register(new DisposableStore());
	private readonly scmViewService: ISCMViewService;
	private readonly graphLabel: string;
	private readonly busyContext: IContextKey<boolean>;
	private readonly providerIdContext: IContextKey<string>;
	private readonly currentItemContext: IContextKey<boolean>;
	private readonly graphElement: HTMLDivElement;
	private readonly statusElement: HTMLDivElement;
	private readonly statusResources = this._register(new DisposableStore());
	private readonly rowResources = this._register(new DisposableMap<string, HistoryItemRow>());
	private readonly resourceLabels: ResourceLabels;
	private readonly more = this._register(new DisposableStore());
	private readonly providerListener = this._register(new MutableDisposable());
	private provider: ISCMHistoryProvider | undefined;
	private viewMode: 'list' | 'tree' = 'list';
	private readonly viewModeContext: IContextKey<'list' | 'tree'>;
	private readonly refsAvailableContext: IContextKey<boolean>;
	private readonly upstreamContext: IContextKey<boolean>;
	private readonly baseContext: IContextKey<boolean>;
	private readonly branchContext: IContextKey<boolean>;
	private readonly filters = new Map<string, HistoryItemRefsFilter>();
	private historyItemRefs: readonly string[] | undefined;
	private comparison: { readonly remote: ISCMHistoryItemRef; readonly base: string; readonly incoming: boolean; readonly outgoing: boolean; } | undefined;
	private readonly filterPicker = this._register(new MutableDisposable<DisposableStore>());
	private page: HistoryPage | undefined;
	private head: ISCMHistoryItemRef | undefined;
	private generation = 0;
	private openGeneration = 0;
	private loading = false;
	private refreshing = false;
	private refreshFailed = false;
	private titleOperation: object | undefined;
	private moreError: string | undefined;
	private rows: readonly ISCMHistoryItemViewModel[] = [];
	private tree: ObjectTree<HistoryTreeElement> | undefined;
	private readonly moreItem: HistoryTreeElement = { id: 'more', kind: 'more' };
	private readonly treeResources = this._register(new MutableDisposable<DisposableStore>());
	private readonly changeRows = this._register(new DisposableMap<HTMLElement, DisposableStore>());

	// Cached provider reads; expansion, focus and selection belong exclusively to ObjectTree.
	private readonly commitChanges = new Map<string, HistoryItemChanges>();
	private graphRepositoryId: string | undefined;
	public get repositoryId(): string | undefined { return this.graphRepositoryId; }

	constructor(container: HTMLElement, options: IViewPaneOptions, @ISCMViewService scmViewService: ISCMViewService, @IMenuService private readonly menuService: IMenuService, @IContextMenuService private readonly contextMenuService: IContextMenuService, @IContextKeyService private readonly contextKeyService: IContextKeyService, @IHoverService private readonly hoverService: IHoverService, @IEditorService private readonly editorService: IEditorService, @IResourceLabelService resourceLabelService: IResourceLabelService, @IAccessibleViewService private readonly accessibleView: IAccessibleViewService, @IContextViewService private readonly contextViewService: IContextViewService, @IClipboardService private readonly clipboardService: IClipboardService, @IOpenerService private readonly openerService: IOpenerService, @IConfigurationService private readonly configurationService: IConfigurationService, @IQuickInputService private readonly quickInputService: IQuickInputService, @IStorageService private readonly storageService: IStorageService, @ISCMService private readonly scmService: ISCMService) {
		super(container, { ...options, showActions: ViewPaneShowActions.WhenExpanded });
		this.resourceLabels = this._register(resourceLabelService.createGroup());
		this.scmViewService = scmViewService;
		this.graphLabel = options.title;
		this.viewMode = storageService.get('scm.graphView.viewMode', StorageScope.WORKSPACE) === 'tree' ? 'tree' : 'list';
		this.viewModeContext = HistoryViewMode.bindTo(contextKeyService);
		this.viewModeContext.set(this.viewMode);
		this.refsAvailableContext = HistoryRefsAvailable.bindTo(contextKeyService);
		this.upstreamContext = HistoryCurrentRefHasUpstream.bindTo(contextKeyService);
		this.baseContext = HistoryCurrentRefHasBase.bindTo(contextKeyService);
		this.branchContext = HistoryCurrentRefHasCommit.bindTo(contextKeyService);
		this._register(toDisposable(() => { this.upstreamContext.reset(); this.baseContext.reset(); this.branchContext.reset(); }));
		this._register(toDisposable(() => { this.viewModeContext.reset(); this.refsAvailableContext.reset(); }));
		try {
			const saved: unknown = JSON.parse(storageService.get('scm.graphView.referencesFilter', StorageScope.WORKSPACE) ?? '[]');
			if (Array.isArray(saved)) {
				for (const entry of saved) {
					if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') { continue; }
					const filter: unknown = entry[1];
					if (filter === 'all' || filter === 'auto' || Array.isArray(filter) && filter.length <= 1000 && filter.every(id => typeof id === 'string' && id.length <= 1024)) { this.filters.set(entry[0], filter as HistoryItemRefsFilter); }
				}
			}
		} catch { /* Invalid saved UI state is reconstructed from the repository. */ }
		this.contentElement.classList.add("ash-scm-secondary-pane");
		this.graphElement = h(container.ownerDocument, "div");
		this.graphElement.className = "ash-scm-graph";
		this.graphElement.style.setProperty('--scm-graph-lane-width', `${SWIMLANE_WIDTH}px`);
		this.statusElement = h(container.ownerDocument, 'div');
		this.statusElement.className = 'ash-scm-empty';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		this.graphElement.append(this.statusElement);
		this.contentElement.append(this.graphElement);
		this._register(observeResize([this.graphElement], () => this.loadMoreIfVisible()));
		this.busyContext = SCMHistoryBusyContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.busyContext.reset()));
		this.providerIdContext = SCMHistoryProviderIdContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.providerIdContext.reset()));
		this.currentItemContext = CurrentHistoryItemAvailable.bindTo(contextKeyService);
		this._register(toDisposable(() => this.currentItemContext.reset()));
		const toolbar = this._register(new MenuWorkbenchToolBar(
			this.headerActionsElement,
			menuService,
			contextMenuService,
			MenuId.SCMHistoryTitle,
			{ ariaLabel: localize('scm.history.actions', 'History actions'), menuOptions: { arg: this } },
		));
		toolbar.element.classList.add("ash-scm-remote-actions");
		this._register(this.scmViewService.onDidChangeActiveRepository(() => void this.refresh()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('scm.graph.pageSize') || event.affectsConfiguration('scm.graph.showIncomingChanges') || event.affectsConfiguration('scm.graph.showOutgoingChanges')) { void this.refresh(); }
			else if (event.affectsConfiguration('scm.graph.pageOnScroll') && this.page) { this.renderGraph(this.page); }
			else if (event.affectsConfiguration('scm.graph.badges') && this.page) { this.renderGraph(this.page); }
		}));
		void this.refresh();
	}

	public setViewMode(mode: 'list' | 'tree'): void {
		if (this.viewMode === mode) { return; }
		this.viewMode = mode;
		this.viewModeContext.set(mode);
		this.storageService.store('scm.graphView.viewMode', mode, StorageScope.WORKSPACE, StorageTarget.USER);
		if (this.page) { this.renderGraph(this.page); }
	}

	private get filterKey(): string {
		const repository = this.scmViewService.activeRepository;
		return repository?.provider.rootUri?.toString() ?? repository?.id ?? '';
	}

	public async pickRepository(): Promise<void> {
		const resources = new DisposableStore();
		this.filterPicker.value = resources;
		const repositories = [...this.scmService.repositories].filter(repository => repository.provider.historyProvider);
		const picker = resources.add(this.quickInputService.createQuickPick<IQuickPickItem & { repository: typeof repositories[number]; }>());
		picker.placeholder = picker.ariaLabel = localize('scm.history.pickRepository', 'Choose a repository for the Source Control Graph');
		picker.items = repositories.map(repository => ({
			label: repository.provider.label,
			description: repository.provider.activeRepositoryName,
			detail: repository.provider.rootUri?.fsPath,
			picked: repository === this.scmViewService.activeRepository,
			repository,
		}));
		const selected = await new Promise<typeof repositories[number] | undefined>(resolve => {
			resources.add(toDisposable(() => resolve(undefined)));
			resources.add(picker.onDidHide(() => { if (this.filterPicker.value === resources) { this.filterPicker.clear(); } }));
			resources.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;

				resolve(item.repository);
				picker.hide();

			}));
			picker.show();
		});
		if (this.isDisposed || !selected || this.scmService.getRepository(selected.id) !== selected) { return; }
		try {
			await selected.provider.activate();
			if (!this.isDisposed && this.scmService.getRepository(selected.id) === selected) { this.scmViewService.selectRepository(selected.id); }
		} catch {
			if (!this.isDisposed) {
				this.statusElement.hidden = false;
				this.statusElement.textContent = localize('scm.history.repositoryFailed', 'Unable to select the history repository.');
			}
		}
	}

	private getHistoryItemReferences(item: ISCMHistoryItem): readonly ISCMHistoryItemRef[] {
		const references = historyItemReferences(item, this.head);
		const filter = this.filters.get(this.filterKey) ?? 'auto';
		if (this.configurationService.getValue<string>('scm.graph.badges') !== 'filter' || filter === 'all' || !this.provider?.provideHistoryItemRefs) { return references; }
		const ids = Array.isArray(filter) ? filter : [this.head?.id, this.provider.historyItemRemoteRef?.get()?.id, this.provider.historyItemBaseRef?.get()?.id];
		return references.filter(reference => ids.includes(reference.id));
	}

	public async pickHistoryItemRef(): Promise<void> {
		const provider = this.provider;
		const key = this.filterKey;
		if (!provider?.provideHistoryItemRefs) { return; }
		const resources = new DisposableStore();
		this.filterPicker.value = resources;
		type Pick = IQuickPickItem & { readonly reference: ISCMHistoryItemRef | 'auto' | 'all'; };
		const picker = resources.add(this.quickInputService.createQuickPick<Pick>());
		picker.canSelectMany = true;
		picker.sortByLabel = false;
		picker.placeholder = picker.ariaLabel = localize('scm.history.selectRefs', 'Select history references; use Ctrl+Space to toggle, then Enter to apply.');
		picker.busy = true;
		resources.add(picker.onDidHide(() => { if (this.filterPicker.value === resources) { this.filterPicker.clear(); } }));
		picker.show();
		try {
			const references = await provider.provideHistoryItemRefs();
			if (this.isDisposed || this.provider !== provider || key !== this.filterKey || this.filterPicker.value !== resources) { return; }
			const current = this.filters.get(key) ?? 'auto';
			const modes: Pick[] = [
				{ label: localize('scm.history.autoRefs', 'Auto (current branch, upstream and base branch)'), reference: 'auto' },
				{ label: localize('scm.history.allRefs', 'All References'), reference: 'all' },
			];
			const referencePicks = references.map(reference => {
				let icon = Lxicon.gitBranch;
				if (reference.category === 'remoteBranch') {
					icon = Lxicon.cloud;
				} else if (reference.category === 'tag') {
					icon = Lxicon.tag;
				}
				return {
					label: reference.name,
					description: reference.description === reference.name ? undefined : reference.description,
					iconClass: ThemeIcon.asClassName(icon),
					reference,
				};
			});
			const selected = Array.isArray(current)
				? referencePicks.filter(item => current.includes(item.reference.id))
				: modes.filter(item => item.reference === current);
			const items: (Pick | IQuickPickSeparator)[] = [...modes];
			// Keep explicit choices together when reopening, then group the remaining refs.
			if (Array.isArray(current) && selected.length) {
				items.push({ type: 'separator' }, ...selected);
			}
			const groups = new Map<string, typeof referencePicks>();
			for (const item of referencePicks) {
				if (selected.includes(item)) { continue; }
				const category = item.reference.category ?? '';
				const group = groups.get(category);
				if (group) {
					group.push(item);
				} else {
					groups.set(category, [item]);
				}
			}
			const categories = ['localBranch', 'remoteBranch', 'tag'];
			const orderedCategories = [...categories, ...[...groups.keys()].filter(category => !categories.includes(category))];
			for (const category of orderedCategories) {
				const group = groups.get(category);
				if (!group) { continue; }
				let label = category;
				if (category === 'localBranch') {
					label = localize('scm.history.branches', 'Branches');
				} else if (category === 'remoteBranch') {
					label = localize('scm.history.remoteBranches', 'Remote Branches');
				} else if (category === 'tag') {
					label = localize('scm.history.tags', 'Tags');
				}
				items.push({ type: 'separator', label }, ...group);
			}
			picker.items = items;
			picker.selectedItems = selected;
			picker.activeItems = selected.slice(0, 1);
			let selection = picker.selectedItems;
			resources.add(picker.onDidChangeSelection(selected => {
				if (selected.length === selection.length && selected.every((item, index) => item === selection[index])) { return; }
				const added = selected.find(item => !selection.includes(item));
				selection = added && typeof added.reference === 'string' ? [added] : selected.filter(item => typeof item.reference !== 'string');
				if (selection.length !== selected.length || selection.some((item, index) => item !== selected[index])) { picker.selectedItems = selection; }
			}));
			picker.busy = false;
			await new Promise<void>(resolve => {
				resources.add(toDisposable(() => resolve()));
				resources.add(picker.onDidHide(() => resolve()));
				resources.add(picker.onDidAccept(() => {
					if (selection.length === 0) { return; }
					const first = selection[0].reference;
					this.filters.set(key, typeof first === 'string' ? first : selection.map(item => (item.reference as ISCMHistoryItemRef).id));
					this.storageService.store('scm.graphView.referencesFilter', JSON.stringify([...this.filters]), StorageScope.WORKSPACE, StorageTarget.USER);
					this.page = undefined;
					this.commitChanges.clear();
					picker.hide();
					void this.refresh();
				}));
			});
		} catch {
			if (!this.isDisposed && this.filterPicker.value === resources) {
				this.statusElement.hidden = false;
				this.statusElement.textContent = localize('scm.history.refsFailed', 'Unable to load history references. Try opening the picker again.');
			}
		} finally {
			if (this.filterPicker.value === resources) { this.filterPicker.clear(); }
		}
	}

	public async runTitleOperation(operation?: () => Promise<unknown>): Promise<void> {
		const owner = {};
		this.titleOperation = owner;
		this.busyContext.set(true);
		try {
			await operation?.();
			if (this.isDisposed || this.titleOperation !== owner) return;
			// Operations publish effective history changes through the provider.
			// Only an explicit refresh bypasses its cached history.
			if (!operation) {
				this.provider?.refresh();
				await this.refresh();
			}
		} finally {
			if (!this.isDisposed && this.titleOperation === owner) {
				this.titleOperation = undefined;
				this.busyContext.set(false);
			}
		}
	}

	public async revealCurrentHistoryItem(): Promise<void> {
		const filter = this.filters.get(this.filterKey) ?? 'auto';
		if (this.head?.revision && (Array.isArray(filter) && !filter.includes(this.head.id) || this.historyItemRefs && !this.historyItemRefs.includes(this.head.revision))) {
			this.filters.delete(this.filterKey);
			this.storageService.store('scm.graphView.referencesFilter', JSON.stringify([...this.filters]), StorageScope.WORKSPACE, StorageTarget.USER);
			this.page = undefined;
			await this.refresh();
		}
		const revision = this.head?.revision;
		const generation = this.generation;
		if (!revision) { return; }
		let index = this.rows.findIndex(row => row.historyItem.id === revision);
		while (index < 0 && this.page?.hasMore) {
			const previousPage = this.page;
			await this.loadMore();
			if (this.isDisposed || generation !== this.generation || this.head?.revision !== revision || this.page === previousPage) { return; }
			index = this.rows.findIndex(row => row.historyItem.id === revision);
		}
		if (index >= 0 && this.tree) {
			this.tree.reveal(`commit:${revision}`, 0.5);
			this.selectCommit(revision);
		}
	}

	private clearGraph(): void {
		this.page = undefined;
		this.head = undefined;
		this.comparison = undefined;
		this.historyItemRefs = undefined;
		this.currentItemContext.set(false);
		this.upstreamContext.set(false);
		this.baseContext.set(false);
		this.branchContext.set(false);
		this.loading = false;
		this.moreError = undefined;
		this.rows = [];
		this.treeResources.clear();
		this.tree = undefined;
		this.changeRows.clearAndDisposeAll();
		this.commitChanges.clear();
		this.rowResources.clearAndDisposeAll();
		this.more.clear();
		this.statusResources.clear();
		this.graphElement.replaceChildren(this.statusElement);
	}

	private async refresh(): Promise<void> {
		this.loadingProgress.clear();
		const generation = ++this.generation;
		const repository = this.scmViewService.activeRepository;
		this.providerIdContext.set(repository?.provider.providerId ?? '');
		this.refsAvailableContext.set(typeof repository?.provider.historyProvider?.provideHistoryItemRefs === 'function');
		const provider = repository?.provider.historyProvider;
		if (repository?.id !== this.graphRepositoryId || provider !== this.provider) {
			this.titleOperation = undefined;
			this.busyContext.set(false);
			this.filterPicker.clear();
			this.clearGraph();
			this.provider = provider;
			const listeners = new DisposableStore();
			this.providerListener.value = listeners;
			if (repository) {
				const busyProgress = listeners.add(new MutableDisposable());
				const updateProgress = () => {
					if (!repository.provider.isBusy) { busyProgress.clear(); }
					else if (!busyProgress.value) {
						const progress = this.getProgressIndicator().show(true, 250);
						busyProgress.value = toDisposable(() => progress.done());
					}
				};
				listeners.add(repository.provider.onDidChangeResources(updateProgress));
				updateProgress();
			}
			if (provider) {
				listeners.add(provider.onDidChange(() => void this.refresh()));
				if (provider.historyItemRemoteRef) { listeners.add(provider.historyItemRemoteRef.onDidChange(() => void this.refresh())); }
				if (provider.historyItemBaseRef) { listeners.add(provider.historyItemBaseRef.onDidChange(() => void this.refresh())); }
				listeners.add(provider.historyItemRef.onDidChange(head => {
					this.head = head;
					if (this.page) this.renderGraph(this.page);
				}));
				if (provider.onDidChangeHistoryItemRefs) {
					listeners.add(provider.onDidChangeHistoryItemRefs(items => {
						if ((this.filters.get(this.filterKey) ?? 'auto') !== 'all' && provider.provideHistoryItemRefs) { void this.refresh(); return; }
						if (!this.page) { return; }
						const byId = new Map(items.map(item => [item.id, item]));
						this.page = {
							...this.page, items: this.page.items.map(item => {
								const update = byId.get(item.id);
								return update ? { ...update, tooltip: update.tooltip ?? item.tooltip } : item;
							})
						};
						this.head = provider.historyItemRef.get();
						this.renderGraph(this.page);
					}));
				}
			}
			this.graphRepositoryId = repository?.id;
		}
		const previousPage = this.page;
		this.loading = false;
		this.moreError = undefined;
		this.refreshing = true;
		this.refreshFailed = false;
		this.statusResources.clear();
		this.statusElement.textContent = localize('scm.history.loadingGraph', 'Loading commit graph…');
		this.statusElement.hidden = this.rows.length > 0;
		this.graphElement.setAttribute('aria-busy', 'true');
		if (!provider) {
			this.refreshing = false;
			this.renderGraph({ items: [], hasMore: false });
			return;
		}
		const progress = this.getProgressIndicator().show(true, 100);
		const handle = this.loadingProgress.add(toDisposable(() => progress.done()));
		using progressLifetime = toDisposable(() => { this.loadingProgress.delete(handle); handle.dispose(); });
		try {
			const previousComparison = this.comparison;
			const previousHead = this.head?.revision;
			if (provider.provideHistoryItemRefs) {
				const refs = await provider.provideHistoryItemRefs();
				if (this.isDisposed || generation !== this.generation) { return; }
				this.head = provider.historyItemRef.get();
				const remoteRef = provider.historyItemRemoteRef?.get();
				// Provider snapshots may identify the upstream without its commit revision.
				// Use the freshly queried ref to capture immutable comparison endpoints.
				const remote = refs.find(ref => ref.id === remoteRef?.id && ref.revision !== undefined) ?? remoteRef;
				let filter = this.filters.get(this.filterKey) ?? 'auto';
				let selected = Array.isArray(filter) ? refs.filter(ref => filter.includes(ref.id)) : [];
				if (Array.isArray(filter) && selected.length === 0) {
					filter = 'auto';
					this.filters.delete(this.filterKey);
					this.storageService.store('scm.graphView.referencesFilter', JSON.stringify([...this.filters]), StorageScope.WORKSPACE, StorageTarget.USER);
				}
				if (filter === 'auto') {
					selected = [this.head, remote, provider.historyItemBaseRef?.get()]
						.filter((ref): ref is ISCMHistoryItemRef => !!ref)
						.map(ref => ref.revision ? ref : refs.find(candidate => candidate.id === ref.id) ?? ref);
				}
				this.historyItemRefs = filter === 'all' ? undefined : selected.map(ref => ref.revision ?? ref.id);
				this.comparison = undefined;
				if (this.head?.revision && remote?.revision && remote.revision !== this.head.revision && provider.resolveHistoryItemRefsCommonAncestor) {
					// A missing merge base must not hide otherwise readable commit history.
					const base = await provider.resolveHistoryItemRefsCommonAncestor([this.head.revision, remote.revision]).catch(() => undefined);
					if (this.isDisposed || generation !== this.generation) { return; }
					if (base) {
						this.comparison = {
							remote, base,
							incoming: this.configurationService.getValue<boolean>('scm.graph.showIncomingChanges') && (filter === 'all' || selected.some(ref => ref.id === remote.id)),
							outgoing: this.configurationService.getValue<boolean>('scm.graph.showOutgoingChanges') && (filter === 'all' || selected.some(ref => ref.id === this.head?.id)),
						};
					}
				}
			}
			if (previousHead !== this.head?.revision || previousComparison?.remote.revision !== this.comparison?.remote.revision || previousComparison?.base !== this.comparison?.base) {
				this.commitChanges.delete(SCMIncomingHistoryItemId);
				this.commitChanges.delete(SCMOutgoingHistoryItemId);
			}
			// One bounded look-ahead page retains the loaded tail when new commits arrive.
			const pageSize = this.configurationService.getValue<number>('scm.graph.pageSize');
			const limit = previousPage ? Math.max(pageSize, previousPage.items.length) + pageSize : pageSize;
			const loaded = await provider.provideHistoryItems({ skip: 0, limit: limit + 1, historyItemRefs: this.historyItemRefs });
			if (this.isDisposed || generation !== this.generation) return;
			const items = [...loaded ?? []];
			const previousTail = previousPage?.items.at(-1)?.id;
			let tailIndex = previousTail === undefined ? -1 : items.findIndex(item => item.id === previousTail);
			let hasMore = items.length > limit;
			if (previousTail && tailIndex < 0 && hasMore && this.head?.revision && provider.resolveHistoryItemRefsCommonAncestor) {
				// Only search beyond the bounded refresh when the old tail is still reachable.
				// A rewritten branch must not cause refresh to drain the entire repository.
				const ancestor = await provider.resolveHistoryItemRefsCommonAncestor([previousTail, this.head.revision]).catch(() => undefined);
				if (this.isDisposed || generation !== this.generation) return;
				while (ancestor === previousTail && tailIndex < 0 && hasMore) {
					const next = await provider.provideHistoryItems({ skip: items.length, limit: pageSize + 1, historyItemRefs: this.historyItemRefs }) ?? [];
					if (this.isDisposed || generation !== this.generation) return;
					items.push(...next);
					hasMore = next.length > pageSize;
					tailIndex = items.findIndex(item => item.id === previousTail);
				}
			}
			const retainedCount = Math.max(pageSize, previousPage?.items.length ?? 0, tailIndex + 1);
			const page = { items: items.slice(0, retainedCount), hasMore: items.length > retainedCount || hasMore };
			this.page = page;
			this.head = provider.historyItemRef.get();
			this.renderGraph(page);
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			this.refreshFailed = true;
			if (error instanceof SCMHistoryUnavailableError) this.clearGraph();
			this.statusElement.hidden = false;
			this.statusElement.textContent = error instanceof Error ? error.message : String(error);
			if (!(error instanceof SCMHistoryUnavailableError)) {
				const retry = h(this.graphElement.ownerDocument, 'button');
				retry.className = 'ash-scm-command';
				retry.type = 'button';
				retry.textContent = localize('scm.history.retry', 'Retry');
				retry.setAttribute('aria-label', localize('scm.history.retryGraph', 'Retry loading commit graph'));
				this.statusResources.add(addDisposableListener(retry, 'click', () => void this.refresh()));
				this.statusElement.append(retry);
			}
		} finally {
			if (!this.isDisposed && generation === this.generation) {
				this.refreshing = false;
				this.graphElement.setAttribute('aria-busy', this.loading || this.refreshing ? 'true' : 'false');
				this.loadMoreIfVisible();
			}
		}
	}

	private renderGraph(page: HistoryPage): void {
		const tree = this.tree;
		const scrollTop = tree?.scrollTop ?? 0;
		const anchor = tree?.model.visibleNodes.find(node => (tree.getElementTop(node.id) ?? 0) + SWIMLANE_HEIGHT > scrollTop);
		const anchorOffset = anchor ? scrollTop - (tree!.getElementTop(anchor.id) ?? 0) : 0;
		const document = this.graphElement.ownerDocument;
		const focused = document.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.graphElement.contains(focused) ? focused : undefined;
		const focusedId = tree?.focus?.id;
		const retained = new Set([...page.items.map(item => item.id), SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId]);
		for (const id of this.commitChanges.keys()) {
			if (!retained.has(id)) this.commitChanges.delete(id);
		}
		this.rows = toISCMHistoryItemViewModelArray(page.items, new Map(), this.head, this.comparison);
		this.currentItemContext.set(this.head?.revision !== undefined);
		this.upstreamContext.set(this.provider?.historyItemRemoteRef?.get() !== undefined);
		this.baseContext.set(this.provider?.historyItemBaseRef?.get() !== undefined);
		this.branchContext.set(this.head?.category === 'localBranch' && this.head.revision !== undefined);
		this.statusElement.hidden = page.items.length > 0;
		this.statusElement.textContent = localize('scm.history.empty', 'No commits yet.');
		if (!this.tree && page.items.length > 0) this.createHistoryTree();
		if (this.tree) {
			const children: ObjectTreeElement<HistoryTreeElement>[] = this.rows.map(model => {
				const id = `commit:${model.historyItem.id}`;
				const previous = this.tree!.model.getElement(id);
				const element: HistoryCommitElement = previous?.kind === 'commit' ? previous : { id, kind: 'commit', model };
				element.model = model;
				const row = this.rowResources.get(model.historyItem.id);
				if (row) this.updateCommitRow(row, model);
				return { element, collapsible: true, collapsed: this.tree!.isCollapsed(id) ?? true, children: this.getCommitChildren(model) };
			});
			if (page.hasMore && this.showLoadMore()) children.push({ element: this.moreItem });
			this.tree.setChildren(children);
			if (anchor && this.tree.model.has(anchor.id)) this.tree.scrollTop = (this.tree.getElementTop(anchor.id) ?? 0) + anchorOffset;
			else if (scrollTop === 0) this.tree.scrollTop = 0;
			if (restoreFocus === this.tree.element && focusedId && !this.tree.model.has(focusedId)) {
				// A rewritten branch may remove the focused node while the tree keeps
				// DOM focus. Give its visible replacement logical focus without scrolling.
				const replacement = this.tree.model.visibleNodes.find(node => (this.tree!.getElementTop(node.id) ?? 0) + SWIMLANE_HEIGHT > this.tree!.scrollTop);
				if (replacement) this.tree.setFocus(replacement.id);
			}
			this.updateSelection();
			for (const node of this.tree.model.rootNodes) {
				if (node.element.kind === 'commit' && !node.collapsed && !this.commitChanges.has(node.element.model.historyItem.id)) {
					const currentTree = this.tree;
					const item = node.element.model.historyItem;
					queueMicrotask(() => { if (!this.isDisposed && currentTree === this.tree && currentTree.isCollapsed(node.id) === false) void this.loadCommitChanges(item); });
				}
			}
			if (restoreFocus && !restoreFocus.isConnected && document.activeElement === document.body) {
				if (focusedId && this.tree.model.has(focusedId)) this.tree.setFocus(focusedId);
				this.tree.domFocus();
			}
		}
		this.graphElement.setAttribute('aria-busy', this.loading || this.refreshing ? 'true' : 'false');
		this.loadMoreIfVisible();
	}

	private createHistoryTree(): void {
		const resources = new DisposableStore();
		this.treeResources.value = resources;
		// Graph columns are SCM content. The shared tree owns full-width rows, hierarchy and interaction.
		const tree = resources.add(new ObjectTree<HistoryTreeElement>(this.graphElement, {
			styles: defaultListStyles,
			findWidgetStyles: defaultFindWidgetStyles,
			ariaLabel: this.graphLabel,
			scrolling: 'managed',
			indent: 0,
			indentGuides: 'none',
			multipleSelectionSupport: false,
			expandOnlyOnTwistieClick: false,
			twistieAdditionalCssClass: () => 'ash-tree-twistie-hidden',
			modelOptions: { identityProvider: { getId: element => element.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.kind === 'commit' ? element.model.historyItem.subject : element.kind === 'file' ? element.change.path : element.kind === 'folder' ? element.folder.name : undefined },
			getHeight: element => element.kind === 'more' ? SWIMLANE_HEIGHT * 2 : SWIMLANE_HEIGHT,
			reuseRows: true,
			renderElement: (element, node) => {
				if (element.kind === 'more') { this.more.clear(); return this.renderMore(); }
				if (element.kind === 'commit') return this.renderCommit(element.model, renderSCMHistoryItemGraph(element.model, SWIMLANE_HEIGHT, this.graphElement.ownerDocument)).element;
				return this.renderHistoryChange(element, node);
			},
			onDidRemoveRow: row => {
				const commit = row.querySelector<HTMLElement>('.ash-scm-graph-commit');
				if (commit?.dataset.historyItemId) this.rowResources.deleteAndDispose(commit.dataset.historyItemId);
				const change = row.querySelector<HTMLElement>('.ash-scm-graph-change-row, .ash-scm-graph-folder, .ash-scm-graph-change-state');
				if (change) this.changeRows.deleteAndDispose(change);
				if (row.querySelector('.ash-scm-graph-load-more')) this.more.clear();
			},
		}));
		this.tree = tree;
		tree.domNode.classList.add('ash-scm-graph-viewport');
		tree.element.classList.add('ash-scm-graph-tree');
		tree.element.setAttribute('aria-multiselectable', 'false');
		const navigationHelp = localize('scm.history.help', 'Use Up and Down Arrow to navigate and select commits, folders and changed files. Navigating to a file previews it while keeping focus here. Home and End move to the first and last loaded rows; Page Up and Page Down move by a page. Right Arrow expands a commit or folder and enters its children; Left Arrow collapses it or returns to its parent. Enter or Space toggles commits and folders. Enter opens and pins a changed file; Space previews it while keeping focus in history. Click a file to preview it and double-click to pin it. Hold Ctrl, Command or Alt when clicking to open it beside the current editor. On macOS, Command+Down Arrow also opens the selected item. Press Shift+F10 or the Context Menu key for provider actions. Use Tab to reach reference badges, Open Changes and Open File. Press Alt+Down Arrow on a commit to focus its details; Escape returns to history. Use Filter History References to select branches and tags; Ctrl+Space toggles a reference and Enter applies the selection. Use View as List or View as Tree to change file layout. Incoming and Outgoing Changes compare the branch with its merge base. Binary changes open a read-only hexadecimal comparison. The graph selects one row at a time. Escape clears the selection without collapsing files. Loading more or refreshing retains available selections and expanded rows.');
		const pagingHelp = localize('scm.history.pagingHelp', 'Automatic loading fetches older commits before you reach the end. When it is off, use Load more commits. If loading fails, use Retry; the loaded history stays available.');
		tree.element.setAttribute('aria-description', `${navigationHelp} ${pagingHelp}`);
		resources.add(tree.onDidChangeSelection(event => {
			this.updateSelection();
			const element = event.elements[0];
			if (element?.kind === 'file' && event.browserEvent instanceof KeyboardEvent && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.browserEvent.key)) {
				void this.openCommitChange(element.model.historyItem, element.change, { editorOptions: { pinned: false, preserveFocus: true }, openToSide: false });
			}
		}));
		resources.add(tree.onDidChangeFocus(() => this.updateSelection()));
		resources.add(tree.onDidChangeCollapseState(event => {
			if (event.element.kind === 'commit' && !event.collapsed) {
				const item = event.element.model.historyItem;
				queueMicrotask(() => { if (!this.isDisposed && tree === this.tree && tree.isCollapsed(event.element.id) === false) void this.loadCommitChanges(item); });
			}
			if (event.element.kind === 'folder') this.updateFolderTwistie(event.element.id, event.collapsed);
		}));
		resources.add(tree.onPointer(({ element, browserEvent }) => {
			if (element.kind === 'file' && browserEvent.detail !== 2) void this.openCommitChange(element.model.historyItem, element.change, toOpenEditorOptions(browserEvent));
		}));
		resources.add(tree.onDidDoubleClick(({ element, browserEvent }) => {
			if (element.kind === 'file') void this.openCommitChange(element.model.historyItem, element.change, toOpenEditorOptions(browserEvent, true));
		}));
		resources.add(tree.onDidAccept(({ element, browserEvent }) => {
			if (element.kind === 'commit' || element.kind === 'folder') tree.toggleCollapsed(element.id);
			else if (element.kind === 'file') {
				const options = toOpenEditorOptions(new StandardKeyboardEvent(browserEvent));
				if (options) void this.openCommitChange(element.model.historyItem, element.change, options);
			} else if (element.kind === 'more') void this.loadMore();
		}));
		// The shared tree prevents native pointer focus, which can retain :focus-visible.
		resources.add(addDisposableListener(tree.element, 'pointerdown', () => tree.element.classList.add('pointer-navigation'), true));
		resources.add(addDisposableListener(tree.element, 'blur', () => tree.element.classList.remove('pointer-navigation')));
		resources.add(addDisposableListener(tree.element, 'keydown', event => {
			tree.element.classList.remove('pointer-navigation');
			this.onHistoryKeyDown(event);
		}, true));
		resources.add(this.onDidChangeBodyVisibility(visible => { if (visible) this.loadMoreIfVisible(); }));
		resources.add(tree.onDidScroll(() => {
			this.updateSelection();
			for (const [, row] of this.rowResources) {
				if (!row.hover?.visible) continue;
				if (!row.element.isConnected) row.hover.hide();
				else this.contextViewService.layout();
			}
			this.loadMoreIfVisible();
		}));
		this.loadMoreIfVisible();
	}

	private getCommitChildren(model: ISCMHistoryItemViewModel): ObjectTreeElement<HistoryTreeElement>[] {
		const changes = this.commitChanges.get(model.historyItem.id);
		if (!changes) return [];
		if (changes.state !== 'ready' || changes.result.length === 0) {
			const message = changes.state === 'loading' ? localize('scm.history.loadingFiles', 'Loading changed files…') : changes.state === 'error' ? changes.message : localize('scm.history.noFiles', 'No changed files.');
			return [{ element: { id: `state:${model.historyItem.id}`, kind: 'state', model, message } }];
		}
		const file = (change: ISCMHistoryItemChange): ObjectTreeElement<HistoryTreeElement> => ({ element: { id: `file:${model.historyItem.id}:${change.path}`, kind: 'file', model, change } });
		if (this.viewMode === 'list') return changes.result.map(file);
		const paths = new ResourceTree<ISCMHistoryItemChange, ISCMHistoryItemViewModel>(model, URI.file('/'));
		for (const change of changes.result) paths.add(URI.file(`/${change.path}`), change);
		const folder = (node: IResourceNode<ISCMHistoryItemChange, ISCMHistoryItemViewModel>): ObjectTreeElement<HistoryTreeElement> => node.element
			? file(node.element)
			: { element: { id: `folder:${model.historyItem.id}:${node.relativePath}`, kind: 'folder', model, folder: node }, collapsed: false, children: [...node.children].map(folder) };
		return [...paths.root.children].map(folder);
	}

	private loadMoreIfVisible(): void {
		const tree = this.tree;
		if (!tree || !this.page?.hasMore || this.loading || this.refreshing || this.refreshFailed || this.moreError || !this.isBodyVisible() || !this.configurationService.getValue<boolean>('scm.graph.pageOnScroll')) return;
		const height = this.graphElement.clientHeight;
		const tail = tree.model.visibleNodes.at(-1);
		if (height <= 0 || !tail) return;
		// A short pane still needs a full page of runway for a provider round trip.
		// Include expanded file rows so they do not cause premature history reads.
		const prefetch = Math.max(height, this.configurationService.getValue<number>('scm.graph.pageSize') * SWIMLANE_HEIGHT);
		const bottom = (tree.getElementTop(tail.id) ?? 0) + SWIMLANE_HEIGHT;
		if (bottom - tree.scrollTop - height <= prefetch) void this.loadMore();
	}

	private showLoadMore(): boolean {
		return !!this.moreError || !this.configurationService.getValue<boolean>('scm.graph.pageOnScroll');
	}

	private selectCommit(id: string, event?: UIEvent): void {
		this.focusHistoryElement(`commit:${id}`, event);
		this.tree?.setSelection([`commit:${id}`], event);
	}

	private focusHistoryElement(id: string, event?: UIEvent): void {
		if (!this.tree?.model.has(id)) return;
		this.tree.setFocus(id, event);
		this.tree.domFocus();
	}

	private updateSelection(): void {
		const selected = new Set(this.tree?.selection.map(element => element.id));
		for (const [id, row] of this.rowResources) {
			row.element.classList.toggle('selected', selected.has(`commit:${id}`));
			row.element.classList.toggle('focused', this.tree?.focus?.id === `commit:${id}`);
		}
		for (const domNode of this.changeRows.keys()) {
			domNode.classList.toggle('selected', selected.has(domNode.dataset.historyTreeId ?? ''));
			domNode.classList.toggle('focused', this.tree?.focus?.id === domNode.dataset.historyTreeId);
		}
	}

	private onHistoryKeyDown(event: KeyboardEvent): void {
		const tree = this.tree;
		if (!tree || event.target !== tree.element) return;
		const element = tree.focus;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			tree.setSelection([]);
			return;
		}
		if (!element) return;
		if (element.kind === 'commit' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopPropagation();
			const row = this.rowResources.get(element.model.historyItem.id);
			row?.hover?.show();
			row?.focusDetails?.();
		} else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
			event.preventDefault();
			event.stopPropagation();
			const domNode = element.kind === 'commit' ? this.rowResources.get(element.model.historyItem.id)?.element : [...this.changeRows.keys()].find(node => node.dataset.historyTreeId === element.id);
			domNode?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		} else if (event.metaKey && event.key === 'ArrowDown') {
			const options = toOpenEditorOptions(new StandardKeyboardEvent(event));
			if (!options) return;
			event.preventDefault();
			event.stopPropagation();
			if (element.kind === 'commit' || element.kind === 'folder') tree.toggleCollapsed(element.id);
			else if (element.kind === 'file') void this.openCommitChange(element.model.historyItem, element.change, options);
		}
	}

	private renderMore(): HTMLDivElement {
		const container = h(this.graphElement.ownerDocument, "div");
		container.className = "ash-scm-graph-load-more";
		container.tabIndex = -1;
		if (this.moreError) {
			const error = h(this.graphElement.ownerDocument, "span");
			error.className = "ash-scm-empty";
			error.textContent = this.moreError;
			error.setAttribute('role', 'status');
			container.append(error);
		}
		const button = h(this.graphElement.ownerDocument, "button");
		button.className = "ash-scm-command";
		button.type = "button";
		button.disabled = this.loading;
		button.textContent = this.moreError ? localize('scm.history.retry', 'Retry') : localize('scm.history.loadMore', 'Load more commits');
		button.setAttribute('aria-label', this.moreError ? localize('scm.history.retryMore', 'Retry loading commit history') : localize('scm.history.loadMore', 'Load more commits'));
		// Native button activation must not be consumed by the containing tree.
		this.more.add(addDisposableListener(button, 'keydown', event => event.stopPropagation()));
		this.more.add(addDisposableListener(button, "click", () => void this.loadMore()));
		container.append(button);
		return container;
	}

	private updateMore(): void {
		if (this.page?.hasMore && this.tree && this.tree.model.has(this.moreItem.id) !== this.showLoadMore()) {
			this.renderGraph(this.page);
		}
		const current = this.graphElement.querySelector('.ash-scm-graph-load-more');
		if (current) {
			const restoreFocus = current.contains(current.ownerDocument.activeElement);
			this.more.clear();
			const next = this.renderMore();
			current.replaceWith(next);
			if (restoreFocus) {
				const button = next.querySelector<HTMLButtonElement>('button');
				if (button && !button.disabled) { button.focus(); } else { next.focus(); }
			}
		}
		this.graphElement.setAttribute('aria-busy', this.loading || this.refreshing ? 'true' : 'false');
	}

	private async loadMore(): Promise<void> {
		const page = this.page;
		const provider = this.provider;
		if (!page || !provider || !page.hasMore || this.loading || this.refreshing || this.refreshFailed) return;
		const progress = this.getProgressIndicator().show(true, 250);
		const handle = this.loadingProgress.add(toDisposable(() => progress.done()));
		using progressLifetime = toDisposable(() => { this.loadingProgress.delete(handle); handle.dispose(); });

		const generation = this.generation;
		const hadLoaderFocus = this.graphElement.querySelector('.ash-scm-graph-load-more')?.contains(this.graphElement.ownerDocument.activeElement) === true
			|| this.tree?.focus?.kind === 'more' && this.graphElement.ownerDocument.activeElement === this.tree.element;
		this.loading = true;
		this.moreError = undefined;
		this.updateMore();
		try {
			// Load one page per request so startup and scrolling do not drain the repository history.
			const pageSize = this.configurationService.getValue<number>('scm.graph.pageSize');
			const next = await provider.provideHistoryItems({ skip: page.items.length, limit: pageSize + 1, historyItemRefs: this.historyItemRefs });
			if (this.isDisposed || generation !== this.generation) return;
			const items = next ?? [];
			this.page = { items: [...page.items, ...items.slice(0, pageSize)], hasMore: items.length > pageSize };
			this.loading = false;
			this.renderGraph(this.page);
			this.updateMore();
			const active = this.graphElement.ownerDocument.activeElement;
			if (hadLoaderFocus && (active === this.graphElement.ownerDocument.body || active === this.tree?.element || active && this.graphElement.querySelector('.ash-scm-graph-load-more')?.contains(active))) {
				if (items[0]) this.focusHistoryElement(`commit:${items[0].id}`);
			}
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			this.loading = false;
			this.moreError = error instanceof Error ? error.message : String(error);
			this.updateMore();
		}
	}

	private renderCommit(historyItemViewModel: ISCMHistoryItemViewModel, graph: SVGSVGElement): HistoryItemRow {
		const historyItem = historyItemViewModel.historyItem;
		const document = this.graphElement.ownerDocument;
		const rendered = this.rowResources.set(historyItem.id, new HistoryItemRow(historyItemViewModel, graph, document));
		const item = rendered.element;
		const resources = rendered.resources;
		item.className = "ash-scm-graph-commit";
		item.dataset.historyItemId = historyItem.id;
		item.classList.toggle('selected', this.tree?.selection.some(element => element.id === `commit:${historyItem.id}`) ?? false);
		item.classList.toggle('focused', this.tree?.focus?.id === `commit:${historyItem.id}`);
		const current = this.head?.revision === historyItem.id;
		const merge = historyItem.parentIds.length > 1;
		item.classList.toggle("current", current);
		item.classList.toggle("head", current);
		item.classList.toggle("merge", merge);
		item.classList.toggle("commit", !current && !merge);
		item.style.setProperty("--scm-graph-node-x", `${graph.dataset.nodeX ?? 11}px`);
		item.style.setProperty("--scm-graph-content-x", graph.style.width || "22px");
		if (current) item.setAttribute("aria-current", "true");
		const details = h(document, "span");
		details.className = "ash-scm-graph-details";
		const subject = h(document, "span");
		subject.className = "ash-scm-graph-subject";
		subject.textContent = historyItem.subject;
		details.append(subject);
		const repository = this.scmViewService.activeRepository;
		const menuTarget: SCMHistoryItemViewModelTreeElement | undefined = repository ? { repository, get historyItemViewModel() { return rendered.historyItemViewModel; }, type: 'historyItemViewModel' } : undefined;
		const scope = resources.add(this.contextKeyService.createScoped(item));
		rendered.scope = scope;
		rendered.target = menuTarget;
		scope.setContext('scmHistoryProviderId', historyItem.comparison ? '' : repository?.provider.providerId ?? '');
		scope.setContext('scmHistoryItemHasRemote', (historyItem.remoteLinks?.length ?? 0) > 0);
		scope.setContext('scmHistoryItemRemoteAuthority', historyItem.remoteLinks?.length === 1 ? historyItem.remoteLinks[0].uri.authority : '');
		scope.setContext('scmHistoryItemHasBranch', historyItem.references?.some(reference => reference.category === 'localBranch' || reference.category === 'remoteBranch') ?? false);
		scope.setContext('scmHistoryItemHasUpstream', historyItem.references?.some(reference => reference.upstream !== undefined) ?? false);
		const commitDetails = menuTarget ? setupHistoryItemHover({
			resources,
			target: item,
			render: (resources, layout) => this.renderCommitHover(menuTarget, scope, resources, layout),
		}, this.hoverService, this.contextViewService) : undefined;
		const commitHover = commitDetails?.hover;
		const visibleReferences = this.getHistoryItemReferences(historyItem);
		rendered.visibleReferences = visibleReferences;
		rendered.headReferenceId = visibleReferences.find(reference => reference.id === this.head?.id)?.id;
		const overlay = h(document, 'div');
		overlay.className = 'ash-scm-graph-overlay';
		if (visibleReferences.length > 0) {
			rendered.referenceLabels = this.renderReferenceLabels(visibleReferences, menuTarget, scope, rendered.references);
			overlay.append(rendered.referenceLabels);
		}
		const row = h(document, "div");
		row.className = "ash-scm-graph-row";
		row.append(graph, details);
		if (repository) {
			const actions = h(document, 'div');
			actions.className = 'ash-scm-graph-actions';
			this.renderInlineActions(actions, MenuId.SCMHistoryItemContext, menuTarget, scope, resources, localize('scm.history.commitActions', 'Commit actions'));
			resources.add(addDisposableListener(actions, 'click', event => event.stopPropagation()));
			resources.add(addDisposableListener(actions, 'dblclick', event => event.stopPropagation()));
			overlay.append(actions);
		}
		row.append(overlay);
		item.append(row);
		rendered.hover = commitHover;
		rendered.focusDetails = commitDetails?.focus;
		resources.add(addDisposableListener(item, "contextmenu", event => {
			event.preventDefault();
			event.stopPropagation();
			if (menuTarget) { this.showHistoryMenu(menuTarget, scope, item, event); }
		}));
		return rendered;
	}

	private renderInlineActions(container: HTMLElement, menuId: MenuId, target: SCMHistoryItemViewModelTreeElement | SCMHistoryItemChangeViewModelTreeElement | undefined, scope: IScopedContextKeyService, resources: DisposableStore, ariaLabel: string): void {
		// Toolbar keys belong to its controls, rather than the containing history tree.
		resources.add(addDisposableListener(container, 'keydown', event => event.stopPropagation()));
		const menu = resources.add(this.menuService.createMenu(menuId, scope));
		const toolbar = resources.add(new WorkbenchToolBar(container, this.contextMenuService, { ariaLabel }));
		const update = (): void => {
			// Secondary actions remain available through the row's context menu.
			const { primary } = getActionBarActions(menu.getActions({ arg: target }), 'inline');
			toolbar.setActions(primary);
			toolbar.element.hidden = primary.length === 0;
		};
		resources.add(menu.onDidChange(update));
		update();
	}

	private updateCommitRow(row: HistoryItemRow, model: ISCMHistoryItemViewModel): void {
		const previous = row.historyItemViewModel;
		const sameLane = (left: ISCMHistoryItemViewModel['inputSwimlanes'][number], right: ISCMHistoryItemViewModel['inputSwimlanes'][number]): boolean => left.id === right.id && left.color === right.color;
		if (previous.kind !== model.kind || !equals(previous.inputSwimlanes, model.inputSwimlanes, sameLane) || !equals(previous.outputSwimlanes, model.outputSwimlanes, sameLane)) {
			const graph = renderSCMHistoryItemGraph(model, SWIMLANE_HEIGHT, this.graphElement.ownerDocument);
			row.graph.replaceWith(graph);
			row.graph = graph;
			row.element.style.setProperty('--scm-graph-node-x', `${graph.dataset.nodeX}px`);
			row.element.style.setProperty('--scm-graph-content-x', graph.style.width);
		}
		row.historyItemViewModel = model;
		const historyItem = model.historyItem;
		const current = this.head?.revision === historyItem.id;
		const merge = historyItem.parentIds.length > 1;
		row.element.classList.toggle('current', current);
		row.element.classList.toggle('head', current);
		row.element.classList.toggle('merge', merge);
		row.element.classList.toggle('commit', !current && !merge);
		if (current) row.element.setAttribute('aria-current', 'true');
		else row.element.removeAttribute('aria-current');
		row.scope?.setContext('scmHistoryItemHasRemote', (historyItem.remoteLinks?.length ?? 0) > 0);
		row.scope?.setContext('scmHistoryItemRemoteAuthority', historyItem.remoteLinks?.length === 1 ? historyItem.remoteLinks[0].uri.authority : '');
		row.scope?.setContext('scmHistoryItemHasBranch', historyItem.references?.some(reference => reference.category === 'localBranch' || reference.category === 'remoteBranch') ?? false);
		row.scope?.setContext('scmHistoryItemHasUpstream', historyItem.references?.some(reference => reference.upstream !== undefined) ?? false);
		const references = this.getHistoryItemReferences(historyItem);
		const headReferenceId = references.find(reference => reference.id === this.head?.id)?.id;
		if (row.headReferenceId !== headReferenceId || !equals(row.visibleReferences, references, (left, right) => left.id === right.id && left.name === right.name && left.revision === right.revision && left.category === right.category && left.description === right.description && left.color === right.color && left.upstream === right.upstream && left.canDelete === right.canDelete)) {
			if (row.referenceLabels?.contains(row.element.ownerDocument.activeElement)) this.focusHistoryElement(`commit:${model.historyItem.id}`);
			row.references.clear();
			row.referenceLabels?.remove();
			row.referenceLabels = undefined;
			row.visibleReferences = references;
			row.headReferenceId = headReferenceId;
			if (references.length > 0) {
				row.referenceLabels = this.renderReferenceLabels(references, row.target, row.scope!, row.references);
				row.element.querySelector('.ash-scm-graph-overlay')!.prepend(row.referenceLabels);
			}
		}
	}

	private showHistoryMenu(target: SCMHistoryItemViewModelTreeElement, scope: IScopedContextKeyService, focus: HTMLElement, event?: MouseEvent): void {
		this.selectCommit(target.historyItemViewModel.historyItem.id);
		if (focus.classList.contains('ash-scm-graph-commit')) this.tree?.domFocus();
		else focus.focus();
		this.contextMenuService.showContextMenu({
			getAnchor: () => event ? { x: event.clientX, y: event.clientY, targetWindow: event.view ?? undefined } : focus,
			menuId: target.references ? MenuId.SCMHistoryItemRefContext : MenuId.SCMHistoryItemContext,
			contextKeyService: scope,
			menuActionOptions: { arg: target },
			onHide: cancelled => { if (cancelled) { this.restoreHistoryFocus(target.repository.id, target.historyItemViewModel.historyItem.id, focus); } },
		});
	}

	private restoreHistoryFocus(repositoryId: string, historyItemId: string, focus: HTMLElement): void {
		if (this.isDisposed || !this.isBodyVisible() || this.scmViewService.activeRepository?.id !== repositoryId) { return; }
		const document = focus.ownerDocument;
		// Another view, menu or input can own focus before this presentation finishes closing.
		if (document.activeElement !== document.body && document.activeElement !== focus) { return; }
		if (focus.isConnected) { focus.focus(); }
		else { this.focusHistoryElement(`commit:${historyItemId}`); }
	}

	private renderReferenceLabels(references: readonly ISCMHistoryItemRef[], target: SCMHistoryItemViewModelTreeElement | undefined, rowScope: IScopedContextKeyService, resources: DisposableStore): HTMLSpanElement {
		const document = this.graphElement.ownerDocument;
		const container = h(document, "span");
		container.className = "ash-scm-graph-label-container";
		container.setAttribute("aria-label", localize('scm.history.references', 'History references'));
		const groups = new Map<string, ISCMHistoryItemRef[]>();
		// Keep HEAD distinct; other refs share a badge to keep the overlay compact.
		for (const reference of references) {
			const key = reference.id === this.head?.id ? 'head' : reference.category ?? 'localBranch';
			const group = groups.get(key);
			if (group) {
				group.push(reference);
			} else {
				groups.set(key, [reference]);
			}
		}
		for (const [category, group] of groups) {
			const reference = group[0];
			const isCurrent = category === 'head';
			let icon = Lxicon.gitBranch;
			let kind = 'local';
			if (isCurrent) {
				kind = 'head';
			} else if (category === 'remoteBranch') {
				kind = 'remote';
				icon = Lxicon.cloud;
			} else if (category === 'tag') {
				icon = Lxicon.tag;
			}
			const names = group.map(reference => reference.name).join(', ');
			const label = h(document, "span");
			label.className = `ash-scm-graph-label ${kind}`;
			label.dataset.icon = icon.id;
			label.setAttribute('role', 'button');
			label.tabIndex = 0;
			label.setAttribute('aria-haspopup', 'menu');
			label.setAttribute('aria-label', names);
			const scope = resources.add(rowScope.createScoped(label));
			scope.setContext('scmHistoryItemHasBranch', group.some(reference => reference.category === 'localBranch' || reference.category === 'remoteBranch'));
			scope.setContext('scmHistoryItemHasUpstream', group.some(reference => reference.upstream !== undefined));
			scope.setContext('scmHistoryRefCanDelete', group.some(reference => reference.canDelete === true || reference.category === 'remoteBranch'));
			scope.setContext('scmHistoryRefHasTag', group.some(reference => reference.category === 'tag'));
			if (target) {
				const menuTarget = { ...target, references: group };
				resources.add(addDisposableListener(label, 'click', event => {
					event.stopPropagation();
					this.showHistoryMenu(menuTarget, scope, label);
				}));
				resources.add(addDisposableListener(label, 'contextmenu', event => {
					event.preventDefault();
					event.stopPropagation();
					this.showHistoryMenu(menuTarget, scope, label, event);
				}));
				resources.add(addDisposableListener(label, 'keydown', event => {
					if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
						event.preventDefault();
						event.stopPropagation();
						this.showHistoryMenu(menuTarget, scope, label);
					}
				}));
			}

			if (group.length > 1) {
				const count = h(document, 'span');
				count.className = 'ash-scm-graph-label-count';
				count.textContent = String(group.length);
				count.setAttribute('aria-hidden', 'true');
				label.append(count);
			}
			appendIcon(icon, label);
			if (isCurrent) {
				const name = h(document, 'span');
				name.className = 'ash-scm-graph-label-name';
				name.textContent = reference.name;
				label.append(name);
			}
			resources.add(this.hoverService.setupDelayedHover(label, { content: names }));
			container.append(label);
		}
		return container;
	}

	private renderHistoryChange(element: Exclude<HistoryTreeElement, HistoryCommitElement | { kind: 'more'; }>, node: ObjectTreeNode<HistoryTreeElement>): HTMLElement {
		const document = this.graphElement.ownerDocument;
		const resources = new DisposableStore();
		const domNode = h(document, 'div');
		domNode.className = element.kind === 'folder' ? 'ash-scm-graph-folder' : element.kind === 'state' ? 'ash-scm-graph-change-state' : 'ash-scm-graph-change-row';
		domNode.dataset.historyTreeId = element.id;
		domNode.classList.toggle('selected', this.tree?.selection.some(selected => selected.id === element.id) ?? false);
		domNode.classList.toggle('focused', this.tree?.focus?.id === element.id);
		domNode.style.setProperty('--scm-graph-change-depth', String(Math.max(0, node.depth - 2)));
		this.changeRows.set(domNode, resources);
		domNode.append(renderSCMHistoryGraphPlaceholder(element.model.outputSwimlanes, document));
		if (element.kind === 'state') {
			const message = h(document, 'span');
			message.textContent = element.message;
			domNode.append(message);
			return domNode;
		}
		if (element.kind === 'folder') {
			domNode.dataset.historyFolder = element.folder.relativePath;
			const label = h(document, 'span');
			label.className = 'ash-scm-graph-folder-label';
			const arrow = h(document, 'span');
			arrow.className = 'ash-scm-graph-folder-arrow';
			arrow.setAttribute('aria-hidden', 'true');
			appendIcon(node.collapsed ? Lxicon.chevronRight : Lxicon.chevronDown, arrow);
			label.append(arrow);
			const resourceLabel = resources.add(this.resourceLabels.create(label));
			resourceLabel.setResource({ resource: element.folder.uri, name: element.folder.name }, { title: element.folder.relativePath, fileKind: FileKind.Directory });
			domNode.append(label);
			return domNode;
		}
		const { model: historyItemViewModel, change } = element;
		const historyItem = historyItemViewModel.historyItem;
		const content = h(document, 'div');
		content.className = 'ash-scm-graph-change';
		content.dataset.historyPath = change.path;
		const name = change.path.split('/').at(-1) ?? change.path;
		const parentPath = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
		const fileLabel = resources.add(this.resourceLabels.create(content));
		fileLabel.setResource({ resource: change.uri, name, description: this.viewMode === 'list' ? parentPath || undefined : undefined }, {
			reserveIconSpace: true, title: change.path, extraClasses: ['ash-scm-graph-change-label'],
		});
		const status = h(document, 'span');
		status.className = `ash-scm-graph-change-status ${change.status}`;
		status.textContent = changeStatusLabel(change.status);
		content.append(status);
		domNode.append(content);
		const scope = resources.add(this.contextKeyService.createScoped(domNode));
		scope.setContext('scmHistoryItemChangeStatus', change.status);
		const repository = this.scmViewService.activeRepository;
		if (repository) {
			const menuTarget = { repository, historyItemViewModel, historyItemChange: change, graphColumns: historyItemViewModel.outputSwimlanes, type: 'historyItemChangeViewModel' } satisfies SCMHistoryItemChangeViewModelTreeElement;
			const actions = h(document, 'div');
			actions.className = 'ash-scm-graph-actions';
			this.renderInlineActions(actions, MenuId.SCMHistoryItemChangeContext, menuTarget, scope, resources, localize('scm.history.fileActions', 'History file actions'));
			resources.add(addDisposableListener(actions, 'click', event => event.stopPropagation()));
			resources.add(addDisposableListener(actions, 'dblclick', event => event.stopPropagation()));
			domNode.append(actions);
			resources.add(addDisposableListener(domNode, 'contextmenu', event => {
				event.preventDefault();
				event.stopPropagation();
				this.focusHistoryElement(element.id);
				this.tree?.setSelection([element.id]);
				this.contextMenuService.showContextMenu({
					getAnchor: () => event.clientX || event.clientY ? { x: event.clientX, y: event.clientY, targetWindow: event.view ?? undefined } : domNode,
					menuId: MenuId.SCMHistoryItemChangeContext, contextKeyService: scope,
					menuActionOptions: { arg: menuTarget },
					onHide: cancelled => { if (cancelled) this.restoreHistoryFocus(repository.id, historyItem.id, this.tree?.element ?? domNode); },
				});
			}));
		}
		return domNode;
	}

	private updateFolderTwistie(id: string, collapsed: boolean): void {
		const domNode = [...this.changeRows.keys()].find(node => node.dataset.historyTreeId === id);
		const arrow = domNode?.querySelector<HTMLElement>('.ash-scm-graph-folder-arrow');
		if (arrow) {
			arrow.replaceChildren();
			appendIcon(collapsed ? Lxicon.chevronRight : Lxicon.chevronDown, arrow);
		}
	}

	private updateCommitChildren(historyItemId: string): void {
		const tree = this.tree;
		const element = tree?.model.getElement(`commit:${historyItemId}`);
		if (!tree || element?.kind !== 'commit') return;
		const scrollTop = tree.scrollTop;
		const anchor = tree.model.visibleNodes.find(node => (tree.getElementTop(node.id) ?? 0) + SWIMLANE_HEIGHT > scrollTop);
		const anchorOffset = anchor ? scrollTop - (tree.getElementTop(anchor.id) ?? 0) : 0;
		// File reads do not change graph lanes or other commits' children. Updating
		// only this branch keeps their rows, actions and hover resources intact.
		tree.setNodeChildren(element.id, this.getCommitChildren(element.model));
		if (anchor && tree.model.has(anchor.id)) tree.scrollTop = (tree.getElementTop(anchor.id) ?? 0) + anchorOffset;
		this.updateSelection();
		this.loadMoreIfVisible();
	}

	private async loadCommitChanges(historyItem: ISCMHistoryItem): Promise<void> {
		const cached = this.commitChanges.get(historyItem.id);
		if (cached && cached.state !== 'error') return;
		const provider = this.provider;
		if (!provider) return;
		const pending = { state: 'loading' } as const;
		this.commitChanges.set(historyItem.id, pending);
		this.updateCommitChildren(historyItem.id);
		const progress = this.getProgressIndicator().show(true, 100);
		const handle = this.loadingProgress.add(toDisposable(() => progress.done()));
		using progressLifetime = toDisposable(() => { this.loadingProgress.delete(handle); handle.dispose(); });
		try {
			const result = await provider.provideHistoryItemChanges(historyItem.comparison?.revision ?? historyItem.id, historyItem.comparison?.baseRevision ?? historyItem.parentIds[0]);
			if (this.isDisposed || provider !== this.provider || this.commitChanges.get(historyItem.id) !== pending) return;
			this.commitChanges.set(historyItem.id, { state: 'ready', result: result ?? [] });
		} catch (error) {
			if (this.isDisposed || provider !== this.provider || this.commitChanges.get(historyItem.id) !== pending) return;
			this.commitChanges.set(historyItem.id, { state: 'error', message: error instanceof Error ? error.message : String(error) });
		}
		this.updateCommitChildren(historyItem.id);
	}

	private async openCommitChange(historyItem: ISCMHistoryItem, change: ISCMHistoryItemChange, options: IOpenEditorOptions): Promise<void> {
		const provider = this.provider;
		if (!provider) return;
		const request = ++this.openGeneration;
		const file = await provider.resolveHistoryItemChangeContents(historyItem.comparison?.revision ?? historyItem.id, change);
		// Rapid keyboard navigation must not let an older preview replace the latest selected file.
		if (this.isDisposed || provider !== this.provider || request !== this.openGeneration && !options.editorOptions.pinned && !options.openToSide) return;
		const name = change.path.split("/").at(-1) ?? change.path;
		const original = file.original.kind === "text" ? {
			resource: change.originalUri ?? change.uri,
			label: `${name} (${file.parentId?.slice(0, 7) ?? "empty"})`,
			readOnly: true,
			initialText: file.original.text,
		} : undefined;
		const modified = file.modified.kind === "text" ? {
			resource: change.modifiedUri ?? change.uri,
			label: `${name} (${historyItem.displayId ?? historyItem.comparison?.revision.slice(0, 7) ?? historyItem.id})`,
			readOnly: true,
			initialText: file.modified.text,
		} : undefined;
		const group = options.openToSide ? 'sideGroup' : 'activeGroup';
		if (file.original.kind === 'binary' || file.modified.kind === 'binary') {
			const before = file.original.kind === 'binary' ? file.original.bytes : file.original.kind === 'text' ? new TextEncoder().encode(file.original.text) : new Uint8Array();
			const after = file.modified.kind === 'binary' ? file.modified.bytes : file.modified.kind === 'text' ? new TextEncoder().encode(file.modified.text) : new Uint8Array();
			if (!before || !after) { return; }
			await this.editorService.openEditor(createBinaryDiffEditorInput(
				{ resource: change.originalUri ?? change.uri, label: `${name} (${file.parentId?.slice(0, 7) ?? 'empty'})`, readOnly: true, initialBytes: before },
				{ resource: change.modifiedUri ?? change.uri, label: `${name} (${historyItem.displayId ?? historyItem.subject})`, readOnly: true, initialBytes: after },
			), options.editorOptions, group);
			return;
		}
		if (original && modified) {
			await this.editorService.openEditor(createDiffEditorInput(original, modified, `${original.label} ↔ ${modified.label}`), options.editorOptions, group);
		} else if (modified) {
			await this.editorService.openEditor(modified, options.editorOptions, group);
		} else if (original) {
			await this.editorService.openEditor(original, options.editorOptions, group);
		}
	}

	private renderCommitHover(target: SCMHistoryItemViewModelTreeElement, scope: IScopedContextKeyService, resources: DisposableStore, layout: () => void): { domNode: HTMLDivElement; toolbar: WorkbenchToolBar; } {
		const historyItem = target.historyItemViewModel.historyItem;
		if (historyItem.comparison) {
			const document = this.graphElement.ownerDocument;
			const hover = h(document, "div");
			hover.className = "ash-scm-graph-hover";
			const hoverScope = resources.add(scope.createScoped(hover));
			hoverScope.setContext('scmHistoryDetailsFocused', true);
			const subject = h(document, 'div');
			subject.className = 'ash-scm-graph-hover-subject';
			subject.textContent = historyItem.subject;
			const range = h(document, 'div');
			range.textContent = localize('scm.history.comparisonRange', 'Changes from {0} to {1}', historyItem.comparison.baseRevision.slice(0, 7), historyItem.comparison.revision.slice(0, 7));
			const actions = h(document, 'div');
			const toolbar = resources.add(new WorkbenchToolBar(actions, this.contextMenuService, {
				ariaLabel: historyItem.subject,
				actionViewItemProvider: (action, options) => new LabelActionViewItem(action, { ...options, tooltip: '' }),
			}));
			const openChanges = this.menuService.getMenuActions(MenuId.SCMHistoryItemContext, { arg: target }, scope)
				.flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.viewChanges')!;
			toolbar.setActions([openChanges]);
			hover.append(subject, range, actions);
			return { domNode: hover, toolbar };
		}
		const openChanges = this.menuService.getMenuActions(MenuId.SCMHistoryItemContext, { arg: target }, scope)
			.flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.viewChanges')!;
		return toHistoryItemHoverContent({
			resources,
			target: this.graphElement,
			historyItem,
			references: historyItemReferences(historyItem, this.head),
			scope,
			layout,
			openChanges: () => openChanges.run(),
		}, this.contextMenuService, this.clipboardService, this.openerService, this.accessibleView);
	}
}

function historyItemReferences(historyItem: ISCMHistoryItem, head: ISCMHistoryItemRef | undefined): readonly ISCMHistoryItemRef[] {
	const references = [...(historyItem.references ?? [])];
	if (head?.revision === historyItem.id && !references.some(reference => reference.id === head.id)) references.unshift(head);
	return references.sort((left, right) => Number(right.id === head?.id) - Number(left.id === head?.id) || left.category?.localeCompare(right.category ?? '') || left.name.localeCompare(right.name));
}

function changeStatusLabel(status: string): string {
	switch (status) {
		case "modified": return "M";
		case "added": return "A";
		case "deleted": return "D";
		case "renamed": return "R";
		case "copied": return "C";
		case "typeChanged": return "T";
		case "unmerged": return "U";
		case "unmodified": return "";
		case "untracked": return "?";
		case "ignored": return "!";
		default: return status.slice(0, 1).toUpperCase();
	}
}
