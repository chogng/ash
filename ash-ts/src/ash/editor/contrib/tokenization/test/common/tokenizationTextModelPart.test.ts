import { TokenizationRegistry, type IState, type ILanguageIdCodec, type SyntaxRequest, LanguageDiagnosticSeverity, SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, type SyntaxResult, type SyntaxWorker, type SyntaxLane } from '../../../../common/languages.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { TextModel } from "../../../../common/model/textModel.js";
import { SyntaxProviderRegistry } from '../../../../common/languageFeatureRegistry.js';
import { Range } from '../../../../common/core/range.js';
import { MetadataConsts, StandardTokenType } from '../../../../common/encodedTokenAttributes.js';
import { getStandardTokenTypeAtPosition } from '../../../../common/tokens/lineTokens.js';
import { SynchronousTokenizationUnavailableError } from '../../../../common/tokenizationTextModelPart.js';
import { SparseMultilineTokens } from '../../../../common/tokens/sparseMultilineTokens.js';
import { Emitter } from '../../../../../base/common/event.js';
import { type LanguageTokenResult } from '../../../../common/tokens/languageTokens.js';
import { type LanguageWorkerRequest } from '../../../../common/model/languageRequestCoordinator.js';

test("TextModel owns default line tokens when no syntax provider exists", () => {
	using model = new TextModel("const value = 1;", { languageId: 'typescript' });
	const lineTokens = model.tokenization.getLineTokens(1);
	assert.equal(lineTokens.getCount(), 1);
	assert.equal(lineTokens.getLineContent(), 'const value = 1;');
	assert.equal(lineTokens.getLanguageId(0), 'typescript');
	assert.equal(lineTokens.getStandardTokenType(0), StandardTokenType.Other);
	assert.equal(model.tokenization.hasAccurateTokensForLine(1), true);
	assert.equal(getStandardTokenTypeAtPosition(model, { lineNumber: 1, column: 2 }), StandardTokenType.Other);
});

test('scoped language tokens expose standard comment, string and regex categories', async () => {
	using registry = new SyntaxProviderRegistry();
	const scopes = ['comment.block.demo', 'string.quoted.demo', 'regex.demo', 'regexp.demo', 'notacomment', 'commentary', 'string_value'];
	using registration = registry.register({
		id: 'test.scoped-tokens',
		languageIds: ['scoped'],
		provideTokens: () => ({ tokens: scopes.map((tokenType, index) => ({ range: new Range(index + 1, 1, index + 1, 2), tokenType, modifiers: [] })) }),
	});
	using model = new TextModel(scopes.map(() => 'x').join('\n'), { languageId: 'scoped', tokenization: { syntaxProviderRegistry: registry } });
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
	assert.deepEqual(scopes.map((_, index) => model.tokenization.getLineTokens(index + 1).getStandardTokenType(0)), [
		StandardTokenType.Comment, StandardTokenType.String, StandardTokenType.RegEx, StandardTokenType.RegEx,
		StandardTokenType.Other, StandardTokenType.Other, StandardTokenType.Other,
	]);
});

test("TextModel publishes current provider tokens through the standard and renderer projections", async () => {
	using registry = new SyntaxProviderRegistry();
	let requests = 0;
	using registration = registry.register({
		id: 'test.tokens',
		languageIds: ['typescript'],
		provideTokens: request => {
			requests += 1;
			return { tokens: [{
				range: new Range(1, 1, 1, 8),
				tokenType: 'comment',
				modifiers: [],
			}] };
		},
	});
	using model = new TextModel("comment value", {
		languageId: 'typescript',
		tokenization: { syntaxProviderRegistry: registry, languageIdCodec: codec() },
	});
	const projection = model.tokenization.languageTokens;

	assert.equal(model.tokenization.isCheapToTokenize(1), false);
	assert.equal(getStandardTokenTypeAtPosition(model, { lineNumber: 1, column: 2 }), undefined);
	assert.throws(() => model.tokenization.forceTokenization(1), SynchronousTokenizationUnavailableError);
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));

	assert.equal(requests, 1);
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.Comment);
	assert.equal(getStandardTokenTypeAtPosition(model, { lineNumber: 1, column: 2 }), StandardTokenType.Comment);
	assert.equal(projection.getLineTokens(0)[0]!.tokenType, 'comment');
	assert.equal(projection.textModel, model);
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.Comment);
});

