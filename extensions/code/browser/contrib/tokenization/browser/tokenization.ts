import { localize2 } from '../../../../../../src/ash/nls.js';
import type { ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction, type ServicesAccessor } from '../../../registration.js';

export class ForceRetokenizeAction extends EditorAction {
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
