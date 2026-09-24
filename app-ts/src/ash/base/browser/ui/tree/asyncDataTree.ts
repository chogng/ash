import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import type { ListScrolling } from "../list/list.js";
import { CompressibleObjectTree, ObjectTree, type CompressibleKeyboardNavigationLabelProvider, type CompressibleTreeAcceptEvent, type CompressibleTreeFocusChangeEvent, type CompressibleTreePointerEvent, type CompressibleTreeSelectionChangeEvent, type ObjectTreeAcceptEvent, type ObjectTreeCollapseStateChangeEvent, type ObjectTreeFocusChangeEvent, type ObjectTreePointerEvent, type ObjectTreeSelectionChangeEvent } from "./objectTree.js";
import type { CompressibleTreeElement, CompressedTreeNode } from "./compressedObjectTreeModel.js";
import type { ObjectTreeIdentityProvider, ObjectTreeNode } from "./objectTreeModel.js";
import type { AsyncTreeDataSource, TreeDragAndDrop, TreeFilter, TreeFindMatchType, TreeFindMode, TreeIndentGuides, TreeKeyboardNavigationLabelProvider, TreePointerTarget, TreeSorter, TreeTwistieState } from "./tree.js";

export interface AsyncTreeTwistieState extends TreeTwistieState {
	readonly loading: boolean;
}

interface AsyncDataTreeCommonOptions<T> {
	readonly ariaLabel?: string;
	readonly scrolling?: ListScrolling;
	readonly indent?: number;
	readonly indentGuides?: TreeIndentGuides;
	readonly identityProvider?: ObjectTreeIdentityProvider<T>;
	readonly sorter?: TreeSorter<T>;
	readonly filter?: TreeFilter<T>;
	readonly collapseByDefault?: (element: T) => boolean;
	readonly isIncompressible?: (element: T) => boolean;
	readonly onWillRender?: () => void;
	readonly findMode?: TreeFindMode;
	readonly findMatchType?: TreeFindMatchType;
	readonly enableStickyScroll?: boolean;
	readonly stickyScrollMaxItemCount?: number;
}

export interface AsyncDataTreeOptions<T> extends AsyncDataTreeCommonOptions<T> {
	readonly expandOnlyOnTwistieClick?: boolean | ((element: T) => boolean);
	readonly getHeight?: (element: T) => number;
	readonly dnd?: TreeDragAndDrop<T>;
	readonly keyboardNavigationLabelProvider?: TreeKeyboardNavigationLabelProvider<T>;
	readonly renderElement: (element: T, node: ObjectTreeNode<T>) => HTMLElement;
	readonly renderTwistie?: (element: T, state: AsyncTreeTwistieState, container: HTMLSpanElement) => void;
}

export interface CompressibleAsyncDataTreeOptions<T> extends AsyncDataTreeCommonOptions<T> {
	readonly identityProvider: ObjectTreeIdentityProvider<T>;
	readonly compressionEnabled?: boolean;
	readonly expandOnlyOnTwistieClick?: boolean | ((elements: readonly T[]) => boolean);
	readonly getHeight?: (elements: readonly T[]) => number;
	readonly dnd?: TreeDragAndDrop<T>;
	readonly keyboardNavigationLabelProvider?: CompressibleKeyboardNavigationLabelProvider<T>;
	readonly renderCompressedElements: (elements: readonly T[], node: ObjectTreeNode<CompressedTreeNode<T>>) => HTMLElement;
	readonly renderTwistie?: (elements: readonly T[], state: AsyncTreeTwistieState, container: HTMLSpanElement) => void;
}

export interface AsyncDataTreeLoadStateEvent<T> {
	readonly element: T | undefined;
	readonly loading: boolean;
}

export interface AsyncDataTreeErrorEvent<T> {
	readonly element: T | undefined;
	readonly error: unknown;
}

interface AsyncTreePointerEvent<T> {
	readonly element: T;
	readonly target: TreePointerTarget;
	readonly browserEvent: MouseEvent;
}

