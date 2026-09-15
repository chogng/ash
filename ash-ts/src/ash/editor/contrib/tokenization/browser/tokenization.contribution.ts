import { registerEditorContribution } from "../../../browser/editorExtensions.js";

registerEditorContribution({ id: "editor.contrib.tokenization", configure: context => {
	const styling = context.resolvedSemanticTokensService;
	const lexicalSource = styling.createSource(context.model.tokenization.languageTokens);
	const semanticTokens = context.model.tokenization.semanticTokens;
	const source = semanticTokens ? styling.createOverlay(lexicalSource, styling.createSource(semanticTokens, semanticTokens.styling)) : lexicalSource;
	context.setSemanticTokenSource(source);
}, install: context => {
	if (context.kind !== "text") return;
	const update = () => context.view.domNode.domNode.classList.toggle('tokens-ready', context.model.tokenization.modelVersion === context.model.version && context.model.tokenization.tokenCount > 0);
	context.register(context.model.tokenization.onDidChange(update));
	update();
} });
