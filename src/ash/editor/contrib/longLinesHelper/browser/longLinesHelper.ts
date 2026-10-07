import { Disposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor, MouseTargetType } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';

class LongLinesHelper extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.longLinesHelper';
	static get(editor: ICodeEditor): LongLinesHelper | null {
		return editor.getContribution<LongLinesHelper>(LongLinesHelper.ID);
	}

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onMouseDown(event => {
			const limit = editor.getOption(EditorOption.stopRenderingLineAfter);
			if (limit >= 0 && event.target.type === MouseTargetType.CONTENT_TEXT && event.target.position.column >= limit) {
				editor.updateOptions({ stopRenderingLineAfter: -1 });
			}
		}));
	}
}

registerEditorContribution(LongLinesHelper.ID, LongLinesHelper, EditorContributionInstantiation.BeforeFirstInteraction);