test("model edits invalidate accuracy until the new provider result is accepted", async () => {
	using registry = new SyntaxProviderRegistry();
	using registration = registry.register({
		id: 'test.tokens',
		languageIds: ['typescript'],
		provideTokens: request => ({ tokens: [{
			range: new Range(1, 1, 1, request.snapshot.getText().length + 1),
			tokenType: request.snapshot.getText().startsWith('//') ? 'comment' : 'string',
			modifiers: [],
		}] }),
	});
	using model = new TextModel('"value"', {
		languageId: 'typescript',
		tokenization: { syntaxProviderRegistry: registry, languageIdCodec: codec() },
	});
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.String);

	model.setValue('// value');
	assert.equal(model.tokenization.hasAccurateTokensForLine(1), false);
	assert.equal(getStandardTokenTypeAtPosition(model, { lineNumber: 1, column: 2 }), undefined);
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.Comment);
});

test("Tokenization renderer projection exposes the model-owned empty index", () => {
	using model = new TextModel("const value = 1;");
	const part = model.tokenization.languageTokens;
	assert.equal(part.textModel, model);
	assert.deepEqual(part.lines, []);
});

test('TextModel owns complete and partial sparse semantic tokens', () => {
	using model = new TextModel('abcdef');
	const semanticMetadata = MetadataConsts.SEMANTIC_USE_FOREGROUND | (7 << MetadataConsts.FOREGROUND_OFFSET);
	const tokens = [SparseMultilineTokens.create(1, new Uint32Array([0, 1, 4, semanticMetadata]))];

	model.tokenization.setSemanticTokens(tokens, true);
	assert.equal(model.tokenization.hasCompleteSemanticTokens(), true);
	assert.equal(model.tokenization.hasSomeSemanticTokens(), true);
	const lineTokens = model.tokenization.getLineTokens(1);
	assert.equal(lineTokens.getForeground(lineTokens.findTokenIndexAtOffset(2)), 7);

	model.tokenization.setSemanticTokens(null, false);
	assert.equal(model.tokenization.hasCompleteSemanticTokens(), false);
	assert.equal(model.tokenization.hasSomeSemanticTokens(), false);
	model.tokenization.setPartialSemanticTokens(new Range(1, 1, 1, 5), tokens);
	assert.equal(model.tokenization.hasSomeSemanticTokens(), true);
	assert.equal(model.tokenization.getLineTokens(1).getForeground(model.tokenization.getLineTokens(1).findTokenIndexAtOffset(2)), 7);
});

test('hypothetical tokenization reports the asynchronous backend boundary', async () => {
	using plainModel = new TextModel('value');
	assert.equal(plainModel.tokenization.getTokenTypeIfInsertingCharacter(1, 1, 'x'), StandardTokenType.Other);
	assert.equal(plainModel.tokenization.tokenizeLinesAt(1, ['inserted']), null);

	using registry = new SyntaxProviderRegistry();
	using registration = registry.register({
		id: 'test.async',
		languageIds: ['typescript'],
		provideTokens: () => ({ tokens: [] }),
	});
	using model = new TextModel('value', { languageId: 'typescript', tokenization: { syntaxProviderRegistry: registry } });
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
	assert.throws(() => model.tokenization.getTokenTypeIfInsertingCharacter(1, 1, 'x'), SynchronousTokenizationUnavailableError);
	assert.equal(model.tokenization.tokenizeLinesAt(1, ['inserted']), null);
});

