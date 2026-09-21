import { strict as assert } from "node:assert";
import { test } from "mocha";
import { syntaxWireCodec } from "../../common/languages/syntax/syntaxWire.js";
import { SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, type SyntaxLane, type SyntaxResult } from "../../common/languages/syntax/syntaxService.js";
import { testTokens, testDiagnostics } from './testSyntaxProvider.js';
import { type LanguageWorkerWireResultState } from "../../common/languages/languageWorkerWireProtocol.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { type TextSnapshot } from "../../common/core/textChange.js";
import { TextModel } from "../../common/model/textModel.js";

test("Syntax wire deltas stay equal to full results across random edits", () => {
	using model = new TextModel("const value = `start\nmiddle\nend`;\nif (value) {\n  return 1;\n}");
	const serverStates = new Map<SyntaxLane, LanguageWorkerWireResultState<SyntaxResult>>();
	const clientStates = new Map<SyntaxLane, LanguageWorkerWireResultState<SyntaxResult>>();
	const insertions = ["x", " ", "\n", "/*", "*/", "`", "'", "(", ")", "const"];
	let requestId = 1;
	let seed = 0x34de17a;
	let deltaCount = 0;

	for (let iteration = 0; iteration < 100; iteration += 1) {
		const snapshot = model.createVersionedSnapshot();
		for (const lane of [SYNTAX_TOKEN_LANE, SYNTAX_DIAGNOSTIC_LANE] as const) {
			const result = syntaxResult(lane, snapshot);
			const encoded = syntaxWireCodec.encodeResult(lane, result, snapshot, serverStates.get(lane)) as { readonly kind: string };
			const decoded = syntaxWireCodec.decodeResult(lane, structuredClone(encoded), snapshot, clientStates.get(lane));
			assert.deepEqual(serializeResult(decoded), serializeResult(result));
			if (encoded.kind === "delta") deltaCount += 1;
			const serverState = Object.freeze({ requestId, snapshot, result });
			const clientState = Object.freeze({ requestId, snapshot, result: decoded });
			serverStates.set(lane, serverState);
			clientStates.set(lane, clientState);
			requestId += 1;
		}
		const length = model.getText().length;
		const startOffset = randomInteger(length + 1);
		const removedLength = Math.min(randomInteger(4), length - startOffset);
		model.applyEdits([{
			range: Range.fromPositions(model.positionAt(startOffset), model.positionAt(startOffset + removedLength)),
			text: insertions[randomInteger(insertions.length)]!,
		}]);
	}

	assert.ok(deltaCount > 75, `Expected repeated lane results to use deltas, got ${deltaCount}`);

	function randomInteger(limit: number): number {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed % limit;
	}
});

test("Syntax wire rejects missing bases and inconsistent delta metadata", () => {
	using model = new TextModel("const value = 1;");
	const firstSnapshot = model.createVersionedSnapshot();
	const firstResult = syntaxResult(SYNTAX_TOKEN_LANE, firstSnapshot);
	const base = Object.freeze({ requestId: 7, snapshot: firstSnapshot, result: firstResult });
	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(model.getText().length)),
		text: "\nreturn value;",
	}]);
	const snapshot = model.createVersionedSnapshot();

	assert.throws(() => syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, {
		kind: "delta",
		baseRequestId: 7,
		splices: [],
	}, snapshot, undefined), /base result is unavailable/);
	assert.throws(() => syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, {
		kind: "delta",
		baseRequestId: 7,
		splices: [{
			startItemIndex: 0,
			deleteItemCount: 0,
			lineDelta: 0,
			items: [],
		}],
	}, snapshot, base), /final line shift does not match/);
	assert.throws(() => syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, {
		kind: "delta",
		baseRequestId: 7,
		splices: [{
			startItemIndex: 99,
			deleteItemCount: 0,
			lineDelta: 1,
			items: [],
		}],
	}, snapshot, base), /inside their base result/);
});

test("Syntax wire uses full fallback when a delta cannot reduce item transfer", () => {
	using model = new TextModel("value");
	const snapshot = model.createVersionedSnapshot();
	const first = tokenResult("variable");
	const second = tokenResult("keyword");
	const base = Object.freeze({ requestId: 1, snapshot, result: first });

	const encoded = syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, second, snapshot, base) as { readonly kind: string };

	assert.equal(encoded.kind, "full");
	assert.deepEqual(serializeResult(syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, encoded, snapshot, base)), serializeResult(second));
});

