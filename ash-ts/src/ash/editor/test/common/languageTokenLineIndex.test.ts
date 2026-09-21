import { strict as assert } from "node:assert";
import { test } from "mocha";
import { syntaxWireCodec } from '../../common/services/editorWorkerWire.js';
import { SYNTAX_TOKEN_LANE, type SyntaxResult } from '../../common/languages.js';
import { testTokens } from './testSyntaxProvider.js';
import { LanguageResultAcceptance, LanguageResultStoreChangeReason } from '../../common/model/languageResultStore.js';
import { LanguageTokenLineIndex } from "../../common/tokens/languageTokenLineIndex.js";
import { attachLanguageTokenResultDelta } from '../../common/services/semanticTokensDto.js';
import { createLanguageTokenSnapshotNormalizer, createLanguageTokenStore, type LanguageToken } from '../../common/tokens/languageTokens.js';
import { type LanguageWorkerWireResultState } from '../../common/services/languageWorkerWire.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Token line index groups sparse lines and answers constant-time line queries", () => {
	using model = new TextModel("const one = 1;\n\nreturn one;");
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, [
		token(0, 0, 5, "keyword"),
		token(0, 6, 9, "variable"),
		token(0, 12, 13, "number"),
		token(2, 0, 6, "keyword"),
		token(2, 7, 10, "variable"),
	]);
	using index = new LanguageTokenLineIndex(store);

	assert.equal(index.textModel, model);
	assert.equal(index.modelVersion, 1);
	assert.equal(index.requestId, 1);
	assert.equal(index.tokenCount, 5);
	assert.deepEqual(index.lines.map(line => ({
		lineIndex: line.lineIndex,
		tokenTypes: line.tokens.map(entry => entry.tokenType),
	})), [
		{ lineIndex: 0, tokenTypes: ["keyword", "variable", "number"] },
		{ lineIndex: 2, tokenTypes: ["keyword", "variable"] },
	]);
	assert.equal(index.getLineTokens(0), index.lines[0]!.tokens);
	assert.deepEqual(index.getLineTokens(1), []);
	assert.equal(index.getLineTokens(2), index.lines[1]!.tokens);
});

test("Token line index replaces same-version results atomically", () => {
	using model = new TextModel("abc\ndef");
	using store = createLanguageTokenStore(model);
	using index = new LanguageTokenLineIndex(store);
	const events: unknown[] = [];
	using listener = index.onDidChange(event => events.push(event));

	acceptTokens(store, model, 1, [token(0, 0, 1, "first")]);
	acceptTokens(store, model, 2, [token(1, 1, 3, "second")]);

	assert.deepEqual(index.getLineTokens(0), []);
	assert.deepEqual(index.getLineTokens(1).map(entry => entry.tokenType), ["second"]);
	assert.deepEqual(events, [{
		reason: LanguageResultStoreChangeReason.Result,
		modelVersion: 1,
		requestId: 1,
		tokenCount: 1,
		rebuiltLineCount: 1,
		reusedLineCount: 0,
	}, {
		reason: LanguageResultStoreChangeReason.Result,
		modelVersion: 1,
		requestId: 2,
		tokenCount: 1,
		rebuiltLineCount: 1,
		reusedLineCount: 0,
	}]);
});

test("Model changes invalidate token lines before consumers observe new text", () => {
	using model = new TextModel("abc");
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, [token(0, 0, 3, "word")]);
	using index = new LanguageTokenLineIndex(store);
	const events: unknown[] = [];
	using listener = index.onDidChange(event => events.push({
		event,
		text: model.getText(),
		tokens: index.getLineTokens(0),
	}));

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "X",
	}]);

	assert.equal(store.result, undefined);
	assert.equal(index.modelVersion, 2);
	assert.equal(index.requestId, undefined);
	assert.equal(index.tokenCount, 0);
	assert.deepEqual(index.lines, []);
	assert.deepEqual(events, [{
		event: {
			reason: LanguageResultStoreChangeReason.ModelChanged,
			modelVersion: 2,
			requestId: undefined,
			tokenCount: 0,
			rebuiltLineCount: 0,
			reusedLineCount: 0,
		},
		text: "Xabc",
		tokens: [],
	}]);
});

