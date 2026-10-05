import { addDisposableListener, isNode, stopEvent, h } from "../../dom.js";
import { disposableWindowTimeout } from "../../scheduler.js";
import { appendIcon } from "../lxicons/lxicon.js";
import type { ListDragAndDrop, ListDragData, ListScrolling } from "../list/list.js";
import { List } from "../list/listWidget.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, MutableDisposable, type IDisposable } from "../../../common/lifecycle.js";
import { Lxicon } from "../../../common/lxicons.js";
import { rot } from "../../../common/numbers.js";
import type { AbstractTreeNode, TreeAcceptEvent, TreeActivateEvent, TreeCollapseRequestEvent, TreeDragAndDrop, TreeDragOverReaction, TreeFindMatchType, TreeFindMode, TreeFindResult, TreeFocusChangeEvent, TreeIndentGuides, TreeKeyboardNavigationLabelProvider, TreePointerEvent, TreePointerTarget, TreeSelectionChangeEvent, TreeSelectionPresentation, TreeTwistieState, TreeVisibleSplice } from "./tree.js";

export interface AbstractTreeOptions<T, TNode extends AbstractTreeNode<T>> {
	readonly ariaLabel?: string;
	readonly scrolling?: ListScrolling;
	readonly smoothScrolling?: boolean;
	readonly indent?: number;
	readonly indentGuides?: TreeIndentGuides;
	readonly twistieAdditionalCssClass?: (element: TNode) => string | undefined;
	/** Whether the second click of a double-click gesture toggles expansion. Defaults to true. */
	readonly expandOnDoubleClick?: boolean;
	readonly expandOnlyOnTwistieClick?: boolean | ((element: TNode) => boolean);
	readonly getHeight?: (element: TNode) => number;
	readonly dnd?: TreeDragAndDrop<TNode>;
	readonly keyboardNavigationLabelProvider?: TreeKeyboardNavigationLabelProvider<T>;
	readonly findMode?: TreeFindMode;
	readonly findMatchType?: TreeFindMatchType;
	readonly selectionPresentation?: TreeSelectionPresentation;
	readonly multipleSelectionSupport?: boolean;
	readonly enableStickyScroll?: boolean;
	readonly stickyScrollMaxItemCount?: number;
	readonly renderElement: (element: TNode) => HTMLElement;
	readonly renderTwistie?: (element: TNode, state: TreeTwistieState, container: HTMLSpanElement) => void;
	readonly reuseRows?: boolean;
	readonly onDidRemoveRow?: (row: HTMLDivElement) => void;
}

/**
 * Projects model-owned tree nodes through the shared flat `List` foundation.
 *
 * Implementations provide an already-flattened visible-node sequence. This
 * layer owns tree row semantics and interaction, but never reconstructs or
 * mutates the hierarchy itself.
 */
export class AbstractTree<T, TNode extends AbstractTreeNode<T>> extends Disposable {
	readonly element: HTMLDivElement;
	readonly domNode: HTMLDivElement;
	private readonly list: List<TNode>;
	private readonly options: AbstractTreeOptions<T, TNode>;
	private twistieAdditionalCssClass: AbstractTreeOptions<T, TNode>["twistieAdditionalCssClass"];
	private readonly _onPointer = this._register(new Emitter<TreePointerEvent<TNode>>());
	private readonly _onDidDoubleClick = this._register(new Emitter<TreePointerEvent<TNode>>());
	private readonly _onDidAccept = this._register(new Emitter<TreeAcceptEvent<TNode>>());
	private readonly _onDidChangeFocus = this._register(new Emitter<TreeFocusChangeEvent<TNode>>());
	private readonly _onDidChangeSelection = this._register(new Emitter<TreeSelectionChangeEvent<TNode>>());
	private readonly _onDidRequestCollapseChange = this._register(new Emitter<TreeCollapseRequestEvent<TNode>>());
	private readonly _onDidActivate = this._register(new Emitter<TreeActivateEvent<TNode>>());
	private readonly _onDidChangeFind = this._register(new Emitter<TreeFindResult<TNode>>());
	private readonly findController: TreeFindController<T, TNode> | undefined;
	private readonly stickyContainer: HTMLDivElement | undefined;
	private readonly renderedElements = new WeakMap<HTMLDivElement, T>();
	private sourceItems: readonly TNode[] = [];
	private findCandidatesProvider: (() => readonly TNode[]) | undefined;
	private findCandidates: readonly TNode[] | undefined;
	private readonly autoExpandTimer = this._register(new MutableDisposable<IDisposable>());
	private autoExpandId: string | undefined;

