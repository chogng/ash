import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { LanguageNavigationController } from "./languageNavigationController.js";
import { LanguageNavigationService } from '../common/languageNavigation.js';

registerEditorContribution({ id: "editor.contrib.languageNavigation", install: context => {
	if (context.kind !== "text") return;
	const service = context.register(new LanguageNavigationService(context.model, context.options.input.resource, {
		definitions: context.languageFeaturesService.definitionProvider,
		declarations: context.languageFeaturesService.declarationProvider,
		implementations: context.languageFeaturesService.implementationProvider,
		typeDefinitions: context.languageFeaturesService.typeDefinitionProvider,
		references: context.languageFeaturesService.referenceProvider,
	}));
	return context.instantiationService.createInstance(LanguageNavigationController,
		context.controller.element,
		context.editor,
		context.view,
		service,
		context.options.input.resource,
		context.languageId,
		context.options.onOpenLocation,
		context.onLanguageError,
	);
} });
