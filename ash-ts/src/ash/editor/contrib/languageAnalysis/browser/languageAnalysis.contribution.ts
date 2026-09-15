import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { LanguageDiagnosticDecorationBridge, LanguageDiagnosticPublisherBridge } from "../../gotoError/common/diagnosticDecorations.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { LanguageLexicalContextIndex, TokenAwareLanguageLexicalContext } from '../../../common/languages/languageLexicalContext.js';

registerEditorContribution({
	id: "editor.contrib.languageAnalysis",
	configure: context => {
		const syntax = context.model.tokenization.syntaxService;
		const tokenization = context.model.tokenization.languageTokens;
		context.register(context.model.tokenization.onDidEncounterError(context.onLanguageError));
		const lexicalFallback = context.register(new LanguageLexicalContextIndex(context.model, context.languageId, context.configurations));
		const lexicalContext = context.register(new TokenAwareLanguageLexicalContext(lexicalFallback, tokenization, context.configurations));
		const languageDiagnostics = context.options.languageDiagnosticsService;
		if (languageDiagnostics) context.register(languageDiagnostics.acquire(context.options.input.resource, context.languageId, context.model));
		if (languageDiagnostics) context.register(new LanguageDiagnosticPublisherBridge(syntax.diagnostics, languageDiagnostics.createPublisher(context.options.input.resource)));
		const diagnostics = context.register(new LanguageDiagnosticDecorationBridge(syntax.diagnostics, languageDiagnostics, context.options.input.resource, context.renderDiagnosticDecorations));
		context.provideCapability(TextEditorCapability.languageLexicalContext, lexicalContext);
		context.provideCapability(TextEditorCapability.diagnosticDecorations, diagnostics.decorations);
		context.setLanguageLexicalContext(lexicalContext);
	},
});
