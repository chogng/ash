import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { LanguageNavigationController } from "./languageNavigationController.js";

registerEditorContribution({ id: "editor.contrib.languageNavigation", install: context => {
	if (context.kind !== "text") return;
	return context.instantiationService.createInstance(LanguageNavigationController,
		context.controller.element,
		context.editor,
		context.view,
		context.options.input.resource,
		context.options.onOpenLocation,
		context.onLanguageError,
	);
} });
