import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageLexicalSyntaxCache, type LanguageLexicalCacheUpdate } from "../../common/languages/languageLexicalSyntaxCache.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Lexical token and diagnostic lanes share one versioned cache", () => {
	using model = new TextModel("const first = 1;\nconst second = 2;\nreturn first + second;");
	const updates: LanguageLexicalCacheUpdate[] = [];
	const cache = new LanguageLexicalSyntaxCache({ onDidUpdate: update => updates.push(update) });
	const signal = new AbortController().signal;

	cache.getTokens(model.createVersionedSnapshot(), signal);
	cache.getDiagnostics(model.createVersionedSnapshot(), signal);

	assert.deepEqual(updates, [{
		modelVersion: 1,
		kind: "full",
		scannedLineCount: 3,
		reusedLineCount: 0,
	}]);

	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(25), model.positionAt(31)),
		text: "answer",
	}]);
	cache.getDiagnostics(model.createVersionedSnapshot(), signal);
	cache.getTokens(model.createVersionedSnapshot(), signal);

	assert.deepEqual(updates[1], {
		modelVersion: 2,
		kind: "incremental",
		scannedLineCount: 1,
		reusedLineCount: 2,
	});
});

test("Lexical multiline state propagates only until the cached suffix converges", () => {
	using model = new TextModel("let value = 1;\ninside\n*/ const after = 2;\nreturn after;");
	const updates: LanguageLexicalCacheUpdate[] = [];
	const cache = new LanguageLexicalSyntaxCache({ onDidUpdate: update => updates.push(update) });
	const signal = new AbortController().signal;
	cache.getTokens(model.createVersionedSnapshot(), signal);

	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(0)),
		text: "/* ",
	}]);
	const tokens = cache.getTokens(model.createVersionedSnapshot(), signal);
	const diagnostics = cache.getDiagnostics(model.createVersionedSnapshot(), signal);

	assert.deepEqual(updates[1], {
		modelVersion: 2,
		kind: "incremental",
		scannedLineCount: 3,
		reusedLineCount: 1,
	});
	assert.deepEqual(tokens.tokens.filter(token => token.range.getStartPosition().lineNumber === 1).map(token => token.tokenType), ["comment"]);
	assert.deepEqual(tokens.tokens.filter(token => token.range.startLineNumber === 3).map(token => token.tokenType), ["comment", "keyword", "variable", "operator", "number"]);
	assert.deepEqual(diagnostics.diagnostics, []);
});

test("Lexical incremental analysis respects a large-document scan budget", () => {
	const lines = Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};`);
	using model = new TextModel(lines.join("\n"));
	const updates: LanguageLexicalCacheUpdate[] = [];
	const cache = new LanguageLexicalSyntaxCache({ onDidUpdate: update => updates.push(update) });
	const signal = new AbortController().signal;
	cache.getTokens(model.createVersionedSnapshot(), signal);

	const line = 517;
	const lineStart = lines.slice(0, line).reduce((offset, value) => offset + value.length + 1, 0);
	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(lineStart + 6), model.positionAt(lineStart + 11)),
		text: "item",
	}]);
	cache.getTokens(model.createVersionedSnapshot(), signal);

	assert.equal(updates[1]!.scannedLineCount, 1);
	assert.equal(updates[1]!.reusedLineCount, 999);
});

test("Lexical incremental results stay equal to a fresh full-scan oracle", () => {
	using model = new TextModel("const value = `start\nmiddle\nend`;\nif (value) {\n  return 1;\n}");
	const cache = new LanguageLexicalSyntaxCache();
	const signal = new AbortController().signal;
	let seed = 0x5eed1234;
	const insertions = ["x", " ", "\n", "/*", "*/", "`", "'", "(", ")", "const"];
	cache.getTokens(model.createVersionedSnapshot(), signal);

	for (let iteration = 0; iteration < 120; iteration += 1) {
		const length = model.getText().length;
		const startOffset = randomInteger(length + 1);
		const removedLength = Math.min(randomInteger(4), length - startOffset);
		model.applyEdits([{
			range: Range.fromPositions(model.positionAt(startOffset), model.positionAt(startOffset + removedLength)),
			text: insertions[randomInteger(insertions.length)]!,
		}]);
		const snapshot = model.createVersionedSnapshot();
		const incrementalTokens = cache.getTokens(snapshot, signal);
		const incrementalDiagnostics = cache.getDiagnostics(snapshot, signal);
		const oracle = new LanguageLexicalSyntaxCache();
		assert.deepEqual(serializeTokens(incrementalTokens.tokens), serializeTokens(oracle.getTokens(snapshot, signal).tokens));
		assert.deepEqual(serializeDiagnostics(incrementalDiagnostics.diagnostics), serializeDiagnostics(oracle.getDiagnostics(snapshot, signal).diagnostics));
	}

	function randomInteger(limit: number): number {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed % limit;
	}
});

function serializeTokens(tokens: ReturnType<LanguageLexicalSyntaxCache["getTokens"]>["tokens"]): readonly unknown[] {
	return tokens.map(token => [
		token.range.getStartPosition().lineNumber,
		token.range.getStartPosition().column,
		token.range.getEndPosition().lineNumber,
		token.range.getEndPosition().column,
		token.tokenType,
		token.modifiers,
	]);
}

function serializeDiagnostics(diagnostics: ReturnType<LanguageLexicalSyntaxCache["getDiagnostics"]>["diagnostics"]): readonly unknown[] {
	return diagnostics.map(diagnostic => [
		diagnostic.range.getStartPosition().lineNumber,
		diagnostic.range.getStartPosition().column,
		diagnostic.range.getEndPosition().lineNumber,
		diagnostic.range.getEndPosition().column,
		diagnostic.severity,
		diagnostic.message,
		diagnostic.source,
	]);
}
