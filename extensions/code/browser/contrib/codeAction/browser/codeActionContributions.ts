import './codeActionCommands.js';
import { registerEditorContribution } from "../../../registration.js";
import { CodeActionController } from "./codeActionController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { TextDecorationCollection } from "../../../../../../src/ash/editor/common/model/decorationCollection.js";
import { type LanguageDiagnostic } from '../../../../../../src/ash/editor/common/languages.js';

registerEditorContribution({
	id: CodeActionController.ID, install: context => {
		if (context.kind !== "text") return;
		const diagnostics = context.getOptionalService(TextEditorCapability.diagnosticDecorations) ?? context.register(new TextDecorationCollection<LanguageDiagnostic>(context.model));
		return context.instantiationService.createInstance(CodeActionController, context.controller.element, context.editor, context.view, diagnostics, context.options.onApplyWorkspaceEdit, context.onLanguageError);
	}
});
