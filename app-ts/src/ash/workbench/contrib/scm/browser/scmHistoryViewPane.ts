import { localize2, localize, getNLSLanguage } from '../../../../nls.js';
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from "../../../../base/browser/ui/contextview/contextview.js";
import { appendIcon } from "../../../../base/browser/ui/lxicons/lxicon.js";
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Lxicon } from "../../../../base/common/lxicons.js";

import { equals } from '../../../../base/common/arrays.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { Action2, IMenuService, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService, type IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService, IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import { registerOpenEditorListeners, type IOpenEditorOptions } from "../../../../platform/editor/browser/editor.js";
import { IHoverService, type IManagedHover } from "../../../../platform/hover/browser/hoverService.js";
import { IResourceLabelService, type ResourceLabels } from "../../../browser/labels.js";
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SCMHistoryUnavailableError, type ISCMHistoryItemDetails, type ISCMHistoryItemComparison, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemRef, type ISCMHistoryItemViewModel, type ISCMHistoryProvider, type SCMHistoryItemChangeViewModelTreeElement, type SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { ISCMViewService } from '../common/scm.js';
import { IEditorService } from "../../../services/editor/common/editorService.js";
import type { IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ViewPane } from "../../../browser/parts/views/viewPane.js";
import { createDiffEditorInput } from "../../../common/editor/diffEditorInput.js";
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
		const changes = await provider.provideHistoryItemChanges(historyItem.id, comparison?.baseId ?? historyItem.parentIds[0]);
		const items: MultiDiffEditorInputItem[] = [];
		let binaryFiles = 0;
		for (const change of changes ?? []) {
			const file = await provider.resolveHistoryItemChangeContents(historyItem.id, change);
			if (file.original.kind === 'binary' || file.modified.kind === 'binary') {
				binaryFiles += 1;
				continue;
			}
			// Missing sides represent additions and deletions; their revision URIs keep empty models distinct.
			items.push({
				label: change.originalPath ? `${change.originalPath} → ${change.path}` : change.path,
				original: { resource: change.originalUri ?? change.uri, readOnly: true, initialText: file.original.kind === 'text' ? file.original.text : '' },
				modified: { resource: change.modifiedUri ?? change.uri, readOnly: true, initialText: file.modified.kind === 'text' ? file.modified.text : '' },
			});
		}
		if (binaryFiles > 0) {
			accessor.get(INotificationService).info(localize('scm.history.binaryFiles', '{0} binary files cannot be shown in the text comparison.', binaryFiles));
		}
		if (items.length === 0) {
			if (changes?.length === 0) { accessor.get(INotificationService).info(localize('scm.history.noChanges', 'There are no changes between these versions.')); }
			return;
		}
		const resource = URI.from({ scheme: 'ash-multi-diff', path: `/scm-history/${repository.id}/${comparison?.baseId ?? 'parent'}/${historyItem.id}` });
		const title = comparison?.label ?? `${historyItem.displayId ?? historyItem.id} · ${historyItem.subject}`;
		await accessor.get(IEditorService).openEditor(createMultiDiffEditorInput(resource, items, title, { kind: 'snapshot', repositoryId: repository.id, label: historyItem.displayId ?? historyItem.id }), { pinned: true });
	}
});

const PageSize = 50;
const LoadAhead = 48;
const Overscan = 8;

type ExpandedCommit =
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly result: readonly ISCMHistoryItemChange[] }
	| { readonly state: "error"; readonly message: string };

interface HistoryPage {
	readonly items: readonly ISCMHistoryItem[];
	readonly hasMore: boolean;
}

// Each visible commit owns its actions and hover independently of viewport updates.
class HistoryItemRow extends Disposable {
	public readonly element: HTMLLIElement;
	public readonly resources = this._register(new DisposableStore());
	public readonly changes = this._register(new DisposableStore());
	public expanded: ExpandedCommit | undefined;
	public changesElement: HTMLUListElement | undefined;
	public hover: IManagedHover | undefined;

