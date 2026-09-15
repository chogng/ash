import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { HoverController } from "./hoverController.js";
import { LanguageHoverService } from '../common/hover.js';

registerEditorContribution({ id: "editor.contrib.hover", install: context => {
	if (context.kind !== "text") return;
	return new HoverController(context.view, context.register(new LanguageHoverService(context.model, context.languageFeaturesService.hoverProvider, context.options.input.resource)), context.languageId);
} });
