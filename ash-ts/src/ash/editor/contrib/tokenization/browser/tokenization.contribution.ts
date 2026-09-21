import { registerEditorContribution } from "../../../browser/editorExtensions.js";

registerEditorContribution({ id: "editor.contrib.tokenization", configure: context => {
	context.setSemanticTokenSource(context.model.tokenization.renderedTokens);
}, install: context => {
	if (context.kind !== "text") return;
	const update = () => context.view.domNode.domNode.classList.toggle('tokens-ready', context.model.tokenization.modelVersion === context.model.version && context.model.tokenization.tokenCount > 0);
	context.register(context.model.tokenization.onDidChange(update));
	update();
} });
