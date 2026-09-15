import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { FindController } from "./findController.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";

registerEditorContribution({
	id: FindController.ID,
	install: context => {
		if (context.kind !== "text") return;
		const decorations = context.register(new TextDecorationCollection<void>(context.model));
		return new FindController(context.controller.element, context.editor, context.view, decorations, context.options.find);
	},
});
