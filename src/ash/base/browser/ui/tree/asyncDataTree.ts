import { Emitter, type Event } from "../../../common/event.js";
import { TaskQueue } from "../../../common/async.js";
import { Disposable, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import type { ListScrolling } from "../list/list.js";
import { CompressibleObjectTree, ObjectTree, type CompressibleKeyboardNavigationLabelProvider, type CompressibleTreeAcceptEvent, type CompressibleTreeFocusChangeEvent, type CompressibleTreePointerEvent, type CompressibleTreeSelectionChangeEvent, type ObjectTreeAcceptEvent, type ObjectTreeCollapseStateChangeEvent, type ObjectTreeFocusChangeEvent, type ObjectTreePointerEvent, type ObjectTreeSelectionChangeEvent } from "./objectTree.js";
import type { CompressibleTreeElement, CompressedTreeNode } from "./compressedObjectTreeModel.js";
import type { ObjectTreeIdentityProvider, ObjectTreeNode } from "./objectTreeModel.js";
import type { AsyncTreeDataSource, TreeDragAndDrop, TreeElement, TreeFilter, TreeFindMatchType, TreeFindMode, TreeIndentGuides, TreeKeyboardNavigationLabelProvider, TreePointerTarget, TreeSorter, TreeTwistieState } from "./tree.js";

export interface AsyncTreeTwistieState extends TreeTwistieState {
	readonly loading: boolean;
}

interface AsyncDataTreeCommonOptions<T> {
	readonly ariaLabel?: string;
	readonly multipleSelectionSupport?: boolean;
	readonly scrolling?: ListScrolling;
	readonly smoothScrolling?: boolean;
	readonly indent?: number;
	readonly indentGuides?: TreeIndentGuides;
	readonly twistieAdditionalCssClass?: (element: T) => string | undefined;
	readonly expandOnDoubleClick?: boolean;
	readonly identityProvider?: ObjectTreeIdentityProvider<T>;
	readonly sorter?: TreeSorter<T>;
	readonly filter?: TreeFilter<T>;
	readonly collapseByDefault?: (element: T) => boolean;
	readonly isIncompressible?: (element: T) => boolean;
	readonly onWillRender?: () => void;
	readonly reuseRows?: boolean;
	readonly onDidRemoveRow?: (row: HTMLDivElement) => void;
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
	readonly error?: unknown;
}

export interface AsyncDataTreeErrorEvent<T> {
	readonly element: T | undefined;
	readonly error: unknown;
}

export interface AsyncDataTreeUpdateOptions {
	readonly recursive?: boolean;
	/** Invalidate folded branches without reading them until their next expansion. */
	readonly deferIfCollapsed?: boolean;
}

export interface IAsyncDataTreeViewState {
	readonly focus?: string[];
	readonly selection?: string[];
	readonly expanded?: string[];
	readonly scrollTop?: number;
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
	updateOptions(options: Pick<AsyncDataTreeCommonOptions<T>, "indent" | "indentGuides" | "twistieAdditionalCssClass" | "smoothScrolling"> & { readonly compressionEnabled?: boolean; }): void;
	readonly element: HTMLDivElement;
	readonly domNode: HTMLDivElement;
	readonly onPointer: Event<AsyncTreePointerEvent<T>>;
	readonly onDidDoubleClick: Event<AsyncTreePointerEvent<T>>;
	readonly onDidAccept: Event<AsyncTreeAcceptEvent<T>>;
	readonly onDidChangeFocus: Event<AsyncTreeFocusEvent<T>>;
	readonly onDidChangeSelection: Event<AsyncTreeSelectionEvent<T>>;
	readonly onDidChangeCollapseState: Event<AsyncTreeCollapseEvent<T>>;
	readonly focus: T | undefined;
	readonly selection: readonly T[];
	scrollTop: number;
	reveal(element: T, relativeTop?: number): void;
	getRelativeTop(element: T): number | null;
	setFocus(element: T, browserEvent?: UIEvent): void;
	setSelection(elements: readonly T[], browserEvent?: UIEvent): void;
	getVisibleElements(): readonly T[];
	domFocus(): void;
	setChildren(children: readonly CompressibleTreeElement<T>[]): void;
	setNodeChildren(element: T, children: readonly CompressibleTreeElement<T>[]): void;
	collapse(element: T): boolean;
	expand(element: T): boolean;
	expandTo(element: T): boolean;
	isCollapsed(element: T): boolean | undefined;
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

interface AsyncTreeRequest {
	readonly generation: number;
	readonly promise: Promise<void>;
}

/** Owns lazy data state and delegates its presentation to a factory-created tree. */
abstract class AbstractAsyncDataTree<TInput, T, TOptions extends AsyncDataTreeCommonOptions<T>> extends Disposable {
	readonly element: HTMLDivElement;
	readonly domNode: HTMLDivElement;
	protected readonly tree: AsyncTreeView<T>;
	private readonly generatedIds = new Map<T, string>();
	private readonly requests = new Map<string | undefined, AsyncTreeRequest>();
	// Bound data-source reads across compression probes and recursive refreshes.
	// Only the read holds a slot; waiting for descendants must never hold it.
	private readonly childReads = Array.from({ length: 8 }, () => new TaskQueue());
	private nextChildRead = 0;
	private readonly _onDidChangeLoadState = this._register(new Emitter<AsyncDataTreeLoadStateEvent<T>>());
	private readonly _onDidError = this._register(new Emitter<AsyncDataTreeErrorEvent<T>>());
	private readonly states = new Map<string, AsyncNodeState<T>>();
	private rootChildren: readonly string[] = [];
	private input: TInput | undefined;
	private generatedId = 0;
	private generation = 0;
	private compressionEnabled: boolean | undefined;

	readonly onDidChangeLoadState: Event<AsyncDataTreeLoadStateEvent<T>> = this._onDidChangeLoadState.event;
	readonly onDidError: Event<AsyncDataTreeErrorEvent<T>> = this._onDidError.event;

	constructor(protected readonly container: HTMLElement, protected readonly dataSource: AsyncTreeDataSource<TInput, T>, protected readonly options: TOptions) {
		super();
		this.compressionEnabled = 'renderCompressedElements' in options ? (options as unknown as CompressibleAsyncDataTreeOptions<T>).compressionEnabled !== false : undefined;
		this.tree = this._register(this.createTree(container, options));
		this.element = this.tree.element;
		this.domNode = this.tree.domNode;
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
			const state = this.states.get(this.getId(element));
			if (!collapsed && state?.hasChildren && state.children === undefined && !this.isLoading(element)) void this.updateChildren(element).catch(() => undefined);
		}));
		this._register(toDisposable(() => {
			this.generation += 1;
			this.requests.clear();
			for (const queue of this.childReads) queue.clearPending();
		}));
	}

	protected abstract createTree(container: HTMLElement, options: TOptions): AsyncTreeView<T>;

	getInput(): TInput | undefined { return this.input; }
	public updateOptions(options: Pick<AsyncDataTreeCommonOptions<T>, "indent" | "indentGuides" | "twistieAdditionalCssClass" | "smoothScrolling"> & { readonly compressionEnabled?: boolean; }): void {
		const state = this.getViewState();
		if (options.compressionEnabled !== undefined) this.compressionEnabled = options.compressionEnabled;
		this.tree.updateOptions(options);
		if (options.compressionEnabled !== undefined) {
			this.restoreLoadedState(state);
		}
	}
	get focus(): T | undefined { return this.tree.focus; }
	get selection(): readonly T[] { return this.tree.selection; }
	get scrollTop(): number { return this.tree.scrollTop; }
	set scrollTop(top: number) { this.tree.scrollTop = top; }
	reveal(element: T, relativeTop?: number): void { this.tree.reveal(element, relativeTop); }
	getRelativeTop(element: T): number | null { return this.tree.getRelativeTop(element); }
	isCollapsed(element: T): boolean | undefined { return this.tree.isCollapsed(element); }
	getViewState(): IAsyncDataTreeViewState {
		return {
			focus: this.focus ? [this.getId(this.focus)] : [],
			selection: this.selection.map(element => this.getId(element)),
			expanded: [...this.states.values()].filter(state => state.hasChildren && this.tree.isCollapsed(state.element) === false).map(state => state.id),
			scrollTop: this.scrollTop,
		};
	}
	getVisibleElements(): readonly T[] { return this.tree.getVisibleElements(); }
	/** Reads cached children, including folded branches, without expanding or loading them. */
	public getNode(element: TInput | T = this.requireInput()): TreeElement<TInput | T> {
		if (element === this.input) return { element, children: this.rootChildren.map(id => this.toTreeElement(id)) };
		return this.toTreeElement(this.getId(element as T));
	}
	setFocus(element: T, browserEvent?: UIEvent): void { this.tree.setFocus(element, browserEvent); }
	setSelection(elements: readonly T[], browserEvent?: UIEvent): void { this.tree.setSelection(elements, browserEvent); }
	domFocus(): void { this.tree.domFocus(); }
	setFindPattern(pattern: string): void { this.tree.setFindPattern(pattern); }
	findNext(): T | undefined { return this.tree.findNext(); }
	findPrevious(): T | undefined { return this.tree.findPrevious(); }
	clearFind(): void { this.tree.clearFind(); }
	updateElementHeight(element: T, height: number | undefined): void { this.tree.updateElementHeight(element, height); }
	collapse(element: T): boolean { return this.tree.collapse(element); }
	public collapseAll(): void {
		for (const { element } of this.states.values()) {
			if (this.tree.isCollapsed(element) === false) {
				this.tree.collapse(element);
			}
		}
	}
	async expand(element: T): Promise<boolean> {
		const expanded = this.tree.expand(element);
		// Expansion starts a read only for unresolved children; callers must await that read before navigating them.
		await this.requests.get(this.getId(element))?.promise;
		return expanded;
	}
	expandTo(element: T): boolean { return this.tree.expandTo(element); }
	isLoading(element: T): boolean { return this.requests.has(element === this.input ? undefined : this.getId(element)); }

	async setInput(input: TInput | undefined, viewState?: IAsyncDataTreeViewState): Promise<void> {
		const generation = ++this.generation;
		this.input = input;
		this.states.clear();
		this.rootChildren = [];
		this.requests.clear();
		for (const queue of this.childReads) queue.clearPending();
		this.updateAriaBusy();
		this.render();
		if (input !== undefined) await this.loadChildren(input, undefined, generation);
		if (!viewState || generation !== this.generation || this.isDisposed) return;
		const pending = new Set(viewState.expanded);
		while (pending.size && generation === this.generation && !this.isDisposed) {
			const branches = [...this.states.values()].filter(state => pending.has(state.id));
			if (!branches.length) break;
			for (const branch of branches) {
				pending.delete(branch.id);
				if (branch.hasChildren) await this.expand(branch.element);
			}
		}
		if (generation !== this.generation || this.isDisposed) return;
		const focused = viewState.focus?.[0];
		if (focused && this.states.has(focused)) this.setFocus(this.states.get(focused)!.element);
		this.setSelection((viewState.selection ?? []).flatMap(id => this.states.has(id) ? [this.states.get(id)!.element] : []));
		if (viewState.scrollTop !== undefined) this.scrollTop = viewState.scrollTop;
	}

	async updateChildren(element: TInput | T = this.requireInput(), options: AsyncDataTreeUpdateOptions = {}): Promise<void> {
		const parentId = element === this.input ? undefined : this.getId(element as T);
		if (parentId !== undefined && !this.states.has(parentId)) throw new RangeError(`Unknown AsyncDataTree element: ${parentId}`);
		if (options.deferIfCollapsed && parentId !== undefined && this.canDeferChildren(element as T)) {
			this.invalidateChildren(parentId);
			return;
		}
		const generation = this.generation;
		const current = this.requests.get(parentId);
		if (options.deferIfCollapsed && current) {
			// A change arriving during a read must be resolved after that read, not lost to request coalescing.
			await current.promise.catch(() => undefined);
			if (this.isDisposed || generation !== this.generation || parentId !== undefined && !this.states.has(parentId)) return;
			if (parentId !== undefined && this.canDeferChildren(element as T)) {
				this.invalidateChildren(parentId);
				return;
			}
		}
		await this.loadChildren(element, parentId, this.generation, { ...options, recursive: options.recursive !== false });
	}

	private canDeferChildren(element: T): boolean {
		if (this.tree.isCollapsed(element) !== true) return false;
		const chain = this.compressionEnabled ? this.tree.getCompressedTreeNode?.(element) : undefined;
		// Interior segments define the visible compact label. Only the final segment's
		// children are hidden and can be discarded without shortening that label.
		return !chain || this.getId(chain.elements.at(-1)!) === this.getId(element);
	}

	private invalidateChildren(parentId: string): void {
		const state = this.states.get(parentId);
		if (!state) return;
		for (const id of state.children ?? []) this.removeStateSubtree(id);
		this.states.set(parentId, { ...state, children: undefined });
		// Obsolete reads may finish, but cannot repopulate a branch that was invalidated while folded.
		this.requests.delete(parentId);
		this.tree.setNodeChildren(state.element, []);
		this.updateAriaBusy();
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

	private async loadChildren(parent: TInput | T, parentId: string | undefined, generation: number, options: AsyncDataTreeUpdateOptions = {}): Promise<void> {
		const requestKey = parentId;
		const current = this.requests.get(requestKey);
		if (current?.generation === generation) return current.promise;
		let start: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { start = resolve; });
		let request: AsyncTreeRequest;
		const promise = gate
			.then(() => this.readChildren(parent, () => this.isCurrentRequest(requestKey, request)))
			.then(async children => {
				if (!this.isCurrentRequest(requestKey, request)) return;
				this.replaceChildren(parentId, [...children]);
				const resolvedCompact = new Set<string>();
				if (this.compressionEnabled && this.options.isIncompressible) {
					const ids = parentId === undefined ? this.rootChildren : this.states.get(parentId)!.children!;
					await Promise.all(ids.map(id => this.resolveCompactChain(id, generation, resolvedCompact, options.deferIfCollapsed)));
					if (!this.isCurrentRequest(requestKey, request)) return;
				}
				const viewState = this.getViewState();
				if (parentId === undefined) this.render();
				else this.tree.setNodeChildren(parent as T, this.states.get(parentId)!.children!.map(id => this.toTreeElement(id)));
				this.restoreLoadedState(viewState);
				if (!options.recursive) return;
				const childIds = parentId === undefined ? this.rootChildren : this.states.get(parentId)?.children ?? [];
				const refreshLoaded = async (ids: readonly string[]): Promise<void> => {
					await Promise.all(ids.flatMap(id => {
						const child = this.states.get(id);
						if (child?.children !== undefined && this.tree.isCollapsed(child.element) === false) {
							return [resolvedCompact.has(id) ? refreshLoaded(child.children) : this.loadChildren(child.element, id, generation, options)];
						}
						if (options.deferIfCollapsed && !resolvedCompact.has(id) && child?.children !== undefined) this.invalidateChildren(id);
						return [];
					}));
				};
				await refreshLoaded(childIds);
			})
			.catch(error => {
				if (!this.isCurrentRequest(requestKey, request)) return;
				if (parentId !== undefined) this.tree.collapse(parent as T);
				this.requests.delete(requestKey);
				this.updateAriaBusy();
				if (parentId !== undefined) this.tree.rerender(parent as T);
				this._onDidChangeLoadState.fire({ element: parentId === undefined ? undefined : parent as T, loading: false, error });
				this._onDidError.fire({ element: parentId === undefined ? undefined : parent as T, error });
				throw error;
			})
			.finally(() => {
				if (!this.isCurrentRequest(requestKey, request)) return;
				this.requests.delete(requestKey);
				this.updateAriaBusy();
				if (parentId !== undefined) this.tree.rerender(parent as T);
				this._onDidChangeLoadState.fire({ element: parentId === undefined ? undefined : parent as T, loading: false });
			});
		request = { generation, promise };
		this.requests.set(requestKey, request);
		this.updateAriaBusy();
		this._onDidChangeLoadState.fire({ element: parentId === undefined ? undefined : parent as T, loading: true });
		if (parentId !== undefined) this.tree.rerender(parent as T);
		start?.();
		await promise;
	}

	private restoreLoadedState(state: IAsyncDataTreeViewState): void {
		const expanded = new Set(state.expanded);
		for (const id of expanded) {
			const branch = this.states.get(id);
			if (!branch?.hasChildren) continue;
			const terminal = this.tree.getCompressedTreeNode?.(branch.element)?.elements.at(-1);
			if (terminal && !expanded.has(this.getId(terminal))) continue;
			if (this.tree.isCollapsed(branch.element) === true) this.tree.expand(branch.element);
		}
		const focused = state.focus?.[0];
		if (focused && this.states.has(focused)) this.setFocus(this.states.get(focused)!.element);
		this.setSelection((state.selection ?? []).flatMap(id => this.states.has(id) ? [this.states.get(id)!.element] : []));
	}

	private async resolveCompactChain(id: string, generation: number, resolved: Set<string>, deferIfCollapsed = false): Promise<void> {
		const state = this.states.get(id);
		if (!state?.hasChildren || this.options.isIncompressible?.(state.element)) return;
		if (deferIfCollapsed && this.canDeferChildren(state.element)) {
			this.invalidateChildren(id);
			resolved.add(id);
			return;
		}
		// Inspect only the continuation of a single-directory chain. Branches stay lazy.
		let children: readonly T[];
		try {
			children = [...await this.readChildren(state.element, () =>
				generation === this.generation && !this.isDisposed && this.states.get(id) === state)];
		} catch {
			return; // An unreadable collapsed folder reports its error when expanded.
		}
		if (generation !== this.generation || this.isDisposed || this.states.get(id) !== state) return;
		this.replaceChildren(id, children);
		resolved.add(id);
		if (children.length === 1) await this.resolveCompactChain(this.getId(children[0]!), generation, resolved, deferIfCollapsed);
	}

	private async readChildren(element: TInput | T, isCurrent: () => boolean): Promise<Iterable<T>> {
		const queue = this.childReads[this.nextChildRead]!;
		this.nextChildRead = (this.nextChildRead + 1) % this.childReads.length;
		const children = await queue.scheduleSkipIfCleared(() => isCurrent() ? this.dataSource.getChildren(element) : []);
		return children ?? [];
	}

	private replaceChildren(parentId: string | undefined, elements: readonly T[]): void {
		const parent = parentId === undefined ? undefined : this.states.get(parentId);
		if (parentId !== undefined && !parent) throw new RangeError(`Unknown AsyncDataTree parent: ${parentId}`);
		const oldChildren = parentId === undefined ? this.rootChildren : parent!.children ?? [];
		const oldChildIds = new Set(oldChildren);
		const childIds: string[] = [];
		const nextChildren: AsyncNodeState<T>[] = [];
		const seen = new Set<string>();
		for (const element of elements) {
			const id = this.getId(element);
			if (seen.has(id) || this.states.has(id) && !oldChildIds.has(id)) throw new Error(`Duplicate tree node ID: ${id}`);
			seen.add(id);
			childIds.push(id);
			const previous = this.states.get(id);
			const hasChildren = this.dataSource.hasChildren(element);
			nextChildren.push({ id, element, parentId, hasChildren, children: hasChildren ? previous?.children : undefined });
		}
		for (const id of oldChildren) if (!seen.has(id)) this.removeStateSubtree(id);
		for (const child of nextChildren) {
			if (!child.hasChildren) {
				// A former branch's pending read must not repopulate children after it becomes a leaf.
				this.requests.delete(child.id);
				for (const id of this.states.get(child.id)?.children ?? []) this.removeStateSubtree(id);
			}
			this.states.set(child.id, child);
		}
		if (parentId === undefined) this.rootChildren = childIds;
		else this.states.set(parentId, { ...parent!, children: childIds });
	}

	private removeStateSubtree(id: string): void {
		const state = this.states.get(id);
		if (!state) return;
		for (const child of state.children ?? []) this.removeStateSubtree(child);
		this.requests.delete(id);
		this.states.delete(id);
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

	private isCurrentRequest(key: string | undefined, request: AsyncTreeRequest): boolean { return !this.isDisposed && request.generation === this.generation && this.requests.get(key) === request; }
	private updateAriaBusy(): void { this.element.setAttribute("aria-busy", String(this.requests.size > 0)); }
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
			multipleSelectionSupport: options.multipleSelectionSupport,
			scrolling: options.scrolling,
			smoothScrolling: options.smoothScrolling,
			indent: options.indent,
			indentGuides: options.indentGuides,
			twistieAdditionalCssClass: options.twistieAdditionalCssClass,
			expandOnDoubleClick: options.expandOnDoubleClick,
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
			reuseRows: options.reuseRows,
			onDidRemoveRow: options.onDidRemoveRow,
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
	get onDidChangeCollapseState(): Event<{ readonly element: T; readonly elements: readonly T[]; readonly collapsed: boolean; readonly browserEvent: MouseEvent | KeyboardEvent | undefined; }> { return this.tree.onDidChangeCollapseState as Event<{ readonly element: T; readonly elements: readonly T[]; readonly collapsed: boolean; readonly browserEvent: MouseEvent | KeyboardEvent | undefined; }>; }

	getCompressedTreeNode(element: T): CompressedTreeNode<T> | undefined { return this.tree.getCompressedTreeNode?.(element); }

	protected createTree(container: HTMLElement, options: CompressibleAsyncDataTreeOptions<T>): AsyncTreeView<T> {
		const tree = new CompressibleObjectTree<T>(container, {
			ariaLabel: options.ariaLabel,
			multipleSelectionSupport: options.multipleSelectionSupport,
			scrolling: options.scrolling,
			smoothScrolling: options.smoothScrolling,
			indent: options.indent,
			indentGuides: options.indentGuides,
			twistieAdditionalCssClass: options.twistieAdditionalCssClass ? elements => options.twistieAdditionalCssClass!(last(elements)) : undefined,
			expandOnDoubleClick: options.expandOnDoubleClick,
			expandOnlyOnTwistieClick: options.expandOnlyOnTwistieClick,
			getHeight: options.getHeight,
			dnd: options.dnd,
			keyboardNavigationLabelProvider: options.keyboardNavigationLabelProvider,
			findMode: options.findMode,
			findMatchType: options.findMatchType,
			enableStickyScroll: options.enableStickyScroll,
			stickyScrollMaxItemCount: options.stickyScrollMaxItemCount,
			modelOptions: { defaultCollapseState: "collapsed", identityProvider: { getId: (element) => this.getId(element) }, sorter: options.sorter, filter: options.filter, compressionEnabled: options.compressionEnabled },
			onWillRender: options.onWillRender,
			reuseRows: options.reuseRows,
			onDidRemoveRow: options.onDidRemoveRow,
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
		domNode: tree.domNode,
		onPointer: tree.onPointer,
		onDidDoubleClick: tree.onDidDoubleClick,
		onDidAccept: tree.onDidAccept,
		onDidChangeFocus: tree.onDidChangeFocus,
		onDidChangeSelection: tree.onDidChangeSelection,
		onDidChangeCollapseState: tree.onDidChangeCollapseState,
		get focus() { return tree.focus; },
		get selection() { return tree.selection; },
		get scrollTop() { return tree.scrollTop; },
		set scrollTop(top) { tree.scrollTop = top; },
		reveal: (element, relativeTop) => tree.reveal(getId(element), relativeTop),
		getRelativeTop: element => tree.getRelativeTop(getId(element)),
		setFocus: (element, browserEvent) => tree.setFocus(getId(element), browserEvent),
		setSelection: (elements, browserEvent) => tree.setSelection(elements.map(getId), browserEvent),
		getVisibleElements: () => tree.getVisibleElements(),
		domFocus: () => tree.domFocus(),
		updateOptions: options => tree.updateOptions(options),
		setChildren: (children) => tree.setChildren(children),
		setNodeChildren: (element, children) => tree.setNodeChildren(getId(element), children),
		collapse: (element) => tree.collapse(getId(element)),
		expand: (element) => tree.expand(getId(element)),
		expandTo: (element) => tree.expandTo(getId(element)),
		isCollapsed: (element) => tree.model.getNode(getId(element))?.collapsed,
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
		domNode: tree.domNode,
		onPointer: tree.onPointer,
		onDidDoubleClick: tree.onDidDoubleClick,
		onDidAccept: tree.onDidAccept,
		onDidChangeFocus: tree.onDidChangeFocus,
		onDidChangeSelection: tree.onDidChangeSelection,
		onDidChangeCollapseState: tree.onDidChangeCollapseState,
		get focus() { return tree.focus; },
		get selection() { return tree.selection; },
		get scrollTop() { return tree.scrollTop; },
		set scrollTop(top) { tree.scrollTop = top; },
		reveal: (element, relativeTop) => tree.reveal(element, relativeTop),
		getRelativeTop: element => tree.getRelativeTop(element),
		setFocus: (element, browserEvent) => tree.setFocus(element, browserEvent),
		setSelection: (elements, browserEvent) => tree.setSelection(elements, browserEvent),
		getVisibleElements: () => tree.getVisibleElements(),
		domFocus: () => tree.domFocus(),
		updateOptions: options => {
			if (options.compressionEnabled !== undefined) tree.setCompressionEnabled(options.compressionEnabled);
			tree.updateOptions({ ...options, twistieAdditionalCssClass: options.twistieAdditionalCssClass ? elements => options.twistieAdditionalCssClass!(last(elements)) : undefined });
		},
		setChildren: (children) => tree.setChildren(children),
		setNodeChildren: (element, children) => tree.setNodeChildren(element, children),
		collapse: (element) => tree.collapse(element),
		expand: (element) => tree.expand(element),
		expandTo: (element) => tree.expandTo(element),
		isCollapsed: (element) => tree.model.getNode(element)?.collapsed,
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

function last<T>(elements: readonly T[]): T {
	const element = elements[elements.length - 1];
	if (element === undefined) throw new Error("Compressed tree nodes must contain at least one element");
	return element;
}
