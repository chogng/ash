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
		dispose: () => { },
		[Symbol.dispose]: () => { },
	}),
};

test('merge model keeps two conflicts anchored to the base after editing the first result', async () => {
	const base = 'before\nbase\nbetween\nbase2\nafter\n';
	const current = 'before\ncurrent\nbetween\ncurrent2\nafter\n';
	const incoming = 'before\nincoming\nbetween\nincoming2\nafter\n';
	const initial = 'before\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\nbetween\n<<<<<<< HEAD\ncurrent2\n=======\nincoming2\n>>>>>>> topic\nafter\n';
	using result = new TextModel(initial);
	using model = new MergeEditorModel(base, current, incoming, result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	assert.equal(model.hunks.length, 2);
	assert.deepEqual(model.hunks.map(hunk => hunk.unresolved), [true, true]);
	assert.equal(model.unresolvedCount, 2);
	await applyChoice(model, 0, 'current');
	assert.equal(model.hunks.length, 2);
	assert.deepEqual(model.hunks.map(hunk => hunk.unresolved), [false, true]);
	assert.deepEqual(model.hunks.map(hunk => hunk.resolution), ['current', 'unresolved']);
	await applyChoice(model, 1, 'incoming');
	assert.equal(result.getValue(), 'before\ncurrent\nbetween\nincoming2\nafter\n');
	assert.deepEqual(model.hunks.map(hunk => hunk.unresolved), [false, false]);
});

test('merge model maps every line inside unequal conflict spans and refreshes the result mapping', async () => {
	using result = new TextModel('head\n<<<<<<< HEAD\ncur1\ncur2\n=======\ninc1\ninc2\ninc3\n>>>>>>> topic\nlast\n');
	using model = new MergeEditorModel(
		'head\nold\nlast\n',
		'head\ncur1\ncur2\nlast\n',
		'head\ninc1\ninc2\ninc3\nlast\n',
		result,
		undefined,
		diffService,
	);
	await model.initialize(new AbortController().signal);
	assert.deepEqual(model.hunks.map(hunk => [hunk.base.serialize(), hunk.current.serialize(), hunk.incoming.serialize(), hunk.result.serialize()]), [
		[[2, 3], [2, 4], [2, 5], [2, 10]],
	]);
	assert.deepEqual(model.getLineMapping('current', 'incoming').project(3).outputRange.serialize(), [2, 5]);
	assert.deepEqual(model.getLineMapping('current', 'result').project(3).outputRange.serialize(), [2, 10]);
	await applyChoice(model, 0, 'current');
	assert.deepEqual(model.hunks[0].result.serialize(), [2, 4]);
	assert.deepEqual(model.getLineMapping('current', 'result').project(3).outputRange.serialize(), [2, 4]);
});

test('merge model maps inserted and deleted conflict ranges without consuming the next line', async () => {
	using insertedResult = new TextModel('head\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\nlast\n');
	using inserted = new MergeEditorModel('head\nlast\n', 'head\ncurrent\nlast\n', 'head\nincoming\nlast\n', insertedResult, undefined, diffService);
	await inserted.initialize(new AbortController().signal);
	assert.deepEqual(inserted.hunks.map(hunk => [hunk.base.serialize(), hunk.current.serialize(), hunk.incoming.serialize(), hunk.result.serialize()]), [
		[[2, 2], [2, 3], [2, 3], [2, 7]],
	]);
	await applyChoice(inserted, 0, 'incoming');
	assert.equal(insertedResult.getValue(), 'head\nincoming\nlast\n');

	using deletedResult = new TextModel('head\n<<<<<<< HEAD\n=======\nnew1\nnew2\n>>>>>>> topic\nlast\n');
	using deleted = new MergeEditorModel('head\nold\nlast\n', 'head\nlast\n', 'head\nnew1\nnew2\nlast\n', deletedResult, undefined, diffService);
	await deleted.initialize(new AbortController().signal);
	assert.deepEqual(deleted.hunks.map(hunk => [hunk.base.serialize(), hunk.current.serialize(), hunk.incoming.serialize(), hunk.result.serialize()]), [
		[[2, 3], [2, 2], [2, 4], [2, 7]],
	]);
	assert.deepEqual(deleted.getLineMapping('current', 'incoming').project(2).outputRange.serialize(), [4, 5]);
	await applyChoice(deleted, 0, 'current');
	assert.equal(deletedResult.getValue(), 'head\nlast\n');
	assert.deepEqual(deleted.hunks[0].result.serialize(), [2, 2]);
});

test('merge model keeps unchanged lines aligned across a one-sided insertion before a conflict', async () => {
	using result = new TextModel('head\ncurrentIntro\nunchanged\n<<<<<<< HEAD\ncur\n=======\ninc\n>>>>>>> topic\nlast\n');
	using model = new MergeEditorModel(
		'head\nunchanged\nold\nlast\n',
		'head\ncurrentIntro\nunchanged\ncur\nlast\n',
		'head\nunchanged\ninc\nlast\n',
		result,
		undefined,
		diffService,
	);
	await model.initialize(new AbortController().signal);
	assert.deepEqual(model.hunks.map(hunk => [hunk.base.serialize(), hunk.current.serialize(), hunk.incoming.serialize(), hunk.result.serialize()]), [
		[[3, 4], [4, 5], [3, 4], [4, 9]],
	]);
	assert.deepEqual(model.getLineMapping('current', 'incoming').project(3).outputRange.serialize(), [2, 3]);
	assert.deepEqual(model.getLineMapping('current', 'incoming').project(4).outputRange.serialize(), [3, 4]);
	assert.deepEqual(model.getLineMapping('incoming', 'current').project(3).outputRange.serialize(), [4, 5]);
});

test('merge model finds a conflict even when the result has no Git markers', async () => {
	using result = new TextModel('manual\n');
	using model = new MergeEditorModel('base\n', 'current\n', 'incoming\n', result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	assert.equal(model.hunks.length, 1);
	assert.equal(model.hunks[0].unresolved, true);
	assert.equal(model.hunks[0].resolution, 'manual');
	model.setHandled(0, true);
	assert.deepEqual([model.hunks[0].handled, model.hunks[0].unresolved], [true, false]);
	model.setHandled(0, false);
	assert.deepEqual([model.hunks[0].handled, model.hunks[0].unresolved], [false, true]);
	assert.equal(model.editForHunk(0, 'incoming').text, 'incoming\n');
});

test('accepting both combines disjoint changes on the same line', async () => {
	using result = new TextModel('<<<<<<< HEAD\nhallo\n=======\nhelloworld\n>>>>>>> topic\n');
	using model = new MergeEditorModel('hello\n', 'hallo\n', 'helloworld\n', result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	assert.equal(model.hunks.length, 1);
	assert.equal(model.editForHunk(0, 'both').text, 'halloworld\n');
});

test('merge model recognizes base and both input orders from the editable result', async () => {
	using result = new TextModel('<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n');
	using model = new MergeEditorModel('base\n', 'current\n', 'incoming\n', result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	assert.deepEqual([
		model.canSmartCombine(0),
		model.editForHunk(0, 'base').text,
		model.editForHunk(0, 'both').text,
		model.editForHunk(0, 'bothReversed').text,
	], [false, 'base\n', 'current\nincoming\n', 'incoming\ncurrent\n']);
	await applyChoice(model, 0, 'bothReversed');
	assert.equal(model.hunks[0].resolution, 'bothReversed');
	await applyChoice(model, 0, 'base');
	assert.equal(model.hunks[0].resolution, 'base');
	assert.equal(model.unresolvedCount, 0);
});

test('merge model keeps explicit handling separate from base text across reopening', async () => {
	using result = new TextModel('base\n');
	using model = new MergeEditorModel('base\n', 'current\n', 'incoming\n', result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	assert.deepEqual([model.hunks[0].resolution, model.hunks[0].handled, model.hunks[0].unresolved], ['base', false, true]);
	await applyChoice(model, 0, 'base');
	assert.deepEqual([model.hunks[0].resolution, model.hunks[0].handled, model.hunks[0].unresolved], ['base', true, false]);
	using reopenedResult = new TextModel(result.getValue());
	using reopened = new MergeEditorModel('base\n', 'current\n', 'incoming\n', reopenedResult, model.getHandledState(), diffService);
	await reopened.initialize(new AbortController().signal);
	assert.deepEqual([reopened.hunks[0].resolution, reopened.hunks[0].handled, reopened.hunks[0].unresolved], ['base', true, false]);
});

test('merge model restores handling after accepting, manually editing, undoing, and redoing', async () => {
	using result = new TextModel('<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n');
	using model = new MergeEditorModel('base\n', 'current\n', 'incoming\n', result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	await applyChoice(model, 0, 'current');
	assert.deepEqual([model.hunks[0].handled, model.hunks[0].unresolved], [true, false]);
	await changeResult(model, () => result.undo());
	assert.deepEqual([model.hunks[0].handled, model.hunks[0].unresolved], [false, true]);
	await changeResult(model, () => result.redo());
	assert.deepEqual([model.hunks[0].handled, model.hunks[0].unresolved], [true, false]);
	await changeResult(model, () => result.applyOperations([model.editForHunk(0, 'base')]));
	assert.deepEqual([model.hunks[0].resolution, model.hunks[0].handled, model.hunks[0].unresolved], ['base', true, false]);
	await changeResult(model, () => result.undo());
	assert.deepEqual([model.hunks[0].resolution, model.hunks[0].handled, model.hunks[0].unresolved], ['current', true, false]);
});

test('manual edits and undo affect only the touched conflict', async () => {
	using result = new TextModel('start\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\nmiddle\n<<<<<<< HEAD\ncurrent2\n=======\nincoming2\n>>>>>>> topic\nend\n');
	using model = new MergeEditorModel('start\nbase\nmiddle\nbase2\nend\n', 'start\ncurrent\nmiddle\ncurrent2\nend\n', 'start\nincoming\nmiddle\nincoming2\nend\n', result, undefined, diffService);
	await model.initialize(new AbortController().signal);
	await applyChoice(model, 0, 'current');
	const second = model.editForHunk(1, 'incoming');
	await changeResult(model, () => result.applyOperations([{ range: second.range, text: 'custom2\n' }]));
	assert.deepEqual(model.hunks.map(hunk => [hunk.resolution, hunk.handled]), [['current', true], ['manual', true]]);
	await changeResult(model, () => result.undo());
	assert.deepEqual(model.hunks.map(hunk => [hunk.resolution, hunk.handled]), [['current', true], ['unresolved', false]]);
});

async function applyChoice(model: MergeEditorModel, index: number, choice: 'base' | 'current' | 'incoming' | 'bothReversed'): Promise<void> {
	await changeResult(model, () => model.acceptHunk(index, choice));
}

async function changeResult(model: MergeEditorModel, edit: () => unknown): Promise<void> {
	const changed = new Promise<void>(resolve => {
		const listener = model.onDidChange(() => {
			if (!model.isReady) return;
			listener.dispose();
			resolve();
		});
	});
	edit();
	await changed;
}
