import { Position } from "./position.js";
import { type IRange, Range } from "./range.js";

/** A single pre-transaction replacement consumed by the text model. */
export interface ISingleEditOperation {
	readonly range: IRange;
	readonly text: string | null;
	readonly forceMoveMarkers?: boolean;
}

/** Factory helpers for the editor's canonical single-edit operation shape. */
export class EditOperation {
	static insert(position: Position, text: string): ISingleEditOperation { return { range: Range.fromPositions(position), text, forceMoveMarkers: true }; }
	static delete(range: Range): ISingleEditOperation { return { range, text: null }; }
	static replace(range: Range, text: string | null): ISingleEditOperation { return { range, text }; }
	static replaceMove(range: Range, text: string | null): ISingleEditOperation { return { range, text, forceMoveMarkers: true }; }
}

/** Selects how a compatible edit updates the latest grouped undo step. */
export enum TextEditHistoryMergeMode {
	Sequential = "sequential",
	ReplacePrevious = "replacePrevious",
}
