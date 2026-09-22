import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import type { GotoLineController } from '../../../contrib/quickAccess/browser/quickAccessController.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';

export class GotoLineAction extends EditorAction {
	public static readonly ID = 'editor.action.gotoLine';

	constructor() {
		super({
			id: GotoLineAction.ID,
			label: localize2('gotoLine', 'Go to Line/Column...'),
			precondition: undefined,
			kbOpts: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyG,
				mac: { primary: KeyMod.WinCtrl | KeyCode.KeyG },
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		editor.getContribution<GotoLineController>('editor.contrib.quickAccess')?.open();
	}
}

registerEditorAction(GotoLineAction);
