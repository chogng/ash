import { Emitter, type Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import type { ListScrolling } from "../list/list.js";
import { AbstractTree } from "./abstractTree.js";
import { CompressibleObjectTreeModel, type CompressibleObjectTreeModelOptions, type CompressibleTreeElement, type CompressedTreeNode } from "./compressedObjectTreeModel.js";
import { ObjectTreeModel, type ObjectTreeElement, type ObjectTreeModelOptions, type ObjectTreeNode } from "./objectTreeModel.js";
import { flattenTreeNodes, mapTreeDragData, type TreeDragAndDrop, type TreeFindMatchType, type TreeFindMode, type TreeFindResult, type TreeIndentGuides, type TreeKeyboardNavigationLabelProvider, type TreePointerTarget, type TreeSelectionPresentation, type TreeTwistieState } from "./tree.js";

export interface ObjectTreeOptions<TNode> {
	readonly ariaLabel?: string;
	readonly scrolling?: ListScrolling;
	readonly indent?: number;
	readonly indentGuides?: TreeIndentGuides;
	readonly expandOnlyOnTwistieClick?: boolean | ((element: TNode) => boolean);
	readonly getHeight?: (element: TNode) => number;
	readonly dnd?: TreeDragAndDrop<TNode>;
	readonly keyboardNavigationLabelProvider?: TreeKeyboardNavigationLabelProvider<TNode>;
	readonly findMode?: TreeFindMode;
	readonly findMatchType?: TreeFindMatchType;
	readonly selectionPresentation?: TreeSelectionPresentation;
	readonly enableStickyScroll?: boolean;
	readonly stickyScrollMaxItemCount?: number;
	readonly modelOptions: ObjectTreeModelOptions<TNode>;
	readonly onWillRender?: () => void;
	readonly renderElement: (element: TNode, node: ObjectTreeNode<TNode>) => HTMLElement;
	readonly renderTwistie?: (element: TNode, state: TreeTwistieState, container: HTMLSpanElement) => void;
}

export interface ObjectTreeActivateEvent<TNode> {
	readonly element: TNode;
	readonly node: ObjectTreeNode<TNode>;
	readonly browserEvent: MouseEvent | KeyboardEvent;
}

export interface ObjectTreePointerEvent<TNode> {
	readonly element: TNode;
	readonly node: ObjectTreeNode<TNode>;
	readonly target: TreePointerTarget;
	readonly browserEvent: MouseEvent;
}

export interface ObjectTreeAcceptEvent<TNode> {
	readonly element: TNode;
	readonly node: ObjectTreeNode<TNode>;
	readonly browserEvent: KeyboardEvent;
}

export interface ObjectTreeFocusChangeEvent<TNode> {
	readonly element: TNode | undefined;
	readonly node: ObjectTreeNode<TNode> | undefined;
	readonly browserEvent: UIEvent | undefined;
}

export interface ObjectTreeSelectionChangeEvent<TNode> {
	readonly elements: readonly TNode[];
	readonly nodes: readonly ObjectTreeNode<TNode>[];
	readonly browserEvent: UIEvent | undefined;
}

export interface ObjectTreeCollapseStateChangeEvent<TNode> {
	readonly element: TNode;
	readonly node: ObjectTreeNode<TNode>;
	readonly collapsed: boolean;
	readonly browserEvent: MouseEvent | KeyboardEvent | undefined;
}

export interface ObjectTreeFindResult<TNode> {
	readonly pattern: string;
	readonly matches: readonly TNode[];
	readonly activeMatch: TNode | undefined;
}

/** Model-driven accessible tree view for ordinary single-action rows. */
export class ObjectTree<TNode> extends Disposable {
	readonly element: HTMLDivElement;
	readonly model: ObjectTreeModel<TNode>;
	private readonly tree: AbstractTree<TNode, ObjectTreeNode<TNode>>;
	private readonly _onPointer = this._register(new Emitter<ObjectTreePointerEvent<TNode>>());
	private readonly _onDidDoubleClick = this._register(new Emitter<ObjectTreePointerEvent<TNode>>());
	private readonly _onDidAccept = this._register(new Emitter<ObjectTreeAcceptEvent<TNode>>());
	private readonly _onDidChangeFocus = this._register(new Emitter<ObjectTreeFocusChangeEvent<TNode>>());
	private readonly _onDidChangeSelection = this._register(new Emitter<ObjectTreeSelectionChangeEvent<TNode>>());
	private readonly _onDidChangeCollapseState = this._register(new Emitter<ObjectTreeCollapseStateChangeEvent<TNode>>());
	private readonly _onDidActivate = this._register(new Emitter<ObjectTreeActivateEvent<TNode>>());
	private readonly _onDidChangeFind = this._register(new Emitter<ObjectTreeFindResult<TNode>>());
	private readonly onWillRender: (() => void) | undefined;
	private collapseBrowserEvent: { readonly id: string; readonly event: MouseEvent | KeyboardEvent } | undefined;

	readonly onPointer: Event<ObjectTreePointerEvent<TNode>> = this._onPointer.event;
	readonly onDidDoubleClick: Event<ObjectTreePointerEvent<TNode>> = this._onDidDoubleClick.event;
	readonly onDidAccept: Event<ObjectTreeAcceptEvent<TNode>> = this._onDidAccept.event;
	readonly onDidChangeFocus: Event<ObjectTreeFocusChangeEvent<TNode>> = this._onDidChangeFocus.event;
	readonly onDidChangeSelection: Event<ObjectTreeSelectionChangeEvent<TNode>> = this._onDidChangeSelection.event;
	readonly onDidChangeCollapseState: Event<ObjectTreeCollapseStateChangeEvent<TNode>> = this._onDidChangeCollapseState.event;
	/** @deprecated Prefer the semantic pointer, accept, and collapse events. */
	readonly onDidActivate: Event<ObjectTreeActivateEvent<TNode>> = this._onDidActivate.event;
	readonly onDidChangeFind: Event<ObjectTreeFindResult<TNode>> = this._onDidChangeFind.event;

	constructor(container: HTMLElement, options: ObjectTreeOptions<TNode>) {
		super();
		const expandOnlyOnTwistieClick = options.expandOnlyOnTwistieClick;
		this.onWillRender = options.onWillRender;
		this.model = this._register(new ObjectTreeModel(options.modelOptions));
		this.tree = this._register(new AbstractTree(container, {
			ariaLabel: options.ariaLabel,
			scrolling: options.scrolling,
			indent: options.indent,
			indentGuides: options.indentGuides,
			expandOnlyOnTwistieClick: typeof expandOnlyOnTwistieClick === "function" ? (node) => expandOnlyOnTwistieClick(node.element) : expandOnlyOnTwistieClick,
			getHeight: options.getHeight ? (node) => options.getHeight!(node.element) : undefined,
			dnd: options.dnd ? mapDragAndDrop(options.dnd) : undefined,
			keyboardNavigationLabelProvider: options.keyboardNavigationLabelProvider ? { getKeyboardNavigationLabel: (element) => options.keyboardNavigationLabelProvider!.getKeyboardNavigationLabel(element) } : undefined,
			findMode: options.findMode,
			findMatchType: options.findMatchType,
			selectionPresentation: options.selectionPresentation,
			enableStickyScroll: options.enableStickyScroll,
			stickyScrollMaxItemCount: options.stickyScrollMaxItemCount,
			renderElement: (node) => options.renderElement(node.element, node),
			renderTwistie: options.renderTwistie
				? (node, state, container) => options.renderTwistie!(node.element, state, container)
				: undefined,
		}));
		this.element = this.tree.element;
		this._register(this.model.onDidChange(() => this.render()));
		this._register(this.model.onDidChangeCollapseState(({ node, collapsed }) => {
			this._onDidChangeCollapseState.fire({ element: node.element, node, collapsed, browserEvent: this.collapseBrowserEvent?.id === node.id ? this.collapseBrowserEvent.event : undefined });
		}));
		this._register(this.tree.onPointer(({ element: node, target, browserEvent }) => {
			this._onPointer.fire({ element: node.element, node, target, browserEvent });
		}));
		this._register(this.tree.onDidDoubleClick(({ element: node, target, browserEvent }) => {
			this._onDidDoubleClick.fire({ element: node.element, node, target, browserEvent });
		}));
		this._register(this.tree.onDidAccept(({ element: node, browserEvent }) => {
			this._onDidAccept.fire({ element: node.element, node, browserEvent });
		}));
		this._register(this.tree.onDidChangeFocus(({ element: node, browserEvent }) => {
			this._onDidChangeFocus.fire({ element: node?.element, node, browserEvent });
		}));
		this._register(this.tree.onDidChangeSelection(({ elements: nodes, browserEvent }) => {
			this._onDidChangeSelection.fire({ elements: nodes.map((node) => node.element), nodes, browserEvent });
		}));
		this._register(this.tree.onDidRequestCollapseChange(({ element: node, expanded, browserEvent }) => {
			this.collapseBrowserEvent = { id: node.id, event: browserEvent };
			try {
				if (expanded) this.model.expand(node.id);
				else this.model.collapse(node.id);
			} finally {
				this.collapseBrowserEvent = undefined;
			}
		}));
		this._register(this.tree.onDidActivate(({ element: node, browserEvent }) => {
			this._onDidActivate.fire({ element: node.element, node, browserEvent });
		}));
		this._register(this.tree.onDidChangeFind((event: TreeFindResult<ObjectTreeNode<TNode>>) => {
			this._onDidChangeFind.fire({ pattern: event.pattern, matches: event.matches.map((node) => node.element), activeMatch: event.activeMatch?.element });
		}));
		this.render();
	}

	setChildren(children: readonly ObjectTreeElement<TNode>[]): void {
		this.model.setChildren(children);
	}

	setNodeChildren(parentId: string, children: readonly ObjectTreeElement<TNode>[]): void {
		this.model.setNodeChildren(parentId, children);
	}

	collapse(id: string): boolean {
		return this.model.collapse(id);
	}

	expand(id: string): boolean {
		return this.model.expand(id);
	}

	toggleCollapsed(id: string): boolean {
		return this.model.toggleCollapsed(id);
	}

	collapseRecursive(id: string): boolean {
		return this.model.collapseRecursive(id);
	}

	expandRecursive(id: string): boolean {
		return this.model.expandRecursive(id);
	}

	expandTo(id: string): boolean {
		return this.model.expandTo(id);
	}

	get focus(): TNode | undefined {
		return this.tree.focus?.element;
	}

	get selection(): readonly TNode[] {
		return this.tree.selection.map((node) => node.element);
	}

	domFocus(): void { this.tree.domFocus(); }
	rerender(id?: string): void { this.model.rerender(id); }

	setFocus(id: string, browserEvent?: UIEvent): void {
		this.tree.setFocus(id, browserEvent);
	}

	setSelection(ids: readonly string[], browserEvent?: UIEvent): void {
		this.tree.setSelection(ids, browserEvent);
	}

	setFindPattern(pattern: string): void { this.tree.setFindPattern(pattern); }
	findNext(): TNode | undefined { return this.tree.findNext()?.element; }
	findPrevious(): TNode | undefined { return this.tree.findPrevious()?.element; }
	clearFind(): void { this.tree.clearFind(); }

	updateElementHeight(id: string, height: number | undefined): void { this.tree.updateElementHeight(id, height); }
	getElementTop(id: string): number | undefined { return this.tree.getElementTop(id); }

	private render(): void {
		this.onWillRender?.();
		this.tree.setFindCandidates(flattenTreeNodes(this.model.rootNodes));
		this.tree.items = this.model.visibleNodes;
	}
}

function mapDragAndDrop<T>(dnd: TreeDragAndDrop<T>): TreeDragAndDrop<ObjectTreeNode<T>> {
	const elements = (nodes: readonly ObjectTreeNode<T>[]) => nodes.map((node) => node.element);
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

export interface CompressibleKeyboardNavigationLabelProvider<T> {
	getKeyboardNavigationLabel(element: T): string | readonly string[] | undefined;
	getCompressedNodeKeyboardNavigationLabel(elements: readonly T[]): string | readonly string[] | undefined;
}

export interface CompressibleObjectTreeOptions<T> {
	readonly ariaLabel?: string;
	readonly scrolling?: ListScrolling;
	readonly indent?: number;
	readonly indentGuides?: TreeIndentGuides;
	readonly expandOnlyOnTwistieClick?: boolean | ((elements: readonly T[]) => boolean);
	readonly getHeight?: (elements: readonly T[]) => number;
	readonly dnd?: TreeDragAndDrop<T>;
	readonly keyboardNavigationLabelProvider?: CompressibleKeyboardNavigationLabelProvider<T>;
	readonly findMode?: TreeFindMode;
	readonly findMatchType?: TreeFindMatchType;
	readonly enableStickyScroll?: boolean;
	readonly stickyScrollMaxItemCount?: number;
	readonly modelOptions: CompressibleObjectTreeModelOptions<T>;
	readonly renderCompressedElements: (elements: readonly T[], node: ObjectTreeNode<CompressedTreeNode<T>>) => HTMLElement;
	readonly renderTwistie?: (elements: readonly T[], state: TreeTwistieState, container: HTMLSpanElement) => void;
}

export interface CompressibleTreePointerEvent<T> {
	readonly element: T;
	readonly elements: readonly T[];
	readonly node: ObjectTreeNode<CompressedTreeNode<T>>;
	readonly target: TreePointerTarget;
	readonly browserEvent: MouseEvent;
}

export interface CompressibleTreeAcceptEvent<T> {
	readonly element: T;
	readonly elements: readonly T[];
	readonly node: ObjectTreeNode<CompressedTreeNode<T>>;
	readonly browserEvent: KeyboardEvent;
}

export interface CompressibleTreeFocusChangeEvent<T> {
	readonly element: T | undefined;
	readonly elements: readonly T[];
	readonly browserEvent: UIEvent | undefined;
}

export interface CompressibleTreeSelectionChangeEvent<T> {
	readonly elements: readonly T[];
	readonly compressedElements: readonly (readonly T[])[];
	readonly browserEvent: UIEvent | undefined;
}

/** Object tree widget whose rows represent maximal compressible single-child chains. */
export class CompressibleObjectTree<T> extends Disposable {
	readonly element: HTMLDivElement;
	readonly model: CompressibleObjectTreeModel<T>;
	private readonly tree: AbstractTree<CompressedTreeNode<T>, ObjectTreeNode<CompressedTreeNode<T>>>;
	private readonly _onPointer = this._register(new Emitter<CompressibleTreePointerEvent<T>>());
	private readonly _onDidDoubleClick = this._register(new Emitter<CompressibleTreePointerEvent<T>>());
	private readonly _onDidAccept = this._register(new Emitter<CompressibleTreeAcceptEvent<T>>());
	private readonly _onDidChangeFocus = this._register(new Emitter<CompressibleTreeFocusChangeEvent<T>>());
	private readonly _onDidChangeSelection = this._register(new Emitter<CompressibleTreeSelectionChangeEvent<T>>());
	private readonly _onDidChangeCollapseState = this._register(new Emitter<{ readonly element: T; readonly elements: readonly T[]; readonly collapsed: boolean; readonly browserEvent: MouseEvent | KeyboardEvent | undefined }>());

	readonly onPointer: Event<CompressibleTreePointerEvent<T>> = this._onPointer.event;
	readonly onDidDoubleClick: Event<CompressibleTreePointerEvent<T>> = this._onDidDoubleClick.event;
	readonly onDidAccept: Event<CompressibleTreeAcceptEvent<T>> = this._onDidAccept.event;
	readonly onDidChangeFocus: Event<CompressibleTreeFocusChangeEvent<T>> = this._onDidChangeFocus.event;
	readonly onDidChangeSelection: Event<CompressibleTreeSelectionChangeEvent<T>> = this._onDidChangeSelection.event;
	readonly onDidChangeCollapseState: Event<{ readonly element: T; readonly elements: readonly T[]; readonly collapsed: boolean; readonly browserEvent: MouseEvent | KeyboardEvent | undefined }> = this._onDidChangeCollapseState.event;

	constructor(container: HTMLElement, private readonly options: CompressibleObjectTreeOptions<T>) {
		super();
		const expandOnlyOnTwistieClick = options.expandOnlyOnTwistieClick;
		this.model = this._register(new CompressibleObjectTreeModel(options.modelOptions));
		this.tree = this._register(new AbstractTree(container, {
			ariaLabel: options.ariaLabel,
			scrolling: options.scrolling,
			indent: options.indent,
			indentGuides: options.indentGuides,
			expandOnlyOnTwistieClick: typeof expandOnlyOnTwistieClick === "function" ? (node) => expandOnlyOnTwistieClick(node.element.elements) : expandOnlyOnTwistieClick,
			getHeight: options.getHeight ? (node) => options.getHeight!(node.element.elements) : undefined,
			dnd: options.dnd ? mapCompressedDragAndDrop(options.dnd) : undefined,
			keyboardNavigationLabelProvider: options.keyboardNavigationLabelProvider ? { getKeyboardNavigationLabel: (compressed) => options.keyboardNavigationLabelProvider!.getCompressedNodeKeyboardNavigationLabel(compressed.elements) } : undefined,
			findMode: options.findMode,
			findMatchType: options.findMatchType,
			enableStickyScroll: options.enableStickyScroll,
			stickyScrollMaxItemCount: options.stickyScrollMaxItemCount,
			renderElement: (node) => options.renderCompressedElements(node.element.elements, node),
			renderTwistie: options.renderTwistie ? (node, state, container) => options.renderTwistie!(node.element.elements, state, container) : undefined,
		}));
		this.element = this.tree.element;
		this._register(this.model.onDidChange(() => this.render()));
		this._register(this.model.onDidChangeCollapseState(({ node, collapsed }) => this._onDidChangeCollapseState.fire({ element: lastCompressedElement(node.element.elements), elements: node.element.elements, collapsed, browserEvent: undefined })));
		this._register(this.tree.onPointer(({ element: node, target, browserEvent }) => this._onPointer.fire({ element: lastCompressedElement(node.element.elements), elements: node.element.elements, node, target, browserEvent })));
		this._register(this.tree.onDidDoubleClick(({ element: node, target, browserEvent }) => this._onDidDoubleClick.fire({ element: lastCompressedElement(node.element.elements), elements: node.element.elements, node, target, browserEvent })));
		this._register(this.tree.onDidAccept(({ element: node, browserEvent }) => this._onDidAccept.fire({ element: lastCompressedElement(node.element.elements), elements: node.element.elements, node, browserEvent })));
		this._register(this.tree.onDidChangeFocus(({ element: node, browserEvent }) => this._onDidChangeFocus.fire({ element: node ? lastCompressedElement(node.element.elements) : undefined, elements: node?.element.elements ?? [], browserEvent })));
		this._register(this.tree.onDidChangeSelection(({ elements: nodes, browserEvent }) => this._onDidChangeSelection.fire({ elements: nodes.map((node) => lastCompressedElement(node.element.elements)), compressedElements: nodes.map((node) => node.element.elements), browserEvent })));
		this._register(this.tree.onDidRequestCollapseChange(({ element: node, expanded }) => {
			const element = lastCompressedElement(node.element.elements);
			if (expanded) this.model.expand(element);
			else this.model.collapse(element);
		}));
		this.render();
	}

	setChildren(children: readonly CompressibleTreeElement<T>[]): void { this.model.setChildren(children); }
	setNodeChildren(element: T, children: readonly CompressibleTreeElement<T>[]): void { this.model.setNodeChildren(element, children); }
	setCompressionEnabled(enabled: boolean): void { this.model.setCompressionEnabled(enabled); }
	getCompressedTreeNode(element: T): CompressedTreeNode<T> | undefined { return this.model.getCompressedNode(element); }
	collapse(element: T): boolean { return this.model.collapse(element); }
	expand(element: T): boolean { return this.model.expand(element); }
	expandTo(element: T): boolean { return this.model.expandTo(element); }
	setFindPattern(pattern: string): void { this.tree.setFindPattern(pattern); }
	findNext(): T | undefined { return this.tree.findNext()?.element.elements.at(-1); }
	findPrevious(): T | undefined { return this.tree.findPrevious()?.element.elements.at(-1); }
	clearFind(): void { this.tree.clearFind(); }
	get focus(): T | undefined { return this.tree.focus ? lastCompressedElement(this.tree.focus.element.elements) : undefined; }
	get selection(): readonly T[] { return this.tree.selection.map((node) => lastCompressedElement(node.element.elements)); }
	domFocus(): void { this.tree.domFocus(); }
	rerender(element?: T): void { this.model.rerender(element); }
	setFocus(element: T, browserEvent?: UIEvent): void {
		const node = this.model.getNode(element);
		if (node) this.tree.setFocus(node.id, browserEvent);
	}
	setSelection(elements: readonly T[], browserEvent?: UIEvent): void {
		const ids = [...new Set(elements.flatMap((element) => {
			const node = this.model.getNode(element);
			return node ? [node.id] : [];
		}))];
		this.tree.setSelection(ids, browserEvent);
	}
	updateElementHeight(element: T, height: number | undefined): void {
		const node = this.model.getNode(element);
		if (node) this.tree.updateElementHeight(node.id, height);
	}

	private render(): void {
		this.tree.setFindCandidates(flattenTreeNodes(this.model.rootNodes));
		this.tree.items = this.model.visibleNodes;
	}
}

function mapCompressedDragAndDrop<T>(dnd: TreeDragAndDrop<T>): TreeDragAndDrop<ObjectTreeNode<CompressedTreeNode<T>>> {
	const originals = (nodes: readonly ObjectTreeNode<CompressedTreeNode<T>>[]) => nodes.map((node) => lastCompressedElement(node.element.elements));
	return {
		getDragURI: (node) => dnd.getDragURI(lastCompressedElement(node.element.elements)),
		getDragLabel: dnd.getDragLabel ? (nodes, event) => dnd.getDragLabel!(originals(nodes), event) : undefined,
		onDragStart: dnd.onDragStart ? (data, event) => dnd.onDragStart!(mapTreeDragData(data, (node) => lastCompressedElement(node.element.elements)), event) : undefined,
		onDragOver: (data, target, index, sector, event) => dnd.onDragOver(mapTreeDragData(data, (node) => lastCompressedElement(node.element.elements)), target ? lastCompressedElement(target.element.elements) : undefined, index, sector, event),
		onDragLeave: dnd.onDragLeave ? (data, target, index, event) => dnd.onDragLeave!(mapTreeDragData(data, (node) => lastCompressedElement(node.element.elements)), target ? lastCompressedElement(target.element.elements) : undefined, index, event) : undefined,
		drop: (data, target, index, sector, event) => dnd.drop(mapTreeDragData(data, (node) => lastCompressedElement(node.element.elements)), target ? lastCompressedElement(target.element.elements) : undefined, index, sector, event),
		onDragEnd: dnd.onDragEnd,
	};
}

function lastCompressedElement<T>(elements: readonly T[]): T {
	const element = elements[elements.length - 1];
	if (element === undefined) throw new Error("Compressed tree nodes must contain at least one element");
	return element;
}
