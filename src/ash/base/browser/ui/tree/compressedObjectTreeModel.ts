import type { Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import { ObjectTreeModel, type ObjectTreeDefaultCollapseState, type ObjectTreeElement, type ObjectTreeIdentityProvider, type ObjectTreeModelChangeEvent, type ObjectTreeModelCollapseStateChangeEvent, type ObjectTreeNode } from "./objectTreeModel.js";
import type { TreeFilter, TreeSorter } from "./tree.js";

export interface CompressibleTreeElement<T> {
	readonly element: T;
	readonly children?: readonly CompressibleTreeElement<T>[];
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
	readonly incompressible?: boolean;
}

export interface CompressedTreeNode<T> {
	readonly elements: readonly T[];
	readonly incompressible: boolean;
}

export interface CompressibleObjectTreeModelOptions<T> {
	readonly identityProvider: ObjectTreeIdentityProvider<T>;
	readonly defaultCollapseState?: ObjectTreeDefaultCollapseState;
	readonly sorter?: TreeSorter<T>;
	readonly filter?: TreeFilter<T>;
	readonly compressionEnabled?: boolean;
}

/** Compresses single-child chains before they enter the canonical ObjectTreeModel. */
export class CompressibleObjectTreeModel<T> extends Disposable {
	readonly model: ObjectTreeModel<CompressedTreeNode<T>>;
	private roots: readonly CompressibleTreeElement<T>[] = [];
	private nodesByElementId = new Map<string, CompressedTreeNode<T>>();
	private compressionEnabled: boolean;

	readonly onDidChange: Event<ObjectTreeModelChangeEvent<CompressedTreeNode<T>>>;
	readonly onDidChangeCollapseState: Event<ObjectTreeModelCollapseStateChangeEvent<CompressedTreeNode<T>>>;

	constructor(private readonly options: CompressibleObjectTreeModelOptions<T>) {
		super();
		this.compressionEnabled = options.compressionEnabled ?? true;
		this.model = this._register(new ObjectTreeModel({
			identityProvider: { getId: (node) => compressedId(node, options.identityProvider) },
			defaultCollapseState: options.defaultCollapseState,
			sorter: options.sorter ? { compare: (left, right) => options.sorter!.compare(last(left.elements), last(right.elements)) } : undefined,
			filter: options.filter ? { filter: (node, parentVisibility) => options.filter!.filter(last(node.elements), parentVisibility) } : undefined,
		}));
		this.onDidChange = this.model.onDidChange;
		this.onDidChangeCollapseState = this.model.onDidChangeCollapseState;
	}

	get visibleNodes(): readonly ObjectTreeNode<CompressedTreeNode<T>>[] { return this.model.visibleNodes; }
	get rootNodes(): readonly ObjectTreeNode<CompressedTreeNode<T>>[] { return this.model.rootNodes; }

	setChildren(children: readonly CompressibleTreeElement<T>[]): void {
		this.rebuild(children);
	}

	setNodeChildren(element: T, children: readonly CompressibleTreeElement<T>[]): void {
		const id = this.options.identityProvider.getId(element);
		let replaced = false;
		const replace = (candidate: CompressibleTreeElement<T>): CompressibleTreeElement<T> => {
			if (this.options.identityProvider.getId(candidate.element) === id) {
				replaced = true;
				return { ...candidate, children };
			}
			return { ...candidate, children: candidate.children?.map(replace) };
		};
		const nextRoots = this.roots.map(replace);
		if (!replaced) throw new RangeError(`Unknown compressible tree element: ${id}`);
		this.rebuild(nextRoots);
	}

	setCompressionEnabled(enabled: boolean): void {
		if (enabled === this.compressionEnabled) return;
		const previous = this.compressionEnabled;
		this.compressionEnabled = enabled;
		try {
			this.rebuild(this.roots);
		} catch (error) {
			this.compressionEnabled = previous;
			throw error;
		}
	}

	getCompressedNode(element: T): CompressedTreeNode<T> | undefined { return this.nodesByElementId.get(this.options.identityProvider.getId(element)); }
	getNode(element: T): ObjectTreeNode<CompressedTreeNode<T>> | undefined {
		const compressed = this.getCompressedNode(element);
		return compressed ? this.model.getNode(compressedId(compressed, this.options.identityProvider)) : undefined;
	}
	collapse(element: T): boolean { return this.model.collapse(this.requireCompressedId(element)); }
	expand(element: T): boolean { return this.model.expand(this.requireCompressedId(element)); }
	toggleCollapsed(element: T): boolean { return this.model.toggleCollapsed(this.requireCompressedId(element)); }
	expandTo(element: T): boolean { return this.model.expandTo(this.requireCompressedId(element)); }
	rerender(element?: T): void { this.model.rerender(element === undefined ? undefined : this.requireCompressedId(element)); }

	private rebuild(nextRoots: readonly CompressibleTreeElement<T>[]): void {
		const compressed = this.compressionEnabled ? nextRoots.map(compressTreeElement) : nextRoots.map(noCompressTreeElement);
		const index = new Map<string, CompressedTreeNode<T>>();
		const visit = (element: ObjectTreeElement<CompressedTreeNode<T>>): void => {
			for (const original of element.element.elements) {
				const id = this.options.identityProvider.getId(original);
				if (index.has(id)) throw new Error(`Duplicate tree node ID: ${id}`);
				index.set(id, element.element);
			}
			for (const child of element.children ?? []) visit(child);
		};
		for (const root of compressed) visit(root);
		const previousRoots = this.roots;
		const previousIndex = this.nodesByElementId;
		this.roots = nextRoots;
		this.nodesByElementId = index;
		try {
			this.model.setChildren(compressed);
		} catch (error) {
			this.roots = previousRoots;
			this.nodesByElementId = previousIndex;
			throw error;
		}
	}

	private requireCompressedId(element: T): string {
		const node = this.getCompressedNode(element);
		if (!node) throw new RangeError(`Unknown compressible tree element: ${this.options.identityProvider.getId(element)}`);
		return compressedId(node, this.options.identityProvider);
	}
}

export function compressTreeElement<T>(input: CompressibleTreeElement<T>): ObjectTreeElement<CompressedTreeNode<T>> {
	const elements = [input.element];
	const incompressible = input.incompressible ?? false;
	let terminal = input;
	while ((terminal.children?.length ?? 0) === 1 && terminal.children![0]!.incompressible !== true) {
		terminal = terminal.children![0]!;
		elements.push(terminal.element);
	}
	return {
		element: { elements, incompressible },
		collapsible: terminal.collapsible,
		collapsed: terminal.collapsed,
		children: terminal.children?.map(compressTreeElement),
	};
}

export function decompressTreeElement<T>(input: ObjectTreeElement<CompressedTreeNode<T>>): CompressibleTreeElement<T> {
	const build = (index: number): CompressibleTreeElement<T> => ({
		element: input.element.elements[index]!,
		incompressible: index === 0 ? input.element.incompressible : undefined,
		collapsible: index === input.element.elements.length - 1 ? input.collapsible : true,
		collapsed: index === input.element.elements.length - 1 ? input.collapsed : false,
		children: index < input.element.elements.length - 1 ? [build(index + 1)] : input.children?.map(decompressTreeElement),
	});
	return build(0);
}

function noCompressTreeElement<T>(input: CompressibleTreeElement<T>): ObjectTreeElement<CompressedTreeNode<T>> {
	return {
		element: { elements: [input.element], incompressible: input.incompressible ?? false },
		collapsible: input.collapsible,
		collapsed: input.collapsed,
		children: input.children?.map(noCompressTreeElement),
	};
}

function compressedId<T>(node: CompressedTreeNode<T>, identityProvider: ObjectTreeIdentityProvider<T>): string {
	return node.elements.map((element) => identityProvider.getId(element)).join("\0");
}

function last<T>(elements: readonly T[]): T {
	const element = elements[elements.length - 1];
	if (element === undefined) throw new Error("Compressed tree nodes must contain at least one element");
	return element;
}
