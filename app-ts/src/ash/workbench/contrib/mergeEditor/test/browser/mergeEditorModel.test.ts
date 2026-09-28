import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DefaultLinesDiffComputer } from '../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import type { IDiffService } from '../../../../services/diff/common/diffService.js';
import { MergeEditorModel } from '../../browser/model/mergeEditorModel.js';

const computer = new DefaultLinesDiffComputer();
const diffService: IDiffService = {
	createComputationService: () => ({
		onDidChange: Event.None,
		computeDiff: async (original, modified, options) => {
			const diff = computer.computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
			return { identical: diff.changes.length === 0, quitEarly: diff.hitTimeout, changes: diff.changes, moves: diff.moves };
		},
		dispose: () => {},
		[Symbol.dispose]: () => {},
	}),
};

test('merge model keeps two conflicts anchored to the base after editing the first result', async () => {
	const base = 'before\nbase\nbetween\nbase2\nafter\n';
	const current = 'before\ncurrent\nbetween\ncurrent2\nafter\n';
	const incoming = 'before\nincoming\nbetween\nincoming2\nafter\n';
	const initial = 'before\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\nbetween\n<<<<<<< HEAD\ncurrent2\n=======\nincoming2\n>>>>>>> topic\nafter\n';
	using result = new TextModel(initial);
	using model = new MergeEditorModel(base, current, incoming, result, diffService);
	await model.initialize(new AbortController().signal);
	assert.equal(model.hunks.length, 2);
	assert.deepEqual(model.hunks.map(hunk => hunk.unresolved), [true, true]);
	await applyChoice(model, result, 0, 'current');
	assert.equal(model.hunks.length, 2);
	assert.deepEqual(model.hunks.map(hunk => hunk.unresolved), [false, true]);
	await applyChoice(model, result, 1, 'incoming');
	assert.equal(result.getValue(), 'before\ncurrent\nbetween\nincoming2\nafter\n');
	assert.deepEqual(model.hunks.map(hunk => hunk.unresolved), [false, false]);
});

test('merge model finds a conflict even when the result has no Git markers', async () => {
	using result = new TextModel('manual\n');
	using model = new MergeEditorModel('base\n', 'current\n', 'incoming\n', result, diffService);
	await model.initialize(new AbortController().signal);
	assert.equal(model.hunks.length, 1);
	assert.equal(model.hunks[0].unresolved, false);
	assert.equal(model.editForHunk(0, 'incoming').text, 'incoming\n');
});

test('accepting both combines disjoint changes on the same line', async () => {
	using result = new TextModel('<<<<<<< HEAD\nhallo\n=======\nhelloworld\n>>>>>>> topic\n');
	using model = new MergeEditorModel('hello\n', 'hallo\n', 'helloworld\n', result, diffService);
	await model.initialize(new AbortController().signal);
	assert.equal(model.hunks.length, 1);
	assert.equal(model.editForHunk(0, 'both').text, 'halloworld\n');
});

async function applyChoice(model: MergeEditorModel, result: TextModel, index: number, choice: 'current' | 'incoming'): Promise<void> {
	const edit = model.editForHunk(index, choice);
	const changed = new Promise<void>(resolve => {
		const listener = model.onDidChange(() => {
			if (!model.isReady) return;
			listener.dispose();
			resolve();
		});
	});
	result.applyEdits([edit]);
	await changed;
}
