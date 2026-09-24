import { localize2 } from '../../../../nls.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { MoveCaretCommand } from './moveCaretCommand.js';

class MoveCaretLeftAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.moveCarretLeftAction',
			label: localize2('caret.moveLeft', 'Move Selected Text Left'),
			precondition: EditorContextKeys.writable,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		moveSelectedText(editor, this.id, true);
	}
}

class MoveCaretRightAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.moveCarretRightAction',
			label: localize2('caret.moveRight', 'Move Selected Text Right'),
			precondition: EditorContextKeys.writable,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		moveSelectedText(editor, this.id, false);
	}
}

function moveSelectedText(editor: ICodeEditor, source: string, isMovingLeft: boolean): void {
	const selections = editor.getSelections();
	if (!selections) return;

	editor.pushUndoStop();
	editor.executeCommands(source, selections.map(selection => new MoveCaretCommand(selection, isMovingLeft)));
	editor.pushUndoStop();
}

registerEditorAction(MoveCaretLeftAction);
registerEditorAction(MoveCaretRightAction);