test("Model changes preserve unaffected token lines and shift later lines", () => {
	using model = new TextModel("alpha\nmiddle\nomega");
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, [
		token(0, 0, 5, "first"),
		token(1, 0, 6, "changed"),
		token(2, 0, 5, "last"),
	]);
	using index = new LanguageTokenLineIndex(store);
	const firstLine = index.lines[0];
	const events: unknown[] = [];
	using listener = index.onDidChange(event => events.push(event));

	model.applyEdits([{
		range: Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (6) + 1)),
		text: "changed\ninserted",
	}]);
	model.applyEdits([{
		range: Range.fromPositions(new Position((2) + 1, (8) + 1)),
		text: "\n",
	}]);

	assert.equal(store.result, undefined);
	assert.equal(index.modelVersion, 3);
	assert.equal(index.requestId, undefined);
	assert.equal(index.tokenCount, 2);
	assert.equal(index.lines[0], firstLine);
	assert.deepEqual(index.lines.map(line => line.lineIndex), [0, 4]);
	assert.deepEqual(index.getLineTokens(0).map(entry => entry.tokenType), ["first"]);
	assert.deepEqual(index.getLineTokens(1), []);
	assert.deepEqual(index.getLineTokens(4).map(entry => entry.tokenType), ["last"]);
	assert.deepEqual(events.map(event => ({
		reason: (event as { readonly reason: LanguageResultStoreChangeReason }).reason,
		tokenCount: (event as { readonly tokenCount: number }).tokenCount,
		reusedLineCount: (event as { readonly reusedLineCount: number }).reusedLineCount,
	})), [{
		reason: LanguageResultStoreChangeReason.ModelChanged,
		tokenCount: 2,
		reusedLineCount: 2,
	}, {
		reason: LanguageResultStoreChangeReason.ModelChanged,
		tokenCount: 2,
		reusedLineCount: 2,
	}]);
});

test("Token line index validates queries and owns neither store nor model", () => {
	using model = new TextModel("abc");
	using store = createLanguageTokenStore(model);
	const index = new LanguageTokenLineIndex(store);

	assert.throws(() => index.getLineTokens(-1), /non-negative safe integer/);
	assert.throws(() => index.getLineTokens(1), /lineNumber/);
	index.dispose();
	assert.throws(() => index.lines, /already disposed/);

	acceptTokens(store, model, 1, [token(0, 0, 1, "word")]);
	assert.equal(store.result!.value.tokens.length, 1);
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "!",
	}]);
	assert.equal(model.getText(), "abc!");
});

test("Token line index reuses unchanged sparse lines from a confirmed delta", () => {
	const lines = Array.from({ length: 1_000 }, (_, index) => `value${index}`);
	using model = new TextModel(lines.join("\n"));
	using store = createLanguageTokenStore(model);
	const initialTokens = lines.map((line, lineIndex) => token(lineIndex, 0, line.length, "variable"));
	acceptTokens(store, model, 1, initialTokens);
	using index = new LanguageTokenLineIndex(store);
	const originalLines = index.lines;
	const events: Array<{ readonly rebuiltLineCount: number; readonly reusedLineCount: number }> = [];
	using listener = index.onDidChange(event => events.push(event));
	const changedLine = 517;
	const oldLine = lines[changedLine]!;
	const lineOffset = lines.slice(0, changedLine).reduce((offset, line) => offset + line.length + 1, 0);
	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(lineOffset), model.positionAt(lineOffset + oldLine.length)),
		text: "changed",
	}]);
	const currentTokens = initialTokens.map((entry, lineIndex) => (
		lineIndex === changedLine ? token(changedLine, 0, 7, "keyword") : entry
	));
	const result = createLanguageTokenSnapshotNormalizer(model.createVersionedSnapshot())({ tokens: currentTokens });
	attachLanguageTokenResultDelta(result, {
		baseRequestId: 1,
		splices: [{
			baseStartItemIndex: changedLine,
			baseDeleteItemCount: 1,
			resultStartItemIndex: changedLine,
			resultInsertItemCount: 1,
			lineDeltaBefore: 0,
			lineDeltaAfter: 0,
		}],
	});

	assert.equal(store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: model.version,
		value: result,
	}), LanguageResultAcceptance.Applied);

	assert.equal(index.lines[0], originalLines[0]);
	assert.notEqual(index.lines[changedLine], originalLines[changedLine]);
	assert.equal(index.lines[999], originalLines[999]);
	assert.deepEqual(index.getLineTokens(changedLine).map(entry => entry.tokenType), ["keyword"]);
	assert.equal(events.at(-1)?.rebuiltLineCount, 1);
	assert.equal(events.at(-1)?.reusedLineCount, 999);
});