	readonly onPointer: Event<TreePointerEvent<TNode>> = this._onPointer.event;
	readonly onDidDoubleClick: Event<TreePointerEvent<TNode>> = this._onDidDoubleClick.event;
	readonly onDidAccept: Event<TreeAcceptEvent<TNode>> = this._onDidAccept.event;
	readonly onDidChangeFocus: Event<TreeFocusChangeEvent<TNode>> = this._onDidChangeFocus.event;
	readonly onDidChangeSelection: Event<TreeSelectionChangeEvent<TNode>> = this._onDidChangeSelection.event;
	readonly onDidRequestCollapseChange: Event<TreeCollapseRequestEvent<TNode>> = this._onDidRequestCollapseChange.event;
	/** @deprecated Prefer the semantic pointer, accept, and collapse events. */
	readonly onDidActivate: Event<TreeActivateEvent<TNode>> = this._onDidActivate.event;
	readonly onDidChangeFind: Event<TreeFindResult<TNode>> = this._onDidChangeFind.event;

	constructor(container: HTMLElement, options: AbstractTreeOptions<T, TNode>) {
		super();
		this.options = options;
		this.twistieAdditionalCssClass = options.twistieAdditionalCssClass;
		validateIndent(options.indent);
		this.findController = options.keyboardNavigationLabelProvider ? new TreeFindController({ labelProvider: options.keyboardNavigationLabelProvider, mode: options.findMode ?? "highlight", matchType: options.findMatchType ?? "fuzzy" }) : undefined;
		this.list = this._register(new List<TNode>(container, {
			ariaLabel: options.ariaLabel,
			role: "tree",
			scrolling: options.scrolling,
			smoothScrolling: options.smoothScrolling,
			loopNavigation: false,
			keyboardNavigation: true,
			multipleSelectionSupport: options.multipleSelectionSupport,
			focusOnMouseMove: false,
			acceptOnClick: false,
			domFocusable: true,
			getId: (node) => node.id,
			getHeight: options.getHeight,
			dnd: options.dnd ? this.asListDragAndDrop(options.dnd) : undefined,
			accessibilityProvider: {
				getRole: () => "treeitem",
				getAriaLevel: (node) => node.depth,
				getAriaSetSize: (node) => node.visibleChildrenCount,
				getAriaPosInSet: (node) => node.visibleChildIndex + 1,
				isExpanded: (node) => node.collapsible ? this.isExpanded(node) : undefined,
			},
			renderItem: (node, _index, row) => this.renderRow(node, row),
			reuseRows: options.reuseRows,
			updateItem: (node, _index, row, rerender) => this.updateRow(node, row, rerender),
			onDidRemoveRow: options.onDidRemoveRow,
		}));
		this.element = this.list.element;
		this.domNode = this.list.domNode;
		this.element.classList.add(
			"ash-tree",
			`ash-tree-indent-guides-${options.indentGuides ?? "none"}`,
			`ash-tree-selection-${options.selectionPresentation ?? "active"}`,
		);
		if (options.indent !== undefined) this.element.style.setProperty("--ash-tree-indent", `${options.indent}px`);
		if (options.enableStickyScroll) {
			this.stickyContainer = h(this.element.ownerDocument, "div");
			this.stickyContainer.className = "ash-tree-sticky-container";
			this.stickyContainer.setAttribute("aria-hidden", "true");
			this.element.append(this.stickyContainer);
			this._register(addDisposableListener(this.stickyContainer, "click", (event: MouseEvent) => this.onStickyClick(event)));
			this._register(this.list.onDidScroll(() => this.updateStickyScroll()));
		}
		this._register(this.list.onPointer((event) => this.onListPointer(event.item, event.browserEvent)));
		this._register(this.list.onDidDoubleClick((event) => this.onListDoubleClick(event.item, event.browserEvent)));
		this._register(this.list.onDidChangeFocus(({ item, browserEvent }) => {
			this.updateActiveIndentGuides();
			this._onDidChangeFocus.fire({ element: item, browserEvent });
		}));
		this._register(this.list.onDidChangeSelection(({ items, browserEvent }) => {
			this.updateActiveIndentGuides();
			this._onDidChangeSelection.fire({ elements: items, browserEvent });
		}));
		this._register(addDisposableListener(this.element, "keydown", (event: KeyboardEvent) => this.onKeyDown(event)));
		this._register(this.list.onDidScroll(() => this.updateActiveIndentGuides()));
	}

