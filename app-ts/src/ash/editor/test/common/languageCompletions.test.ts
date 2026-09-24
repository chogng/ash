import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageResultAcceptance } from '../../common/model/languageResultStore.js';
import { LanguageCompletionItemKind, type LanguageCompletionItem, createLanguageCompletionSnapshotNormalizer } from '../../common/languages.js';
import { createLanguageCompletionStore } from '../../contrib/suggest/browser/suggest.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { type TextSnapshot } from "../../common/core/textChange.js";
import { TextModel } from "../../common/model/textModel.js";

test("Completion stores normalize immutable current-version results", () => {
	using model = new TextModel("con");
	using store = createLanguageCompletionStore(model);
	const item = completion("constant", "const", 0, 3, {
		detail: "keyword",
		documentation: "Declares a constant.",
		filterText: "constant",
		sortText: "001",
		preselect: true,
		insertText: "const\r\n",
		commitCharacters: [".", "("],
	});
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (3) + 1),
			items: [item],
			isIncomplete: true,
		},
	}), LanguageResultAcceptance.Applied);

	item.label = "mutated";
	const result = store.result!.value;
	assert.equal(result.position, result.position);
	assert.equal(result.items[0]!.label, "const");
	assert.equal(result.items[0]!.insertText, "const\n");
	assert.equal(result.items[0]!.preselect, true);
	assert.deepEqual(result.items[0]!.commitCharacters, [".", "("]);
	assert.equal(Object.isFrozen(result.items[0]!.commitCharacters), true);
	assert.equal(result.isIncomplete, true);
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.items), true);
	assert.equal(Object.isFrozen(result.items[0]), true);
});

test("Completion normalization rejects ambiguous items atomically", () => {
	using model = new TextModel("abc\ndef");
	using store = createLanguageCompletionStore(model);
	accept(store, model, 1, [completion("one", "one", 0, 3)]);
	const prior = store.result;
	const cases: readonly LanguageCompletionItem[][] = [
		[
			completion("same", "one", 0, 3),
			completion("same", "two", 0, 3),
		],
		[completion("line", "line", 0, 3, {
			range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((1) + 1, (0) + 1)),
		})],
		[completion("ahead", "ahead", 0, 2, {
			range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
		})],
		[completion("kind", "kind", 0, 3, {
			kind: "mystery" as LanguageCompletionItemKind,
		})],
		[
			completion("one", "one", 0, 3, { preselect: true }),
			completion("two", "two", 0, 3, { preselect: true }),
		],
		[completion(" spaced ", "spaced", 0, 3)],
		[completion("duplicate-commit", "duplicate-commit", 0, 3, { commitCharacters: [".", "."] })],
		[completion("invalid-commit", "invalid-commit", 0, 3, { commitCharacters: ["two"] })],
	];

	for (const [index, items] of cases.entries()) {
		assert.throws(() => store.accept({
			requestId: index + 2,
			textModel: model,
			modelVersion: model.version,
			value: {
				position: new Position((0) + 1, (3) + 1),
				items,
				isIncomplete: false,
			},
		}));
		assert.equal(store.result, prior);
	}
});

test("Completion stores invalidate results on model edits", () => {
	using model = new TextModel("abc");
	using store = createLanguageCompletionStore(model);
	accept(store, model, 1, [completion("abc", "abc", 0, 3)]);

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "!",
	}]);

	assert.equal(store.result, undefined);
});

test("Completion stores normalize immutable non-overlapping additional text edits", () => {
	using model = new TextModel("xcon");
	using store = createLanguageCompletionStore(model);
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (4) + 1),
			items: [{
				...completion("console", "console", 1, 4),
				additionalTextEdits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "import " }],
			}],
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);
	const edits = store.result!.value.items[0]!.additionalTextEdits!;
	assert.deepEqual(edits, [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "import " }]);
	assert.equal(Object.isFrozen(edits), true);
	assert.equal(Object.isFrozen(edits[0]), true);

	assert.throws(() => store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (4) + 1),
			items: [{
				...completion("overlap", "overlap", 1, 4),
				additionalTextEdits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)), text: "" }],
			}],
			isIncomplete: false,
		},
	}), /must not overlap or touch/);
});

test("Snapshot completion normalization indexes captured text once", () => {
	let reads = 0;
	const snapshot: TextSnapshot = {
		version: 1,
		length: 3,
		lineCount: 1,
		getText: () => {
			reads += 1;
			return "abc";
		},
		getTextBetweenOffsets: (startOffset, endOffset) => "abc".slice(startOffset, endOffset),
	};
	const normalize = createLanguageCompletionSnapshotNormalizer(snapshot);
	const value = {
		position: new Position((0) + 1, (3) + 1),
		items: [completion("abc", "abc", 0, 3)],
		isIncomplete: false,
	};

	normalize(value);
	normalize(value);

	assert.equal(reads, 1);
});

function accept(
	store: ReturnType<typeof createLanguageCompletionStore>,
	model: TextModel,
	requestId: number,
	items: readonly LanguageCompletionItem[],
): void {
	assert.equal(store.accept({
		requestId,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (3) + 1),
			items,
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);
}

interface CompletionOverrides {
	readonly providerId?: string;
	readonly detail?: string;
	readonly documentation?: string;
	readonly filterText?: string;
	readonly sortText?: string;
	readonly preselect?: boolean;
	readonly commitCharacters?: readonly string[];
	readonly insertText?: string;
	readonly range?: Range;
	readonly kind?: LanguageCompletionItemKind;
}

function completion(id: string, label: string, startColumn: number, endColumn: number, overrides: CompletionOverrides = {}): LanguageCompletionItem & { label: string } {
	return {
		providerId: overrides.providerId ?? "test",
		id,
		label,
		kind: overrides.kind ?? LanguageCompletionItemKind.Keyword,
		range: overrides.range ?? Range.fromPositions(
			new Position((0) + 1, (startColumn) + 1),
			new Position((0) + 1, (endColumn) + 1),
		),
		insertText: overrides.insertText ?? label,
		...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
		...(overrides.documentation === undefined ? {} : { documentation: overrides.documentation }),
		...(overrides.filterText === undefined ? {} : { filterText: overrides.filterText }),
		...(overrides.sortText === undefined ? {} : { sortText: overrides.sortText }),
		...(overrides.preselect === undefined ? {} : { preselect: overrides.preselect }),
		...(overrides.commitCharacters === undefined ? {} : { commitCharacters: overrides.commitCharacters }),
	};
}