	constructor(public historyItemViewModel: ISCMHistoryItemViewModel, public graph: SVGSVGElement, document: Document) {
		super();
		this.element = h(document, 'li');
		this._register(toDisposable(() => this.element.remove()));
	}
}

/** Paged SCM history rendered as a compact graph. */
export class SCMHistoryViewPane extends ViewPane {
	private readonly scmViewService: ISCMViewService;
	private readonly graphLabel: string;
	private readonly busyContext: IContextKey<boolean>;
	private readonly providerIdContext: IContextKey<string>;
	private readonly graphElement: HTMLDivElement;
	private readonly renderedRows = this._register(new DisposableMap<string, HistoryItemRow>());
	private readonly resourceLabels: ResourceLabels;
	private readonly more = this._register(new DisposableStore());
	private readonly providerListener = this._register(new MutableDisposable());
	private provider: ISCMHistoryProvider | undefined;
	private page: HistoryPage | undefined;
	private head: ISCMHistoryItemRef | undefined;
	private generation = 0;
	private loading = false;
	private moreError: string | undefined;
	private rows: readonly ISCMHistoryItemViewModel[] = [];
	private list: HTMLOListElement | undefined;
	private topSpacer: HTMLLIElement | undefined;
	private bottomSpacer: HTMLLIElement | undefined;
	private readonly expanded = new Map<string, ExpandedCommit>();
	private graphRepositoryId: string | undefined;
	public get repositoryId(): string | undefined { return this.graphRepositoryId; }

