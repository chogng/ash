import { localize2 } from '../../../../../nls.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { GotoLineController } from '../../../../../editor/contrib/quickAccess/browser/quickAccessController.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorsVisibleContext } from '../../../../common/contextkeys.js';

class GotoLineAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.gotoLine',
			get title() { return localize2('gotoLine', 'Go to Line/Column...'); },
			f1: true,
			menu: { id: MenuId.MenubarGoMenu, when: EditorsVisibleContext.isEqualTo(true), group: '2_navigation', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		editor?.getContribution<GotoLineController>('editor.contrib.quickAccess')?.open();
	}
}

registerAction2(GotoLineAction);
