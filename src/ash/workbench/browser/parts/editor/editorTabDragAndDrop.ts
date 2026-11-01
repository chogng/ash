import { EditorInputCapabilities, type IResourceEditorInput } from '../../../common/editor.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import type { EditorGroupView } from './editorGroupView.js';
import type { Direction } from '../../../../base/browser/ui/grid/grid.js';

/** The side of a tab at which an Editor drop will insert its source. */
export type EditorTabDropPosition = 'before' | 'after';

/**
 * Coordinates one local editor selection drag across editor groups.
 *
 * MultiEditorTabsControl owns DOM drag events and feedback, while EditorPart owns
 * the source group, target group, and the resulting Editor lifetime changes.
 */
export interface IEditorTabDragAndDrop {
	start(source: EditorGroupView, input: IResourceEditorInput): void;
	startGroup(source: EditorGroupView): void;
	isDragging(): boolean;
	getOperation(target: EditorGroupView, copyRequested: boolean, splitDirection?: Direction): 'move' | 'copy';
	drop(target: EditorGroupView, targetInput: IResourceEditorInput | undefined, position: EditorTabDropPosition, splitDirection?: Direction, copyRequested?: boolean): void;
	end(): void;
}

/** One editor in the drag snapshot. The primary editor is the first transfer entry. */
export class DraggedEditorIdentifier {
	constructor(
		readonly source: EditorGroupView | undefined,
		readonly input: IResourceEditorInput,
		readonly wholeGroup = false,
		readonly sourceIndex = -1,
	) { }
}

/** The resolved target of an editor tab drag. */
export interface EditorTabDropEvent {
	/** Absent when a contribution lends an input that has no editor group yet. */
	readonly source: EditorGroupView | undefined;
	readonly input: IResourceEditorInput;
	/** Selection captured at drag start, in source tab order. */
	readonly inputs?: readonly IResourceEditorInput[];
	readonly copy?: boolean;
	readonly target: EditorGroupView;
	readonly targetInput: IResourceEditorInput | undefined;
	readonly position: EditorTabDropPosition;
	readonly splitDirection?: Direction;
	readonly wholeGroup?: boolean;
}

/**
 * Coordinates Editor tab transfer inside one renderer process.
 *
 * It deliberately owns no DOM events and no Editor lifetime behavior: tab
 * controls project native DnD while EditorPart performs the resulting move.
 */
export class EditorTabDragAndDropController implements IEditorTabDragAndDrop {
	private readonly transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();

	constructor(private readonly onDrop: (event: EditorTabDropEvent) => void) { }

	start(source: EditorGroupView, input: IResourceEditorInput): void {
		const inputs = source.selectedInputs.includes(input) ? source.selectedInputs : [input];
		const primaryFirst = [input, ...inputs.filter(selected => selected !== input)];
		this.transfer.setData(
			primaryFirst.map(selected => new DraggedEditorIdentifier(source, selected, false, source.inputs.indexOf(selected))),
			DraggedEditorIdentifier.prototype,
		);
	}

	startGroup(source: EditorGroupView): void {
		if (!source.activeInput) return;
		this.transfer.setData([new DraggedEditorIdentifier(source, source.activeInput, true)], DraggedEditorIdentifier.prototype);
	}

	isDragging(): boolean {
		return this.transfer.hasData(DraggedEditorIdentifier.prototype);
	}

	getOperation(target: EditorGroupView, copyRequested: boolean, splitDirection?: Direction): 'move' | 'copy' {
		const data = this.transfer.getData(DraggedEditorIdentifier.prototype);
		const source = data?.[0]?.source;
		if (!copyRequested || !source || (source === target && splitDirection === undefined)) return 'move';
		const canCopy = data!.some(item => item.source === source && !((item.input.capabilities ?? EditorInputCapabilities.None) & EditorInputCapabilities.Singleton));
		return canCopy ? 'copy' : 'move';
	}

	drop(target: EditorGroupView, targetInput: IResourceEditorInput | undefined, position: EditorTabDropPosition, splitDirection?: Direction, copyRequested = false): void {
		const data = this.transfer.getData(DraggedEditorIdentifier.prototype);
		const dragged = data?.[0];
		const copy = this.getOperation(target, copyRequested, splitDirection) === 'copy';
		this.end();
		if (!dragged) return;
		const inputs = data!.filter(item => item.source === dragged.source);
		inputs.sort((left, right) => left.sourceIndex - right.sourceIndex);
		this.onDrop({
			source: dragged.source,
			input: dragged.input,
			inputs: inputs.map(item => item.input),
			copy,
			target,
			targetInput,
			position,
			wholeGroup: dragged.wholeGroup,
			...(splitDirection !== undefined ? { splitDirection } : {}),
		});
	}

	end(): void {
		this.transfer.clearData(DraggedEditorIdentifier.prototype);
	}
}

/** Interpret the native copy modifier once at editor drag event boundaries. */
export function isEditorTabCopyRequested(event: Pick<DragEvent, 'altKey' | 'ctrlKey'>): boolean {
	return isMacintosh ? event.altKey : event.ctrlKey;
}
