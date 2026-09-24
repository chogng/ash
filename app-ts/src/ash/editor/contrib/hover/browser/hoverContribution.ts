import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { ContentHoverController } from './contentHoverController.js';

registerEditorContribution({
	id: 'editor.contrib.hover',
	install: context => {
		if (context.kind !== 'text') {
			return;
		}
		return context.instantiationService.createInstance(ContentHoverController, context.view, context.editor, context.onLanguageError);
	},
});
