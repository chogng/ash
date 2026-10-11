import { localize2, localize, getNLSLanguage } from '../../../../nls.js';
import { addDisposableListener, getWindow, h } from "../../../../base/browser/dom.js";
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from "../../../../base/browser/ui/contextview/contextview.js";
import { appendIcon } from "../../../../base/browser/ui/lxicons/lxicon.js";
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Lxicon } from "../../../../base/common/lxicons.js";

import { equals } from '../../../../base/common/arrays.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Action2, IMenuService, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { ContextKeyExpr, RawContextKey, type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService, type IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService, IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import { registerOpenEditorListeners, type IOpenEditorOptions } from "../../../../platform/editor/browser/editor.js";
import { IHoverService, type IManagedHover } from "../../../../platform/hover/browser/hoverService.js";
import { IResourceLabelService, type ResourceLabels } from "../../../browser/labels.js";
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId, SCMHistoryUnavailableError, type ISCMHistoryItemDetails, type ISCMHistoryItemComparison, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemRef, type ISCMHistoryItemViewModel, type ISCMHistoryProvider, type SCMHistoryItemChangeViewModelTreeElement, type SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { ISCMViewService } from '../common/scm.js';
import { IEditorService } from "../../../services/editor/common/editorService.js";
import type { IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ViewPane } from "../../../browser/parts/views/viewPane.js";
import { createBinaryDiffEditorInput, createDiffEditorInput } from "../../../common/editor/diffEditorInput.js";
import { SWIMLANE_HEIGHT, renderSCMHistoryItemGraph, toISCMHistoryItemViewModelArray } from './scmHistory.js';
import { SCMHistoryBusyContext, SCMHistoryProviderIdContext } from '../common/scm.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../multiDiffEditor/browser/multiDiffEditorInput.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.viewChanges',
			title: localize2({ bundle: 'ash', key: 'scm.history.openChanges' }, 'Open Changes'),
			icon: Lxicon.diff,
			f1: false,
			menu: { id: MenuId.SCMHistoryItemContext, group: 'inline', order: 1 },
		});
	}

	public override async run(accessor: ServicesAccessor, element: SCMHistoryItemViewModelTreeElement, comparison?: ISCMHistoryItemComparison): Promise<void> {
		if (element?.type !== 'historyItemViewModel') { return; }
		const { repository, historyItemViewModel } = element;
		const provider = repository.provider.historyProvider;
		if (!provider) { return; }
		const historyItem = historyItemViewModel.historyItem;
		const revision = historyItem.comparison?.revision ?? historyItem.id;
		const baseRevision = comparison?.baseId ?? historyItem.comparison?.baseRevision ?? historyItem.parentIds[0];
		const changes = await provider.provideHistoryItemChanges(revision, baseRevision);
		const items: MultiDiffEditorInputItem[] = [];
		for (const change of changes ?? []) {
			const file = await provider.resolveHistoryItemChangeContents(revision, change);
			// Missing sides represent additions and deletions; their revision URIs keep empty models distinct.
			items.push({
				binary: file.original.kind === 'binary' || file.modified.kind === 'binary',
				label: change.originalPath ? `${change.originalPath} → ${change.path}` : change.path,
				original: { resource: change.originalUri ?? change.uri, readOnly: true, initialText: file.original.kind === 'text' ? file.original.text : '' },
				modified: { resource: change.modifiedUri ?? change.uri, readOnly: true, initialText: file.modified.kind === 'text' ? file.modified.text : '' },
			});
		}
		if (items.length === 0) {
			if (changes?.length === 0) { accessor.get(INotificationService).info(localize('scm.history.noChanges', 'There are no changes between these versions.')); }
			return;
		}
		const resource = URI.from({ scheme: 'ash-multi-diff', path: `/scm-history/${repository.id}/${baseRevision ?? 'parent'}/${revision}` });
		const title = comparison?.label ?? (historyItem.comparison ? historyItem.subject : `${historyItem.displayId ?? historyItem.id} · ${historyItem.subject}`);
		await accessor.get(IEditorService).openEditor(createMultiDiffEditorInput(resource, items, title, { kind: 'snapshot', repositoryId: repository.id, label: historyItem.displayId ?? historyItem.id }), { pinned: true });
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
			menu: { id: MenuId.SCMHistoryItemChangeContext, group: '0_view', order: 1 },
		});
	}

	public override async run(accessor: ServicesAccessor, element: SCMHistoryItemChangeViewModelTreeElement): Promise<void> {
		if (element?.type !== 'historyItemChangeViewModel') { return; }
		const { repository, historyItemViewModel, historyItemChange } = element;
		const provider = repository.provider.historyProvider;
		if (!provider) { return; }
		const historyItem = historyItemViewModel.historyItem;
		const file = await provider.resolveHistoryItemChangeContents(historyItem.comparison?.revision ?? historyItem.id, historyItemChange);
		if (file.modified.kind === 'missing') { return; }
		if (file.modified.kind === 'binary' && !file.modified.bytes) {
			accessor.get(INotificationService).info(localize('scm.history.binaryUnavailable', 'The history provider did not supply binary file contents.'));
			return;
		}
		const name = historyItemChange.path.split('/').at(-1) ?? historyItemChange.path;
		await accessor.get(IEditorService).openEditor({
			resource: historyItemChange.modifiedUri ?? historyItemChange.uri,
			label: `${name} (${historyItem.displayId ?? historyItem.comparison?.revision.slice(0, 7) ?? historyItem.id})`,
			readOnly: true,
			...(file.modified.kind === 'text' ? { initialText: file.modified.text } : { initialBytes: file.modified.bytes, contentType: 'application/octet-stream' }),
		});
	}
});

