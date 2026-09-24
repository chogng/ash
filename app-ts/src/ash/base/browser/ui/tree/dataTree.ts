import type { Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import type { ListScrolling } from "../list/list.js";
import { ObjectTree, type ObjectTreeAcceptEvent, type ObjectTreeCollapseStateChangeEvent, type ObjectTreeFocusChangeEvent, type ObjectTreePointerEvent, type ObjectTreeSelectionChangeEvent } from "./objectTree.js";
import type { ObjectTreeElement, ObjectTreeIdentityProvider, ObjectTreeNode } from "./objectTreeModel.js";
import type { TreeDataSource, TreeDragAndDrop, TreeFilter, TreeFindMatchType, TreeFindMode, TreeIndentGuides, TreeKeyboardNavigationLabelProvider, TreeSorter, TreeTwistieState } from "./tree.js";

export interface DataTreeOptions<T> {
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
	readonly identityProvider?: ObjectTreeIdentityProvider<T>;
	readonly sorter?: TreeSorter<T>;
	readonly filter?: TreeFilter<T>;
	readonly collapseByDefault?: (element: T) => boolean;
	readonly onWillRender?: () => void;
	readonly renderElement: (element: T, node: ObjectTreeNode<T>) => HTMLElement;
	readonly renderTwistie?: (element: T, state: TreeTwistieState, container: HTMLSpanElement) => void;
}

/** Synchronous data-source adapter over `ObjectTree`. */
export class DataTree<TInput, T> extends Disposable {
	readonly element: HTMLDivElement;
	private readonly tree: ObjectTree<T>;
	private readonly generatedIds = new Map<T, string>();
	private generatedId = 0;
	private input: TInput | undefined;

	readonly onPointer: Event<ObjectTreePointerEvent<T>>;
	readonly onDidDoubleClick: Event<ObjectTreePointerEvent<T>>;
	readonly onDidAccept: Event<ObjectTreeAcceptEvent<T>>;
	readonly onDidChangeFocus: Event<ObjectTreeFocusChangeEvent<T>>;
	readonly onDidChangeSelection: Event<ObjectTreeSelectionChangeEvent<T>>;
	readonly onDidChangeCollapseState: Event<ObjectTreeCollapseStateChangeEvent<T>>;

	constructor(container: HTMLElement, private readonly dataSource: TreeDataSource<TInput, T>, private readonly options: DataTreeOptions<T>) {
		super();
		this.tree = this._register(new ObjectTree<T>(container, {
			ariaLabel: options.ariaLabel,
			scrolling: options.scrolling,
			indent: options.indent,
			indentGuides: options.indentGuides,
			expandOnlyOnTwistieClick: options.expandOnlyOnTwistieClick,
			getHeight: options.getHeight,
			dnd: options.dnd,
			keyboardNavigationLabelProvider: options.keyboardNavigationLabelProvider,
			findMode: options.findMode,
			findMatchType: options.findMatchType,
			enableStickyScroll: options.enableStickyScroll,
			stickyScrollMaxItemCount: options.stickyScrollMaxItemCount,
			modelOptions: {
				identityProvider: { getId: (element) => this.getId(element) },
				sorter: options.sorter,
				filter: options.filter,
			},
			onWillRender: options.onWillRender,
			renderElement: options.renderElement,
			renderTwistie: options.renderTwistie,
		}));
		this.element = this.tree.element;
		this.onPointer = this.tree.onPointer;
		this.onDidDoubleClick = this.tree.onDidDoubleClick;
		this.onDidAccept = this.tree.onDidAccept;
		this.onDidChangeFocus = this.tree.onDidChangeFocus;
		this.onDidChangeSelection = this.tree.onDidChangeSelection;
		this.onDidChangeCollapseState = this.tree.onDidChangeCollapseState;
	}

	getInput(): TInput | undefined { return this.input; }

	setInput(input: TInput | undefined): void {
		this.input = input;
		this.tree.setChildren(input === undefined ? [] : this.createChildren(input, new Set()));
	}

	updateChildren(element: TInput | T = this.requireInput()): void {
		const children = this.createChildren(element, new Set());
		if (element === this.input) this.tree.setChildren(children);
		else this.tree.setNodeChildren(this.getId(element as T), children);
	}

	collapse(element: T): boolean { return this.tree.collapse(this.getId(element)); }
	expand(element: T): boolean { return this.tree.expand(this.getId(element)); }
	expandTo(element: T): boolean { return this.tree.expandTo(this.getId(element)); }
	get focus(): T | undefined { return this.tree.focus; }
	get selection(): readonly T[] { return this.tree.selection; }
	setFindPattern(pattern: string): void { this.tree.setFindPattern(pattern); }
	findNext(): T | undefined { return this.tree.findNext(); }
	findPrevious(): T | undefined { return this.tree.findPrevious(); }
	clearFind(): void { this.tree.clearFind(); }
	updateElementHeight(element: T, height: number | undefined): void { this.tree.updateElementHeight(this.getId(element), height); }

	private createChildren(parent: TInput | T, ancestry: Set<T>): readonly ObjectTreeElement<T>[] {
		return [...this.dataSource.getChildren(parent)].map((element) => {
			if (ancestry.has(element)) throw new Error(`DataTree cycle at ${this.getId(element)}`);
			const nextAncestry = new Set(ancestry).add(element);
			const hasChildren = this.dataSource.hasChildren?.(element);
			const children = hasChildren === false ? [] : this.createChildren(element, nextAncestry);
			return {
				element,
				children,
				collapsible: hasChildren ?? children.length > 0,
				collapsed: this.options.collapseByDefault?.(element),
			};
		});
	}

	private getId(element: T): string {
		const external = this.options.identityProvider?.getId(element);
		if (external !== undefined) return external;
		let id = this.generatedIds.get(element);
		if (!id) {
			id = `data-tree-node-${++this.generatedId}`;
			this.generatedIds.set(element, id);
		}
		return id;
	}

	private requireInput(): TInput {
		if (this.input === undefined) throw new Error("DataTree input is not set");
		return this.input;
	}
}