interface AsyncTreeAcceptEvent<T> {
	readonly element: T;
	readonly browserEvent: KeyboardEvent;
}

interface AsyncTreeFocusEvent<T> {
	readonly element: T | undefined;
	readonly browserEvent: UIEvent | undefined;
}

interface AsyncTreeSelectionEvent<T> {
	readonly elements: readonly T[];
	readonly browserEvent: UIEvent | undefined;
}

interface AsyncTreeCollapseEvent<T> {
	readonly element: T;
	readonly collapsed: boolean;
	readonly browserEvent: MouseEvent | KeyboardEvent | undefined;
}

interface AsyncTreeView<T> extends IDisposable {
	readonly element: HTMLDivElement;
	readonly onPointer: Event<AsyncTreePointerEvent<T>>;
	readonly onDidDoubleClick: Event<AsyncTreePointerEvent<T>>;
	readonly onDidAccept: Event<AsyncTreeAcceptEvent<T>>;
	readonly onDidChangeFocus: Event<AsyncTreeFocusEvent<T>>;
	readonly onDidChangeSelection: Event<AsyncTreeSelectionEvent<T>>;
	readonly onDidChangeCollapseState: Event<AsyncTreeCollapseEvent<T>>;
	readonly focus: T | undefined;
	readonly selection: readonly T[];
	domFocus(): void;
	setChildren(children: readonly CompressibleTreeElement<T>[]): void;
	collapse(element: T): boolean;
	expand(element: T): boolean;
	expandTo(element: T): boolean;
	rerender(element: T): void;
	setFindPattern(pattern: string): void;
	findNext(): T | undefined;
	findPrevious(): T | undefined;
	clearFind(): void;
	updateElementHeight(element: T, height: number | undefined): void;
	getCompressedTreeNode?(element: T): CompressedTreeNode<T> | undefined;
}

interface AsyncNodeState<T> {
	readonly id: string;
	readonly element: T;
	readonly parentId: string | undefined;
	readonly hasChildren: boolean;
	readonly children: readonly string[] | undefined;
}

/** Owns lazy data state and delegates its presentation to a factory-created tree. */
abstract class AbstractAsyncDataTree<TInput, T, TOptions extends AsyncDataTreeCommonOptions<T>> extends Disposable {
	readonly element: HTMLDivElement;
	protected readonly tree: AsyncTreeView<T>;
	private readonly generatedIds = new Map<T, string>();
	private readonly requests = new Map<string, number>();
	private readonly _onDidChangeLoadState = this._register(new Emitter<AsyncDataTreeLoadStateEvent<T>>());
	private readonly _onDidError = this._register(new Emitter<AsyncDataTreeErrorEvent<T>>());
	private states = new Map<string, AsyncNodeState<T>>();
	private rootChildren: readonly string[] = [];
	private input: TInput | undefined;
	private generatedId = 0;
	private requestSequence = 0;
	private generation = 0;

	readonly onDidChangeLoadState: Event<AsyncDataTreeLoadStateEvent<T>> = this._onDidChangeLoadState.event;
	readonly onDidError: Event<AsyncDataTreeErrorEvent<T>> = this._onDidError.event;