test('TextModel owns the syntax worker lifecycle and reanalyzes language-support changes', async () => {
	using supportChanges = new Emitter<void>();
	let workerCount = 0;
	let disposedWorkerCount = 0;
	let tokenRequestCount = 0;
	const workerFactory = (): SyntaxWorker => {
		workerCount += 1;
		return {
			async run(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>): Promise<SyntaxResult> {
				if (request.lane === SYNTAX_TOKEN_LANE) {
					tokenRequestCount += 1;
					return { lane: SYNTAX_TOKEN_LANE, value: { tokens: [{
						range: new Range(1, 1, 1, request.snapshot.getText().length + 1),
						tokenType: tokenRequestCount === 1 ? 'string' : 'comment',
						modifiers: [],
					}] } };
				}
				return { lane: SYNTAX_DIAGNOSTIC_LANE, value: { diagnostics: [] } };
			},
			dispose(): void { disposedWorkerCount += 1; },
			[Symbol.dispose](): void { this.dispose(); },
		};
	};
	using model = new TextModel('value', {
		languageId: 'typescript',
		tokenization: {
			syntaxService: { workerFactory },
			onDidChangeLanguageSupport: supportChanges.event,
		},
	});

	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.String);
	assert.equal(workerCount, 1);

	supportChanges.fire();
	assert.equal(model.tokenization.hasAccurateTokensForLine(1), false);
	await waitFor(() => tokenRequestCount === 2 && model.tokenization.hasAccurateTokensForLine(1));
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.Comment);
	assert.equal(workerCount, 2);
	assert.equal(disposedWorkerCount, 1);
});

function codec(): ILanguageIdCodec {
	const ids = new Map<string, number>([['plaintext', 1], ['typescript', 2]]);
	const languages = new Map<number, string>([[1, 'plaintext'], [2, 'typescript']]);
	return {
		encodeLanguageId: languageId => {
			const current = ids.get(languageId);
			if (current !== undefined) return current;
			const next = ids.size + 1;
			ids.set(languageId, next);
			languages.set(next, languageId);
			return next;
		},
		decodeLanguageId: languageId => languages.get(languageId) ?? 'plaintext',
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for tokenization');
}

test('registered line tokenizers refresh existing models without clearing diagnostics', async () => {
	using providers = new SyntaxProviderRegistry();
	using diagnostic = providers.register({
		id: 'test.diagnostic', languageIds: ['registry-test'],
		provideDiagnostics: () => ({ diagnostics: [{ range: new Range(1, 1, 1, 2), severity: LanguageDiagnosticSeverity.Warning, message: 'problem' }] }),
	});
	using model = new TextModel('alpha\nbeta', { languageId: 'registry-test', tokenization: { syntaxProviderRegistry: providers } });
	await waitFor(() => model.diagnostics.results.result !== undefined);
	const result = model.diagnostics.results.result;
	const state: IState = { clone() { return this; }, equals(other) { return other === this; } };
	const first = TokenizationRegistry.register('registry-test', {
		getInitialState: () => state,
		tokenize: () => ({ tokens: [{ offset: 0, type: 'comment', language: 'registry-test' }], endState: state }),
	});
	try {
		await waitFor(() => model.tokenization.hasAccurateTokensForLine(2));
		assert.equal(model.tokenization.getLineTokens(2).getStandardTokenType(0), StandardTokenType.Comment);
		model.tokenization.resetTokenization();
		assert.equal(model.diagnostics.results.result, result);
		await waitFor(() => model.tokenization.hasAccurateTokensForLine(2));
	} finally {
		first.dispose();
	}
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.Other);
	assert.equal(model.diagnostics.results.result, result);
	model.setValue('changed');
	assert.equal(model.diagnostics.results.result, undefined);
	await waitFor(() => model.diagnostics.results.result?.modelVersion === model.version);
});

