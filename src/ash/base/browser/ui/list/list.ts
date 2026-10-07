import type { DragAndDropData } from "../dnd/dnd.js";

export type ListScrolling = "internal" | "external" | "managed";

export interface IKeyboardNavigationLabelProvider<T> {
	getKeyboardNavigationLabel(element: T): { toString(): string | undefined; } | { toString(): string | undefined; }[] | undefined;
}

export interface IListElementRenderDetails {
	readonly height?: number;
	readonly onScroll?: boolean;
}

export interface IListVirtualDelegate<T> {
	getHeight(element: T): number;
	getTemplateId(element: T): string;
}

export interface IListRenderer<T, TTemplateData> {
	readonly templateId: string;
	renderTemplate(container: HTMLElement): TTemplateData;
	renderElement(element: T, index: number, templateData: TTemplateData, details?: IListElementRenderDetails): void;
	disposeElement?(element: T, index: number, templateData: TTemplateData, details?: IListElementRenderDetails): void;
	disposeTemplate(templateData: TTemplateData): void;
}

export interface ListAccessibilityProvider<T> {
	readonly getRole?: (item: T) => "option" | "treeitem" | "row" | "presentation";
	readonly getAriaLabel?: (item: T) => string | undefined;
	readonly getAriaLevel?: (item: T) => number | undefined;
	readonly getAriaSetSize?: (item: T) => number | undefined;
	readonly getAriaPosInSet?: (item: T) => number | undefined;
	readonly isExpanded?: (item: T) => boolean | undefined;
}

export const ListDragTargetSector = Object.freeze({ Top: "top", CenterTop: "center-top", CenterBottom: "center-bottom", Bottom: "bottom" } as const);
export type ListDragTargetSector = typeof ListDragTargetSector[keyof typeof ListDragTargetSector];

export const ListDragOverPosition = Object.freeze({ Over: "over", Before: "before", After: "after" } as const);
export type ListDragOverPosition = typeof ListDragOverPosition[keyof typeof ListDragOverPosition];

export type ListDragData<T> = DragAndDropData<T>;

export interface ListDragOverReaction {
	readonly accept: boolean;
	readonly effect?: "copy" | "move";
	readonly position?: ListDragOverPosition;
	readonly feedback?: readonly number[];
}

/** HTML drag-and-drop policy owned by a flat List consumer. */
export interface ListDragAndDrop<T> {
	getDragURI(element: T): string | undefined;
	getDragLabel?: (elements: readonly T[], browserEvent: DragEvent) => string | undefined;
	onDragStart?: (data: ListDragData<T>, browserEvent: DragEvent) => void;
	onDragOver: (data: ListDragData<T>, target: T | undefined, targetIndex: number | undefined, targetSector: ListDragTargetSector | undefined, browserEvent: DragEvent) => boolean | ListDragOverReaction;
	onDragLeave?: (data: ListDragData<T>, target: T | undefined, targetIndex: number | undefined, browserEvent: DragEvent) => void;
	drop: (data: ListDragData<T>, target: T | undefined, targetIndex: number | undefined, targetSector: ListDragTargetSector | undefined, browserEvent: DragEvent) => void;
	onDragEnd?: (browserEvent: DragEvent) => void;
}
