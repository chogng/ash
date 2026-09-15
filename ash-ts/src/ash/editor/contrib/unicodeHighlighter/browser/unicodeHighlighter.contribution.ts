import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { UnicodeHighlighterController } from "./unicodeHighlighterController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type UnicodeHighlight } from "../common/unicodeHighlights.js";

registerEditorContribution({ id: "editor.contrib.unicodeHighlighter", configure: context => {
	if (context.options.showUnicodeHighlights === false) return;
	const decorations = context.register(new TextDecorationCollection<UnicodeHighlight>(context.model));
	context.provideCapability(TextEditorCapability.unicodeDecorations, decorations);
}, install: context => {
	if (context.kind !== "text" || context.options.showUnicodeHighlights === false || context.model.largeFile.tooLargeForTokenization) return;
	context.register(new UnicodeHighlighterController(context.model, context.getCapability(TextEditorCapability.unicodeDecorations), context.editorWorker, context.onLanguageError));
} });