test('line tokenization reuses unchanged lines after a model edit', async () => {
	let scanned = 0;
	const state: IState = { clone() { return this; }, equals(other) { return other === this; } };
	using support = TokenizationRegistry.register('incremental-test', {
		getInitialState: () => state,
		tokenize: () => {
			scanned++;
			return { tokens: [{ offset: 0, type: 'comment', language: 'incremental-test' }], endState: state };
		},
	});
	using model = new TextModel('first\nsecond\nthird', { languageId: 'incremental-test' });
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(3));
	assert.equal(scanned, 3);
	model.applyEdits([{ range: new Range(2, 1, 2, 7), text: 'changed' }]);
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(3));
	assert.equal(scanned, 4);
	assert.equal(model.tokenization.getLineTokens(2).getLineContent(), 'changed');
});


test('async hypothetical tokens are bounded by proposed text and never change live tokens or model state', async () => {
	using registry = new SyntaxProviderRegistry();
	using registration = registry.register({
		id: 'test.preview', languageIds: ['demo'], provideTokens: () => ({ tokens: [] }),
		provideTokensForLines: request => ({ tokens: request.tokenize.lines.map((line, index) => ({
			range: new Range(index + 1, 1, index + 1, line.length + 1), tokenType: 'string', modifiers: [],
		})) }),
	});
	using model = new TextModel('x', { languageId: 'demo', tokenization: { syntaxProviderRegistry: registry } });
	await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
	let changes = 0;
	using listener = model.tokenization.onDidChange(() => changes++);
	const preview = await model.tokenization.tokenizeLinesAtAsync(1, ['long ( string', 'second'], new AbortController().signal);
	assert.deepEqual(preview!.map(line => [line.getLineContent(), line.getStandardTokenType(0)]), [['long ( string', StandardTokenType.String], ['second', StandardTokenType.String]]);
	assert.equal(model.getText(), 'x');
	assert.equal(model.getVersionId(), 1);
	assert.equal(model.tokenization.getLineTokens(1).getStandardTokenType(0), StandardTokenType.Other);
	assert.equal(changes, 0);
});

for (const reason of ['edit', 'language', 'abort', 'dispose'] as const) {
	test(`hypothetical tokenization is discarded after ${reason}`, async () => {
		using registry = new SyntaxProviderRegistry();
		let resolve: ((result: LanguageTokenResult) => void) | undefined;
		using registration = registry.register({
			id: 'test.deferred-preview', languageIds: ['demo'], provideTokens: () => ({ tokens: [] }),
			provideTokensForLines: () => new Promise<LanguageTokenResult>(done => { resolve = done; }),
		});
		using model = new TextModel('x', { languageId: 'demo', tokenization: { syntaxProviderRegistry: registry } });
		await waitFor(() => model.tokenization.hasAccurateTokensForLine(1));
		const controller = new AbortController();
		const pending = model.tokenization.tokenizeLinesAtAsync(1, ['()'], controller.signal);
		await waitFor(() => resolve !== undefined);
		if (reason === 'edit') model.setValue('new');
		if (reason === 'language') model.setLanguage('plaintext');
		if (reason === 'abort') controller.abort();
		if (reason === 'dispose') model.dispose();
		assert.equal(await pending, null);
		resolve!({ tokens: [] });
	});
}

test('hypothetical tokenization reports unavailable lexers and rejects malformed ranges', async () => {
	using plain = new TextModel('x');
	const signal = new AbortController().signal;
	assert.equal(await plain.tokenization.tokenizeLinesAtAsync(1, ['('], signal), null);
	using registry = new SyntaxProviderRegistry();
	using registration = registry.register({ id: 'test.invalid-preview', languageIds: ['demo'], provideTokens: () => ({ tokens: [] }),
		provideTokensForLines: () => ({ tokens: [{ range: new Range(1, 1, 1, 100), tokenType: 'string', modifiers: [] }] }),
	});
	using model = new TextModel('x', { languageId: 'demo', tokenization: { syntaxProviderRegistry: registry } });
	await assert.rejects(model.tokenization.tokenizeLinesAtAsync(1, ['()'], signal), /range|column/i);
	await assert.rejects(model.tokenization.tokenizeLinesAtAsync(1, ['a\nb'], signal), /line endings/);
});
