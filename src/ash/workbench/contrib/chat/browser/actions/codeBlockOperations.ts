import { localize } from '../../../../../nls.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { ICodeBlockActionContext } from '../widget/chatContentParts/codeBlockPart.js';

/** Inserts through the active file's existing Stanza model and undo stack. */
export class InsertCodeBlockOperation {
	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IEditorPart private readonly editorPart: IEditorPart,
	) {}

	public async run(context: ICodeBlockActionContext): Promise<void> {
		const input = this.editors.activeEditor;
		const control = this.editorPart.activePane?.getControl();
		const editor =
			this.codeEditors.listCodeEditors().find(candidate => candidate === control) ??
			this.codeEditors
				.listDiffEditors()
				.find(candidate => candidate === control)
				?.getModifiedEditor();
		if (!editor || !input) throw new Error(localize('chat.code.noEditor', 'Open a file editor and place the cursor where the code should be inserted.'));
		if (input.readOnly || editor.getOption(EditorOption.readOnly)) throw new Error(localize('chat.code.readOnly', 'The active file editor is read-only.'));
		const selections = editor.getSelections();
		if (!selections?.length || !context.code) return;
		editor.pushUndoStop();
		if (
			!editor.executeEdits(
				'chat.insertCodeBlock',
				selections.map(range => ({ range, text: context.code })),
			)
		) {
			throw new Error(localize('chat.code.insertFailed', 'The active editor could not insert this code block.'));
		}
		editor.pushUndoStop();
		this.editors.focusActiveEditor();
	}
}
