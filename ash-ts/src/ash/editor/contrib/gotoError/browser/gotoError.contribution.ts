import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { DiagnosticNavigationController } from "./gotoError.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";

registerEditorContribution({ id: "editor.contrib.gotoError", install: context => {
	if (context.kind !== "text") return;
	return new DiagnosticNavigationController(
		context.controller.element,
		context.view,
		context.viewModel,
		context.getService(TextEditorCapability.diagnosticDecorations),
	);
} });
