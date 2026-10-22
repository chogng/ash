import { registerEditorContribution } from '../../../browser/editorFeatureRegistration.js';
import { ContentHoverController } from './contentHoverController.js';
import { GlyphHoverController } from './glyphHoverController.js';
import './hoverActions.js';

registerEditorContribution({
	id: 'editor.contrib.hover',
	install: context => {
		if (context.kind !== 'text') {
			return;
		}
		return context.instantiationService.createInstance(ContentHoverController, context.view, context.editor, context.onLanguageError);
	},
});

registerEditorContribution({
	id: GlyphHoverController.ID,
	install: context => context.kind === 'text' ? context.instantiationService.createInstance(GlyphHoverController, context.editor) : undefined,
});
