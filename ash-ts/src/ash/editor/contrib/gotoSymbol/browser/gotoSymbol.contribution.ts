import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { GotoSymbolController } from "./gotoSymbolController.js";

registerEditorContribution({ id: "editor.contrib.gotoSymbol", install: context => {
	if (context.kind !== "text") return;
	return context.instantiationService.createInstance(GotoSymbolController,
		context.controller.element,
		context.view,
		context.viewModel,
		context.editor,
		context.onLanguageError,
	);
} });
