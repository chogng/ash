import { localize2 } from '../../../../nls.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';

class ForceRetokenizeAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.forceRetokenize',
			label: localize2('forceRetokenize', 'Developer: Force Retokenize'),
			precondition: undefined,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		editor.getModel()?.tokenization.resetTokenization();
	}
}

registerEditorAction(ForceRetokenizeAction);
