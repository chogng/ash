import type { IRange } from '../../../../../../../editor/common/core/range.js';

/** The model clamps the trailing span, including placeholder positions on long lines. */
export function getRangeForPlaceholder(editorRange: IRange): IRange {
	return {
		startLineNumber: editorRange.endLineNumber,
		startColumn: editorRange.endColumn + 1,
		endLineNumber: editorRange.endLineNumber,
		endColumn: Number.MAX_SAFE_INTEGER,
	};
}
