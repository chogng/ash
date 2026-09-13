import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageRequestCoordinator, LanguageRequestStatus, type LanguageWorker, type LanguageWorkerRequest } from "../../common/languages/languageRequestCoordinator.js";
import { LanguageResultAcceptance, LanguageResultStoreChangeReason, VersionedLanguageResultStore } from "../../common/languages/languageResultStore.js";
import { LanguageDiagnosticSeverity, createLanguageDiagnosticStore, createLanguageTokenStore, type LanguageDiagnosticResult, type LanguageTokenResult } from "../../common/languages/languageResults.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

const position = (lineIndex: number, columnIndex: number): Position => new Position(lineIndex + 1, columnIndex + 1);
const range = (lineIndex: number, startColumn: number, endColumn: number): Range => Range.fromPositions(
	position(lineIndex, startColumn),
	position(lineIndex, endColumn),
);

test("Language token stores freeze current-version results and invalidate on edit", () => {
	using model = new TextModel("const value = 1;\n");
	using store = createLanguageTokenStore(model);
	const events: unknown[] = [];
	using listener = store.onDidChange(event => events.push(event));
	const modifiers = ["declaration"];
	const result: LanguageTokenResult = {
		tokens: [
			{
				range: range(0, 0, 5),
				tokenType: "keyword",
				modifiers: [],
			},
			{
				range: range(0, 6, 11),
				tokenType: "variable",
				modifiers,
			},
		],
	};

	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: result,
	}), LanguageResultAcceptance.Applied);
	modifiers.push("readonly");
	const stored = store.result!;
	assert.equal(Object.isFrozen(stored), true);
	assert.equal(Object.isFrozen(stored.value), true);
	assert.equal(Object.isFrozen(stored.value.tokens), true);
	assert.equal(Object.isFrozen(stored.value.tokens[0]), true);
	assert.equal(Object.isFrozen(stored.value.tokens[1]!.modifiers), true);
	assert.deepEqual(stored.value.tokens[1]!.modifiers, ["declaration"]);
	assert.deepEqual(events, [{
		reason: LanguageResultStoreChangeReason.Result,
		modelVersion: 1,
		result: stored,
	}]);

	model.applyEdits([{
		range: Range.fromPositions(position(0, 0)),
		text: "// ",
	}]);
	assert.equal(store.result, undefined);
	assert.deepEqual(events[1], {
		reason: LanguageResultStoreChangeReason.ModelChanged,
		modelVersion: 2,
		result: undefined,
	});
	assert.equal(store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: 1,
		value: result,
	}), LanguageResultAcceptance.StaleVersion);
	assert.equal(events.length, 2);
});

test("Language result stores reject duplicate and superseded request IDs", () => {
	using model = new TextModel("x");
	using store = createLanguageTokenStore(model);
	const value = tokenResult(0, 1, "variable");

	assert.equal(store.accept({
		requestId: 5,
		textModel: model,
		modelVersion: 1,
		value,
	}), LanguageResultAcceptance.Applied);
	assert.equal(store.accept({
		requestId: 4,
		textModel: model,
		modelVersion: 1,
		value,
	}), LanguageResultAcceptance.SupersededRequest);
	assert.equal(store.accept({
		requestId: 5,
		textModel: model,
		modelVersion: 1,
		value: tokenResult(0, 1, "keyword"),
	}), LanguageResultAcceptance.DuplicateRequest);
	assert.equal(store.result!.requestId, 5);
	assert.equal(store.result!.value.tokens[0]!.tokenType, "variable");

	assert.equal(store.accept({
		requestId: 6,
		textModel: model,
		modelVersion: 1,
		value: tokenResult(0, 1, "keyword"),
	}), LanguageResultAcceptance.Applied);
	assert.equal(store.result!.requestId, 6);
	using otherModel = new TextModel("x");
	assert.throws(() => store.accept({
		requestId: 7,
		textModel: otherModel,
		modelVersion: 1,
		value,
	}), /share one text model/);
	assert.throws(() => store.accept({
		requestId: 0,
		textModel: model,
		modelVersion: 1,
		value,
	}), /positive safe integer/);
	assert.throws(() => store.accept({
		requestId: 7,
		textModel: model,
		modelVersion: Number.NaN,
		value,
	}), /positive safe integer/);
	assert.equal(store.result!.requestId, 6);
});

