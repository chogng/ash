import { localize2 } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { type LanguageHierarchyController } from '../../../../editor/contrib/callHierarchy/browser/languageHierarchyController.js';

class PeekTypeHierarchyAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.showTypeHierarchy',
			label: localize2('typeHierarchy.peek', 'Peek Type Hierarchy'),
			precondition: EditorContextKeys.hasTypeHierarchyProvider.isEqualTo(true),
			contextMenuOpts: { menuId: MenuId.EditorContextPeek, group: 'navigation', order: 1000 },
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await editor.getContribution<LanguageHierarchyController>('editor.contrib.languageHierarchy')?.showTypeHierarchy();
	}
}

registerEditorAction(PeekTypeHierarchyAction);
