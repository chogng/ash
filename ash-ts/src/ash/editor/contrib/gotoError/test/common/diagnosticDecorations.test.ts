import { strict as assert } from "node:assert";
import { test } from "mocha";
import { TextDecorationChangeReason } from "../../../../common/model/decorationCollection.js";
import { LanguageDiagnosticDecorationBridge } from "../../common/diagnosticDecorations.js";
import { LanguageResultAcceptance } from "../../../../common/languages/languageResultStore.js";
import { LanguageDiagnosticSeverity, createLanguageDiagnosticStore, type LanguageDiagnostic } from "../../../../common/languages/languageResults.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";

const position = (lineIndex: number, columnIndex: number): Position => new Position(lineIndex + 1, columnIndex + 1);
const range = (lineIndex: number, startColumn: number, endColumn: number): Range => Range.fromPositions(
	position(lineIndex, startColumn),
	position(lineIndex, endColumn),
);

test("Diagnostic bridge projects existing results, replacements, and clear", () => {
	using model = new TextModel("abc\ndef");
	using store = createLanguageDiagnosticStore(model);
	acceptDiagnostics(store, model, 1, [
		diagnostic(range(0, 0, 2), LanguageDiagnosticSeverity.Error, "error"),
		diagnostic(range(1, 1, 3), LanguageDiagnosticSeverity.Warning, "warning"),
	]);
	using bridge = new LanguageDiagnosticDecorationBridge(store);
	const first = bridge.decorations.decorations;
	assert.deepEqual(first.map(entry => ({
		range: entry.range,
		metadata: entry.metadata,
	})), store.result!.value.diagnostics.map(metadata => ({
		range: metadata.range,
		metadata,
	})));
	assert.equal(new Set(first.map(entry => entry.id)).size, 2);

	const events: unknown[] = [];
	using listener = bridge.decorations.onDidChange(event => events.push(event));
	acceptDiagnostics(store, model, 2, [
		diagnostic(range(1, 0, 1), LanguageDiagnosticSeverity.Information, "info"),
	]);
	const second = bridge.decorations.decorations;
	assert.equal(second.length, 1);
	assert.equal(second[0]!.metadata.message, "info");
	assert.equal(first.some(entry => entry.id === second[0]!.id), true);

	store.clear();
	assert.deepEqual(bridge.decorations.decorations, []);
	assert.deepEqual(events.map(event => (
		event as { readonly reason: TextDecorationChangeReason }
	).reason), [
		TextDecorationChangeReason.Content,
		TextDecorationChangeReason.Content,
	]);
});

test("Model edits clear diagnostics before decoration ranges can drift", () => {
	using model = new TextModel("abc");
	using store = createLanguageDiagnosticStore(model);
	using bridge = new LanguageDiagnosticDecorationBridge(store);
	acceptDiagnostics(store, model, 1, [
		diagnostic(range(0, 1, 3), LanguageDiagnosticSeverity.Error, "error"),
	]);
	const events: unknown[] = [];
	using listener = bridge.decorations.onDidChange(event => events.push(event));

	model.applyEdits([{
		range: Range.fromPositions(position(0, 0)),
		text: "X",
	}]);

	assert.equal(store.result, undefined);
	assert.deepEqual(bridge.decorations.decorations, []);
	assert.deepEqual(events, [{
		reason: TextDecorationChangeReason.Content,
		modelVersion: 2,
		decorations: [],
	}]);
});

test("Diagnostic bridge merges only current external diagnostics and removes duplicates", () => {
	using model = new TextModel("abc");
	using store = createLanguageDiagnosticStore(model);
	const resource = URI.file("C:\\project\\main.rs");
	using changes = new Emitter<URI>();
	let external = { resource, revision: model.version, diagnostics: [diagnostic(range(0, 0, 1), LanguageDiagnosticSeverity.Error, "shared")] };
	using bridge = new LanguageDiagnosticDecorationBridge(store, {
		onDidChangeDiagnostics: changes.event,
		getDiagnostics: () => external,
	}, resource);
	acceptDiagnostics(store, model, 1, [diagnostic(range(0, 0, 1), LanguageDiagnosticSeverity.Error, "shared")]);

	assert.equal(bridge.decorations.decorations.length, 1);
	model.applyEdits([{ range: Range.fromPositions(position(0, 3)), text: "d" }]);
	assert.equal(bridge.decorations.decorations.length, 0);

	external = { resource, revision: model.version, diagnostics: [diagnostic(range(0, 1, 2), LanguageDiagnosticSeverity.Warning, "fresh")] };
	changes.fire(resource);
	assert.equal(bridge.decorations.decorations[0]!.metadata.message, "fresh");
});

test("Diagnostic bridge disposal owns only its projected collection", () => {
	using model = new TextModel("abc");
	using store = createLanguageDiagnosticStore(model);
	const bridge = new LanguageDiagnosticDecorationBridge(store);
	acceptDiagnostics(store, model, 1, [
		diagnostic(range(0, 0, 1), LanguageDiagnosticSeverity.Hint, "hint"),
	]);
	bridge.dispose();

	assert.throws(() => bridge.decorations.decorations, /already disposed/);
	assert.equal(store.result!.value.diagnostics.length, 1);
	model.applyEdits([{
		range: range(0, 0, 1),
		text: "A",
	}]);
	assert.equal(model.getText(), "Abc");
});

function acceptDiagnostics(
	store: ReturnType<typeof createLanguageDiagnosticStore>,
	model: TextModel,
	requestId: number,
	diagnostics: readonly LanguageDiagnostic[],
): void {
	assert.equal(store.accept({
		requestId,
		textModel: model,
		modelVersion: model.version,
		value: { diagnostics },
	}), LanguageResultAcceptance.Applied);
}

function diagnostic(
	diagnosticRange: Range,
	severity: LanguageDiagnosticSeverity,
	message: string,
): LanguageDiagnostic {
	return {
		range: diagnosticRange,
		severity,
		message,
	};
}