type HistoryItemRefsFilter = 'auto' | 'all' | readonly string[];
const HistoryViewMode = new RawContextKey<'list' | 'tree'>('scmHistoryViewMode', 'list');
const HistoryRefsAvailable = new RawContextKey<boolean>('scmHistoryRefsAvailable', false);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.selectHistoryItemRefs',
			title: localize2('scm.history.filter', 'Filter History References'),
			icon: Lxicon.filter,
			precondition: HistoryRefsAvailable.isEqualTo(true),
			menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 1 },
		});
	}
	public override async run(_accessor: ServicesAccessor, target: unknown): Promise<void> {
		if (target instanceof SCMHistoryViewPane) { await target.selectHistoryItemRefs(); }
	}
});
for (const mode of ['list', 'tree'] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.scm.action.graph.viewAs${mode === 'list' ? 'List' : 'Tree'}`,
				title: mode === 'list' ? localize2('scm.history.viewAsList', 'View as List') : localize2('scm.history.viewAsTree', 'View as Tree'),
				icon: mode === 'list' ? Lxicon.listUnordered : Lxicon.folders,
				menu: { id: MenuId.SCMHistoryTitle, group: 'view', order: mode === 'list' ? 1 : 2 },
				toggled: HistoryViewMode.isEqualTo(mode),
			});
		}
		public override run(_accessor: ServicesAccessor, target: unknown): void {
			if (target instanceof SCMHistoryViewPane) { target.setViewMode(mode); }
		}
	});
}

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

	public override async run(_accessor: ServicesAccessor, target: unknown): Promise<void> {
		if (target instanceof SCMHistoryViewPane) {
			await target.runTitleOperation(() => target.revealCurrentHistoryItem());
		}
	}
});

type ExpandedCommit =
	| { readonly state: "loading"; }
	| { readonly state: "ready"; readonly result: readonly ISCMHistoryItemChange[]; }
	| { readonly state: "error"; readonly message: string; };

interface HistoryPage {
	readonly items: readonly ISCMHistoryItem[];
	readonly hasMore: boolean;
}

interface HistoryListItem {
	readonly id: string;
	model: ISCMHistoryItemViewModel | undefined;
}

// Each rendered commit owns its actions and hover independently of viewport updates.
class HistoryItemRow extends Disposable {
	public readonly element: HTMLDivElement;
	public readonly resources = this._register(new DisposableStore());
	public readonly changes = this._register(new DisposableStore());
	public readonly references = this._register(new DisposableStore());
	public referenceLabels: HTMLSpanElement | undefined;
	public visibleReferences: readonly ISCMHistoryItemRef[] = [];
	public headReferenceId: string | undefined;
	public scope: IScopedContextKeyService | undefined;
	public target: SCMHistoryItemViewModelTreeElement | undefined;
	public expanded: ExpandedCommit | undefined;
	public changesDirty = false;
	public changesElement: HTMLUListElement | undefined;
	public hover: IManagedHover | undefined;

	constructor(public historyItemViewModel: ISCMHistoryItemViewModel, public graph: SVGSVGElement, document: Document) {
		super();
		this.element = h(document, 'div');
		this._register(toDisposable(() => this.element.remove()));
	}
}

/** Paged SCM history rendered as a compact graph. */
export class SCMHistoryViewPane extends ViewPane {
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
	private readonly filters = new Map<string, HistoryItemRefsFilter>();
	private historyItemRefs: readonly string[] | undefined;
	private comparison: { readonly remote: ISCMHistoryItemRef; readonly base: string; readonly incoming: boolean; readonly outgoing: boolean; } | undefined;
	private readonly filterPicker = this._register(new MutableDisposable<DisposableStore>());
	private readonly collapsedFolders = new Map<string, Set<string>>();
	private page: HistoryPage | undefined;
	private head: ISCMHistoryItemRef | undefined;
	private generation = 0;
	private loading = false;
	private refreshing = false;
	private refreshFailed = false;
	private titleOperation: object | undefined;
	private moreError: string | undefined;
	private rows: readonly ISCMHistoryItemViewModel[] = [];
	private list: List<HistoryListItem> | undefined;
	private readonly moreItem: HistoryListItem = { id: 'more', model: undefined };
	private readonly listResources = this._register(new MutableDisposable<DisposableStore>());

	private readonly expanded = new Map<string, ExpandedCommit>();
	private graphRepositoryId: string | undefined;
	public get repositoryId(): string | undefined { return this.graphRepositoryId; }

	constructor(container: HTMLElement, options: IViewPaneOptions, @ISCMViewService scmViewService: ISCMViewService, @IMenuService private readonly menuService: IMenuService, @IContextMenuService private readonly contextMenuService: IContextMenuService, @IContextKeyService private readonly contextKeyService: IContextKeyService, @IHoverService private readonly hoverService: IHoverService, @IEditorService private readonly editorService: IEditorService, @IResourceLabelService resourceLabelService: IResourceLabelService, @IAccessibleViewService private readonly accessibleView: IAccessibleViewService, @IContextViewService private readonly contextViewService: IContextViewService, @IClipboardService private readonly clipboardService: IClipboardService, @IOpenerService private readonly openerService: IOpenerService, @IConfigurationService private readonly configurationService: IConfigurationService, @IQuickInputService private readonly quickInputService: IQuickInputService, @IStorageService private readonly storageService: IStorageService) {
		super(container, { ...options, headerActionsVisibility: "whenExpanded" });
		this.resourceLabels = this._register(resourceLabelService.createGroup());
		this.scmViewService = scmViewService;
		this.graphLabel = options.title;
		this.viewMode = storageService.get('scm.graphView.viewMode', StorageScope.WORKSPACE) === 'tree' ? 'tree' : 'list';
		this.viewModeContext = HistoryViewMode.bindTo(contextKeyService);
		this.viewModeContext.set(this.viewMode);
		this.refsAvailableContext = HistoryRefsAvailable.bindTo(contextKeyService);
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
		this.statusElement = h(container.ownerDocument, 'div');
		this.statusElement.className = 'ash-scm-empty';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		this.graphElement.append(this.statusElement);
		this.contentElement.append(this.graphElement);
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
			else if (event.affectsConfiguration('scm.graph.pageOnScroll')) { this.loadMoreIfVisible(); }
		}));
		void this.refresh();
	}

	public setViewMode(mode: 'list' | 'tree'): void {
		if (this.viewMode === mode) { return; }
		this.viewMode = mode;
		this.viewModeContext.set(mode);
		this.storageService.store('scm.graphView.viewMode', mode, StorageScope.WORKSPACE, StorageTarget.USER);
		for (const [, row] of this.rowResources) { row.changesDirty = true; }
		if (this.page) { this.renderGraph(this.page); }
	}

	private get filterKey(): string {
		const repository = this.scmViewService.activeRepository;
		return repository?.provider.rootUri?.toString() ?? repository?.id ?? '';
	}

	public async selectHistoryItemRefs(): Promise<void> {
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
			const items: Pick[] = [
				{ label: localize('scm.history.autoRefs', 'Auto (current branch and upstream)'), reference: 'auto' },
				{ label: localize('scm.history.allRefs', 'All References'), reference: 'all' },
				...references.map(reference => ({ label: reference.name, description: reference.category === 'localBranch' ? localize('scm.history.localBranch', 'Branch') : reference.category === 'remoteBranch' ? localize('scm.history.remoteBranch', 'Remote Branch') : reference.category === 'tag' ? localize('scm.history.tag', 'Tag') : undefined, reference })),
			];
			picker.items = items;
			picker.selectedItems = items.filter(item => typeof item.reference === 'string' ? current === item.reference : Array.isArray(current) && current.includes(item.reference.id));
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
					this.expanded.clear();
					picker.hide();
					void this.refresh();
				}));
			});
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
		if (index >= 0 && this.list) {
			this.list.reveal(index, 0.5);
			this.list.setActiveIndex(index, undefined, { reveal: false });
			this.list.row(index)?.querySelector<HTMLElement>('.ash-scm-graph-commit')?.focus({ preventScroll: true });
		}
	}

	private clearGraph(): void {
		this.page = undefined;
		this.head = undefined;
		this.comparison = undefined;
		this.historyItemRefs = undefined;
		this.collapsedFolders.clear();
		this.currentItemContext.set(false);
		this.loading = false;
		this.moreError = undefined;
		this.rows = [];
		this.listResources.clear();
		this.list = undefined;
		this.expanded.clear();
		this.rowResources.clearAndDisposeAll();
		this.more.clear();
		this.statusResources.clear();
		this.graphElement.replaceChildren(this.statusElement);
	}

	private async refresh(): Promise<void> {
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
			if (provider) {
				listeners.add(provider.onDidChange(() => void this.refresh()));
				if (provider.historyItemRemoteRef) { listeners.add(provider.historyItemRemoteRef.onDidChange(() => void this.refresh())); }
				listeners.add(provider.historyItemRef.onDidChange(head => {
					this.head = head;
					if (this.page) this.renderGraph(this.page);
				}));
				if (provider.onDidChangeHistoryItemRefs) {
					listeners.add(provider.onDidChangeHistoryItemRefs(items => {
						if ((this.filters.get(this.filterKey) ?? 'auto') !== 'all' && provider.provideHistoryItemRefs) { void this.refresh(); return; }
						if (!this.page) { return; }
						const byId = new Map(items.map(item => [item.id, item]));
						this.page = { ...this.page, items: this.page.items.map(item => byId.get(item.id) ?? item) };
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
		try {
			const previousComparison = this.comparison;
			const previousHead = this.head?.revision;
			if (provider.provideHistoryItemRefs) {
				const refs = await provider.provideHistoryItemRefs();
				if (this.isDisposed || generation !== this.generation) { return; }
				this.head = provider.historyItemRef.get();
				const remote = provider.historyItemRemoteRef?.get();
				let filter = this.filters.get(this.filterKey) ?? 'auto';
				let selected = Array.isArray(filter) ? refs.filter(ref => filter.includes(ref.id)) : [];
				if (Array.isArray(filter) && selected.length === 0) {
					filter = 'auto';
					this.filters.delete(this.filterKey);
					this.storageService.store('scm.graphView.referencesFilter', JSON.stringify([...this.filters]), StorageScope.WORKSPACE, StorageTarget.USER);
				}
				if (filter === 'auto') { selected = [this.head, remote].filter((ref): ref is ISCMHistoryItemRef => !!ref); }
				this.historyItemRefs = filter === 'all' ? undefined : selected.flatMap(ref => ref.revision ? [ref.revision] : []);
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
				this.expanded.delete(SCMIncomingHistoryItemId);
				this.expanded.delete(SCMOutgoingHistoryItemId);
			}
			// One bounded look-ahead page retains the loaded tail when new commits arrive.
			const pageSize = this.configurationService.getValue<number>('scm.graph.pageSize');
			const limit = previousPage ? Math.max(pageSize, previousPage.items.length) + pageSize : pageSize;
			const loaded = await provider.provideHistoryItems({ skip: 0, limit: limit + 1, historyItemRefs: this.historyItemRefs });
			if (this.isDisposed || generation !== this.generation) return;
			const items = loaded ?? [];
			const previousTail = previousPage?.items.at(-1)?.id;
			const tailIndex = previousTail === undefined ? -1 : items.findIndex(item => item.id === previousTail);
			const retainedCount = Math.max(pageSize, tailIndex + 1);
			const page = { items: items.slice(0, retainedCount), hasMore: items.length > retainedCount };
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
		const previousRows = this.rows;
		const scrollTop = this.list?.scrollTop ?? 0;
		let anchor: { id: string; offset: number; } | undefined;
		let position = 0;
		if (scrollTop > 0) {
			for (const model of previousRows) {
				const height = this.rowHeight(model.historyItem);
				if (position + height > scrollTop) { anchor = { id: model.historyItem.id, offset: scrollTop - position }; break; }
				position += height;
			}
		}
		const focused = this.graphElement.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.graphElement.contains(focused) ? focused : undefined;
		const retained = new Set([...page.items.map(item => item.id), SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId]);
		for (const id of this.expanded.keys()) {
			if (!retained.has(id)) this.expanded.delete(id);
		}
		this.rows = toISCMHistoryItemViewModelArray(page.items, new Map(), this.head, this.comparison);
		this.currentItemContext.set(this.head?.revision !== undefined);
		this.statusElement.hidden = page.items.length > 0;
		this.statusElement.textContent = localize('scm.history.empty', 'No commits yet.');
		if (!this.list && page.items.length > 0) {
			const resources = new DisposableStore();
			this.listResources.value = resources;
			const list = resources.add(new List<HistoryListItem>(this.graphElement, {
				role: 'tree', ariaLabel: this.graphLabel, scrolling: 'managed',
				mouseSupport: false, keyboardNavigation: false,
				loopNavigation: false,
				getId: item => item.id,
				getHeight: item => item.model ? this.rowHeight(item.model.historyItem) : SWIMLANE_HEIGHT * 2,
				reuseRows: true,
				accessibilityProvider: { getRole: () => 'presentation' },
				renderItem: (item, index) => {
					if (!item.model) { this.more.clear(); return this.renderMore(); }
					const row = this.renderCommit(item.model, renderSCMHistoryItemGraph(item.model, this.rowHeight(item.model.historyItem), this.graphElement.ownerDocument));
					this.updateCommitAccessibility(row, index);
					return row.element;
				},
				updateItem: (item, index) => {
					if (!item.model) return;
					const row = this.rowResources.get(item.model.historyItem.id)!;
					this.updateCommitRow(row, item.model);
					this.updateCommitAccessibility(row, index);
				},
				onDidRemoveRow: row => {
					const id = row.dataset.listId;
					if (id?.startsWith('commit:')) this.rowResources.deleteAndDispose(id.slice(7));
					else this.more.clear();
				},
			}));
			this.list = list;
			resources.add(this.onDidChangeBodyVisibility(visible => { if (visible) this.loadMoreIfVisible(); }));
			list.domNode.classList.add('ash-scm-graph-viewport');
			list.element.setAttribute('aria-description', localize('scm.history.help', 'Use Up and Down Arrow to move between commits, Home and End to move to the first and last loaded commits, and Page Up and Page Down to move by a page. Use Right Arrow to expand files and Left Arrow to collapse them. Press Enter or Space on a history item to toggle its files. Press Shift+F10 or the Context Menu key for provider actions. Use Tab to reach reference badges and Open Changes. Press Enter on Open Changes to compare all text files in that item. Press Enter on a reference badge for provider actions. Press Alt+Down Arrow to focus history details and use its actions; Escape returns to the history item. Use Filter History References to select branches and tags; Ctrl+Space toggles a reference and Enter applies the selection. Use View as List or View as Tree to change file layout. In tree mode, use Enter or the Left and Right Arrow keys on a folder to collapse or expand it. Incoming and Outgoing Changes compare the corresponding branch with its merge base. Binary changes open a read-only hexadecimal comparison.'));
			resources.add(list.onDidRenderRows(() => {
				for (const [, row] of this.rowResources) {
					if (!row.hover?.visible) continue;
					if (!row.element.isConnected) row.hover.hide();
					else this.contextViewService.layout();
				}
				this.loadMoreIfVisible();
			}));
		}
		if (this.list) {
			// Stable wrappers let List retain a commit's DOM while its graph and refs change.
			const previous = new Map(this.list.items.map(item => [item.id, item]));
			const items = this.rows.map(model => {
				const id = `commit:${model.historyItem.id}`;
				const item = previous.get(id) ?? { id, model };
				item.model = model;
				return item;
			});
			if (page.hasMore) items.push(this.moreItem);
			this.list.items = items;
			if (anchor) {
				let top = 0;
				for (const model of this.rows) {
					if (model.historyItem.id === anchor.id) { this.list.scrollTop = top + anchor.offset; break; }
					top += this.rowHeight(model.historyItem);
				}
			} else if (scrollTop === 0) { this.list.scrollTop = 0; }
			if (restoreFocus?.isConnected && restoreFocus !== this.graphElement.ownerDocument.activeElement) restoreFocus.focus({ preventScroll: true });
		}
		this.graphElement.setAttribute('aria-busy', this.loading || this.refreshing ? 'true' : 'false');
	}

	private loadMoreIfVisible(): void {
		if (this.configurationService.getValue<boolean>('scm.graph.pageOnScroll') && this.isBodyVisible() && this.graphElement.querySelector('.ash-scm-graph-load-more')) void this.loadMore();
	}

	private updateCommitAccessibility(row: HistoryItemRow, index: number): void {
		row.element.setAttribute('aria-posinset', String(index + 1));
		row.element.setAttribute('aria-setsize', String(this.rows.length));
	}


	private updateCommitHeight(historyItem: ISCMHistoryItem): void {
		const row = this.rowResources.get(historyItem.id);
		if (row) { row.changesDirty = true; }
		const index = this.rows.findIndex(model => model.historyItem.id === historyItem.id);
		// Recompute from the owning expansion state instead of retaining an override across filters.
		this.list?.updateElementHeight(index, undefined);
		this.list?.rerender(index);
	}

	private rowHeight(historyItem: ISCMHistoryItem): number {
		const expanded = this.expanded.get(historyItem.id);
		if (!expanded) return SWIMLANE_HEIGHT;
		let childRows = expanded.state === 'ready' ? Math.max(1, expanded.result.length) : 1;
		if (this.viewMode === 'tree' && expanded.state === 'ready' && expanded.result.length > 0) {
			const folders = this.collapsedFolders.get(historyItem.id);
			const directories = new Set<string>();
			let visibleFiles = 0;
			for (const change of expanded.result) {
				const parts = change.path.split('/');
				let visible = true;
				for (let depth = 1; depth < parts.length; depth++) {
					const path = parts.slice(0, depth).join('/');
					if (visible) { directories.add(path); }
					if (folders?.has(path)) { visible = false; }
				}
				if (visible) { visibleFiles++; }
			}
			childRows = directories.size + visibleFiles;
		}
		return SWIMLANE_HEIGHT * (childRows + 1);
	}

	private renderMore(): HTMLDivElement {
		const container = h(this.graphElement.ownerDocument, "div");
		container.className = "ash-scm-graph-load-more";
		if (this.moreError) {
			const error = h(this.graphElement.ownerDocument, "span");
			error.className = "ash-scm-empty";
			error.textContent = this.moreError;
			container.append(error);
		}
		const button = h(this.graphElement.ownerDocument, "button");
		button.className = "ash-scm-command";
		button.type = "button";
		button.disabled = this.loading;
		button.textContent = this.loading ? localize('scm.history.loadingMore', 'Loading commit history…') : this.moreError ? localize('scm.history.retry', 'Retry') : localize('scm.history.loadMore', 'Load more commits');
		button.setAttribute('aria-label', this.moreError ? localize('scm.history.retryMore', 'Retry loading commit history') : localize('scm.history.loadMore', 'Load more commits'));
		this.more.add(addDisposableListener(button, "click", () => void this.loadMore()));
		container.append(button);
		return container;
	}

	private updateMore(): void {
		const current = this.graphElement.querySelector('.ash-scm-graph-load-more');
		if (current) {
			this.more.clear();
			current.replaceWith(this.renderMore());
		}
		this.graphElement.setAttribute('aria-busy', this.loading || this.refreshing ? 'true' : 'false');
	}

	private async loadMore(): Promise<void> {
		const page = this.page;
		const provider = this.provider;
		if (!page || !provider || !page.hasMore || this.loading || this.refreshing || this.refreshFailed) return;

		const generation = this.generation;
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
		const current = this.head?.revision === historyItem.id;
		const merge = historyItem.parentIds.length > 1;
		item.classList.toggle("current", current);
		item.classList.toggle("head", current);
		item.classList.toggle("merge", merge);
		item.classList.toggle("commit", !current && !merge);
		item.style.setProperty("--scm-graph-node-x", `${graph.dataset.nodeX ?? 11}px`);
		item.style.setProperty("--scm-graph-content-x", graph.style.width || "22px");
		item.tabIndex = 0;
		item.setAttribute("role", "treeitem");
		item.setAttribute("aria-expanded", String(this.expanded.has(historyItem.id)));
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
		const hoverContent = resources.add(new MutableDisposable<DisposableStore>());
		let hoverToolbar: WorkbenchToolBar | undefined;
		let commitHover: IManagedHover | undefined;
		if (menuTarget) {
			commitHover = resources.add(this.hoverService.setupHover({
				target: item,
				content: token => {
					const resources = new DisposableStore();
					hoverContent.value = resources;
					const card = this.renderCommitHover(menuTarget, scope, resources, token, () => {
						// Relayout loaded details without replacing the lazy factory or its focused actions.
						if (commitHover!.visible) this.contextViewService.layout();
					});
					hoverToolbar = card.toolbar;
					return card.domNode;
				},
				groupId: 'scm.history.items',
				trapFocus: true,
				onDidHide: () => {
					hoverContent.clear();
					hoverToolbar = undefined;
				},
				persistence: 'transient',
				anchorAlignment: AnchorAlignment.Left,
				anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
				anchorPosition: AnchorPosition.Below,
				gap: 8,
			}));
		}
		const visibleReferences = historyItemReferences(historyItem, this.head);
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
			resources.add(new MenuWorkbenchToolBar(actions, this.menuService, this.contextMenuService, MenuId.SCMHistoryItemContext, {
				ariaLabel: localize('scm.history.commitActions', 'Commit actions'),
				contextKeyService: scope,
				menuOptions: { arg: menuTarget },
				toolbarOptions: { primaryGroup: 'inline' },
			}));
			overlay.append(actions);
		}
		row.append(overlay);
		item.append(row);
		rendered.hover = commitHover;
		rendered.expanded = this.expanded.get(historyItem.id);
		if (rendered.expanded) {
			rendered.changesElement = this.renderCommitChanges(historyItemViewModel, rendered.expanded, rendered.changes);
			item.append(rendered.changesElement);
		}
		resources.add(addDisposableListener(item, "click", (event) => {
			if ((event.target as Element).closest(".ash-scm-graph-change, .ash-scm-graph-folder, .ash-scm-graph-actions, .ash-scm-graph-label")) return;
			void this.toggleCommit(historyItem);
		}));
		resources.add(addDisposableListener(item, 'focus', () => {
			const index = this.list?.items.findIndex(entry => entry.model?.historyItem.id === historyItem.id) ?? -1;
			this.list?.setActiveIndex(index, undefined, { reveal: false });
		}));
		resources.add(addDisposableListener(item, "keydown", event => {
			if (event.target !== item) { return; }
			if (event.altKey && event.key === 'ArrowDown') {
				event.preventDefault();
				commitHover?.show();
				hoverToolbar?.focus();
			} else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
				event.preventDefault();
				if (menuTarget) { this.showHistoryMenu(menuTarget, scope, item); }
			} else if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				void this.toggleCommit(historyItem);
			} else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
				if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
					event.preventDefault();
					if (this.expanded.has(historyItem.id) === (event.key === 'ArrowLeft')) { void this.toggleCommit(rendered.historyItemViewModel.historyItem); }
				} else {
					void this.navigateCommits(event);
				}
			}
		}));
		resources.add(addDisposableListener(item, "contextmenu", event => {
			event.preventDefault();
			event.stopPropagation();
			if (menuTarget) { this.showHistoryMenu(menuTarget, scope, item, event); }
		}));
		return rendered;
	}

	private async navigateCommits(event: KeyboardEvent): Promise<void> {
		const list = this.list;
		if (!list || this.rows.length === 0) { return; }
		let index = list.activeIndex;
		switch (event.key) {
			case 'ArrowDown': index++; break;
			case 'ArrowUp': index--; break;
			case 'Home': index = 0; break;
			case 'End': index = this.rows.length - 1; break;
			case 'PageDown':
				event.preventDefault();
				await list.focusNextPage(event);
				index = list.activeIndex;
				break;
			case 'PageUp':
				event.preventDefault();
				await list.focusPreviousPage(event);
				index = list.activeIndex;
				break;
			default: return;
		}
		event.preventDefault();
		if (this.list !== list || this.isDisposed) { return; }
		index = Math.max(0, Math.min(index, this.rows.length - 1));
		list.reveal(index);
		list.setActiveIndex(index, event, { reveal: false });
		list.row(index)?.querySelector<HTMLElement>('.ash-scm-graph-commit')?.focus({ preventScroll: true });
	}

	private updateCommitRow(row: HistoryItemRow, model: ISCMHistoryItemViewModel): void {
		const previous = row.historyItemViewModel;
		const expanded = this.expanded.get(model.historyItem.id);
		const expansionChanged = row.changesDirty || row.expanded !== expanded;
		const sameLane = (left: ISCMHistoryItemViewModel['inputSwimlanes'][number], right: ISCMHistoryItemViewModel['inputSwimlanes'][number]): boolean => left.id === right.id && left.color === right.color;
		if (expansionChanged || previous.kind !== model.kind || !equals(previous.inputSwimlanes, model.inputSwimlanes, sameLane) || !equals(previous.outputSwimlanes, model.outputSwimlanes, sameLane)) {
			const graph = renderSCMHistoryItemGraph(model, this.rowHeight(model.historyItem), this.graphElement.ownerDocument);
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
		const references = historyItemReferences(historyItem, this.head);
		const headReferenceId = references.find(reference => reference.id === this.head?.id)?.id;
		if (row.headReferenceId !== headReferenceId || !equals(row.visibleReferences, references, (left, right) => left.id === right.id && left.name === right.name && left.revision === right.revision && left.category === right.category && left.description === right.description && left.color === right.color && left.upstream === right.upstream && left.canDelete === right.canDelete)) {
			if (row.referenceLabels?.contains(row.element.ownerDocument.activeElement)) row.element.focus({ preventScroll: true });
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
		if (!expansionChanged) return;
		if (row.changesElement?.contains(row.element.ownerDocument.activeElement)) row.element.focus();
		row.changes.clear();
		row.changesElement?.remove();
		row.changesElement = undefined;
		row.expanded = expanded;
		row.changesDirty = false;
		row.element.setAttribute('aria-expanded', String(expanded !== undefined));
		if (expanded) {
			row.changesElement = this.renderCommitChanges(model, expanded, row.changes);
			row.element.append(row.changesElement);
		}
	}

	private showHistoryMenu(target: SCMHistoryItemViewModelTreeElement, scope: IScopedContextKeyService, focus: HTMLElement, event?: MouseEvent): void {
		focus.focus();
		this.contextMenuService.showContextMenu({
			getAnchor: () => event ? { x: event.clientX, y: event.clientY, targetWindow: event.view ?? undefined } : focus,
			menuId: target.references ? MenuId.for('SCMHistoryItemRefContext') : MenuId.SCMHistoryItemContext,
			contextKeyService: scope,
			menuActionOptions: { arg: target },
			onHide: cancelled => { if (cancelled) { focus.focus(); } },
		});
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
			scope.setContext('scmHistoryRefCanDelete', group.some(reference => reference.canDelete === true));
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

	private renderCommitChanges(historyItemViewModel: ISCMHistoryItemViewModel, expanded: ExpandedCommit, resources: DisposableStore): HTMLUListElement {
		const historyItem = historyItemViewModel.historyItem;
		const document = this.graphElement.ownerDocument;
		const list = h(document, "ul");
		list.className = "ash-scm-graph-changes";
		if (expanded.state !== "ready" || expanded.result.length === 0) {
			const state = h(document, "li");
			state.className = `ash-scm-graph-change-state ${expanded.state}`;
			state.textContent = expanded.state === "loading" ? localize('scm.history.loadingFiles', 'Loading changed files…') : expanded.state === "error" ? expanded.message : localize('scm.history.noFiles', 'No changed files.');
			list.append(state);
			return list;
		}
		list.setAttribute('role', 'group');
		const directories = new Map<string, HTMLUListElement>();
		for (const change of expanded.result) {
			let parent = list;
			const parts = change.path.split('/');
			if (this.viewMode === 'tree') {
				for (let depth = 1; depth < parts.length; depth++) {
					const path = parts.slice(0, depth).join('/');
					let children = directories.get(path);
					if (!children) {
						const directory = h(document, 'li');
						directory.className = 'ash-scm-graph-directory';
						const folders = this.collapsedFolders.get(historyItem.id) ?? new Set<string>();
						this.collapsedFolders.set(historyItem.id, folders);
						const folder = resources.add(new Button(directory, { label: parts[depth - 1], icon: folders.has(path) ? Lxicon.chevronRight : Lxicon.chevronDown, ariaLabel: localize('scm.history.folder', 'Folder {0}', path) }));
						folder.domNode.classList.add('ash-scm-graph-folder');
						folder.domNode.dataset.historyFolder = path;
						folder.domNode.style.setProperty('--scm-graph-change-depth', String(depth - 1));
						folder.domNode.setAttribute('aria-expanded', String(!folders.has(path)));
						folder.domNode.classList.toggle('expanded', !folders.has(path));
						children = h(document, 'ul');
						children.className = 'ash-scm-graph-folder-children';
						children.setAttribute('role', 'group');
						children.hidden = folders.has(path);
						const toggle = (): void => {
							if (folders.has(path)) { folders.delete(path); } else { folders.add(path); }
							this.updateCommitHeight(historyItem);
							Array.from(this.rowResources.get(historyItem.id)?.element.querySelectorAll<HTMLButtonElement>('.ash-scm-graph-folder') ?? []).find(button => button.dataset.historyFolder === path)?.focus();
						};
						resources.add(folder.onDidClick(event => { event.stopPropagation(); toggle(); }));
						resources.add(addDisposableListener(folder.domNode, 'keydown', event => {
							if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
								event.preventDefault(); event.stopPropagation();
								if (folders.has(path) === (event.key === 'ArrowRight')) { toggle(); }
							}
						}));
						directory.append(children);
						parent.append(directory);
						directories.set(path, children);
					}
					parent = children;
				}
			}
			const row = h(document, "li");
			const button = h(document, "button");
			button.className = "ash-scm-graph-change";
			button.style.setProperty('--scm-graph-change-depth', String(this.viewMode === 'tree' ? parts.length - 1 : 0));
			button.type = "button";
			button.title = localize('scm.history.openChange', 'Open {0} from {1}', change.path, historyItem.displayId ?? historyItem.subject);
			const name = change.path.split("/").at(-1) ?? change.path;
			const parentPath = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
			const fileLabel = resources.add(this.resourceLabels.create(button));
			fileLabel.setResource({ resource: change.uri, name, description: this.viewMode === 'list' ? parentPath || undefined : undefined }, {
				reserveIconSpace: true,
				title: change.path,
				extraClasses: ["ash-scm-graph-change-label"],
			});
			const status = h(document, "span");
			status.className = `ash-scm-graph-change-status ${change.status}`;
			status.textContent = changeStatusLabel(change.status);
			button.append(fileLabel.element, status);
			resources.add(registerOpenEditorListeners(button, options => {
				void this.openCommitChange(historyItem, change, options);
			}));
			const scope = resources.add(this.contextKeyService.createScoped(button));
			scope.setContext('scmHistoryItemChangeStatus', change.status);
			const showMenu = (event?: MouseEvent): void => {
				const repository = this.scmViewService.activeRepository;
				if (!repository) return;
				button.focus();
				this.contextMenuService.showContextMenu({
					getAnchor: () => event ? {
						x: event.clientX,
						y: event.clientY,
						targetWindow: event.view ?? undefined,
					} : button,
					menuId: MenuId.SCMHistoryItemChangeContext,
					contextKeyService: scope,
					menuActionOptions: {
						arg: {
							repository,
							historyItemViewModel,
							historyItemChange: change,
							graphColumns: historyItemViewModel.outputSwimlanes,
							type: 'historyItemChangeViewModel',
						} satisfies SCMHistoryItemChangeViewModelTreeElement
					},
					onHide: cancelled => { if (cancelled && button.isConnected) { button.focus(); } },
				});
			};
			resources.add(addDisposableListener(button, 'contextmenu', event => {
				event.preventDefault();
				event.stopPropagation();
				showMenu(event);
			}));
			resources.add(addDisposableListener(button, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
					event.preventDefault();
					event.stopPropagation();
					showMenu();
				}
			}));
			row.append(button);
			parent.append(row);
		}
		return list;
	}

	private async toggleCommit(historyItem: ISCMHistoryItem): Promise<void> {
		if (this.expanded.delete(historyItem.id)) {
			this.updateCommitHeight(historyItem);
			return;
		}
		const provider = this.provider;
		if (!provider) return;
		const pending = { state: 'loading' } as const;
		this.expanded.set(historyItem.id, pending);
		this.updateCommitHeight(historyItem);
		try {
			const result = await provider.provideHistoryItemChanges(historyItem.comparison?.revision ?? historyItem.id, historyItem.comparison?.baseRevision ?? historyItem.parentIds[0]);
			if (this.isDisposed || provider !== this.provider || this.expanded.get(historyItem.id) !== pending) return;
			this.expanded.set(historyItem.id, { state: "ready", result: result ?? [] });
		} catch (error) {
			if (this.isDisposed || provider !== this.provider || this.expanded.get(historyItem.id) !== pending) return;
			this.expanded.set(historyItem.id, { state: "error", message: error instanceof Error ? error.message : String(error) });
		}
		this.updateCommitHeight(historyItem);
	}

	private async openCommitChange(historyItem: ISCMHistoryItem, change: ISCMHistoryItemChange, options: IOpenEditorOptions): Promise<void> {
		const provider = this.provider;
		if (!provider) return;
		const file = await provider.resolveHistoryItemChangeContents(historyItem.comparison?.revision ?? historyItem.id, change);
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

	private renderCommitHover(target: SCMHistoryItemViewModelTreeElement, scope: IScopedContextKeyService, resources: DisposableStore, token: CancellationToken, layout: () => void): { domNode: HTMLDivElement; toolbar: WorkbenchToolBar; } {
		const historyItem = target.historyItemViewModel.historyItem;
		const document = this.graphElement.ownerDocument;
		const hover = h(document, "div");
		hover.className = "ash-scm-graph-hover";
		const hoverScope = resources.add(scope.createScoped(hover));
		hoverScope.setContext('scmHistoryDetailsFocused', true);
		if (historyItem.comparison) {
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
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ScmHistoryDetails);
		if (hint) hover.setAttribute('aria-description', hint);
		const details = h(document, 'div');
		details.className = 'ash-scm-graph-hover-details';
		details.setAttribute('aria-busy', 'true');
		const status = h(document, 'div');
		status.className = 'ash-scm-graph-hover-status';
		status.setAttribute('role', 'status');
		status.textContent = localize('scm.history.loadingDetails', 'Loading commit details…');
		const subject = h(document, "div");
		subject.className = "ash-scm-graph-hover-subject";
		subject.textContent = historyItem.subject;
		details.append(subject, status);
		const footer = h(document, 'div');
		footer.className = 'ash-scm-graph-hover-footer';
		const hash = h(document, 'div');
		hash.className = 'ash-scm-graph-hover-hash';
		hash.title = historyItem.id;
		const openChanges = this.menuService.getMenuActions(MenuId.SCMHistoryItemContext, { arg: target }, scope)
			.flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.viewChanges')!;
		const openLabel = localize('scm.history.openCommit', 'Open Commit {0}', historyItem.displayId ?? historyItem.id);
		const hashToolbar = resources.add(new WorkbenchToolBar(hash, this.contextMenuService, {
			ariaLabel: openLabel,
			actionViewItemProvider: (action, options) => new LabelActionViewItem(action, { ...options, ariaLabel: openLabel, tooltip: '' }),
		}));
		hashToolbar.setActions([{ id: openChanges.id, label: historyItem.displayId ?? historyItem.id, tooltip: openLabel, enabled: true, run: () => openChanges.run() }]);
		const actions = h(document, 'div');
		actions.className = 'ash-scm-graph-hover-actions';
		const toolbar = resources.add(new WorkbenchToolBar(actions, this.contextMenuService, {
			ariaLabel: localize('scm.history.commitActions', 'Commit actions'),
			// Action tooltips share the ContextView and would replace their own details card.
			actionViewItemProvider: (action, options) => new LabelActionViewItem(action, { ...options, ariaLabel: action.tooltip, tooltip: '' }),
		}));
		const copyLabel = localize('scm.history.copyHash', 'Copy Commit Hash');
		const hoverActions: IAction[] = [{
			id: 'scm.history.copyHash', label: '', tooltip: copyLabel, icon: Lxicon.copy, enabled: true,
			run: () => this.clipboardService.writeText(historyItem.id),
		}];
		const hostingNames: Readonly<Record<string, string>> = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket' };
		for (const [index, link] of (historyItem.remoteLinks ?? []).entries()) {
			const label = localize('scm.history.openRemote', 'Open on {0}', hostingNames[link.uri.authority] ?? link.name);
			hoverActions.push({
				id: `scm.history.openRemote.${index}`, label, tooltip: label, icon: Lxicon.linkExternal, enabled: true,
				run: () => this.openerService.open(link.uri, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }),
			});
		}
		toolbar.setActions(hoverActions);
		if (hint) toolbar.element.setAttribute('aria-description', hint);
		footer.append(hash, actions);
		hover.append(details);
		const references = historyItemReferences(historyItem, this.head);
		if (references.length > 0) {
			const labels = h(document, 'div');
			labels.className = 'ash-scm-graph-hover-references';
			labels.setAttribute('role', 'group');
			labels.setAttribute('aria-label', localize('scm.history.references', 'History references'));
			for (const reference of references) {
				const label = h(document, 'span');
				label.className = 'ash-scm-graph-label';
				appendIcon(reference.category === 'tag' ? Lxicon.tag : reference.category === 'remoteBranch' ? Lxicon.cloud : Lxicon.gitBranch, label);
				label.append(document.createTextNode(reference.name));
				labels.append(label);
			}
			hover.append(labels);
		}
		hover.append(footer);
		void this.resolveCommitHover(target, details, status, resources, token, layout);
		return { domNode: hover, toolbar };
	}

	private async resolveCommitHover(target: SCMHistoryItemViewModelTreeElement, details: HTMLElement, status: HTMLElement, resources: DisposableStore, token: CancellationToken, layout: () => void): Promise<void> {
		try {
			const result = await target.repository.provider.historyProvider!.resolveHistoryItemDetails(target.historyItemViewModel.historyItem.id);
			if (token.isCancellationRequested) return;
			this.renderCommitDetails(details, target.historyItemViewModel.historyItem.subject, result, resources, layout);
		} catch {
			if (token.isCancellationRequested) return;
			status.textContent = localize('scm.history.detailsFailed', 'Unable to load commit details.');
		}
		details.setAttribute('aria-busy', 'false');
		layout();
	}

	private renderCommitDetails(container: HTMLElement, subjectText: string, details: ISCMHistoryItemDetails, resources: DisposableStore, layout: () => void): void {
		const document = container.ownerDocument;
		const author = h(document, 'div');
		author.className = 'ash-scm-graph-hover-author';
		appendIcon(Lxicon.account, author);
		const name = h(document, 'span');
		name.textContent = details.authorName;
		name.title = details.authorEmail;
		const time = h(document, 'time');
		time.className = 'ash-scm-graph-hover-time';
		const date = new Date(details.timestamp);
		time.dateTime = date.toISOString();
		const seconds = Math.round((details.timestamp - Date.now()) / 1000);
		const units = [{ unit: 'year', seconds: 31_536_000 }, { unit: 'month', seconds: 2_592_000 }, { unit: 'day', seconds: 86_400 }, { unit: 'hour', seconds: 3_600 }, { unit: 'minute', seconds: 60 }, { unit: 'second', seconds: 1 }] as const;
		const unit = units.find(candidate => Math.abs(seconds) >= candidate.seconds) ?? units.at(-1)!;
		const relative = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'auto' }).format(Math.round(seconds / unit.seconds), unit.unit);
		time.textContent = localize('scm.history.commitTime', '{0} ({1})', relative, date.toLocaleString(getNLSLanguage()));
		author.append(name, time);
		const subject = h(document, 'div');
		subject.className = 'ash-scm-graph-hover-subject';
		subject.textContent = subjectText;
		const message = h(document, 'div');
		message.className = 'ash-scm-graph-hover-message';
		message.textContent = details.message.startsWith(subjectText) ? details.message.slice(subjectText.length).replace(/^\n+/, '') : details.message;
		const statistics = h(document, 'div');
		statistics.className = 'ash-scm-graph-hover-statistics';
		const files = h(document, 'span');
		files.textContent = localize('scm.history.filesChanged', '{0} files changed', details.statistics.files);
		const additions = h(document, 'span');
		additions.className = 'ash-scm-graph-hover-additions';
		additions.textContent = localize('scm.history.additions', '{0} insertions(+)', details.statistics.additions);
		const deletions = h(document, 'span');
		deletions.className = 'ash-scm-graph-hover-deletions';
		deletions.textContent = localize('scm.history.deletions', '{0} deletions(-)', details.statistics.deletions);
		statistics.append(files, additions, deletions);
		container.replaceChildren(author, subject);
		if (message.textContent) {
			const scrollable = resources.add(new ScrollableElement(container, { direction: 'vertical', ariaLabel: localize('scm.history.message', 'Commit message') }));
			scrollable.element.classList.add('ash-scm-graph-hover-message-scroll');
			scrollable.setContent(message);
			// A hover relayout may resize the observed message; leave the observer delivery before writing geometry.
			const resize = resources.add(new AnimationFrameScheduler(getWindow(message), () => {
				const height = Math.min(180, message.scrollHeight);
				if (scrollable.element.style.height !== `${height}px`) {
					scrollable.element.style.height = `${height}px`;
					layout();
				}
				scrollable.layout();
			}));
			resources.add(observeResize(message, () => resize.schedule()));
		}
		container.append(statistics);
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
