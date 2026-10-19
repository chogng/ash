import type { ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { StableEditorScrollState } from '../../../../../../src/ash/editor/browser/stableEditorScroll.js';
import { EditorOption } from '../../../../../../src/ash/editor/common/config/editorOptions.js';
import { Range } from '../../../../../../src/ash/editor/common/core/range.js';
import type { TextEdit } from '../../../../../../src/ash/editor/common/languages.js';

export class FormattingEdit {
	public static execute(editor: ICodeEditor, edits: TextEdit[], addUndoStops: boolean): void {
		const model = editor.getModel();
		if (!model || editor.getOption(EditorOption.readOnly) || edits.length === 0) {
			return;
		}
		const scroll = StableEditorScrollState.capture(editor);
		const fullReplacement = edits.length === 1 && Range.equalsRange(edits[0].range, model.getFullModelRange());
		const operations = edits.map(edit => ({ range: edit.range, text: edit.text, forceMoveMarkers: !fullReplacement }));
		if (addUndoStops) {
			editor.pushUndoStop();
		}
		try {
			editor.executeEdits('formatEditsCommand', operations);
			const eol = [...edits].reverse().find(edit => edit.eol !== undefined)?.eol;
			if (eol !== undefined) {
				model.pushEOL(eol);
			}
		} finally {
			if (addUndoStops) {
				editor.pushUndoStop();
			}
			scroll.restoreRelativeVerticalPositionOfCursor(editor);
		}
	}
}