	get items(): readonly TNode[] { return this.list.items; }
	public updateOptions(options: Pick<AbstractTreeOptions<T, TNode>, "indent" | "indentGuides" | "twistieAdditionalCssClass" | "smoothScrolling">): void {
		if (options.smoothScrolling !== undefined) { this.list.updateOptions({ smoothScrolling: options.smoothScrolling }); }
		validateIndent(options.indent);
		if (options.indent !== undefined) this.element.style.setProperty("--ash-tree-indent", `${options.indent}px`);
		if (options.indentGuides !== undefined) {
			this.element.classList.remove("ash-tree-indent-guides-none", "ash-tree-indent-guides-onHover", "ash-tree-indent-guides-always");
			this.element.classList.add(`ash-tree-indent-guides-${options.indentGuides}`);
		}
		if (options.twistieAdditionalCssClass !== undefined) {
			this.twistieAdditionalCssClass = options.twistieAdditionalCssClass;
			this.items.forEach((_node, index) => this.list.rerender(index));
			this.updateStickyScroll();
		}
	}
	clearRetainedRows(): void { this.list.clearRetainedRows(); }
	domFocus(): void { this.list.domFocus(); }
	set items(items: readonly TNode[]) {
		this.sourceItems = items;
		const candidates = this.findController?.query ? this.findableNodes() : items;
		this.spliceItems(this.findController?.update(this.findController.query, candidates, items) ?? items);
		this.restoreStickyContainer();
		this.updateStickyScroll();
		this.emitFindResult();
	}

	spliceVisibleItems(items: readonly TNode[], splice: TreeVisibleSplice<TNode>): void {
		if (this.findController?.query) {
			this.items = items;
			return;
		}
		this.sourceItems = items;
		this.spliceListRange(splice);
		this.restoreStickyContainer();
		this.updateStickyScroll();
		this.emitFindResult();
	}

	rerender(id: string): void {
		if (this.findController?.query) {
			this.items = this.sourceItems;
			return;
		}
		const index = this.items.findIndex(node => node.id === id);
		if (index < 0) return;
		this.list.rerender(index);
		this.updateActiveIndentGuides();
		this.updateStickyScroll();
	}

	setFindCandidates(provider: () => readonly TNode[]): void {
		this.findCandidatesProvider = provider;
		this.findCandidates = undefined;
	}
	get focus(): TNode | undefined { return this.list.activeItem; }
	get selection(): readonly TNode[] { return this.list.selection; }

	setFocus(id: string, browserEvent?: UIEvent): void {
		const index = this.items.findIndex((node) => node.id === id);
		if (index >= 0) this.list.setActiveIndex(index, browserEvent);
	}

