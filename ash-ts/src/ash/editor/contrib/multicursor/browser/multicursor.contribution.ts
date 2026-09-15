import { type EditorCapability, registerTextEditorCapabilityContribution } from "../../../browser/editorExtensions.js";
import { MultiCursorController } from "./multiCursorController.js";
import { OccurrenceSelectionController } from "./occurrenceSelectionController.js";
import { SelectionHighlighter } from "./multicursor.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";

const selectionHighlightDecorations: EditorCapability<TextDecorationCollection<boolean>> = Object.freeze({ id: "editor.capability.selectionHighlightDecorations" });

registerTextEditorCapabilityContribution({ id: "editor.contrib.multicursor", install: context => {
	if (context.kind !== "text") return;
	context.register(new MultiCursorController(context.controller.element, context.view, context.viewModel));
	context.register(new OccurrenceSelectionController(context.controller.element, context.view, context.viewModel));
} });

registerTextEditorCapabilityContribution({ id: SelectionHighlighter.ID, configure: context => {
	const decorations = context.register(new TextDecorationCollection<boolean>(context.model));
	context.provideCapability(selectionHighlightDecorations, decorations);
}, install: context => {
	if (context.kind !== "text") return;
	if (!context.model.largeFile.tooLargeForTokenization) {
		context.register(new SelectionHighlighter(
			context.editor,
			context.getCapability(selectionHighlightDecorations),
			{
				languageId: context.languageId,
				languageFeaturesService: context.languageFeaturesService,
				enabled: context.options.selectionHighlight,
				multiline: context.options.selectionHighlightMultiline,
				maxLength: context.options.selectionHighlightMaxLength,
				occurrenceHighlights: context.options.occurrencesHighlight !== "off",
			},
		));
	}
} });
