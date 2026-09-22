import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { StickyScrollController } from "./stickyScrollController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";

registerEditorContribution({ id: "editor.contrib.stickyScroll", install: context => {
	if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) return;
	return new StickyScrollController(context.editor, context.view, context.getService(TextEditorCapability.folding));
} });
