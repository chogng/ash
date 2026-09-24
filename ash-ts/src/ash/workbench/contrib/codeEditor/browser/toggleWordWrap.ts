import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { WordWrapController } from '../../../../editor/contrib/wordWrap/browser/wordWrapController.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { DiffEditorPane } from './diffEditorPane.js';

class ToggleWordWrapAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.toggleWordWrap',
			title: localize2('toggle.wordwrap', 'View: Toggle Word Wrap'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const pane = accessor.getOptional(IEditorPartsService)?.activePane;
		if (pane instanceof DiffEditorPane) {
			pane.toggleWordWrap();
			return;
		}
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		editor?.getContribution<WordWrapController>('editor.contrib.wordWrap')?.toggle();
	}
}

registerAction2(ToggleWordWrapAction);
