import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { type LanguageHierarchyController } from '../../../../editor/contrib/callHierarchy/browser/languageHierarchyController.js';

class PeekCallHierarchyAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.showCallHierarchy',
			label: localize2('callHierarchy.peek', 'Peek Call Hierarchy'),
			precondition: EditorContextKeys.hasCallHierarchyProvider.isEqualTo(true),
			contextMenuOpts: { menuId: MenuId.EditorContextPeek, group: 'navigation', order: 1000 },
			kbOpts: {
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyH,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await editor.getContribution<LanguageHierarchyController>('editor.contrib.languageHierarchy')?.showCallHierarchy();
	}
}

registerEditorAction(PeekCallHierarchyAction);