test("Language result clear is explicit and suppresses empty no-ops", () => {
	using model = new TextModel("x");
	using store = createLanguageTokenStore(model);
	const events: unknown[] = [];
	using listener = store.onDidChange(event => events.push(event));
	store.accept({
		requestId: 5,
		textModel: model,
		modelVersion: 1,
		value: tokenResult(0, 1, "variable"),
	});

	store.clear();
	store.clear();

	assert.equal(store.result, undefined);
	assert.equal(store.accept({
		requestId: 5,
		textModel: model,
		modelVersion: 1,
		value: tokenResult(0, 1, "keyword"),
	}), LanguageResultAcceptance.DuplicateRequest);
	assert.equal(store.accept({
		requestId: 4,
		textModel: model,
		modelVersion: 1,
		value: tokenResult(0, 1, "keyword"),
	}), LanguageResultAcceptance.SupersededRequest);
	assert.deepEqual(events.map(event => (
		event as { readonly reason: LanguageResultStoreChangeReason }
	).reason), [
		LanguageResultStoreChangeReason.Result,
		LanguageResultStoreChangeReason.Cleared,
	]);
	assert.deepEqual(events[1], {
		reason: LanguageResultStoreChangeReason.Cleared,
		modelVersion: 1,
		result: undefined,
	});
});

test("Language diagnostics validate atomically while allowing points and overlap", () => {
	using model = new TextModel("abc\ndef");
	using store = createLanguageDiagnosticStore(model);
	const valid: LanguageDiagnosticResult = {
		diagnostics: [
			{
				range: range(0, 0, 2),
				severity: LanguageDiagnosticSeverity.Error,
				message: "first",
				code: 1001,
				source: "parser",
			},
			{
				range: Range.fromPositions(position(0, 1)),
				severity: LanguageDiagnosticSeverity.Hint,
				message: "overlapping point",
				code: "hint-code",
			},
		],
	};
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: valid,
	}), LanguageResultAcceptance.Applied);
	const original = store.result;
	assert.equal(Object.isFrozen(original!.value.diagnostics), true);
	assert.equal(Object.isFrozen(original!.value.diagnostics[0]), true);

	const invalidResults: LanguageDiagnosticResult[] = [
		{
			diagnostics: [{
				range: Range.fromPositions(position(2, 0)),
				severity: LanguageDiagnosticSeverity.Error,
				message: "outside",
			}],
		},
		{
			diagnostics: [{
				range: range(0, 0, 1),
				severity: "fatal" as LanguageDiagnosticSeverity,
				message: "unknown severity",
			}],
		},
		{
			diagnostics: [{
				range: range(0, 0, 1),
				severity: LanguageDiagnosticSeverity.Warning,
				message: "   ",
			}],
		},
		{
			diagnostics: [{
				range: range(0, 0, 1),
				severity: LanguageDiagnosticSeverity.Information,
				message: "bad code",
				code: Number.POSITIVE_INFINITY,
			}],
		},
		{
			diagnostics: [{
				range: range(0, 0, 1),
				severity: LanguageDiagnosticSeverity.Information,
				message: "bad source",
				source: " source ",
			}],
		},
	];
	for (let index = 0; index < invalidResults.length; index += 1) {
		assert.throws(() => store.accept({
			requestId: index + 2,
			textModel: model,
			modelVersion: 1,
			value: invalidResults[index]!,
		}));
		assert.equal(store.result, original);
	}
});

test("Language tokens reject ambiguous spans without replacing prior state", () => {
	using model = new TextModel("abc\ndef");
	using store = createLanguageTokenStore(model);
	store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: tokenResult(0, 1, "variable"),
	});
	const original = store.result;
	const invalidResults: LanguageTokenResult[] = [
		tokenResult(1, 1, "empty"),
		{
			tokens: [{
				range: Range.fromPositions(position(0, 1), position(1, 1)),
				tokenType: "string",
				modifiers: [],
			}],
		},
		{
			tokens: [
				token(0, 0, 2, "first"),
				token(0, 1, 3, "overlap"),
			],
		},
		{
			tokens: [
				token(0, 2, 3, "later"),
				token(0, 0, 1, "earlier"),
			],
		},
		{
			tokens: [{
				range: range(0, 0, 1),
				tokenType: " variable ",
				modifiers: [],
			}],
		},
		{
			tokens: [{
				range: range(0, 0, 1),
				tokenType: "variable",
				modifiers: ["readonly", "readonly"],
			}],
		},
	];

	for (let index = 0; index < invalidResults.length; index += 1) {
		assert.throws(() => store.accept({
			requestId: index + 2,
			textModel: model,
			modelVersion: 1,
			value: invalidResults[index]!,
		}));
		assert.equal(store.result, original);
	}
});

