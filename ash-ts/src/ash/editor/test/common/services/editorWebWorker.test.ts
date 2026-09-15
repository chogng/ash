import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { DEFAULT_WORD_REGEXP } from '../../../common/core/wordHelper.js';
import { EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerLane, type EditorWorkerRequest } from '../../../common/services/editorWorkerProtocol.js';
import { EditorWorkerRequestExecutor } from '../../../common/services/editorWorkerRequestExecutor.js';
import { TextModel } from '../../../common/model/textModel.js';
import { EndOfLineSequence } from '../../../common/model.js';

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
