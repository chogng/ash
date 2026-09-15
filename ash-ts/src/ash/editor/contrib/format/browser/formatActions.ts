import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import type { FormatController } from './formatController.js';

class FormatDocumentAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.formatDocument',
			label: localize2('formatDocument.label', 'Format Document'),
			precondition: EditorContextKeys.writable,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		await editor.getContribution<FormatController>('editor.contrib.format')?.formatDocument();
	}
}

registerEditorAction(FormatDocumentAction);