test("Model mutation during normalization cannot publish the captured version", () => {
	using model = new TextModel("a");
	let mutate = false;
	using store = new VersionedLanguageResultStore<{ readonly value: number }>(
		model,
		value => {
			if (mutate) {
				model.applyEdits([{
					range: Range.fromPositions(position(0, 1)),
					text: "!",
				}]);
			}
			return Object.freeze({ ...value });
		},
	);
	const events: unknown[] = [];
	using listener = store.onDidChange(event => events.push(event));
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: { value: 1 },
	}), LanguageResultAcceptance.Applied);

	mutate = true;
	assert.equal(store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: 1,
		value: { value: 2 },
	}), LanguageResultAcceptance.StaleVersion);
	assert.equal(model.version, 2);
	assert.equal(store.result, undefined);
	assert.deepEqual(events.map(event => (
		event as { readonly reason: LanguageResultStoreChangeReason }
	).reason), [
		LanguageResultStoreChangeReason.Result,
		LanguageResultStoreChangeReason.ModelChanged,
	]);
});

test("Normalizer failures preserve accepted state and are not reentrant", () => {
	using model = new TextModel("x");
	let store!: VersionedLanguageResultStore<number>;
	store = new VersionedLanguageResultStore(model, value => {
		if (value < 0) throw new RangeError("negative result");
		if (value === 2) {
			store.accept({
				requestId: 3,
				textModel: model,
				modelVersion: 1,
				value: 3,
			});
		}
		return value;
	});
	using ownedStore = store;
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: 1,
	}), LanguageResultAcceptance.Applied);
	const original = store.result;

	assert.throws(() => store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: 1,
		value: -1,
	}), /negative result/);
	assert.equal(store.result, original);
	assert.throws(() => store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: 1,
		value: 2,
	}), /must not be reentrant/);
	assert.equal(store.result, original);
});

test("Language result store lifecycle does not own the text model", () => {
	const disposedModel = new TextModel("x");
	const unavailableStore = createLanguageTokenStore(disposedModel);
	unavailableStore.accept({
		requestId: 1,
		textModel: disposedModel,
		modelVersion: 1,
		value: tokenResult(0, 1, "variable"),
	});
	disposedModel.dispose();
	assert.equal(unavailableStore.result, undefined);
	assert.equal(unavailableStore.accept({
		requestId: 2,
		textModel: disposedModel,
		modelVersion: 1,
		value: tokenResult(0, 1, "variable"),
	}), LanguageResultAcceptance.ModelUnavailable);
	unavailableStore.dispose();

	using liveModel = new TextModel("x");
	const store = createLanguageTokenStore(liveModel);
	assert.equal(store.textModel, liveModel);
	store.dispose();
	assert.throws(() => store.result, /already disposed/);
	assert.throws(() => store.textModel, /already disposed/);
	liveModel.applyEdits([{
		range: range(0, 0, 1),
		text: "X",
	}]);
	assert.equal(liveModel.getText(), "X");
});

test("Language request coordinator publishes directly into a typed result store", async () => {
	using model = new TextModel("x");
	using store = createLanguageTokenStore(model);
	const worker = new ImmediateTokenWorker();
	using coordinator = new LanguageRequestCoordinator<"tokens", LanguageTokenResult, LanguageTokenResult>(
		model,
		() => worker,
	);
	let acceptance: LanguageResultAcceptance | undefined;

	const outcome = await coordinator.runLatest(
		"tokens",
		tokenResult(0, 1, "variable"),
		result => {
			acceptance = store.accept(result);
		},
	);

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.equal(acceptance, LanguageResultAcceptance.Applied);
	assert.equal(store.result!.requestId, outcome.requestId);
	assert.equal(store.result!.textModel, model);
	assert.equal(store.result!.value.tokens[0]!.tokenType, "variable");
});

class ImmediateTokenWorker implements LanguageWorker<"tokens", LanguageTokenResult, LanguageTokenResult> {
	disposed = false;

	async run(request: LanguageWorkerRequest<"tokens", LanguageTokenResult>, signal: AbortSignal): Promise<LanguageTokenResult> {
		assert.equal(signal.aborted, false);
		return request.payload;
	}

	dispose(): void {
		this.disposed = true;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function tokenResult(startColumn: number, endColumn: number, tokenType: string): LanguageTokenResult {
	return { tokens: [token(0, startColumn, endColumn, tokenType)] };
}

function token(lineIndex: number, startColumn: number, endColumn: number, tokenType: string): LanguageTokenResult["tokens"][number] {
	return {
		range: range(lineIndex, startColumn, endColumn),
		tokenType,
		modifiers: [],
	};
}
