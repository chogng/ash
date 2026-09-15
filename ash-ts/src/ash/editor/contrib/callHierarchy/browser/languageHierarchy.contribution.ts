import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { LanguageHierarchyController } from "./languageHierarchyController.js";
import { LanguageHierarchyService } from '../common/languageHierarchy.js';

registerEditorContribution({ id: "editor.contrib.languageHierarchy", install: context => {
	if (context.kind !== "text") return;
	const service = context.register(new LanguageHierarchyService(context.model, context.options.input.resource, context.languageFeaturesService.callHierarchyProvider, context.languageFeaturesService.typeHierarchyProvider));
	context.register(new LanguageHierarchyController(
		context.controller.element,
		context.editor,
		context.view,
		service,
		context.options.input.resource,
		context.languageId,
		context.options.onOpenLocation,
		context.onLanguageError,
	));
} });
