import { onActivate, registerEditorContribution } from '../../../browser/editorFeatureRegistration.js';
import { ContentHoverController } from './contentHoverController.js';
import { GlyphHoverController } from './glyphHoverController.js';
import './hoverActions.js';
import { HoverParticipantRegistry } from './hoverTypes.js';
import { MarkdownHoverParticipant } from './markdownHoverParticipant.js';

onActivate(() => HoverParticipantRegistry.register(MarkdownHoverParticipant));

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
