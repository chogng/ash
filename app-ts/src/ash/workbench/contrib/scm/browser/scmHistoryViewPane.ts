import { localize2, localize } from '../../../../nls.js';
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from "../../../../base/browser/ui/contextview/contextview.js";
import { appendIcon } from "../../../../base/browser/ui/lxicons/lxicon.js";
import { Lxicon } from "../../../../base/common/lxicons.js";

import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { Action2, IMenuService, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { registerOpenEditorListeners, type IOpenEditorOptions } from "../../../../platform/editor/browser/editor.js";
import { IHoverService } from "../../../../platform/hover/browser/hoverService.js";
import { IResourceLabelService, type ResourceLabels } from "../../../browser/labels.js";
import { SCMHistoryUnavailableError, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemRef, type ISCMHistoryItemViewModel, type ISCMHistoryProvider, type SCMHistoryItemChangeViewModelTreeElement, type SCMHistoryItemViewModelTreeElement } from '../common/history.js';
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

	public override async run(accessor: ServicesAccessor, element: SCMHistoryItemViewModelTreeElement): Promise<void> {
		if (element?.type !== 'historyItemViewModel') { return; }
		const { repository, historyItemViewModel } = element;
		const provider = repository.provider.historyProvider;
		if (!provider) { return; }
		const historyItem = historyItemViewModel.historyItem;
		const changes = await provider.provideHistoryItemChanges(historyItem.id, historyItem.parentIds[0]);
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
		if (items.length === 0) { return; }
		const resource = URI.from({ scheme: 'ash-multi-diff', path: `/scm-history/${repository.id}/${historyItem.id}` });
		const title = `${historyItem.displayId ?? historyItem.id} · ${historyItem.subject}`;
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

/** Paged SCM history rendered as a compact graph. */
export class SCMHistoryViewPane extends ViewPane {
	private readonly scmViewService: ISCMViewService;
	private readonly graphLabel: string;
	private readonly busyContext: IContextKey<boolean>;
	private readonly providerIdContext: IContextKey<string>;
	private readonly graphElement: HTMLDivElement;
	private readonly hovers = this._register(new DisposableStore());
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
	private readonly expanded = new Map<string, ExpandedCommit>();
	private graphRepositoryId: string | undefined;
	public get repositoryId(): string | undefined { return this.graphRepositoryId; }

	constructor(container: HTMLElement, options: IViewPaneOptions, @ISCMViewService scmViewService: ISCMViewService, @IMenuService private readonly menuService: IMenuService, @IContextMenuService private readonly contextMenuService: IContextMenuService, @IContextKeyService contextKeyService: IContextKeyService, @IHoverService private readonly hoverService: IHoverService, @IEditorService private readonly editorService: IEditorService, @IResourceLabelService resourceLabelService: IResourceLabelService) {
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
		this.expanded.clear();
		this.hovers.clear();
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
			if (page.hasMore) void this.loadMore();
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
		this.hovers.clear();
		this.more.clear();
		this.rows = toISCMHistoryItemViewModelArray(page.items, new Map(), this.head);
		const children: HTMLElement[] = [];
		this.list = undefined;
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
			this.list.setAttribute('aria-description', localize('scm.history.help', 'Press Enter or Space on a commit to expand its files. Use Tab to reach Open Changes and press Enter to compare all text files in that commit. The same action is available in the commit context menu.'));
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
		this.hovers.clear();
		const listTop = offsetTopWithinScrollContainer(list, this.graphElement);
		const viewportTop = Math.max(0, this.graphElement.scrollTop - listTop);
		const viewportHeight = Math.max(SWIMLANE_HEIGHT, this.graphElement.clientHeight);
		const offsets = this.rowOffsets();
		const firstVisible = offsets.findIndex((offset, index) => offset + this.rowHeight(this.rows[index].historyItem) > viewportTop);
		const start = Math.max(0, (firstVisible < 0 ? this.rows.length - 1 : firstVisible) - Overscan);
		let end = start;
		while (end < this.rows.length && offsets[end] < viewportTop + viewportHeight) end += 1;
		end = Math.min(this.rows.length, Math.max(start + 1, end + Overscan));
		const children: HTMLElement[] = [this.renderSpacer(offsets[start] ?? 0)];
		for (let index = start; index < end; index += 1) {
			const row = this.rows[index];
			const item = this.renderCommit(row, renderSCMHistoryItemGraph(row, this.rowHeight(row.historyItem), this.graphElement.ownerDocument));
			item.setAttribute('aria-posinset', String(index + 1));
			item.setAttribute('aria-setsize', String(this.rows.length));
			children.push(item);
		}
		const totalHeight = offsets.at(-1)! + this.rowHeight(this.rows.at(-1)!.historyItem);
		children.push(this.renderSpacer(totalHeight - (offsets[end] ?? totalHeight)));
		list.replaceChildren(...children);
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
			while (this.page?.hasMore) {
				const current = this.page;
				const next = await provider.provideHistoryItems({ skip: current.items.length, limit: PageSize + 1 });
				if (this.isDisposed || generation !== this.generation) return;
				const items = next ?? [];
				const additions = items.slice(0, PageSize);
				this.page = { items: [...current.items, ...additions], hasMore: items.length > PageSize };
				this.rows = toISCMHistoryItemViewModelArray(this.page.items, new Map(), this.head);
				this.updateMore();
				this.renderRows();
			}
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

	private renderCommit(historyItemViewModel: ISCMHistoryItemViewModel, graph: SVGSVGElement): HTMLLIElement {
		const historyItem = historyItemViewModel.historyItem;
		const document = this.graphElement.ownerDocument;
		const item = h(document, "li");
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
		this.hovers.add(this.hoverService.setupHover({
			target: item,
			content: () => this.renderCommitHover(historyItem),
			groupId: "scm.history.items",
			anchorAlignment: AnchorAlignment.Left,
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			anchorPosition: AnchorPosition.Below,
			gap: 8,
		}));
		const details = h(document, "span");
		details.className = "ash-scm-graph-details";
		const subject = h(document, "span");
		subject.className = "ash-scm-graph-subject";
		subject.textContent = historyItem.subject;
		details.append(subject);
		const visibleReferences = historyItemReferences(historyItem, this.head);
		const overlay = h(document, 'div');
		overlay.className = 'ash-scm-graph-overlay';
		if (visibleReferences.length > 0) { overlay.append(this.renderReferenceLabels(visibleReferences)); }
		const metadata = h(document, "span");
		metadata.className = "ash-scm-graph-metadata";
		const date = historyItem.timestamp === undefined ? undefined : new Date(historyItem.timestamp);
		metadata.textContent = date ? `${historyItem.displayId ?? historyItem.id} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : historyItem.displayId ?? historyItem.id;
		const row = h(document, "div");
		row.className = "ash-scm-graph-row";
		row.append(graph, details, metadata);
		const repository = this.scmViewService.activeRepository;
		if (repository) {
			const actions = h(document, 'div');
			actions.className = 'ash-scm-graph-actions';
			this.hovers.add(new MenuWorkbenchToolBar(actions, this.menuService, this.contextMenuService, MenuId.SCMHistoryItemContext, {
				ariaLabel: localize('scm.history.commitActions', 'Commit actions'),
				menuOptions: { arg: { repository, historyItemViewModel, type: 'historyItemViewModel' } satisfies SCMHistoryItemViewModelTreeElement },
				toolbarOptions: { primaryGroup: 'inline' },
			}));
			overlay.append(actions);
		}
		row.append(overlay);
		item.append(row);
		const expanded = this.expanded.get(historyItem.id);
		if (expanded) item.append(this.renderCommitChanges(historyItemViewModel, expanded));
		this.hovers.add(addDisposableListener(item, "click", (event) => {
			if ((event.target as Element).closest(".ash-scm-graph-change, .ash-scm-graph-actions")) return;
			void this.toggleCommit(historyItem);
		}));
		this.hovers.add(addDisposableListener(item, "keydown", (event) => {
			if (event.target !== item || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			void this.toggleCommit(historyItem);
		}));
		this.hovers.add(addDisposableListener(item, "contextmenu", event => {
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
				menuId: MenuId.SCMHistoryItemContext,
				menuActionOptions: { arg: {
					repository,
					historyItemViewModel,
					type: 'historyItemViewModel',
				} satisfies SCMHistoryItemViewModelTreeElement },
			});
		}));
		return item;
	}

	private renderReferenceLabels(references: readonly ISCMHistoryItemRef[]): HTMLSpanElement {
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
			label.setAttribute('role', 'img');
			label.setAttribute('aria-label', names);
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
			this.hovers.add(this.hoverService.setupDelayedHover(label, { content: names }));
			container.append(label);
		}
		return container;
	}

	private renderCommitChanges(historyItemViewModel: ISCMHistoryItemViewModel, expanded: ExpandedCommit): HTMLUListElement {
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
			const fileLabel = this.hovers.add(this.resourceLabels.create(button));
			fileLabel.setResource({ resource: change.uri, name, description: parentPath || undefined }, {
				reserveIconSpace: true,
				title: change.path,
				extraClasses: ["ash-scm-graph-change-label"],
			});
			const status = h(document, "span");
			status.className = `ash-scm-graph-change-status ${change.status}`;
			status.textContent = changeStatusLabel(change.status);
			button.append(fileLabel.element, status);
			this.hovers.add(registerOpenEditorListeners(button, options => {
				void this.openCommitChange(historyItem, change, options);
			}));
			this.hovers.add(addDisposableListener(button, "contextmenu", event => {
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

	private renderCommitHover(historyItem: ISCMHistoryItem): HTMLDivElement {
		const document = this.graphElement.ownerDocument;
		const hover = h(document, "div");
		hover.className = "ash-scm-graph-hover";
		const subject = h(document, "div");
		subject.className = "ash-scm-graph-hover-subject";
		subject.textContent = historyItem.subject;
		const metadata = h(document, "div");
		metadata.className = "ash-scm-graph-hover-metadata";
		metadata.textContent = historyItem.timestamp === undefined ? historyItem.id : `${historyItem.id} · ${new Date(historyItem.timestamp).toLocaleString()}`;
		hover.append(subject, metadata);
		return hover;
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
