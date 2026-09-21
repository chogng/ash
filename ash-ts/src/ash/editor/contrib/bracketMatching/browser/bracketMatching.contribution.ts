import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { LanguageBracketColorizationSource } from './bracketColorizationPresentation.js';
import { BracketMatchingController } from './bracketMatching.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';

registerEditorContribution({
	id: BracketMatchingController.ID,
	configure: context => {
		const largeFile = context.model.largeFile.tooLargeForTokenization;
		const colorizeBrackets = context.options.bracketPairColorization?.enabled !== false;
		const renderBracketGuides = context.options.guides?.bracketPairs !== undefined && context.options.guides.bracketPairs !== false;
		if (!largeFile && (colorizeBrackets || renderBracketGuides)) {
			context.setBracketColorizationSource(new LanguageBracketColorizationSource(context.model, colorizeBrackets));
		}
	},
	install: context => {
		if (context.kind !== 'text') return;
		const bracketPairs = context.model.bracketPairs;
		const controller = new BracketMatchingController(
			context.editor,
			bracketPairs,
			context.register(new TextDecorationCollection<void>(context.model)),
			context.options.matchBrackets ?? 'always',
		);
		context.register(controller);
		context.register(context.editor.onKeyDown(event => {
			if (event.browserEvent.defaultPrevented || event.isComposing || event.browserEvent.getModifierState('AltGraph') || (!event.ctrlKey && !event.metaKey)) return;
			if (event.shiftKey && !event.altKey && event.keyCode === KeyCode.Backslash) {
				event.stop();
				controller.jumpToBracket();
			} else if (event.altKey && !event.shiftKey && event.key === 'Backspace') {
				if (context.editor.getOption(EditorOption.readOnly)) return;
				const selections = context.editor.getSelections() ?? [];
				if (!selections.some(selection => selection.isEmpty() && (bracketPairs.matchBracket(selection.getPosition()) || bracketPairs.findEnclosingBrackets(selection.getPosition())))) return;
				event.stop();
				context.executeCommand('editor.action.removeBrackets', () => controller.removeBrackets('editor.action.removeBrackets'));
			}
		}));
		return controller;
	},
});
