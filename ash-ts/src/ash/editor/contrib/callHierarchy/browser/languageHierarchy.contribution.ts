import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { LanguageHierarchyController } from "./languageHierarchyController.js";

registerEditorContribution({ id: "editor.contrib.languageHierarchy", install: context => {
	if (context.kind !== "text") return;
	return context.instantiationService.createInstance(LanguageHierarchyController,
		context.controller.element,
		context.editor,
		context.view,
		context.options.input.resource,
		context.options.onOpenLocation,
		context.onLanguageError,
	);
} });
