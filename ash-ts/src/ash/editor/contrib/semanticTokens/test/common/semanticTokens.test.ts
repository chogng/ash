import assert from "node:assert/strict";
import { test } from "mocha";
import { Range } from "../../../../common/core/range.js";
import { LanguageFeatureRegistry } from "../../../../common/languageFeatureRegistry.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { type LanguageTokenResult } from "../../../../common/tokens/languageTokens.js";
import { SemanticTokenModifier, SemanticTokenPresentation } from '../../../../common/tokens/languageTokens.js';
import { type LanguageSemanticTokensProvider } from '../../../../common/languages.js';

test("TextModel semantic-token owner publishes only current model results", async () => {
	const providers = new LanguageFeatureRegistry<LanguageSemanticTokensProvider>();
	const pending: Array<(value: LanguageTokenResult | undefined) => void> = [];
	using registration = providers.register('typescript', {
		provideSemanticTokens: () => new Promise<LanguageTokenResult | undefined>(resolve => pending.push(resolve)),
	});
	using model = new TextModel("value", { languageId: 'typescript', tokenization: { documentSemanticTokensProvider: providers } });
	const semanticTokens = model.tokenization.semanticTokens!;
	await waitFor(() => pending.length === 1);
	model.setValue('value!');
	await waitFor(() => pending.length === 2);
	pending[0]!({ tokens: [{ range: new Range(1, 1, 1, 6), tokenType: "variable", modifiers: [] }] });
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	assert.deepEqual(semanticTokens.lines, []);

	pending[1]!({ tokens: [{ range: new Range(1, 1, 1, 7), tokenType: "variable", modifiers: [] }] });
	await waitFor(() => semanticTokens.lines.length === 1);
	assert.equal(semanticTokens.getLineTokens(0)[0]!.range.endColumn, 7);
});

test("TextModel semantic-token owner applies provider styling", async () => {
	const providers = new LanguageFeatureRegistry<LanguageSemanticTokensProvider>();
	using registration = providers.register('typescript', {
		provideSemanticTokens: request => ({ tokens: [{ range: new Range(1, 1, 1, request.snapshot.getText().length + 1), tokenType: "variable", modifiers: ["readonly"] }] }),
	});
	using model = new TextModel("value", { languageId: 'typescript', tokenization: { documentSemanticTokensProvider: providers } });
	const semanticTokens = model.tokenization.semanticTokens!;
	await waitFor(() => semanticTokens.lines.length === 1);
	const token = semanticTokens.getLineTokens(0)[0]!;

	assert.equal(token.tokenType, "variable");
	assert.deepEqual(token.modifiers, ["readonly"]);
	assert.deepEqual(semanticTokens.styling.resolve(token), {
		presentation: SemanticTokenPresentation.Variable,
		modifiers: [SemanticTokenModifier.Readonly],
	});
});

test('TextModel owns styled token caching, invalidation and disposal', async () => {
	const providers = new LanguageFeatureRegistry<LanguageSemanticTokensProvider>();
	using registration = providers.register('typescript', {
		provideSemanticTokens: request => ({ tokens: [{ range: new Range(1, 1, 1, request.snapshot.getText().length + 1), tokenType: 'variable', modifiers: [] }] }),
	});
	using model = new TextModel('value', { languageId: 'typescript', tokenization: { documentSemanticTokensProvider: providers } });
	const source = model.tokenization.renderedTokens;
	await waitFor(() => source.getLineTokens(0).length === 1);
	assert.deepEqual(source.getLineTokens(0), [{ startColumn: 0, endColumn: 5, presentation: SemanticTokenPresentation.Variable }]);
	let changes = 0;
	using listener = source.onDidChange(() => { changes += 1; });
	model.setValue('next');
	assert.deepEqual(source.getLineTokens(0), []);
	await waitFor(() => source.getLineTokens(0).length === 1);
	assert.equal(source.getLineTokens(0)[0]!.endColumn, 4);
	assert.ok(changes > 0);
	model.dispose();
	assert.throws(() => source.getLineTokens(0), /already disposed/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for semantic tokens');
}