test("Token line index rebuilds only two disjoint splice lines", () => {
	const lines = Array.from({ length: 1_000 }, (_, index) => `value${index}`);
	using model = new TextModel(lines.join("\n"));
	using store = createLanguageTokenStore(model);
	const initialTokens = lines.map((line, lineIndex) => token(lineIndex, 0, line.length, "variable"));
	acceptTokens(store, model, 1, initialTokens);
	using index = new LanguageTokenLineIndex(store);
	const originalLines = index.lines;
	const events: Array<{ readonly rebuiltLineCount: number; readonly reusedLineCount: number }> = [];
	using listener = index.onDidChange(event => events.push(event));
	model.applyEdits([{
		range: Range.fromPositions(new Position((100) + 1, (0) + 1), new Position((100) + 1, (lines[100]!.length) + 1)),
		text: "changed100",
	}, {
		range: Range.fromPositions(new Position((900) + 1, (0) + 1), new Position((900) + 1, (lines[900]!.length) + 1)),
		text: "changed900",
	}]);
	const currentTokens = initialTokens.map((entry, lineIndex) => (
		lineIndex === 100 || lineIndex === 900 ? token(lineIndex, 0, 10, "keyword") : entry
	));
	const result = createLanguageTokenSnapshotNormalizer(model.createVersionedSnapshot())({ tokens: currentTokens });
	attachLanguageTokenResultDelta(result, {
		baseRequestId: 1,
		splices: [100, 900].map(itemIndex => ({
			baseStartItemIndex: itemIndex,
			baseDeleteItemCount: 1,
			resultStartItemIndex: itemIndex,
			resultInsertItemCount: 1,
			lineDeltaBefore: 0,
			lineDeltaAfter: 0,
		})),
	});

	assert.equal(store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: model.version,
		value: result,
	}), LanguageResultAcceptance.Applied);

	assert.equal(index.lines[99], originalLines[99]);
	assert.notEqual(index.lines[100], originalLines[100]);
	assert.equal(index.lines[500], originalLines[500]);
	assert.notEqual(index.lines[900], originalLines[900]);
	assert.equal(index.lines[999], originalLines[999]);
	assert.equal(events.at(-1)?.rebuiltLineCount, 2);
	assert.equal(events.at(-1)?.reusedLineCount, 998);
});

test("Token line index reuses relative suffix payloads across line insertion", () => {
	const lines = Array.from({ length: 1_000 }, (_, index) => `value${index}`);
	using model = new TextModel(lines.join("\n"));
	using store = createLanguageTokenStore(model);
	using index = new LanguageTokenLineIndex(store);
	const firstSnapshot = model.createVersionedSnapshot();
	const firstResult: SyntaxResult = Object.freeze({
		lane: SYNTAX_TOKEN_LANE,
		value: testTokens(firstSnapshot),
	});
	const firstDecoded = syntaxWireCodec.decodeResult(
		SYNTAX_TOKEN_LANE,
		syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, firstResult, firstSnapshot, undefined),
		firstSnapshot,
		undefined,
	);
	assert.equal(firstDecoded.lane, SYNTAX_TOKEN_LANE);
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: firstDecoded.value,
	}), LanguageResultAcceptance.Applied);
	const originalLines = index.lines;
	const events: Array<{ readonly rebuiltLineCount: number; readonly reusedLineCount: number }> = [];
	using listener = index.onDidChange(event => events.push(event));
	const insertionLine = 100;
	const insertionOffset = lines.slice(0, insertionLine).reduce((offset, line) => offset + line.length + 1, 0);
	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(insertionOffset)),
		text: "inserted\n",
	}]);
	const snapshot = model.createVersionedSnapshot();
	const currentResult: SyntaxResult = Object.freeze({
		lane: SYNTAX_TOKEN_LANE,
		value: testTokens(snapshot),
	});
	const serverBase = Object.freeze({ requestId: 1, snapshot: firstSnapshot, result: firstResult });
	const clientBase = Object.freeze({ requestId: 1, snapshot: firstSnapshot, result: firstDecoded });
	const encoded = syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, currentResult, snapshot, serverBase);
	const decoded = syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, structuredClone(encoded), snapshot, clientBase);
	assert.equal(decoded.lane, SYNTAX_TOKEN_LANE);

	assert.equal(store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: model.version,
		value: decoded.value,
	}), LanguageResultAcceptance.Applied);

	assert.equal(index.lines[0], originalLines[0]);
	assert.equal(index.lines[insertionLine]!.lineIndex, insertionLine);
	assert.equal(index.lines[insertionLine + 1]!.lineIndex, insertionLine + 1);
	assert.deepEqual(index.getLineTokens(insertionLine + 1).map(entry => entry.tokenType), ["value100"]);
	assert.equal(events.at(-1)?.rebuiltLineCount, 1);
	assert.equal(events.at(-1)?.reusedLineCount, 1_000);
});

