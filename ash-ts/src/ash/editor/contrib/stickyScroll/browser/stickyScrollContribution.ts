import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { StickyScrollController } from "./stickyScrollController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";

registerEditorContribution({ id: "editor.contrib.stickyScroll", install: context => {
	if (context.kind !== "text" || context.options.stickyScroll?.enabled === false || context.model.largeFile.tooLargeForTokenization) return;
	return new StickyScrollController(context.view, context.getService(TextEditorCapability.folding));
} });
