import { type TextModel } from "../../../common/model/textModel.js";

/** Identifies whether a folding range was manually created or supplied by a language provider. */
export enum EditorFoldingRangeSource {
	Manual = "manual",
	Provider = "provider",
}

/** One inclusive physical-line range that can be collapsed without changing document text. */
export interface EditorFoldingRange {
	readonly startLineIndex: number;
	readonly endLineIndex: number;
	readonly collapsed?: boolean;
	readonly source?: EditorFoldingRangeSource;
}

/** One current folding range whose line boundaries follow edits in its owning TextModel. */
export interface EditorFoldingRegion {
	readonly startLineIndex: number;
	readonly endLineIndex: number;
	readonly collapsed: boolean;
	readonly source: EditorFoldingRangeSource;
}

/** Validated, sorted range data consumed by the stateful folding model. */
export type ResolvedEditorFoldingRange = Required<EditorFoldingRange>;

/** Normalizes range data before it is attached to tracked text ranges. */
export function normalizeEditorFoldingRanges(model: TextModel, ranges: readonly EditorFoldingRange[]): readonly ResolvedEditorFoldingRange[] {
	if (!Array.isArray(ranges)) throw new TypeError("Folding ranges must be an array");
	const normalized = ranges.map(range => {
		if (!range || typeof range !== "object") throw new TypeError("Folding range must be an object");
		validateEditorFoldingLineIndex(model, range.startLineIndex);
		validateEditorFoldingLineIndex(model, range.endLineIndex);
		if (range.endLineIndex <= range.startLineIndex) throw new RangeError("Folding ranges must span at least two lines");
		if (range.collapsed !== undefined && typeof range.collapsed !== "boolean") throw new TypeError("Folding range collapse state must be boolean");
		if (range.source !== undefined && !Object.values(EditorFoldingRangeSource).includes(range.source)) throw new TypeError("Unknown folding range source");
		return Object.freeze({
			startLineIndex: range.startLineIndex,
			endLineIndex: range.endLineIndex,
			collapsed: range.collapsed ?? false,
			source: range.source ?? EditorFoldingRangeSource.Provider,
		});
	});
	normalized.sort((left, right) => left.startLineIndex - right.startLineIndex || right.endLineIndex - left.endLineIndex);
	const ancestors: ResolvedEditorFoldingRange[] = [];
	for (const current of normalized) {
		while (ancestors.length > 0 && current.startLineIndex > ancestors.at(-1)!.endLineIndex) {
			ancestors.pop();
		}
		const parent = ancestors.at(-1);
		if (parent && current.endLineIndex > parent.endLineIndex) {
			throw new RangeError("Folding ranges must be nested or disjoint");
		}
		ancestors.push(current);
	}
	return Object.freeze(deduplicateEditorFoldingRanges(normalized));
}

/** Returns a stable physical-line identity used to retain provider collapse state. */
export function editorFoldingRangeKey(range: Pick<EditorFoldingRange, "startLineIndex" | "endLineIndex">): string {
	return `${range.startLineIndex}:${range.endLineIndex}`;
}

export function validateEditorFoldingLineIndex(model: TextModel, lineIndex: number): void {
	if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex >= model.lineCount) throw new RangeError("Folding line index is outside the text model");
}

function deduplicateEditorFoldingRanges(ranges: readonly ResolvedEditorFoldingRange[]): readonly ResolvedEditorFoldingRange[] {
	return ranges.filter((range, index) => {
		const previous = ranges[index - 1];
		return !previous || range.startLineIndex !== previous.startLineIndex || range.endLineIndex !== previous.endLineIndex;
	});
}
