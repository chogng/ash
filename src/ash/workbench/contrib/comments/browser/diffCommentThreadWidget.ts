import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING, type CommentThreadStyle } from '../common/commentsConfiguration.js';
import { CommentThreadEditorWidget, type ICommentThreadEditorWidgetOptions } from './commentThreadEditorWidget.js';
import { ReviewFloatingWidget } from './commentThreadFloatingWidget.js';
import { ReviewZoneWidget, type IReviewZoneComparison } from './commentThreadZoneWidget.js';

/** A diff-side comment thread whose placement follows the shared review setting. */
export class DiffCommentThreadWidget extends CommentThreadEditorWidget {
	constructor(editor: ICodeEditor, options: ICommentThreadEditorWidgetOptions, comparison: IReviewZoneComparison,
		@IConfigurationService configuration: IConfigurationService,
	) {
		const inline = new ReviewZoneWidget(editor, comparison);
		const floating = new ReviewFloatingWidget(editor);
		const presentation = () => configuration.getValue<CommentThreadStyle>(COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING) === 'floating' ? floating : inline;
		super(editor, options, presentation());
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING)) this.setPresentation(presentation());
		}));
	}
}