	constructor(protected readonly container: HTMLElement, protected readonly dataSource: AsyncTreeDataSource<TInput, T>, protected readonly options: TOptions) {
		super();
		this.tree = this._register(this.createTree(container, options));
		this.element = this.tree.element;
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
			const state = this.states.get(this.getId(element));
			if (!collapsed && state?.hasChildren && state.children === undefined) void this.updateChildren(element).catch(() => undefined);
		}));
		this._register(toDisposable(() => {
			this.generation += 1;
			this.requests.clear();
		}));
	}

	protected abstract createTree(container: HTMLElement, options: TOptions): AsyncTreeView<T>;

	getInput(): TInput | undefined { return this.input; }
	get focus(): T | undefined { return this.tree.focus; }
	get selection(): readonly T[] { return this.tree.selection; }
	domFocus(): void { this.tree.domFocus(); }
	setFindPattern(pattern: string): void { this.tree.setFindPattern(pattern); }
	findNext(): T | undefined { return this.tree.findNext(); }
	findPrevious(): T | undefined { return this.tree.findPrevious(); }
	clearFind(): void { this.tree.clearFind(); }
	updateElementHeight(element: T, height: number | undefined): void { this.tree.updateElementHeight(element, height); }
	collapse(element: T): boolean { return this.tree.collapse(element); }
	expand(element: T): boolean { return this.tree.expand(element); }
	expandTo(element: T): boolean { return this.tree.expandTo(element); }
	isLoading(element: T): boolean { return this.requests.has(this.getId(element)); }

	async setInput(input: TInput | undefined): Promise<void> {
		const generation = ++this.generation;
		this.input = input;
		this.states.clear();
		this.rootChildren = [];
		this.requests.clear();
		this.render();
		if (input !== undefined) await this.loadChildren(input, undefined, generation);
	}

	async updateChildren(element: TInput | T = this.requireInput()): Promise<void> {
		const parentId = element === this.input ? undefined : this.getId(element as T);
		if (parentId !== undefined && !this.states.has(parentId)) throw new RangeError(`Unknown AsyncDataTree element: ${parentId}`);
		await this.loadChildren(element, parentId, this.generation);
	}

	protected getId(element: T): string {
		const external = this.options.identityProvider?.getId(element);
		if (external !== undefined) return external;
		let id = this.generatedIds.get(element);
		if (!id) {
			id = `async-data-tree-node-${++this.generatedId}`;
			this.generatedIds.set(element, id);
		}
		return id;
	}

	private async loadChildren(parent: TInput | T, parentId: string | undefined, generation: number): Promise<void> {
		const requestKey = parentId ?? "__ash_async_tree_root__";
		const request = ++this.requestSequence;
		this.requests.set(requestKey, request);
		this._onDidChangeLoadState.fire({ element: parentId === undefined ? undefined : parent as T, loading: true });
		if (parentId !== undefined) this.tree.rerender(parent as T);
		try {
			const children = [...await this.dataSource.getChildren(parent)];
			if (!this.isCurrentRequest(requestKey, request, generation)) return;
			this.replaceChildren(parentId, children);
			this.render();
		} catch (error) {
			if (!this.isCurrentRequest(requestKey, request, generation)) return;
			this._onDidError.fire({ element: parentId === undefined ? undefined : parent as T, error });
			throw error;
		} finally {
			if (this.isCurrentRequest(requestKey, request, generation)) {
				this.requests.delete(requestKey);
				if (parentId !== undefined) this.tree.rerender(parent as T);
				this._onDidChangeLoadState.fire({ element: parentId === undefined ? undefined : parent as T, loading: false });
			}
		}
	}

	private replaceChildren(parentId: string | undefined, elements: readonly T[]): void {
		const nextStates = new Map(this.states);
		const oldChildren = parentId === undefined ? this.rootChildren : nextStates.get(parentId)?.children ?? [];
		for (const id of oldChildren) removeStateSubtree(id, nextStates);
		const childIds: string[] = [];
		for (const element of elements) {
			const id = this.getId(element);
			if (childIds.includes(id) || nextStates.has(id)) throw new Error(`Duplicate tree node ID: ${id}`);
			childIds.push(id);
			nextStates.set(id, { id, element, parentId, hasChildren: this.dataSource.hasChildren(element), children: undefined });
		}
		if (parentId === undefined) this.rootChildren = childIds;
		else {
			const parent = nextStates.get(parentId);
			if (!parent) throw new RangeError(`Unknown AsyncDataTree parent: ${parentId}`);
			nextStates.set(parentId, { ...parent, children: childIds });
		}
		this.states = nextStates;
	}

	private render(): void { this.tree.setChildren(this.rootChildren.map((id) => this.toTreeElement(id))); }

	private toTreeElement(id: string): CompressibleTreeElement<T> {
		const state = this.states.get(id);
		if (!state) throw new RangeError(`Unknown AsyncDataTree state: ${id}`);
		return {
			element: state.element,
			collapsible: state.hasChildren,
			collapsed: this.options.collapseByDefault?.(state.element),
			incompressible: this.options.isIncompressible?.(state.element),
			children: state.children?.map((childId) => this.toTreeElement(childId)),
		};
	}

	private isCurrentRequest(key: string, request: number, generation: number): boolean { return !this.isDisposed && generation === this.generation && this.requests.get(key) === request; }
	private requireInput(): TInput {
		if (this.input === undefined) throw new Error("AsyncDataTree input is not set");
		return this.input;
	}
}

