import './codeActionCommands.js';
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { CodeActionController } from "./codeActionController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type LanguageDiagnostic } from '../../../common/languages.js';

registerEditorContribution({ id: CodeActionController.ID, install: context => {
	if (context.kind !== "text") return;
	const diagnostics = context.getOptionalService(TextEditorCapability.diagnosticDecorations) ?? context.register(new TextDecorationCollection<LanguageDiagnostic>(context.model));
	return context.instantiationService.createInstance(CodeActionController, context.controller.element, context.editor, context.view, diagnostics, context.options.onApplyWorkspaceEdit, context.onLanguageError);
} });