	setSelection(ids: readonly string[], browserEvent?: UIEvent): void {
		const selected = new Set(ids);
		this.list.setSelection(this.items.flatMap((node, index) => selected.has(node.id) ? [index] : []), browserEvent);
	}

	setFindPattern(pattern: string): void {
		if (!this.findController) throw new Error("Tree find requires a keyboardNavigationLabelProvider");
		const candidates = pattern ? this.findableNodes() : this.sourceItems;
		this.spliceItems(this.findController.update(pattern, candidates, this.sourceItems));
		if (!pattern) this.findCandidates = undefined;
		this.restoreStickyContainer();
		const active = this.findController.activeMatch;
		if (active) this.setFocus(active.id);
		this.updateStickyScroll();
		this.emitFindResult();
	}

	findNext(): TNode | undefined { return this.moveFind(1); }
	findPrevious(): TNode | undefined { return this.moveFind(-1); }
	clearFind(): void { this.setFindPattern(""); }

	updateElementHeight(id: string, height: number | undefined): void {
		const index = this.items.findIndex((node) => node.id === id);
		if (index >= 0) this.list.updateElementHeight(index, height);
		this.updateStickyScroll();
	}

	getElementTop(id: string): number | undefined {
		const index = this.items.findIndex((node) => node.id === id);
		return index < 0 ? undefined : this.list.getElementTop(index);
	}

	private spliceItems(items: readonly TNode[]): void {
		this.spliceListRange({ start: 0, deleteCount: this.list.items.length, elements: items });
	}

	private spliceListRange(splice: TreeVisibleSplice<TNode>): void {
		const previous = this.list.items;
		let start = splice.start;
		let nextStart = 0;
		while (start < splice.start + splice.deleteCount && nextStart < splice.elements.length && previous[start] === splice.elements[nextStart]) {
			start += 1;
			nextStart += 1;
		}
		let previousEnd = splice.start + splice.deleteCount;
		let nextEnd = splice.elements.length;
		while (previousEnd > start && nextEnd > nextStart && previous[previousEnd - 1] === splice.elements[nextEnd - 1]) {
			previousEnd -= 1;
			nextEnd -= 1;
		}
		this.list.splice(start, previousEnd - start, splice.elements.slice(nextStart, nextEnd));
		this.updateActiveIndentGuides();
	}

	private updateActiveIndentGuides(): void {
		const activeParents = new Set<string>();
		for (const node of [...this.selection, ...(this.focus ? [this.focus] : [])]) {
			const parent = node.collapsible && this.isExpanded(node) && node.children.length > 0 ? node : node.parent;
			if (parent && parent.depth > 0) activeParents.add(parent.id);
		}
		for (const guide of this.element.querySelectorAll<HTMLElement>(".ash-tree-indent-guide")) {
			guide.classList.toggle("active", activeParents.has(guide.dataset.treeParentId!));
		}
	}

	private renderIndentGuides(node: TNode, indent: HTMLSpanElement): void {
		const ancestors: AbstractTreeNode<T>[] = [];
		for (let parent = node.parent; parent && parent.depth > 0; parent = parent.parent) ancestors.unshift(parent);
		// Retained rows can move between parents without changing element identity or depth.
		if (indent.childElementCount === ancestors.length && ancestors.every((ancestor, index) => (indent.children[index] as HTMLElement).dataset.treeParentId === ancestor.id)) return;
		indent.replaceChildren(...ancestors.map(ancestor => {
			const guide = h(indent.ownerDocument, "span");
			guide.className = "ash-tree-indent-guide";
			guide.dataset.treeParentId = ancestor.id;
			return guide;
		}));
	}