test("Syntax wire bounds a one-line edit independently of document token count", () => {
	const lines = Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};`);
	using model = new TextModel(lines.join("\n"));
	const firstSnapshot = model.createVersionedSnapshot();
	const first = syntaxResult(SYNTAX_TOKEN_LANE, firstSnapshot);
	const base = Object.freeze({ requestId: 1, snapshot: firstSnapshot, result: first });
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)),
		text: "let",
	}]);
	const snapshot = model.createVersionedSnapshot();
	const current = syntaxResult(SYNTAX_TOKEN_LANE, snapshot);

	const encoded = syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, current, snapshot, base) as { readonly kind: string; readonly splices: readonly { readonly items: readonly unknown[] }[] };
	const decoded = syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, structuredClone(encoded), snapshot, base);

	assert.equal(encoded.kind, "delta");
	assert.ok(encoded.splices.reduce((count, splice) => count + splice.items.length, 0) <= 4);
	assert.ok(first.lane === SYNTAX_TOKEN_LANE && first.value.tokens.length > 3_000);
	assert.deepEqual(serializeResult(decoded), serializeResult(current));
});

test("Syntax wire isolates two distant edits into multiple item splices", () => {
	const lines = Array.from({ length: 1_000 }, (_, index) => `const uniqueValue${index} = ${index};`);
	using model = new TextModel(lines.join("\n"));
	const firstSnapshot = model.createVersionedSnapshot();
	const first = syntaxResult(SYNTAX_TOKEN_LANE, firstSnapshot);
	const base = Object.freeze({ requestId: 1, snapshot: firstSnapshot, result: first });
	model.applyEdits([{
		range: Range.fromPositions(new Position((100) + 1, (0) + 1), new Position((100) + 1, (5) + 1)),
		text: "let",
	}, {
		range: Range.fromPositions(new Position((900) + 1, (lines[900]!.length - 4) + 1), new Position((900) + 1, (lines[900]!.length - 1) + 1)),
		text: "901",
	}]);
	const snapshot = model.createVersionedSnapshot();
	const current = syntaxResult(SYNTAX_TOKEN_LANE, snapshot);

	const encoded = syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, current, snapshot, base) as { readonly kind: string; readonly splices: readonly { readonly items: readonly unknown[] }[] };
	const decoded = syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, structuredClone(encoded), snapshot, base);

	assert.equal(encoded.kind, "delta");
	assert.equal(encoded.splices.length, 2);
	assert.ok(encoded.splices.every(splice => splice.items.length <= 4));
	assert.deepEqual(serializeResult(decoded), serializeResult(current));
});

test("Syntax wire multi-splices stay exact across repeated disjoint transactions", () => {
	const lines = Array.from({ length: 300 }, (_, index) => `const uniqueValue${index} = ${index};`);
	using model = new TextModel(lines.join("\n"));
	let serverState: LanguageWorkerWireResultState<SyntaxResult> | undefined;
	let clientState: LanguageWorkerWireResultState<SyntaxResult> | undefined;
	let seed = 0x36a17;
	let multiSpliceCount = 0;

	for (let requestId = 1; requestId <= 40; requestId += 1) {
		const snapshot = model.createVersionedSnapshot();
		const result = syntaxResult(SYNTAX_TOKEN_LANE, snapshot);
		const encoded = syntaxWireCodec.encodeResult(SYNTAX_TOKEN_LANE, result, snapshot, serverState) as { readonly kind: string; readonly splices?: readonly unknown[] };
		const decoded = syntaxWireCodec.decodeResult(SYNTAX_TOKEN_LANE, structuredClone(encoded), snapshot, clientState);
		assert.deepEqual(serializeResult(decoded), serializeResult(result));
		if ((encoded.splices?.length ?? 0) >= 2) multiSpliceCount += 1;
		serverState = Object.freeze({ requestId, snapshot, result });
		clientState = Object.freeze({ requestId, snapshot, result: decoded });

		const firstLine = randomInteger(140) + 1;
		const secondLine = randomInteger(140) + 159;
		model.applyEdits([firstLine, secondLine].map(lineIndex => ({
			range: Range.fromPositions(new Position((lineIndex) + 1, (0) + 1), new Position((lineIndex) + 1, (5) + 1)),
			text: model.getLineContent((lineIndex) + 1).startsWith("const") ? "alpha" : "const",
		})));
	}

	assert.ok(multiSpliceCount >= 35, `Expected most disjoint transactions to retain multiple splices, got ${multiSpliceCount}`);

	function randomInteger(limit: number): number {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed % limit;
	}
});

function syntaxResult(lane: SyntaxLane, snapshot: TextSnapshot): SyntaxResult {
	return lane === SYNTAX_TOKEN_LANE
		? Object.freeze({ lane, value: testTokens(snapshot) })
		: Object.freeze({ lane, value: testDiagnostics(snapshot) });
}

function tokenResult(tokenType: string): SyntaxResult {
	return Object.freeze({
		lane: SYNTAX_TOKEN_LANE,
		value: Object.freeze({
			tokens: Object.freeze([Object.freeze({
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)),
				tokenType,
				modifiers: Object.freeze([]),
			})]),
		}),
	});
}

function serializeResult(result: SyntaxResult): unknown {
	const items = result.lane === SYNTAX_TOKEN_LANE ? result.value.tokens : result.value.diagnostics;
	return {
		lane: result.lane,
		items: items.map(item => ({
			start: [item.range.getStartPosition().lineNumber, item.range.getStartPosition().column],
			end: [item.range.getEndPosition().lineNumber, item.range.getEndPosition().column],
			...("tokenType" in item
				? { tokenType: item.tokenType, modifiers: item.modifiers }
				: { severity: item.severity, message: item.message, code: item.code, source: item.source }),
		})),
	};
}
