import { Range } from '../../../editor/common/core/range.js';
import type { IEditor, ScrollType } from '../../../editor/common/editorCommon.js';
import { TextEditorSelectionSource, type ITextEditorOptions } from '../../../platform/editor/common/editor.js';

/** Applies resource navigation to the editor that owns selection and scrolling. */
export function applyTextEditorOptions(options: ITextEditorOptions, editor: IEditor, scrollType: ScrollType): boolean {
	const selection = options.selection;
	if (!selection) {
		return false;
	}
	const range = new Range(
		selection.startLineNumber,
		selection.startColumn,
		selection.endLineNumber ?? selection.startLineNumber,
		selection.endColumn ?? selection.startColumn,
	);
	editor.setSelection(range, TextEditorSelectionSource.NAVIGATION);
	editor.revealRange(range, scrollType);
	return true;
}
