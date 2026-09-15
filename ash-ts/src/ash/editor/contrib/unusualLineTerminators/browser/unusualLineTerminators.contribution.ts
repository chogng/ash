import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { UnusualLineTerminatorsController } from "./unusualLineTerminatorsController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";

registerEditorContribution({ id: "editor.contrib.unusualLineTerminators", configure: context => {
	const decorations = context.register(new TextDecorationCollection<void>(context.model));
	context.provideCapability(TextEditorCapability.unusualLineTerminatorDecorations, decorations);
}, install: context => {
	if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) return;
	context.register(new UnusualLineTerminatorsController(context.model, context.getCapability(TextEditorCapability.unusualLineTerminatorDecorations)));
} });
