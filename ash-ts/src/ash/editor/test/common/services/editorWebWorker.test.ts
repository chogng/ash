import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { DEFAULT_WORD_REGEXP } from '../../../common/core/wordHelper.js';
import { EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerLane, type EditorWorkerRequest } from '../../../common/services/editorWorkerProtocol.js';
import { EditorWorkerRequestExecutor } from '../../../common/services/editorWorkerRequestExecutor.js';
import { TextModel } from '../../../common/model/textModel.js';
import { EndOfLineSequence } from '../../../common/model.js';

for (const [original, formatted] of [
	['😀 hello', '😀 Hello'],
	['a😀z', 'a😁z'],
	['a😀z', 'a🨀z'],
	['first\n😀 hello', 'first\n😀 Hello'],
]) {
	test(`minimal formatting preserves UTF-16 characters in ${JSON.stringify(original)}`, async () => {
		using model = new TextModel(original);
		using worker = new EditorWorkerRequestExecutor();
		const result = await run(worker, model, 1, EDITOR_WORKER_MINIMAL_EDITS_LANE, {
			edits: [{ range: model.getFullModelRange(), text: formatted }],
		});
		assert.ok(Array.isArray(result));
		model.pushEditOperations(null, result as { range: Range; text: string }[], () => null);
		assert.equal(model.getValue(), formatted);
		model.undo();
		assert.equal(model.getValue(), original);
	});
}

test('value navigation includes the final character when the word pattern excludes numbers', async () => {
	using model = new TextModel('version 2');
	using worker = new EditorWorkerRequestExecutor();
	const result = await run(worker, model, 1, EDITOR_WORKER_NAVIGATE_VALUE_LANE, {
		range: new Range(1, 9, 1, 9), up: true, wordDefinition: /[A-Za-z]+/g,
	});
	assert.deepEqual(result, { range: new Range(1, 9, 1, 10), value: '3' });
});

for (const column of [7, 8, 9]) {
	test(`value navigation increments the entire number with a cursor at column ${column}`, async () => {
		using model = new TextModel('value 99');
		using worker = new EditorWorkerRequestExecutor();
		const result = await run(worker, model, 1, EDITOR_WORKER_NAVIGATE_VALUE_LANE, {
			range: new Range(1, column, 1, column), up: true, wordDefinition: DEFAULT_WORD_REGEXP,
		});
		assert.deepEqual(result, { range: new Range(1, 7, 1, 9), value: '100' });
	});
}

test('minimal formatting edits retain the last requested EOL with text changes', async () => {
	using model = new TextModel('abc');
	using worker = new EditorWorkerRequestExecutor();
	const result = await run(worker, model, 1, EDITOR_WORKER_MINIMAL_EDITS_LANE, {
		edits: [
			{ range: new Range(1, 1, 1, 2), text: 'A', eol: EndOfLineSequence.CRLF },
			{ range: new Range(1, 3, 1, 4), text: 'C', eol: EndOfLineSequence.LF },
		],
	});
	assert.deepEqual(result, [
		{ range: new Range(1, 1, 1, 2), text: 'A' },
		{ range: new Range(1, 3, 1, 4), text: 'C', eol: EndOfLineSequence.LF },
	]);
});

test('Editor worker computes Unicode highlights from the captured model version', async () => {
	using model = new TextModel('const a = 1;\u200b\nconst \u0430 = 2;\u202e');
	using worker = new EditorWorkerRequestExecutor();

	const result = await run(worker, model, 1, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, Object.freeze({}));

	assert.deepEqual((result as readonly { readonly kind: string }[]).map(highlight => highlight.kind), ['invisible', 'confusable', 'bidi']);
});

test('Unicode highlights exclude CRLF separators and retain character positions', async () => {
	using model = new TextModel('first\r\nsecond\u200b\r\nthird');
	using worker = new EditorWorkerRequestExecutor();
	const result = await run(worker, model, 1, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, {});
	assert.deepEqual(result, [{ range: new Range(2, 7, 2, 8), kind: 'invisible', character: '\u200b' }]);
});

test('Editor worker reduces formatting replacements without changing their result', async () => {
	using model = new TextModel('This is line one');
	using worker = new EditorWorkerRequestExecutor();
	const range = Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (model.length) + 1));

	const result = await run(worker, model, 1, EDITOR_WORKER_MINIMAL_EDITS_LANE, Object.freeze({ edits: [{ range, text: 'This is line One' }] }));

	assert.deepEqual(result, [{
		range: Range.fromPositions(new Position((0) + 1, (13) + 1), new Position((0) + 1, (14) + 1)),
		text: 'O',
	}]);
});

test('Editor worker navigates values at an empty selection through the enclosing word', async () => {
	using model = new TextModel('const enabled = true;');
	using worker = new EditorWorkerRequestExecutor();
	const start = model.getText().indexOf('true');

	const result = await run(worker, model, 1, EDITOR_WORKER_NAVIGATE_VALUE_LANE, Object.freeze({
		range: Range.fromPositions(new Position((0) + 1, (start) + 1)),
		up: true,
		wordDefinition: DEFAULT_WORD_REGEXP,
	}));

	assert.deepEqual(result, {
		range: Range.fromPositions(new Position((0) + 1, (start) + 1), new Position((0) + 1, (start + 4) + 1)),
		value: 'false',
	});
});

test('Editor worker navigates an explicitly selected number without a matching word pattern', async () => {
	using model = new TextModel('version 2');
	using worker = new EditorWorkerRequestExecutor();
	const result = await run(worker, model, 1, EDITOR_WORKER_NAVIGATE_VALUE_LANE, Object.freeze({
		range: Range.fromPositions(new Position((0) + 1, (8) + 1), new Position((0) + 1, (9) + 1)),
		up: true,
		wordDefinition: /[A-Za-z]+/g,
	}));

	assert.deepEqual(result, {
		range: Range.fromPositions(new Position((0) + 1, (8) + 1), new Position((0) + 1, (9) + 1)),
		value: '3',
	});
});

function run(worker: EditorWorkerRequestExecutor, model: TextModel, requestId: number, lane: EditorWorkerLane, payload: EditorWorkerRequest): ReturnType<EditorWorkerRequestExecutor['run']> {
	return worker.run(Object.freeze({ requestId, lane, payload, snapshot: model.createVersionedSnapshot() }), new AbortController().signal);
}

test('a single formatting response with overlapping edits is rejected without changing the model', async () => {
	using model = new TextModel('alpha');
	using worker = new EditorWorkerRequestExecutor();
	await assert.rejects(run(worker, model, 1, EDITOR_WORKER_MINIMAL_EDITS_LANE, {
		edits: [
			{ range: new Range(1, 1, 1, 4), text: 'ALP', eol: EndOfLineSequence.CRLF },
			{ range: new Range(1, 3, 1, 6), text: 'PHA' },
		],
	}), /must not overlap/);
	assert.deepEqual([model.getValue(), model.getEOL()], ['alpha', '\n']);
});