	private renderRow(node: TNode, row: HTMLDivElement): HTMLElement {
		const document = row.ownerDocument;
		row.classList.add("ash-tree-row");
		row.dataset.treeId = node.id;
		row.classList.toggle("collapsible", node.collapsible);
		row.classList.toggle("expanded", node.collapsible && this.isExpanded(node));
		row.classList.toggle("collapsed", node.collapsible && !this.isExpanded(node));
		row.classList.toggle("find-match", this.findController?.isMatch(node) ?? false);
		row.style.paddingLeft = treeRowPadding(node.depth);
		row.dataset.treeDepth = String(node.depth);
		row.dataset.treeExpanded = String(node.collapsible && !node.collapsed);
		row.dataset.treeCollapsible = String(node.collapsible);
		const inner = h(document, "span");
		inner.className = "ash-tree-row-inner";
		const indent = h(document, "span");
		indent.className = "ash-tree-indent";
		indent.setAttribute("aria-hidden", "true");
		this.renderIndentGuides(node, indent);
		const twistie = h(document, "span");
		twistie.className = ["ash-tree-twistie", this.twistieAdditionalCssClass?.(node)].filter(Boolean).join(" ");
		twistie.setAttribute("aria-hidden", "true");
		const twistieState = { collapsible: node.collapsible, expanded: node.collapsible && !node.collapsed };
		if (this.options.renderTwistie) this.options.renderTwistie(node, twistieState, twistie);
		else if (twistieState.collapsible) appendIcon(twistieState.expanded ? Lxicon.chevronDown : Lxicon.chevronRight, twistie);
		const contents = h(document, "span");
		contents.className = "ash-tree-contents";
		contents.append(this.options.renderElement(node));
		this.renderedElements.set(row, node.element);
		inner.append(indent, twistie, contents);
		return inner;
	}

	private updateRow(node: TNode, row: HTMLDivElement, rerender: boolean): void {
		const elementChanged = this.renderedElements.get(row) !== node.element;
		if (elementChanged) {
			this.options.onDidRemoveRow?.(row);
			const contents = row.querySelector<HTMLSpanElement>(":scope > .ash-tree-row-inner > .ash-tree-contents");
			contents?.replaceChildren(this.options.renderElement(node));
			this.renderedElements.set(row, node.element);
		}
		row.classList.toggle("collapsible", node.collapsible);
		row.classList.toggle("expanded", node.collapsible && !node.collapsed);
		row.classList.toggle("collapsed", node.collapsible && node.collapsed);
		row.classList.toggle("find-match", this.findController?.isMatch(node) ?? false);
		row.style.paddingLeft = treeRowPadding(node.depth);
		const twistie = row.querySelector<HTMLSpanElement>(":scope > .ash-tree-row-inner > .ash-tree-twistie");
		if (!twistie) return;
		twistie.className = ["ash-tree-twistie", this.twistieAdditionalCssClass?.(node)].filter(Boolean).join(" ");
		const expanded = node.collapsible && !node.collapsed;
		if (rerender || elementChanged || row.dataset.treeExpanded !== String(expanded) || row.dataset.treeCollapsible !== String(node.collapsible)) {
			twistie.replaceChildren();
			const state = { collapsible: node.collapsible, expanded };
			if (this.options.renderTwistie) this.options.renderTwistie(node, state, twistie);
			else if (state.collapsible) appendIcon(state.expanded ? Lxicon.chevronDown : Lxicon.chevronRight, twistie);
			row.dataset.treeExpanded = String(expanded);
			row.dataset.treeCollapsible = String(node.collapsible);
		}
		const indent = row.querySelector<HTMLSpanElement>(":scope > .ash-tree-row-inner > .ash-tree-indent");
		if (indent) this.renderIndentGuides(node, indent);
		row.dataset.treeDepth = String(node.depth);
	}

	private onListPointer(node: TNode, browserEvent: MouseEvent): void {
		const target = this.pointerTarget(browserEvent);
		const canToggle = browserEvent.button === 0 && (this.options.expandOnDoubleClick !== false || browserEvent.detail !== 2);
		if (target === "twistie") {
			if (canToggle) this.requestCollapseChange(node, browserEvent);
			return;
		}
		if (canToggle && (!this.expandOnlyOnTwistieClick(node) || browserEvent.detail === 2)) this.requestCollapseChange(node, browserEvent);
		const event = { element: node, target, browserEvent } as const;
		this._onPointer.fire(event);
		this._onDidActivate.fire({ element: node, browserEvent });
	}