/** Lazy, race-safe data-source adapter over ObjectTree. */
export class AsyncDataTree<TInput, T> extends AbstractAsyncDataTree<TInput, T, AsyncDataTreeOptions<T>> {
	get onPointer(): Event<ObjectTreePointerEvent<T>> { return this.tree.onPointer as Event<ObjectTreePointerEvent<T>>; }
	get onDidDoubleClick(): Event<ObjectTreePointerEvent<T>> { return this.tree.onDidDoubleClick as Event<ObjectTreePointerEvent<T>>; }
	get onDidAccept(): Event<ObjectTreeAcceptEvent<T>> { return this.tree.onDidAccept as Event<ObjectTreeAcceptEvent<T>>; }
	get onDidChangeFocus(): Event<ObjectTreeFocusChangeEvent<T>> { return this.tree.onDidChangeFocus as Event<ObjectTreeFocusChangeEvent<T>>; }
	get onDidChangeSelection(): Event<ObjectTreeSelectionChangeEvent<T>> { return this.tree.onDidChangeSelection as Event<ObjectTreeSelectionChangeEvent<T>>; }
	get onDidChangeCollapseState(): Event<ObjectTreeCollapseStateChangeEvent<T>> { return this.tree.onDidChangeCollapseState as Event<ObjectTreeCollapseStateChangeEvent<T>>; }

	protected createTree(container: HTMLElement, options: AsyncDataTreeOptions<T>): AsyncTreeView<T> {
		const tree = new ObjectTree<T>(container, {
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
			modelOptions: { defaultCollapseState: "collapsed", identityProvider: { getId: (element) => this.getId(element) }, sorter: options.sorter, filter: options.filter },
			onWillRender: options.onWillRender,
			renderElement: options.renderElement,
			renderTwistie: options.renderTwistie
				? (element, state, container) => options.renderTwistie!(element, { ...state, loading: this.isLoading(element) }, container)
				: undefined,
		});
		return objectTreeView(tree, (element) => this.getId(element));
	}
}

/** AsyncDataTree whose factory selects the canonical CompressibleObjectTree. */
export class CompressibleAsyncDataTree<TInput, T> extends AbstractAsyncDataTree<TInput, T, CompressibleAsyncDataTreeOptions<T>> {
	get onPointer(): Event<CompressibleTreePointerEvent<T>> { return this.tree.onPointer as Event<CompressibleTreePointerEvent<T>>; }
	get onDidDoubleClick(): Event<CompressibleTreePointerEvent<T>> { return this.tree.onDidDoubleClick as Event<CompressibleTreePointerEvent<T>>; }
	get onDidAccept(): Event<CompressibleTreeAcceptEvent<T>> { return this.tree.onDidAccept as Event<CompressibleTreeAcceptEvent<T>>; }
	get onDidChangeFocus(): Event<CompressibleTreeFocusChangeEvent<T>> { return this.tree.onDidChangeFocus as Event<CompressibleTreeFocusChangeEvent<T>>; }
	get onDidChangeSelection(): Event<CompressibleTreeSelectionChangeEvent<T>> { return this.tree.onDidChangeSelection as Event<CompressibleTreeSelectionChangeEvent<T>>; }
	get onDidChangeCollapseState(): Event<{ readonly element: T; readonly elements: readonly T[]; readonly collapsed: boolean; readonly browserEvent: MouseEvent | KeyboardEvent | undefined }> { return this.tree.onDidChangeCollapseState as Event<{ readonly element: T; readonly elements: readonly T[]; readonly collapsed: boolean; readonly browserEvent: MouseEvent | KeyboardEvent | undefined }>; }

