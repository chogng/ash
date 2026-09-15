import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { FindController } from "./findController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";

registerEditorContribution({
	id: FindController.ID,
	configure: context => {
		const decorations = context.register(new TextDecorationCollection<void>(context.model));
		context.provideCapability(TextEditorCapability.searchDecorations, decorations);
	},
	install: context => {
		if (context.kind !== "text") return;
		context.register(new FindController(context.controller.element, context.editor, context.view, context.getCapability(TextEditorCapability.searchDecorations), context.options.find));
	},
});