	private onListDoubleClick(node: TNode, browserEvent: MouseEvent): void {
		const target = this.pointerTarget(browserEvent);
		if (target === "twistie") return;
		this._onDidDoubleClick.fire({ element: node, target, browserEvent });
	}

	private onKeyDown(event: KeyboardEvent): void {
		const node = this.list.activeItem;
		if (!node) return;
		if (event.key === "ArrowRight" && node.collapsible) {
			stopEvent(event);
			if (node.collapsed) this._onDidRequestCollapseChange.fire({ element: node, expanded: true, browserEvent: event });
			else if (node.children.length > 0) {
				const childIndex = this.list.activeIndex + 1;
				this.list.setActiveIndex(childIndex, event);
				this.list.setSelection([childIndex], event);
			}
			return;
		}
		if (event.key === "ArrowLeft") {
			if (node.collapsible && !node.collapsed) {
				stopEvent(event);
				this._onDidRequestCollapseChange.fire({ element: node, expanded: false, browserEvent: event });
			} else if (node.parent) {
				stopEvent(event);
				this.setFocus(node.parent.id, event);
				this.setSelection([node.parent.id], event);
			}
			return;
		}
		if (event.key !== "Enter" && event.key !== " ") return;
		stopEvent(event);
		this.list.setSelection([this.list.activeIndex], event);
		this._onDidAccept.fire({ element: node, browserEvent: event });
		this._onDidActivate.fire({ element: node, browserEvent: event });
	}

	private requestCollapseChange(node: TNode, browserEvent: MouseEvent): void {
		if (node.collapsible) this._onDidRequestCollapseChange.fire({ element: node, expanded: node.collapsed, browserEvent });
	}

	private expandOnlyOnTwistieClick(node: TNode): boolean {
		const value = this.options.expandOnlyOnTwistieClick;
		return typeof value === "function" ? value(node) : value ?? true;
	}

	private pointerTarget(event: MouseEvent): TreePointerTarget {
		if (!isNode(event.target) || event.target.nodeType !== 1) return "contents";
		return (event.target as Element).closest(".ash-tree-twistie") ? "twistie" : "contents";
	}

	private moveFind(delta: 1 | -1): TNode | undefined {
		const candidates = this.findController?.query ? this.findableNodes() : this.sourceItems;
		const match = this.findController?.next(candidates, delta);
		if (match) this.setFocus(match.id);
		this.emitFindResult();
		return match;
	}

	private findableNodes(): readonly TNode[] {
		if (!this.findCandidatesProvider) return this.sourceItems;
		return this.findCandidates ??= this.findCandidatesProvider();
	}

	private isExpanded(node: TNode): boolean { return !node.collapsed || (this.findController?.isExpandedByFilter(node) ?? false); }

	private emitFindResult(): void {
		if (!this.findController) return;
		this._onDidChangeFind.fire({ pattern: this.findController.query, matches: this.findController.matchedNodes, activeMatch: this.findController.activeMatch });
	}

