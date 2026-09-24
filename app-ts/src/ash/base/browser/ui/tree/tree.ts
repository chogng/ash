import { mapDragAndDropData, type DragAndDropData } from "../dnd/dnd.js";
import type { ListDragOverPosition, ListDragTargetSector } from "../list/list.js";

export const TreeVisibility = Object.freeze({
	Hidden: "hidden",
	Visible: "visible",
	Recurse: "recurse",
} as const);

export type TreeVisibility = typeof TreeVisibility[keyof typeof TreeVisibility];
export type TreeFilterResult = boolean | TreeVisibility;

export interface TreeFilter<T> {
	filter(element: T, parentVisibility: TreeVisibility): TreeFilterResult;
}

export interface TreeSorter<T> {
	compare(left: T, right: T): number;
}

export interface TreeElement<T> {
	readonly element: T;
	readonly children?: readonly TreeElement<T>[];
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
}

export interface TreeDataSource<TInput, T> {
	readonly hasChildren?: (element: TInput | T) => boolean;
	readonly getChildren: (element: TInput | T) => Iterable<T>;
}

export interface AsyncTreeDataSource<TInput, T> {
	readonly hasChildren: (element: TInput | T) => boolean;
	readonly getChildren: (element: TInput | T) => Iterable<T> | Promise<Iterable<T>>;
	readonly getParent?: (element: T) => TInput | T;
}

export type IndexTreeLocation = readonly number[];

export type TreeIndentGuides = "none" | "onHover" | "always";
export type TreeSelectionPresentation = "active" | "subtle";

export interface TreeTwistieState {
	readonly collapsible: boolean;
	readonly expanded: boolean;
}

export type TreePointerTarget = "twistie" | "contents";

export const TreeFindMode = Object.freeze({ Highlight: "highlight", Filter: "filter" } as const);
export type TreeFindMode = typeof TreeFindMode[keyof typeof TreeFindMode];

export const TreeFindMatchType = Object.freeze({ Fuzzy: "fuzzy", Contiguous: "contiguous" } as const);
export type TreeFindMatchType = typeof TreeFindMatchType[keyof typeof TreeFindMatchType];

export interface TreeKeyboardNavigationLabelProvider<T> {
	getKeyboardNavigationLabel(element: T): string | readonly string[] | undefined;
}

export interface TreeFindResult<T> {
	readonly pattern: string;
	readonly matches: readonly T[];
	readonly activeMatch: T | undefined;
}

export const TreeDragOverBubble = Object.freeze({ Up: "up", Down: "down" } as const);
export type TreeDragOverBubble = typeof TreeDragOverBubble[keyof typeof TreeDragOverBubble];

export type TreeDragData<T> = DragAndDropData<T>;

export interface TreeDragOverReaction {
	readonly accept: boolean;
	readonly effect?: "copy" | "move";
	readonly position?: ListDragOverPosition;
	readonly bubble?: TreeDragOverBubble;
	readonly autoExpand?: boolean;
}

/** Drag policy for hierarchy-aware targets. */
export interface TreeDragAndDrop<T> {
	getDragURI(element: T): string | undefined;
	getDragLabel?: (elements: readonly T[], browserEvent: DragEvent) => string | undefined;
	onDragStart?: (data: TreeDragData<T>, browserEvent: DragEvent) => void;
	onDragOver: (data: TreeDragData<T>, target: T | undefined, targetIndex: number | undefined, targetSector: ListDragTargetSector | undefined, browserEvent: DragEvent) => boolean | TreeDragOverReaction;
	onDragLeave?: (data: TreeDragData<T>, target: T | undefined, targetIndex: number | undefined, browserEvent: DragEvent) => void;
	drop: (data: TreeDragData<T>, target: T | undefined, targetIndex: number | undefined, targetSector: ListDragTargetSector | undefined, browserEvent: DragEvent) => void;
	onDragEnd?: (browserEvent: DragEvent) => void;
}

export function mapTreeDragData<T, R>(data: TreeDragData<T>, map: (element: T) => R): TreeDragData<R> {
	return mapDragAndDropData(data, map);
}

/** Structural node contract projected by `AbstractTree` into flat list rows. */
export interface AbstractTreeNode<T> {
	readonly id: string;
	readonly element: T;
	readonly parent: AbstractTreeNode<T> | undefined;
	readonly children: readonly AbstractTreeNode<T>[];
	readonly depth: number;
	readonly collapsible: boolean;
	readonly collapsed: boolean;
	readonly visible: boolean;
	readonly visibleChildIndex: number;
	readonly visibleChildrenCount: number;
}

export function flattenTreeNodes<T, TNode extends AbstractTreeNode<T>>(roots: readonly TNode[]): readonly TNode[] {
	const result: TNode[] = [];
	const visit = (node: TNode): void => {
		result.push(node);
		for (const child of node.children) visit(child as TNode);
	};
	for (const root of roots) visit(root);
	return result;
}

export interface TreePointerEvent<T> {
	readonly element: T;
	readonly target: TreePointerTarget;
	readonly browserEvent: MouseEvent;
}

export interface TreeAcceptEvent<T> {
	readonly element: T;
	readonly browserEvent: KeyboardEvent;
}

export interface TreeFocusChangeEvent<T> {
	readonly element: T | undefined;
	readonly browserEvent: UIEvent | undefined;
}

export interface TreeSelectionChangeEvent<T> {
	readonly elements: readonly T[];
	readonly browserEvent: UIEvent | undefined;
}

export interface TreeCollapseRequestEvent<T> {
	readonly element: T;
	readonly expanded: boolean;
	readonly browserEvent: MouseEvent | KeyboardEvent;
}

export interface TreeActivateEvent<T> {
	readonly element: T;
	readonly browserEvent: MouseEvent | KeyboardEvent;
}
