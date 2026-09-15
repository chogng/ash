import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { UnicodeHighlighterController } from "./unicodeHighlighterController.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type UnicodeHighlight } from "../common/unicodeHighlights.js";

registerEditorContribution({ id: "editor.contrib.unicodeHighlighter", install: context => {
	if (context.kind !== "text" || context.options.showUnicodeHighlights === false || context.model.largeFile.tooLargeForTokenization) return;
	const decorations = context.register(new TextDecorationCollection<UnicodeHighlight>(context.model));
	return new UnicodeHighlighterController(context.model, decorations, context.editorWorker, context.onLanguageError);
} });