	private asListDragAndDrop(dnd: TreeDragAndDrop<TNode>): ListDragAndDrop<TNode> {
		const mapData = (data: ListDragData<TNode>) => data;
		return {
			getDragURI: (element) => dnd.getDragURI(element),
			getDragLabel: dnd.getDragLabel ? (elements, event) => dnd.getDragLabel!(elements, event) : undefined,
			onDragStart: dnd.onDragStart ? (data, event) => dnd.onDragStart!(mapData(data), event) : undefined,
			onDragOver: (data, target, index, sector, event) => {
				let resolved = target;
				let reaction = dnd.onDragOver(mapData(data), resolved, index, sector, event);
				let normalized: TreeDragOverReaction = typeof reaction === "boolean" ? { accept: reaction } : reaction;
				while (normalized.bubble === "up" && resolved?.parent) {
					resolved = resolved.parent as TNode;
					reaction = dnd.onDragOver(mapData(data), resolved, this.items.indexOf(resolved), sector, event);
					normalized = typeof reaction === "boolean" ? { accept: reaction } : reaction;
				}
				this.scheduleAutoExpand(normalized.accept && normalized.autoExpand ? resolved : undefined, event);
				const feedback = normalized.bubble === "down" && resolved ? this.subtreeIndexes(resolved) : resolved ? [this.items.indexOf(resolved)] : [];
				return { accept: normalized.accept, effect: normalized.effect, position: normalized.position, feedback };
			},
			onDragLeave: (data, target, index, event) => {
				this.clearAutoExpand();
				dnd.onDragLeave?.(mapData(data), target, index, event);
			},
			drop: (data, target, index, sector, event) => {
				this.clearAutoExpand();
				dnd.drop(mapData(data), target, index, sector, event);
			},
			onDragEnd: (event) => {
				this.clearAutoExpand();
				dnd.onDragEnd?.(event);
			},
		};
	}

	private subtreeIndexes(node: TNode): readonly number[] {
		const start = this.items.indexOf(node);
		if (start < 0) return [];
		let end = start + 1;
		while (end < this.items.length && this.items[end]!.depth > node.depth) end += 1;
		return Array.from({ length: end - start }, (_, index) => start + index);
	}

	private scheduleAutoExpand(node: TNode | undefined, browserEvent: DragEvent): void {
		if (node?.id === this.autoExpandId) return;
		this.clearAutoExpand();
		if (!node?.collapsible || !node.collapsed) return;
		this.autoExpandId = node.id;
		const targetWindow = this.element.ownerDocument.defaultView;
		if (!targetWindow) return;
		this.autoExpandTimer.value = disposableWindowTimeout(targetWindow, () => {
			this.autoExpandTimer.clear();
			this.autoExpandId = undefined;
			this._onDidRequestCollapseChange.fire({ element: node, expanded: true, browserEvent });
		}, 500);
	}

	private clearAutoExpand(): void {
		this.autoExpandTimer.clear();
		this.autoExpandId = undefined;
	}

	private restoreStickyContainer(): void {
		if (this.stickyContainer && this.stickyContainer.parentElement !== this.element) this.element.append(this.stickyContainer);
	}

	private updateStickyScroll(): void {
		const container = this.stickyContainer;
		if (!container) return;
		container.style.transform = `translateY(${this.list.scrollTop}px)`;
		const firstIndex = this.list.indexAt(this.list.scrollTop);
		const first = this.items[firstIndex];
		const ancestors: TNode[] = [];
		let parent = first?.parent as TNode | undefined;
		while (parent) {
			if (this.items.includes(parent)) ancestors.unshift(parent);
			parent = parent.parent as TNode | undefined;
		}
		const max = Math.max(1, this.options.stickyScrollMaxItemCount ?? 7);
		const sticky = ancestors.slice(-max);
		const rows = sticky.flatMap((node) => {
			const index = this.items.indexOf(node);
			const row = this.list.row(index);
			if (!row) return [];
			const clone = row.cloneNode(true) as HTMLElement;
			clone.removeAttribute("id");
			clone.removeAttribute("role");
			clone.removeAttribute("aria-selected");
			clone.classList.add("ash-tree-sticky-row");
			clone.dataset.treeId = node.id;
			clone.style.height = `${this.list.getElementHeight(index)}px`;
			return [clone];
		});
		container.replaceChildren(...rows);
		container.classList.toggle("empty", rows.length === 0);
	}

