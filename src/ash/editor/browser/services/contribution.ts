import { EditorContributionInstantiation, registerEditorContribution } from '../editorExtensions.js';
import { MarkerDecorationsContribution } from './markerDecorations.js';

registerEditorContribution({
	id: MarkerDecorationsContribution.ID,
	instantiation: EditorContributionInstantiation.Eager,
	install: context => {
		if (context.kind !== 'text') {
			return;
		}
		return context.instantiationService.createInstance(MarkerDecorationsContribution, context.editor, context.options.languageDiagnosticsService);
	},
});
