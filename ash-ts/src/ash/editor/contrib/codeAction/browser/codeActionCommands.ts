import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { CodeActionController } from './codeActionController.js';

class QuickFixAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.quickFix',
			label: localize2('quickfix.trigger.label', 'Quick Fix...'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyCode.Period,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition();
	}
}

registerEditorAction(QuickFixAction);
