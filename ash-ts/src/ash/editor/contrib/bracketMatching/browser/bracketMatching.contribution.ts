import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { LanguageBracketPairs } from '../../../common/languages/languageBracketPairs.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { TextEditorCapability } from '../../textEditorCapabilities.js';
import { LanguageBracketColorizationSource } from './bracketColorizationPresentation.js';
import { BracketEditingController, RemoveBracketsCommandId } from './bracketEditingController.js';
import { BracketMatchController } from './bracketMatchController.js';
import { BracketNavigationController } from './bracketNavigationController.js';

registerEditorContribution({
	id: 'editor.contrib.bracketMatching',
	commands: [{ id: RemoveBracketsCommandId, canTriggerInlineEdits: true }],
	configure: context => {
		const lexicalContext = context.getCapability(TextEditorCapability.languageLexicalContext);
		const largeFile = context.model.largeFile.tooLargeForTokenization;
		const bracketPairs = context.register(new LanguageBracketPairs(context.model, lexicalContext));
		const decorations = context.register(new TextDecorationCollection<void>(context.model));
		context.provideCapability(TextEditorCapability.bracketPairs, bracketPairs);
		context.provideCapability(TextEditorCapability.bracketDecorations, decorations);
		const colorizeBrackets = context.options.bracketPairColorization?.enabled !== false;
		const renderBracketGuides = context.options.guides?.bracketPairs !== undefined && context.options.guides.bracketPairs !== false;
		if (!largeFile && (colorizeBrackets || renderBracketGuides)) {
			context.setBracketColorizationSource(new LanguageBracketColorizationSource(bracketPairs, colorizeBrackets));
		}
	},
	install: context => {
		if (context.kind !== 'text') return;
		const bracketPairs = context.getCapability(TextEditorCapability.bracketPairs);
		context.register(new BracketMatchController(
			context.editor,
			bracketPairs,
			context.getCapability(TextEditorCapability.bracketDecorations),
			context.options.matchBrackets ?? 'always',
		));
		context.register(new BracketNavigationController(
			context.controller.element,
			context.view,
			context.viewModel,
			bracketPairs,
		));
		context.register(new BracketEditingController(context.controller.element, context.view, context.selectionController, bracketPairs, context.executeCommand));
	},
});
