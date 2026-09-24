import { localize2 } from '../../../../../nls.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { GotoLineController } from '../../../../../editor/contrib/quickAccess/browser/quickAccessController.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';

class GotoLineAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.gotoLine',
			title: localize2('gotoLine', 'Go to Line/Column...'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		editor?.getContribution<GotoLineController>('editor.contrib.quickAccess')?.open();
	}
}

registerAction2(GotoLineAction);
