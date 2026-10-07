import { registerEditorContribution } from "../browser/editorExtensions.js";
import { FormattingContribution } from "./formatting/browser/formattingContribution.js";

registerEditorContribution({
	id: "editor.contrib.documentFormatting",
	install: context => {
		if (context.kind !== "document") return;
		context.setFormattingContribution(new FormattingContribution(context.container, {
			documentActions: context.documentActions,
			onToggleMark: context.onToggleMark,
			onSetTextStyle: context.onSetTextStyle,
			onClearTextStyle: context.onClearTextStyle,
			onRunDocumentAction: context.onRunDocumentAction,
		}));
	},
});
