import "./dnd.css";

export const DndCssClasses = {
	Draggable: "ash-dnd-draggable",
	Dragging: "ash-dnd-dragging",
	DropTarget: "ash-dnd-drop-target",
	DropBefore: "ash-dnd-drop-before",
	DropAfter: "ash-dnd-drop-after",
} as const;

export const DragAndDropDataKind = Object.freeze({
	Internal: "internal",
	External: "external",
	Native: "native",
} as const);

export type DragAndDropDataKind = typeof DragAndDropDataKind[keyof typeof DragAndDropDataKind];

/** One collection drag payload as observed by a browser UI component. */
export interface DragAndDropData<T> {
	readonly kind: DragAndDropDataKind;
	readonly elements: readonly T[];
	readonly types: readonly string[];
	readonly files: readonly File[];
}

/** Projects collection elements without erasing native or cross-list origin. */
export function mapDragAndDropData<T, R>(data: DragAndDropData<T>, map: (element: T) => R): DragAndDropData<R> {
	return {
		kind: data.kind,
		elements: data.elements.map(map),
		types: data.types,
		files: data.files,
	};
}