	private onStickyClick(event: MouseEvent): void {
		if (!isNode(event.target) || event.target.nodeType !== 1) return;
		const row = (event.target as Element).closest<HTMLElement>(".ash-tree-sticky-row");
		const id = row?.dataset.treeId;
		if (!id) return;
		this.setFocus(id, event);
		this.setSelection([id], event);
	}
}

function validateIndent(indent: number | undefined): void {
	if (indent !== undefined && (!Number.isFinite(indent) || indent < 4 || indent > 40)) throw new RangeError("Tree indent must be between 4 and 40 pixels");
}

function treeRowPadding(level: number): string {
	return level === 1 ? "8px" : `calc(8px + ${Array.from({ length: level - 1 }, () => "var(--ash-tree-indent, 8px)").join(" + ")})`;
}

interface TreeFindControllerOptions<T, TNode extends AbstractTreeNode<T>> {
	readonly labelProvider: TreeKeyboardNavigationLabelProvider<T>;
	readonly mode: TreeFindMode;
	readonly matchType: TreeFindMatchType;
}

/** Pure find projection owned by AbstractTree. */
class TreeFindController<T, TNode extends AbstractTreeNode<T>> {
	private pattern = "";
	private matches: readonly TNode[] = [];
	private activeIndex = -1;

	constructor(private readonly options: TreeFindControllerOptions<T, TNode>) {}

	get query(): string { return this.pattern; }
	get activeMatch(): TNode | undefined { return this.matches[this.activeIndex]; }
	get matchedNodes(): readonly TNode[] { return this.matches; }
	get filtering(): boolean { return this.options.mode === "filter" && this.pattern.length > 0; }

	update(pattern: string, candidates: readonly TNode[], visibleNodes: readonly TNode[] = candidates): readonly TNode[] {
		const previousActive = this.activeMatch?.id;
		this.pattern = pattern;
		this.matches = pattern.length === 0 ? [] : candidates.filter((node) => this.matchesNode(node));
		const preservedIndex = previousActive === undefined ? -1 : this.matches.findIndex((node) => node.id === previousActive);
		this.activeIndex = preservedIndex >= 0 ? preservedIndex : this.matches.length > 0 ? 0 : -1;
		if (!this.filtering) return visibleNodes;
		const included = new Set<TNode>();
		for (const match of this.matches) {
			let node: AbstractTreeNode<T> | undefined = match;
			while (node) {
				included.add(node as TNode);
				node = node.parent;
			}
		}
		return candidates.filter((node) => included.has(node));
	}

	next(nodes: readonly TNode[], delta: 1 | -1): TNode | undefined {
		if (this.matches.length === 0) this.update(this.pattern, nodes);
		if (this.matches.length === 0) return undefined;
		this.activeIndex = rot(this.activeIndex + delta, this.matches.length);
		return this.activeMatch;
	}

	isMatch(node: TNode): boolean { return this.matches.includes(node); }
	isExpandedByFilter(node: TNode): boolean { return this.filtering && this.matches.some((match) => isDescendantOf(match, node)); }

	private matchesNode(node: TNode): boolean {
		const value = this.options.labelProvider.getKeyboardNavigationLabel(node.element);
		const labels = typeof value === "string" ? [value] : value ?? [];
		return labels.some((label) => this.options.matchType === "contiguous" ? label.toLocaleLowerCase().includes(this.pattern.toLocaleLowerCase()) : fuzzyMatch(this.pattern, label));
	}
}

function isDescendantOf<T, TNode extends AbstractTreeNode<T>>(candidate: TNode, ancestor: TNode): boolean {
	let parent = candidate.parent;
	while (parent) {
		if (parent === ancestor) return true;
		parent = parent.parent;
	}
	return false;
}

function fuzzyMatch(pattern: string, label: string): boolean {
	const needle = pattern.toLocaleLowerCase();
	const haystack = label.toLocaleLowerCase();
	let index = 0;
	for (const character of haystack) {
		if (character === needle[index]) index += 1;
		if (index === needle.length) return true;
	}
	return needle.length === 0;
}