test("Token line index matches full results across random wire deltas", () => {
	using model = new TextModel("const value = `start\nmiddle\nend`;\nif (value) {\n  return 1;\n}");
	using store = createLanguageTokenStore(model);
	using index = new LanguageTokenLineIndex(store);
	const insertions = ["x", " ", "\n", "/*", "*/", "`", "'", "(", ")", "const"];
	let serverState: LanguageWorkerWireResultState<SyntaxResult> | undefined;
	let clientState: LanguageWorkerWireResultState<SyntaxResult> | undefined;
	let seed = 0x3511de;
	let reusedLineCount = 0;
	using listener = index.onDidChange(event => {
		reusedLineCount += event.reusedLineCount;
	});

	for (let requestId = 1; requestId <= 100; requestId += 1) {
		const snapshot = model.createVersionedSnapshot();
		const serverResult: SyntaxResult = Object.freeze({
			lane: SYNTAX_TOKEN_LANE,
			value: testTokens(snapshot),
		});
		const encoded = syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, serverResult, snapshot, serverState);
		const clientResult = syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, structuredClone(encoded), snapshot, clientState);
		assert.equal(clientResult.lane, SYNTAX_TOKEN_LANE);
		assert.equal(store.accept({
			requestId,
			textModel: model,
			modelVersion: model.version,
			value: clientResult.value,
		}), LanguageResultAcceptance.Applied);
		assert.deepEqual(serializeTokens(index.lines.flatMap(line => line.tokens)), serializeTokens(clientResult.value.tokens));
		serverState = Object.freeze({ requestId, snapshot, result: serverResult });
		clientState = Object.freeze({ requestId, snapshot, result: clientResult });

		const length = model.getText().length;
		const startOffset = randomInteger(length + 1);
		const removedLength = Math.min(randomInteger(4), length - startOffset);
		model.applyEdits([{
			range: Range.fromPositions(model.positionAt(startOffset), model.positionAt(startOffset + removedLength)),
			text: insertions[randomInteger(insertions.length)]!,
		}]);
	}

	assert.ok(reusedLineCount > 0);

	function randomInteger(limit: number): number {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed % limit;
	}
});

function acceptTokens(
	store: ReturnType<typeof createLanguageTokenStore>,
	model: TextModel,
	requestId: number,
	tokens: readonly LanguageToken[],
): void {
	assert.equal(store.accept({
		requestId,
		textModel: model,
		modelVersion: model.version,
		value: { tokens },
	}), LanguageResultAcceptance.Applied);
}

function token(lineIndex: number, startColumn: number, endColumn: number, tokenType: string): LanguageToken {
	return {
		range: Range.fromPositions(
			new Position((lineIndex) + 1, (startColumn) + 1),
			new Position((lineIndex) + 1, (endColumn) + 1),
		),
		tokenType,
		modifiers: [],
	};
}

function serializeTokens(tokens: readonly LanguageToken[]): readonly unknown[] {
	return tokens.map(entry => [
		entry.range.getStartPosition().lineNumber,
		entry.range.getStartPosition().column,
		entry.range.getEndPosition().column,
		entry.tokenType,
		entry.modifiers,
	]);
}
