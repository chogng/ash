import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { CodeActionController } from "./codeActionController.js";
import { CodeActionService } from '../common/languageCodeActions.js';
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type LanguageDiagnostic } from '../../../common/languages.js';

registerEditorContribution({ id: "editor.contrib.codeAction", install: context => {
	if (context.kind !== "text") return;
	const service = context.register(new CodeActionService(context.model, context.options.input.resource, context.languageFeaturesService.codeActionProvider));
	const diagnostics = context.getOptionalService(TextEditorCapability.diagnosticDecorations) ?? context.register(new TextDecorationCollection<LanguageDiagnostic>(context.model));
	return new CodeActionController(context.controller.element, context.editor, context.view, service, diagnostics, context.languageId, context.options.input.resource, context.options.onApplyWorkspaceEdit, context.onLanguageError);
} });
