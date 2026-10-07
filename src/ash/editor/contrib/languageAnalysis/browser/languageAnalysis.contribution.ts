import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { LanguageDiagnosticDecorationBridge, LanguageDiagnosticPublisherBridge } from "../../gotoError/common/diagnosticDecorations.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";

registerEditorContribution({
	id: "editor.contrib.languageAnalysis",
	configure: context => {
		const diagnosticsSource = context.model.diagnostics;
		context.register(diagnosticsSource.onDidEncounterError(context.onLanguageError));
		context.register(context.model.tokenization.onDidEncounterError(context.onLanguageError));
		const languageDiagnostics = context.options.languageDiagnosticsService;
		if (languageDiagnostics) context.register(languageDiagnostics.acquire(context.model.uri, context.model.getLanguageId(), context.model));
		if (languageDiagnostics) context.register(new LanguageDiagnosticPublisherBridge(diagnosticsSource.results, languageDiagnostics.createPublisher(context.model.uri)));
		const diagnostics = context.register(new LanguageDiagnosticDecorationBridge(diagnosticsSource.results, languageDiagnostics, context.model.uri, context.renderDiagnosticDecorations));
		context.provideService(TextEditorCapability.diagnosticDecorations, diagnostics.decorations);
	},
});
