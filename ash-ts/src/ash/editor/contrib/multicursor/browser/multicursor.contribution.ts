import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { MultiCursorController } from "./multiCursorController.js";
import { OccurrenceSelectionController } from "./occurrenceSelectionController.js";
import { SelectionHighlighter } from "./multicursor.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";

registerEditorContribution({ id: "editor.contrib.multicursor", install: context => {
	if (context.kind !== "text") return;
	context.register(new MultiCursorController(context.controller.element, context.view, context.viewModel));
	context.register(new OccurrenceSelectionController(context.controller.element, context.view, context.viewModel));
} });

registerEditorContribution({ id: SelectionHighlighter.ID, install: context => {
	if (context.kind !== "text") return;
	const decorations = context.register(new TextDecorationCollection<boolean>(context.model));
	if (!context.model.largeFile.tooLargeForTokenization) {
		return new SelectionHighlighter(
			context.editor,
			decorations,
			{
				languageId: context.languageId,
				languageFeaturesService: context.languageFeaturesService,
				enabled: context.options.selectionHighlight,
				multiline: context.options.selectionHighlightMultiline,
				maxLength: context.options.selectionHighlightMaxLength,
				occurrenceHighlights: context.options.occurrencesHighlight !== "off",
			},
		);
	}
} });
