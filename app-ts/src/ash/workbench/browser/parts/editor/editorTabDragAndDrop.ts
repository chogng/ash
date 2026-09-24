import { LocalSelectionTransfer } from "../../../../platform/dnd/browser/dnd.js";
import type { EditorGroup } from "./editorGroup.js";
import type { EditorInput } from "./editorInput.js";
import type { Direction } from "../../../../base/browser/ui/grid/grid.js";

/** The side of a tab at which an Editor drop will insert its source. */
export type EditorTabDropPosition = "before" | "after";

/**
 * Coordinates one local Editor tab drag across Editor groups.
 *
 * MultiEditorTabsControl owns DOM drag events and feedback, while EditorPart owns
 * the source group, target group, and the resulting Editor lifetime changes.
 */
export interface IEditorTabDragAndDrop {
	start(source: EditorGroup, input: EditorInput): void;
	isDragging(): boolean;
	drop(target: EditorGroup, targetInput: EditorInput | undefined, position: EditorTabDropPosition, splitDirection?: Direction): void;
	end(): void;
}

/** One editor tab retained as an in-renderer drag payload. */
export class DraggedEditorIdentifier {
	constructor(
		readonly source: EditorGroup,
		readonly input: EditorInput,
	) {}
}

/** The resolved target of an editor tab drag. */
export interface EditorTabDropEvent {
	readonly source: EditorGroup;
	readonly input: EditorInput;
	readonly target: EditorGroup;
	readonly targetInput: EditorInput | undefined;
	readonly position: EditorTabDropPosition;
	readonly splitDirection?: Direction;
}

/**
 * Coordinates Editor tab transfer inside one renderer process.
 *
 * It deliberately owns no DOM events and no Editor lifetime behavior: tab
 * controls project native DnD while EditorPart performs the resulting move.
 */
export class EditorTabDragAndDropController implements IEditorTabDragAndDrop {
	private readonly transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();

	constructor(private readonly onDrop: (event: EditorTabDropEvent) => void) {}

	start(source: EditorGroup, input: EditorInput): void {
		this.transfer.setData(
			[new DraggedEditorIdentifier(source, input)],
			DraggedEditorIdentifier.prototype,
		);
	}

	isDragging(): boolean {
		return this.transfer.hasData(DraggedEditorIdentifier.prototype);
	}

	drop(target: EditorGroup, targetInput: EditorInput | undefined, position: EditorTabDropPosition, splitDirection?: Direction): void {
		const dragged = this.transfer.getData(DraggedEditorIdentifier.prototype)?.[0];
		this.end();
		if (!dragged) return;
		this.onDrop({
			source: dragged.source,
			input: dragged.input,
			target,
			targetInput,
			position,
			...(splitDirection ? { splitDirection } : {}),
		});
	}

	end(): void {
		this.transfer.clearData(DraggedEditorIdentifier.prototype);
	}
}