	getCompressedTreeNode(element: T): CompressedTreeNode<T> | undefined { return this.tree.getCompressedTreeNode?.(element); }

	protected createTree(container: HTMLElement, options: CompressibleAsyncDataTreeOptions<T>): AsyncTreeView<T> {
		const tree = new CompressibleObjectTree<T>(container, {
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
			modelOptions: { defaultCollapseState: "collapsed", identityProvider: { getId: (element) => this.getId(element) }, sorter: options.sorter, filter: options.filter, compressionEnabled: options.compressionEnabled },
			renderCompressedElements: options.renderCompressedElements,
			renderTwistie: options.renderTwistie
				? (elements, state, container) => options.renderTwistie!(elements, { ...state, loading: this.isLoading(last(elements)) }, container)
				: undefined,
		});
		return compressibleTreeView(tree);
	}
}

function objectTreeView<T>(tree: ObjectTree<T>, getId: (element: T) => string): AsyncTreeView<T> {
	return {
		element: tree.element,
		onPointer: tree.onPointer,
		onDidDoubleClick: tree.onDidDoubleClick,
		onDidAccept: tree.onDidAccept,
		onDidChangeFocus: tree.onDidChangeFocus,
		onDidChangeSelection: tree.onDidChangeSelection,
		onDidChangeCollapseState: tree.onDidChangeCollapseState,
		get focus() { return tree.focus; },
		get selection() { return tree.selection; },
		domFocus: () => tree.domFocus(),
		setChildren: (children) => tree.setChildren(children),
		collapse: (element) => tree.collapse(getId(element)),
		expand: (element) => tree.expand(getId(element)),
		expandTo: (element) => tree.expandTo(getId(element)),
		rerender: (element) => { if (tree.model.has(getId(element))) tree.rerender(getId(element)); },
		setFindPattern: (pattern) => tree.setFindPattern(pattern),
		findNext: () => tree.findNext(),
		findPrevious: () => tree.findPrevious(),
		clearFind: () => tree.clearFind(),
		updateElementHeight: (element, height) => tree.updateElementHeight(getId(element), height),
		dispose: () => tree.dispose(),
		[Symbol.dispose]: () => tree.dispose(),
	};
}

function compressibleTreeView<T>(tree: CompressibleObjectTree<T>): AsyncTreeView<T> {
	return {
		element: tree.element,
		onPointer: tree.onPointer,
		onDidDoubleClick: tree.onDidDoubleClick,
		onDidAccept: tree.onDidAccept,
		onDidChangeFocus: tree.onDidChangeFocus,
		onDidChangeSelection: tree.onDidChangeSelection,
		onDidChangeCollapseState: tree.onDidChangeCollapseState,
		get focus() { return tree.focus; },
		get selection() { return tree.selection; },
		domFocus: () => tree.domFocus(),
		setChildren: (children) => tree.setChildren(children),
		collapse: (element) => tree.collapse(element),
		expand: (element) => tree.expand(element),
		expandTo: (element) => tree.expandTo(element),
		rerender: (element) => { if (tree.model.getNode(element)) tree.rerender(element); },
		setFindPattern: (pattern) => tree.setFindPattern(pattern),
		findNext: () => tree.findNext(),
		findPrevious: () => tree.findPrevious(),
		clearFind: () => tree.clearFind(),
		updateElementHeight: (element, height) => tree.updateElementHeight(element, height),
		getCompressedTreeNode: (element) => tree.getCompressedTreeNode(element),
		dispose: () => tree.dispose(),
		[Symbol.dispose]: () => tree.dispose(),
	};
}

function removeStateSubtree<T>(id: string, states: Map<string, AsyncNodeState<T>>): void {
	const state = states.get(id);
	if (!state) return;
	for (const child of state.children ?? []) removeStateSubtree(child, states);
	states.delete(id);
}

function last<T>(elements: readonly T[]): T {
	const element = elements[elements.length - 1];
	if (element === undefined) throw new Error("Compressed tree nodes must contain at least one element");
	return element;
}