	constructor(container: HTMLElement, options: IViewPaneOptions, @ISCMViewService scmViewService: ISCMViewService, @IMenuService private readonly menuService: IMenuService, @IContextMenuService private readonly contextMenuService: IContextMenuService, @IContextKeyService private readonly contextKeyService: IContextKeyService, @IHoverService private readonly hoverService: IHoverService, @IEditorService private readonly editorService: IEditorService, @IResourceLabelService resourceLabelService: IResourceLabelService, @IAccessibleViewService private readonly accessibleView: IAccessibleViewService, @IContextViewService private readonly contextViewService: IContextViewService) {
		super(container, { ...options, headerActionsVisibility: "whenExpanded" });
		this.resourceLabels = this._register(resourceLabelService.createGroup());
		this.scmViewService = scmViewService;
		this.graphLabel = options.title;
		this.contentElement.classList.add("ash-scm-secondary-pane");
		this.graphElement = h(container.ownerDocument, "div");
		this.graphElement.className = "ash-scm-graph";
		this._register(addDisposableListener(this.graphElement, "scroll", () => {
			this.renderRows();
			if (this.graphElement.scrollTop + this.graphElement.clientHeight >= this.graphElement.scrollHeight - LoadAhead) void this.loadMore();
		}));
		this.contentElement.append(this.graphElement);
		this._register(observeElementSize(this.graphElement, () => this.renderRows()));
		this.busyContext = SCMHistoryBusyContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.busyContext.reset()));
		this.providerIdContext = SCMHistoryProviderIdContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.providerIdContext.reset()));
		const toolbar = this._register(new MenuWorkbenchToolBar(
			this.headerActionsElement,
			menuService,
			contextMenuService,
			MenuId.SCMHistoryTitle,
			{ ariaLabel: localize('scm.history.actions', 'History actions'), menuOptions: { arg: this } },
		));
		toolbar.element.classList.add("ash-scm-remote-actions");
		this._register(this.scmViewService.onDidChangeActiveRepository(() => void this.refresh()));
		void this.refresh();
	}

	public async runTitleOperation(operation?: () => Promise<unknown>): Promise<void> {
		this.busyContext.set(true);
		try {
			await operation?.();
			this.provider?.refresh();
			await this.refresh();
		} finally {
			this.busyContext.set(false);
		}
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const repository = this.scmViewService.activeRepository;
		this.providerIdContext.set(repository?.provider.providerId ?? '');
		const provider = repository?.provider.historyProvider;
		this.provider = provider;
		this.providerListener.value = provider?.onDidChange(() => void this.refresh());
		this.graphRepositoryId = repository?.id;
		this.page = undefined;
		this.head = undefined;
		this.loading = false;
		this.moreError = undefined;
		this.rows = [];
		this.list = undefined;
		this.topSpacer = undefined;
		this.bottomSpacer = undefined;
		this.expanded.clear();
		this.renderedRows.clearAndDisposeAll();
		this.more.clear();
		this.graphElement.textContent = "Loading commit graph…";
		this.graphElement.setAttribute('role', 'status');
		this.graphElement.setAttribute('aria-live', 'polite');
		this.graphElement.setAttribute("aria-busy", "true");
		if (!provider) {
			this.renderGraph({ items: [], hasMore: false });
			return;
		}
		try {
			const loaded = await provider.provideHistoryItems({ skip: 0, limit: PageSize + 1 });
			if (this.isDisposed || generation !== this.generation) return;
			const items = loaded ?? [];
			const page = { items: items.slice(0, PageSize), hasMore: items.length > PageSize };
			this.page = page;
			this.head = provider.historyItemRef.get();
			this.renderGraph(page);
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			const document = this.graphElement.ownerDocument;
			const message = h(document, "p");
			message.className = "ash-scm-empty";
			message.textContent = error instanceof Error ? error.message : String(error);
			this.graphElement.replaceChildren(message);
			if (!(error instanceof SCMHistoryUnavailableError)) {
				const retry = h(document, "button");
				retry.className = "ash-scm-command";
				retry.type = "button";
				retry.textContent = "Retry";
				retry.setAttribute("aria-label", "Retry loading commit graph");
				this.more.add(addDisposableListener(retry, "click", () => void this.refresh()));
				this.graphElement.append(retry);
			}
			this.graphElement.setAttribute("aria-busy", "false");
		}
	}

	private renderGraph(page: HistoryPage): void {
		this.graphElement.removeAttribute('role');
		this.graphElement.removeAttribute('aria-live');
		this.renderedRows.clearAndDisposeAll();
		this.more.clear();
		this.rows = toISCMHistoryItemViewModelArray(page.items, new Map(), this.head);
		const children: HTMLElement[] = [];
		this.list = undefined;
		this.topSpacer = undefined;
		this.bottomSpacer = undefined;
		if (page.items.length === 0) {
			const empty = h(this.graphElement.ownerDocument, "p");
			empty.className = "ash-scm-empty";
			empty.textContent = "No commits yet.";
			children.push(empty);
		} else {
			this.list = h(this.graphElement.ownerDocument, "ol");
			this.list.className = "ash-scm-graph-list";
			this.list.setAttribute("role", "tree");
			this.list.setAttribute('aria-label', this.graphLabel);
			this.list.setAttribute('aria-description', localize('scm.history.help', 'Press Enter or Space on a commit to expand its files. Press Shift+F10 or the Context Menu key for commit actions: view or compare changes, create a branch, cherry-pick, copy commit information, or add to Chat. Use Tab to reach reference badges and Open Changes. Press Enter on Open Changes to compare all text files in that commit. Press Enter on a reference badge for branch actions. Checkout includes detached commits; More includes creating a tag. Press Alt+Down Arrow to focus commit details and use its actions; Escape returns to the commit.'));
			this.topSpacer = this.renderSpacer(0);
			this.bottomSpacer = this.renderSpacer(0);
			this.list.append(this.topSpacer, this.bottomSpacer);
			children.push(this.list);
		}
		if (page.hasMore) children.push(this.renderMore());
		this.graphElement.replaceChildren(...children);
		this.renderRows();
		this.graphElement.setAttribute("aria-busy", this.loading ? "true" : "false");
	}

	private renderRows(): void {
		const list = this.list;
		if (!list || this.rows.length === 0) return;
		const listTop = offsetTopWithinScrollContainer(list, this.graphElement);
		const viewportTop = Math.max(0, this.graphElement.scrollTop - listTop);
		const viewportHeight = Math.max(SWIMLANE_HEIGHT, this.graphElement.clientHeight);
		const offsets = this.rowOffsets();
		const firstVisible = offsets.findIndex((offset, index) => offset + this.rowHeight(this.rows[index].historyItem) > viewportTop);
		const start = Math.max(0, (firstVisible < 0 ? this.rows.length - 1 : firstVisible) - Overscan);
		let end = start;
		while (end < this.rows.length && offsets[end] < viewportTop + viewportHeight) end += 1;
		end = Math.min(this.rows.length, Math.max(start + 1, end + Overscan));
		const visibleIds = new Set(this.rows.slice(start, end).map(row => row.historyItem.id));
		for (const [id] of this.renderedRows) {
			if (!visibleIds.has(id)) this.renderedRows.deleteAndDispose(id);
		}
		this.topSpacer!.style.height = `${offsets[start] ?? 0}px`;
		let previous: Element = this.topSpacer!;
		for (let index = start; index < end; index += 1) {
			const model = this.rows[index];
			let row = this.renderedRows.get(model.historyItem.id);
			if (!row) {
				row = this.renderCommit(model, renderSCMHistoryItemGraph(model, this.rowHeight(model.historyItem), this.graphElement.ownerDocument));
			}
			this.updateCommitRow(row, model);
			row.element.setAttribute('aria-posinset', String(index + 1));
			row.element.setAttribute('aria-setsize', String(this.rows.length));
			// Inserting only new rows leaves overlapping nodes, focus, and active hover targets connected.
			if (previous.nextElementSibling !== row.element) list.insertBefore(row.element, previous.nextSibling);
			previous = row.element;
		}
		const totalHeight = offsets.at(-1)! + this.rowHeight(this.rows.at(-1)!.historyItem);
		this.bottomSpacer!.style.height = `${totalHeight - (offsets[end] ?? totalHeight)}px`;
		for (const [, row] of this.renderedRows) {
			if (row.hover?.visible) {
				this.contextViewService.layout();
				break;
			}
		}
	}

	private rowOffsets(): number[] {
		const offsets: number[] = [];
		let offset = 0;
		for (const row of this.rows) {
			offsets.push(offset);
			offset += this.rowHeight(row.historyItem);
		}
		return offsets;
	}

	private rowHeight(historyItem: ISCMHistoryItem): number {
		const expanded = this.expanded.get(historyItem.id);
		if (!expanded) return SWIMLANE_HEIGHT;
		const childRows = expanded.state === "ready" ? Math.max(1, expanded.result.length) : 1;
		return SWIMLANE_HEIGHT * (childRows + 1);
	}

	private renderSpacer(height: number): HTMLLIElement {
		const spacer = h(this.graphElement.ownerDocument, "li");
		spacer.className = "ash-scm-graph-spacer";
		spacer.setAttribute("aria-hidden", "true");
		spacer.style.height = `${height}px`;
		return spacer;
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
		button.textContent = this.loading ? "Loading commit history…" : this.moreError ? "Retry" : "Load more commits";
		button.setAttribute("aria-label", this.moreError ? "Retry loading commit history" : "Load more commits");
		this.more.add(addDisposableListener(button, "click", () => void this.loadMore()));
		container.append(button);
		return container;
	}

	private updateMore(): void {
		const current = this.graphElement.querySelector(".ash-scm-graph-load-more");
		if (!this.page?.hasMore) {
			current?.remove();
			this.more.clear();
		} else if (current) {
			this.more.clear();
			current.replaceWith(this.renderMore());
		} else {
			this.graphElement.append(this.renderMore());
		}
		this.graphElement.setAttribute("aria-busy", this.loading ? "true" : "false");
	}

	private async loadMore(): Promise<void> {
		const page = this.page;
		const provider = this.provider;
		if (!page || !provider || !page.hasMore || this.loading) return;

		const generation = this.generation;
		this.loading = true;
		this.moreError = undefined;
		this.updateMore();
		try {
			// Load one page per request so startup and scrolling do not drain the repository history.
			const next = await provider.provideHistoryItems({ skip: page.items.length, limit: PageSize + 1 });
			if (this.isDisposed || generation !== this.generation) return;
			const items = next ?? [];
			this.page = { items: [...page.items, ...items.slice(0, PageSize)], hasMore: items.length > PageSize };
			this.rows = toISCMHistoryItemViewModelArray(this.page.items, new Map(), this.head);
			this.loading = false;
			this.updateMore();
			this.renderRows();
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
		const rendered = this.renderedRows.set(historyItem.id, new HistoryItemRow(historyItemViewModel, graph, document));
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
		scope.setContext('scmHistoryProviderId', repository?.provider.providerId ?? '');
		scope.setContext('scmHistoryItemHasRemote', (historyItem.remoteLinks?.length ?? 0) > 0);
		scope.setContext('scmHistoryItemRemoteAuthority', historyItem.remoteLinks?.length === 1 ? historyItem.remoteLinks[0].uri.authority : '');
		scope.setContext('scmHistoryItemHasBranch', historyItem.references?.some(reference => reference.category === 'localBranch' || reference.category === 'remoteBranch') ?? false);
		scope.setContext('scmHistoryItemHasUpstream', historyItem.references?.some(reference => reference.upstream !== undefined) ?? false);
		const hoverContent = resources.add(new MutableDisposable<DisposableStore>());
		let hoverToolbar: MenuWorkbenchToolBar | undefined;
		let commitHover: IManagedHover | undefined;
		if (menuTarget) {
			commitHover = resources.add(this.hoverService.setupHover({
				target: item,
				content: () => {
					const resources = new DisposableStore();
					hoverContent.value = resources;
					const card = this.renderCommitHover(menuTarget, scope, resources, () => {
						// Relayout loaded details without replacing the lazy factory or its focused actions.
						if (commitHover!.visible) this.contextViewService.layout();
					});
					hoverToolbar = card.toolbar;
					return card.domNode;
				},
				groupId: 'scm.history.items',
				// Commit details contain actions, so crossing the gap must not dismiss them.
				persistence: 'sticky',
				anchorAlignment: AnchorAlignment.Left,
				anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
				anchorPosition: AnchorPosition.Below,
				gap: 8,
			}));
		}
		const visibleReferences = historyItemReferences(historyItem, this.head);
		const overlay = h(document, 'div');
		overlay.className = 'ash-scm-graph-overlay';
		if (visibleReferences.length > 0) { overlay.append(this.renderReferenceLabels(visibleReferences, menuTarget, scope, resources)); }
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
			if ((event.target as Element).closest(".ash-scm-graph-change, .ash-scm-graph-actions, .ash-scm-graph-label")) return;
			void this.toggleCommit(historyItem);
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
			}
		}));
		resources.add(addDisposableListener(item, "contextmenu", event => {
			event.preventDefault();
			event.stopPropagation();
			if (menuTarget) { this.showHistoryMenu(menuTarget, scope, item, event); }
		}));
		return rendered;
	}

	private updateCommitRow(row: HistoryItemRow, model: ISCMHistoryItemViewModel): void {
		const previous = row.historyItemViewModel;
		const expanded = this.expanded.get(model.historyItem.id);
		const expansionChanged = row.expanded !== expanded;
		const sameLane = (left: ISCMHistoryItemViewModel['inputSwimlanes'][number], right: ISCMHistoryItemViewModel['inputSwimlanes'][number]): boolean => left.id === right.id && left.color === right.color;
		if (expansionChanged || previous.kind !== model.kind || !equals(previous.inputSwimlanes, model.inputSwimlanes, sameLane) || !equals(previous.outputSwimlanes, model.outputSwimlanes, sameLane)) {
			const graph = renderSCMHistoryItemGraph(model, this.rowHeight(model.historyItem), this.graphElement.ownerDocument);
			row.graph.replaceWith(graph);
			row.graph = graph;
			row.element.style.setProperty('--scm-graph-node-x', `${graph.dataset.nodeX}px`);
			row.element.style.setProperty('--scm-graph-content-x', graph.style.width);
		}
		row.historyItemViewModel = model;
		if (!expansionChanged) return;
		if (row.changesElement?.contains(row.element.ownerDocument.activeElement)) row.element.focus();
		row.changes.clear();
		row.changesElement?.remove();
		row.changesElement = undefined;
		row.expanded = expanded;
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
			state.textContent = expanded.state === "loading" ? "Loading changed files…" : expanded.state === "error" ? expanded.message : "No changed files.";
			list.append(state);
			return list;
		}
		for (const change of expanded.result) {
			const row = h(document, "li");
			const button = h(document, "button");
			button.className = "ash-scm-graph-change";
			button.type = "button";
			button.title = `Open ${change.path} from ${historyItem.displayId ?? historyItem.id}`;
			const name = change.path.split("/").at(-1) ?? change.path;
			const parentPath = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
			const fileLabel = resources.add(this.resourceLabels.create(button));
			fileLabel.setResource({ resource: change.uri, name, description: parentPath || undefined }, {
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
			resources.add(addDisposableListener(button, "contextmenu", event => {
				event.preventDefault();
				event.stopPropagation();
				const repository = this.scmViewService.activeRepository;
				if (!repository) return;
				this.contextMenuService.showContextMenu({
					getAnchor: () => ({
						x: event.clientX,
						y: event.clientY,
						targetWindow: event.view ?? undefined,
					}),
					menuId: MenuId.SCMHistoryItemChangeContext,
					menuActionOptions: { arg: {
						repository,
						historyItemViewModel,
						historyItemChange: change,
						graphColumns: historyItemViewModel.outputSwimlanes,
						type: 'historyItemChangeViewModel',
					} satisfies SCMHistoryItemChangeViewModelTreeElement },
				});
			}));
			row.append(button);
			list.append(row);
		}
		return list;
	}

	private async toggleCommit(historyItem: ISCMHistoryItem): Promise<void> {
		if (this.expanded.delete(historyItem.id)) {
			this.renderRows();
			return;
		}
		const provider = this.provider;
		if (!provider) return;
		const generation = this.generation;
		this.expanded.set(historyItem.id, { state: "loading" });
		this.renderRows();
		try {
			const result = await provider.provideHistoryItemChanges(historyItem.id, historyItem.parentIds[0]);
			if (this.isDisposed || generation !== this.generation || !this.expanded.has(historyItem.id)) return;
			this.expanded.set(historyItem.id, { state: "ready", result: result ?? [] });
		} catch (error) {
			if (this.isDisposed || generation !== this.generation || !this.expanded.has(historyItem.id)) return;
			this.expanded.set(historyItem.id, { state: "error", message: error instanceof Error ? error.message : String(error) });
		}
		this.renderRows();
	}

	private async openCommitChange(historyItem: ISCMHistoryItem, change: ISCMHistoryItemChange, options: IOpenEditorOptions): Promise<void> {
		const provider = this.provider;
		if (!provider) return;
		const file = await provider.resolveHistoryItemChangeContents(historyItem.id, change);
		const name = change.path.split("/").at(-1) ?? change.path;
		const original = file.original.kind === "text" ? {
			resource: change.originalUri ?? change.uri,
			label: `${name} (${file.parentId?.slice(0, 7) ?? "empty"})`,
			readOnly: true,
			initialText: file.original.text,
		} : undefined;
		const modified = file.modified.kind === "text" ? {
			resource: change.modifiedUri ?? change.uri,
			label: `${name} (${historyItem.displayId ?? historyItem.id})`,
			readOnly: true,
			initialText: file.modified.text,
		} : undefined;
		const group = options.openToSide ? 'sideGroup' : 'activeGroup';
		if (original && modified) {
			await this.editorService.openEditor(createDiffEditorInput(original, modified, `${original.label} ↔ ${modified.label}`), options.editorOptions, group);
		} else if (modified) {
			await this.editorService.openEditor(modified, options.editorOptions, group);
		} else if (original) {
			await this.editorService.openEditor(original, options.editorOptions, group);
		}
	}

	private renderCommitHover(target: SCMHistoryItemViewModelTreeElement, scope: IScopedContextKeyService, resources: DisposableStore, layout: () => void): { domNode: HTMLDivElement; toolbar: MenuWorkbenchToolBar } {
		const historyItem = target.historyItemViewModel.historyItem;
		const document = this.graphElement.ownerDocument;
		const hover = h(document, "div");
		hover.className = "ash-scm-graph-hover";
		const hoverScope = resources.add(scope.createScoped(hover));
		hoverScope.setContext('scmHistoryDetailsFocused', true);
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
		const hash = h(document, 'code');
		hash.className = 'ash-scm-graph-hover-hash';
		hash.textContent = historyItem.displayId ?? historyItem.id;
		hash.title = historyItem.id;
		hash.setAttribute('aria-label', localize('scm.history.commitId', 'Commit {0}', historyItem.id));
		const actions = h(document, 'div');
		actions.className = 'ash-scm-graph-hover-actions';
		const toolbar = resources.add(new MenuWorkbenchToolBar(actions, this.menuService, this.contextMenuService, MenuId.for('SCMHistoryItemHover'), {
			ariaLabel: localize('scm.history.commitActions', 'Commit actions'),
			contextKeyService: scope,
			menuOptions: { arg: target, renderShortTitle: true },
			// Action tooltips share the ContextView and would replace their own details card.
			actionViewItemProvider: (action, options) => new LabelActionViewItem(action, { ...options, ariaLabel: action.tooltip, tooltip: '' }),
			toolbarOptions: { primaryGroup: 'inline' },
		}));
		if (hint) toolbar.element.setAttribute('aria-description', hint);
		footer.append(hash, actions);
		hover.append(details, footer);
		void this.resolveCommitHover(target, details, status, resources, layout);
		return { domNode: hover, toolbar };
	}

	private async resolveCommitHover(target: SCMHistoryItemViewModelTreeElement, details: HTMLElement, status: HTMLElement, resources: DisposableStore, layout: () => void): Promise<void> {
		try {
			const result = await target.repository.provider.historyProvider!.resolveHistoryItemDetails(target.historyItemViewModel.historyItem.id);
			if (resources.isDisposed) { return; }
			this.renderCommitDetails(details, target.historyItemViewModel.historyItem.subject, result);
		} catch {
			if (resources.isDisposed) { return; }
			status.textContent = localize('scm.history.detailsFailed', 'Unable to load commit details.');
		}
		details.setAttribute('aria-busy', 'false');
		layout();
	}

	private renderCommitDetails(container: HTMLElement, subjectText: string, details: ISCMHistoryItemDetails): void {
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
		message.tabIndex = 0;
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
		if (message.textContent) { container.append(message); }
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

function offsetTopWithinScrollContainer(element: HTMLElement, scrollContainer: HTMLElement): number {
	if (element.offsetParent === scrollContainer) return element.offsetTop;
	if (element.offsetParent === scrollContainer.offsetParent) return element.offsetTop - scrollContainer.offsetTop;
	return element.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop;
}
