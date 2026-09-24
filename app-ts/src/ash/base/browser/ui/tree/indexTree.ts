import { Emitter, type Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import type { ListScrolling } from "../list/list.js";
import { AbstractTree } from "./abstractTree.js";
import { IndexTreeModel, type IndexTreeModelOptions, type IndexTreeNode } from "./indexTreeModel.js";
import { flattenTreeNodes, mapTreeDragData, type IndexTreeLocation, type TreeDragAndDrop, type TreeElement, type TreeFindMatchType, type TreeFindMode, type TreeIndentGuides, type TreeKeyboardNavigationLabelProvider, type TreePointerTarget, type TreeTwistieState } from "./tree.js";

export interface IndexTreeOptions<T> {
	readonly ariaLabel?: string;
	readonly scrolling?: ListScrolling;
	readonly indent?: number;
	readonly indentGuides?: TreeIndentGuides;
	readonly expandOnlyOnTwistieClick?: boolean | ((element: T) => boolean);
	readonly getHeight?: (element: T) => number;
	readonly dnd?: TreeDragAndDrop<T>;
	readonly keyboardNavigationLabelProvider?: TreeKeyboardNavigationLabelProvider<T>;
	readonly findMode?: TreeFindMode;
	readonly findMatchType?: TreeFindMatchType;
	readonly enableStickyScroll?: boolean;
	readonly stickyScrollMaxItemCount?: number;
	readonly modelOptions?: IndexTreeModelOptions<T>;
	readonly renderElement: (element: T, node: IndexTreeNode<T>) => HTMLElement;
	readonly renderTwistie?: (element: T, state: TreeTwistieState, container: HTMLSpanElement) => void;
}

export interface IndexTreePointerEvent<T> {
	readonly element: T;
	readonly node: IndexTreeNode<T>;
	readonly target: TreePointerTarget;
	readonly browserEvent: MouseEvent;
}

export interface IndexTreeAcceptEvent<T> {
	readonly element: T;
	readonly node: IndexTreeNode<T>;
	readonly browserEvent: KeyboardEvent;
}

export interface IndexTreeEvent<T> {
	readonly element: T | undefined;
	readonly node: IndexTreeNode<T> | undefined;
	readonly browserEvent: UIEvent | undefined;
}

export interface IndexTreeSelectionEvent<T> {
	readonly elements: readonly T[];
	readonly nodes: readonly IndexTreeNode<T>[];
	readonly browserEvent: UIEvent | undefined;
}

export interface IndexTreeCollapseStateChangeEvent<T> {
	readonly element: T;
	readonly node: IndexTreeNode<T>;
	readonly collapsed: boolean;
	readonly browserEvent: MouseEvent | KeyboardEvent | undefined;
}

/** Index-path tree widget backed directly by `IndexTreeModel.splice`. */
export class IndexTree<T> extends Disposable {
	readonly element: HTMLDivElement;
	readonly model: IndexTreeModel<T>;
	private readonly tree: AbstractTree<T, IndexTreeNode<T>>;
	private readonly _onPointer = this._register(new Emitter<IndexTreePointerEvent<T>>());
	private readonly _onDidDoubleClick = this._register(new Emitter<IndexTreePointerEvent<T>>());
	private readonly _onDidAccept = this._register(new Emitter<IndexTreeAcceptEvent<T>>());
	private readonly _onDidChangeFocus = this._register(new Emitter<IndexTreeEvent<T>>());
	private readonly _onDidChangeSelection = this._register(new Emitter<IndexTreeSelectionEvent<T>>());
	private readonly _onDidChangeCollapseState = this._register(new Emitter<IndexTreeCollapseStateChangeEvent<T>>());
	private collapseBrowserEvent: { readonly id: string; readonly event: MouseEvent | KeyboardEvent } | undefined;

	readonly onPointer: Event<IndexTreePointerEvent<T>> = this._onPointer.event;
	readonly onDidDoubleClick: Event<IndexTreePointerEvent<T>> = this._onDidDoubleClick.event;
	readonly onDidAccept: Event<IndexTreeAcceptEvent<T>> = this._onDidAccept.event;
	readonly onDidChangeFocus: Event<IndexTreeEvent<T>> = this._onDidChangeFocus.event;
	readonly onDidChangeSelection: Event<IndexTreeSelectionEvent<T>> = this._onDidChangeSelection.event;
	readonly onDidChangeCollapseState: Event<IndexTreeCollapseStateChangeEvent<T>> = this._onDidChangeCollapseState.event;

	constructor(container: HTMLElement, rootElement: T, options: IndexTreeOptions<T>) {
		super();
		const expandOnlyOnTwistieClick = options.expandOnlyOnTwistieClick;
		this.model = this._register(new IndexTreeModel(rootElement, options.modelOptions));
		this.tree = this._register(new AbstractTree(container, {
			ariaLabel: options.ariaLabel,
			scrolling: options.scrolling,
			indent: options.indent,
			indentGuides: options.indentGuides,
			expandOnlyOnTwistieClick: typeof expandOnlyOnTwistieClick === "function" ? (node) => expandOnlyOnTwistieClick(node.element) : expandOnlyOnTwistieClick,
			getHeight: options.getHeight ? (node) => options.getHeight!(node.element) : undefined,
			dnd: options.dnd ? mapDragAndDrop(options.dnd) : undefined,
			keyboardNavigationLabelProvider: options.keyboardNavigationLabelProvider,
			findMode: options.findMode,
			findMatchType: options.findMatchType,
			enableStickyScroll: options.enableStickyScroll,
			stickyScrollMaxItemCount: options.stickyScrollMaxItemCount,
			renderElement: (node) => options.renderElement(node.element, node),
			renderTwistie: options.renderTwistie ? (node, state, container) => options.renderTwistie!(node.element, state, container) : undefined,
		}));
		this.element = this.tree.element;
		this._register(this.model.onDidChange(() => this.render()));
		this._register(this.model.onDidChangeCollapseState(({ node, collapsed }) => {
			this._onDidChangeCollapseState.fire({ element: node.element, node, collapsed, browserEvent: this.collapseBrowserEvent?.id === node.id ? this.collapseBrowserEvent.event : undefined });
		}));
		this._register(this.tree.onPointer(({ element: node, target, browserEvent }) => this._onPointer.fire({ element: node.element, node, target, browserEvent })));
		this._register(this.tree.onDidDoubleClick(({ element: node, target, browserEvent }) => this._onDidDoubleClick.fire({ element: node.element, node, target, browserEvent })));
		this._register(this.tree.onDidAccept(({ element: node, browserEvent }) => this._onDidAccept.fire({ element: node.element, node, browserEvent })));
		this._register(this.tree.onDidChangeFocus(({ element: node, browserEvent }) => this._onDidChangeFocus.fire({ element: node?.element, node, browserEvent })));
		this._register(this.tree.onDidChangeSelection(({ elements: nodes, browserEvent }) => this._onDidChangeSelection.fire({ elements: nodes.map((node) => node.element), nodes, browserEvent })));
		this._register(this.tree.onDidRequestCollapseChange(({ element: node, expanded, browserEvent }) => {
			this.collapseBrowserEvent = { id: node.id, event: browserEvent };
			try {
				if (expanded) this.model.expand(node.location);
				else this.model.collapse(node.location);
			} finally {
				this.collapseBrowserEvent = undefined;
			}
		}));
		this.render();
	}

	splice(location: IndexTreeLocation, deleteCount: number, toInsert: readonly TreeElement<T>[] = []): void { this.model.splice(location, deleteCount, toInsert); }
	setChildren(children: readonly TreeElement<T>[]): void { this.model.setChildren(children); }
	collapse(location: IndexTreeLocation): boolean { return this.model.collapse(location); }
	expand(location: IndexTreeLocation): boolean { return this.model.expand(location); }
	toggleCollapsed(location: IndexTreeLocation): boolean { return this.model.toggleCollapsed(location); }
	expandTo(location: IndexTreeLocation): boolean { return this.model.expandTo(location); }
	get focus(): T | undefined { return this.tree.focus?.element; }
	get selection(): readonly T[] { return this.tree.selection.map((node) => node.element); }

	setFocus(location: IndexTreeLocation, browserEvent?: UIEvent): void {
		this.tree.setFocus(this.model.getNode(location).id, browserEvent);
	}

	setSelection(locations: readonly IndexTreeLocation[], browserEvent?: UIEvent): void {
		this.tree.setSelection(locations.map((location) => this.model.getNode(location).id), browserEvent);
	}

	setFindPattern(pattern: string): void { this.tree.setFindPattern(pattern); }
	findNext(): T | undefined { return this.tree.findNext()?.element; }
	findPrevious(): T | undefined { return this.tree.findPrevious()?.element; }
	clearFind(): void { this.tree.clearFind(); }
	updateElementHeight(location: IndexTreeLocation, height: number | undefined): void { this.tree.updateElementHeight(this.model.getNode(location).id, height); }

	private render(): void {
		this.tree.setFindCandidates(flattenTreeNodes(this.model.rootNodes));
		this.tree.items = this.model.visibleNodes;
	}
}

function mapDragAndDrop<T>(dnd: TreeDragAndDrop<T>): TreeDragAndDrop<IndexTreeNode<T>> {
	const elements = (nodes: readonly IndexTreeNode<T>[]) => nodes.map((node) => node.element);
	return {
		getDragURI: (node) => dnd.getDragURI(node.element),
		getDragLabel: dnd.getDragLabel ? (nodes, event) => dnd.getDragLabel!(elements(nodes), event) : undefined,
		onDragStart: dnd.onDragStart ? (data, event) => dnd.onDragStart!(mapTreeDragData(data, (node) => node.element), event) : undefined,
		onDragOver: (data, target, index, sector, event) => dnd.onDragOver(mapTreeDragData(data, (node) => node.element), target?.element, index, sector, event),
		onDragLeave: dnd.onDragLeave ? (data, target, index, event) => dnd.onDragLeave!(mapTreeDragData(data, (node) => node.element), target?.element, index, event) : undefined,
		drop: (data, target, index, sector, event) => dnd.drop(mapTreeDragData(data, (node) => node.element), target?.element, index, sector, event),
		onDragEnd: dnd.onDragEnd,
	};
}
