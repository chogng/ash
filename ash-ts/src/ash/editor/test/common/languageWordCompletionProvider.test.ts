import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createLanguageCompletionInvokeContext, type LanguageCompletionProviderRequest } from "../../common/languages/completion/languageCompletionProviders.js";
import { createLanguageWordCompletionProvider } from "../../common/services/editorWebWorker.js";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";

test("Word completion is deterministic, bounded, and snapshot-local", async () => {
	using model = new TextModel("alpine alpha alphabet al");
	const provider = createLanguageWordCompletionProvider({ maximumItems: 2 });
	const position = new Position((0) + 1, (model.getText().length) + 1);

	const result = await provider.provideCompletions(request(model, position), new AbortController().signal);

	assert.deepEqual(result?.items.map(item => item.label), ["alpha", "alphabet"]);
	assert.equal(result?.isIncomplete, true);
	assert.equal(result?.items.every(item => /^[A-Za-z0-9._-]+$/.test(item.id)), true);
	assert.equal(result?.items[0]!.range.getStartPosition().column, position.column - 2);
	assert.deepEqual(result?.items[0]!.range.getEndPosition(), position);
});

test("Word completion replaces a complete active segment from a mid-word caret", async () => {
	using model = new TextModel("connection console");
	const provider = createLanguageWordCompletionProvider();
	const position = new Position((0) + 1, ("connection con".length) + 1);

	const result = await provider.provideCompletions(request(model, position), new AbortController().signal);

	assert.deepEqual(result?.items.map(item => item.label), ["connection"]);
	assert.equal(result?.items[0]!.range.startColumn, "connection ".length + 1);
	assert.equal(result?.items[0]!.range.endColumn, model.getText().length + 1);
});

test("Word completion validates limits and observes cancellation", async () => {
	assert.throws(() => createLanguageWordCompletionProvider({ maximumItems: 0 }), /positive safe integer/);
	using model = new TextModel("alpha al");
	const provider = createLanguageWordCompletionProvider();
	const controller = new AbortController();
	controller.abort("cancelled");

	assert.throws(
		() => provider.provideCompletions(
			request(model, new Position((0) + 1, (model.getText().length) + 1)),
			controller.signal,
		),
	);
});

function request(model: TextModel, position: Position): LanguageCompletionProviderRequest {
	return Object.freeze({
		requestId: 1,
		snapshot: model.createVersionedSnapshot(),
		languageId: "plaintext",
		position,
		context: createLanguageCompletionInvokeContext(),
	});
}
