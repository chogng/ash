import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { UnusualLineTerminatorsController } from "./unusualLineTerminatorsController.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";

registerEditorContribution({ id: "editor.contrib.unusualLineTerminators", install: context => {
	if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) return;
	const decorations = context.register(new TextDecorationCollection<void>(context.model));
	context.register(new UnusualLineTerminatorsController(context.model, decorations));
} });
