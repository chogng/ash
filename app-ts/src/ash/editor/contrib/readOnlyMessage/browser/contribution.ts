import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import type { IEditorContribution } from '../../../common/editorCommon.js';
import { MessageController } from '../../message/browser/messageController.js';

/** Turns rejected read-only edits into an editor-positioned explanation. */
export class ReadOnlyMessageController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.readOnlyMessageController';

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onDidAttemptReadOnlyEdit(() => this.showMessage()));
	}

	private showMessage(): void {
		const controller = MessageController.get(this.editor);
		const position = this.editor.getPosition();
		if (!controller || !position) return;
		const message = this.editor.getOption(EditorOption.readOnlyMessage)
			?? new MarkdownString(nls.localize('editor.readonly', 'Cannot edit in read-only editor'));
		controller.showMessage(message, position);
	}
}

registerEditorContribution(ReadOnlyMessageController.ID, ReadOnlyMessageController, EditorContributionInstantiation.BeforeFirstInteraction);
