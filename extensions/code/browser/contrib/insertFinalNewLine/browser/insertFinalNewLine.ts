import { localize2 } from '../../../../../../src/ash/nls.js';
import type { ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../registration.js';
import { EditorContextKeys } from '../../../../../../src/ash/editor/common/editorContextKeys.js';
import { InsertFinalNewLineCommand } from './insertFinalNewLineCommand.js';

export class InsertFinalNewLineAction extends EditorAction {
	public static readonly ID = 'editor.action.insertFinalNewLine';

	constructor() {
		super({
			id: InsertFinalNewLineAction.ID,
			label: localize2('insertFinalNewLine', 'Insert Final New Line'),
			precondition: EditorContextKeys.writable,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const selection = editor.getSelection();
		if (!selection) return;

		editor.pushUndoStop();
		editor.executeCommands(this.id, [new InsertFinalNewLineCommand(selection)]);
		editor.pushUndoStop();
	}
}

registerEditorAction(InsertFinalNewLineAction);
