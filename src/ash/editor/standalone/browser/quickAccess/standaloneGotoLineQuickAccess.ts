import type { IEditorContribution } from '../../../common/editorCommon.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';

interface GotoLineContribution extends IEditorContribution { open(mode?: 'line' | 'offset'): void; }

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
		editor.getContribution<GotoLineContribution>('editor.contrib.quickAccess')?.open();
	}
}

registerEditorAction(GotoLineAction);

export class GotoOffsetAction extends EditorAction {
	public static readonly ID = 'editor.action.gotoOffset';

	constructor() {
		super({
			id: GotoOffsetAction.ID,
			label: localize2('gotoOffset', 'Go to Offset...'),
			precondition: undefined,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		editor.getContribution<GotoLineContribution>('editor.contrib.quickAccess')?.open('offset');
	}
}

registerEditorAction(GotoOffsetAction);
